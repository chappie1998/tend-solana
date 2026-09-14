import assert from "node:assert/strict";
import test from "node:test";

// Offline (no network) tests for the provider-neutral market-data layer:
// app/lib/market-data.ts (provider selection/dispatch), app/lib/coinbase-market-data.ts
// (ticker parsing, confidence, live/stale) and app/lib/coinbase-market-bars.ts
// (candle row parsing, pagination windows, merge/dedupe). `globalThis.fetch`
// is stubbed with an in-memory Response for every test that needs one --
// never a real network call -- and restored afterward.

const root = new URL("../", import.meta.url);

async function loadModules() {
  const [marketData, coinbaseData, coinbaseBars, markets] = await Promise.all([
    import(new URL("app/lib/market-data.ts", root)),
    import(new URL("app/lib/coinbase-market-data.ts", root)),
    import(new URL("app/lib/coinbase-market-bars.ts", root)),
    import(new URL("app/lib/markets.ts", root)),
  ]);
  return { marketData, coinbaseData, coinbaseBars, markets };
}

/** Stubs globalThis.fetch with `respond(url) -> unknown` (the parsed JSON body); returns a restore function. */
function stubFetch(respond) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = JSON.stringify(respond(new URL(url.toString())));
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

// --- provider selection ------------------------------------------------

test("marketDataProviderName defaults to coinbase, accepts an explicit pyth, and rejects anything else", async () => {
  const { marketData } = await loadModules();
  assert.equal(withEnv("MARKET_DATA_PROVIDER", undefined, () => marketData.marketDataProviderName()), "coinbase");
  assert.equal(withEnv("MARKET_DATA_PROVIDER", "coinbase", () => marketData.marketDataProviderName()), "coinbase");
  assert.equal(withEnv("MARKET_DATA_PROVIDER", "PYTH", () => marketData.marketDataProviderName()), "pyth");
  assert.throws(() => withEnv("MARKET_DATA_PROVIDER", "bloomberg", () => marketData.marketDataProviderName()), /Unknown MARKET_DATA_PROVIDER/);
});

test("marketDataSourceLabel names the provider that is actually selected, never a hardcoded one", async () => {
  const { marketData } = await loadModules();
  assert.equal(withEnv("MARKET_DATA_PROVIDER", undefined, () => marketData.marketDataSourceLabel()), "Coinbase Exchange");
  assert.equal(withEnv("MARKET_DATA_PROVIDER", "pyth", () => marketData.marketDataSourceLabel()), "Pyth Core Hermes");
});

test("the default provider dispatches to the Coinbase implementation, not Pyth: a market with no Coinbase product fails with the Coinbase-specific reason", async () => {
  const { marketData, markets } = await loadModules();
  // NVDA is coming-soon: no Coinbase product configured (see app/lib/markets.ts).
  // If this reached the Pyth path instead it would attempt a real Hermes
  // fetch and fail differently (or hang) -- this exact, synchronous, offline
  // rejection is only reachable through the Coinbase code path.
  const nvda = markets.marketBySymbol("NVDA");
  await assert.rejects(
    () => withEnv("MARKET_DATA_PROVIDER", undefined, () => marketData.getMarketSnapshot(nvda)),
    /has no Coinbase product configured/,
  );
  await assert.rejects(
    () => withEnv("MARKET_DATA_PROVIDER", undefined, () => marketData.getMarketBars(nvda, "D")),
    /has no Coinbase product configured/,
  );
});

// --- markets.ts wiring ---------------------------------------------------

test("every live market has a Coinbase product id; every coming-soon market has none", async () => {
  const { markets } = await loadModules();
  for (const market of markets.markets) {
    if (market.status === "live") {
      assert.match(market.coinbaseProductId, /^[A-Z]+-USD$/, `${market.symbol} must carry a real Coinbase product id`);
    } else {
      assert.equal(market.coinbaseProductId, "", `${market.symbol} is coming-soon and must carry no Coinbase product id`);
    }
  }
  assert.deepEqual(
    markets.liveMarkets.map((market) => market.coinbaseProductId).sort(),
    ["BTC-USD", "ETH-USD", "SOL-USD"],
  );
});

// --- Coinbase ticker parsing ---------------------------------------------

test("parseCoinbaseTicker extracts price/bid/ask/time and rejects malformed tickers", async () => {
  const { coinbaseData } = await loadModules();
  const parsed = coinbaseData.parseCoinbaseTicker(
    { ask: "101.42", bid: "101.40", price: "101.41", time: "2026-09-13T21:10:39.499440150Z" },
    "SOL-USD",
  );
  assert.equal(parsed.price, 101.41);
  assert.equal(parsed.bid, 101.40);
  assert.equal(parsed.ask, 101.42);
  assert.equal(parsed.publishTime, Math.floor(Date.parse("2026-09-13T21:10:39.499440150Z") / 1_000));

  assert.throws(() => coinbaseData.parseCoinbaseTicker(null, "SOL-USD"), /invalid ticker/);
  assert.throws(() => coinbaseData.parseCoinbaseTicker({ ask: "1", bid: "1", price: "0", time: "2026-01-01T00:00:00Z" }, "SOL-USD"), /invalid price/);
  assert.throws(() => coinbaseData.parseCoinbaseTicker({ ask: "1", bid: "2", price: "1.5", time: "2026-01-01T00:00:00Z" }, "SOL-USD"), /invalid bid\/ask/, "ask below bid must be rejected");
  assert.throws(() => coinbaseData.parseCoinbaseTicker({ ask: "1", bid: "1", price: "1", time: "not-a-date" }, "SOL-USD"), /invalid ticker time/);
});

test("getCoinbaseSnapshot computes confidence as half the bid/ask spread, and sets live/stale from ticker age", async () => {
  const { coinbaseData } = await loadModules();
  const market = { name: "Test", symbol: "TEST", coinbaseProductId: "TEST-LIVE" };

  const restore = stubFetch(() => ({
    ask: "101.42",
    bid: "101.38",
    price: "101.40",
    time: new Date().toISOString(),
  }));
  try {
    const snapshot = await coinbaseData.getCoinbaseSnapshot(market);
    assert.equal(snapshot.price, 101.40);
    // Half the live bid/ask spread ((101.42 - 101.38) / 2), not a Pyth
    // confidence interval -- see the field's doc comment in market-data-types.ts.
    assert.ok(Math.abs(snapshot.confidence - 0.02) < 1e-9);
    assert.ok(Math.abs(snapshot.confidenceBps - (0.02 / 101.40) * 10_000) < 1e-6);
    assert.equal(snapshot.slot, null);
    assert.equal(snapshot.source, "Coinbase Exchange");
    assert.equal(snapshot.mode, "live");
    assert.match(snapshot.warning, /Fresh Coinbase reference/);
  } finally {
    restore();
  }
});

test("getCoinbaseSnapshot reports stale mode and an honest gap-risk warning for an old ticker", async () => {
  const { coinbaseData } = await loadModules();
  const market = { name: "Test", symbol: "TEST", coinbaseProductId: "TEST-STALE" };
  const oldTime = new Date(Date.now() - 5 * 60_000).toISOString();

  const restore = stubFetch(() => ({ ask: "10.02", bid: "9.98", price: "10.00", time: oldTime }));
  try {
    const snapshot = await coinbaseData.getCoinbaseSnapshot(market);
    assert.equal(snapshot.mode, "stale");
    assert.ok(snapshot.ageSeconds >= 299);
    assert.match(snapshot.warning, /is not printing fresh updates/);
    assert.match(snapshot.warning, /TEST-STALE/);
  } finally {
    restore();
  }
});

test("getCoinbaseSnapshot refuses a market with no Coinbase product configured, without ever calling fetch", async () => {
  const { coinbaseData } = await loadModules();
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return {};
  });
  try {
    await assert.rejects(
      () => coinbaseData.getCoinbaseSnapshot({ name: "SpaceX", symbol: "SPACEX", coinbaseProductId: "" }),
      /has no Coinbase product configured/,
    );
    assert.equal(called, false, "a market with no product id must never reach fetch");
  } finally {
    restore();
  }
});

// --- Coinbase candle row parsing -----------------------------------------

test("parseCoinbaseCandleRow reads Coinbase's [time, low, high, open, close, volume] order, not OHLC order", async () => {
  const { coinbaseBars } = await loadModules();
  // Row shape verified live against api.exchange.coinbase.com/products/SOL-USD/candles
  // on 2026-09-13 -- see the module doc comment for how the column order was
  // confirmed (close matched the live ticker price; open matched the
  // chronologically-next candle's close).
  const bar = coinbaseBars.parseCoinbaseCandleRow([1_700_000_000, 199, 202, 200, 201, 12_345.6]);
  assert.deepEqual(bar, { time: 1_700_000_000, open: 200, high: 202, low: 199, close: 201 });
});

test("parseCoinbaseCandleRow rejects malformed, non-numeric, and OHLC-inconsistent rows", async () => {
  const { coinbaseBars } = await loadModules();
  assert.throws(() => coinbaseBars.parseCoinbaseCandleRow(null), /malformed/);
  assert.throws(() => coinbaseBars.parseCoinbaseCandleRow([1, 2, 3]), /malformed/);
  assert.throws(() => coinbaseBars.parseCoinbaseCandleRow([1_700_000_000, 199, 202, 200, "201", 1]), /must be numbers/);
  assert.throws(() => coinbaseBars.parseCoinbaseCandleRow([1_700_000_000, -1, 202, 200, 201, 1]), /prices are invalid/);
  // high (198) below open/close/low is inconsistent OHLC.
  assert.throws(() => coinbaseBars.parseCoinbaseCandleRow([1_700_000_000, 199, 198, 200, 201, 1]), /OHLC bounds are invalid/);
  assert.throws(() => coinbaseBars.parseCoinbaseCandleRow([1.5, 199, 202, 200, 201, 1]), /timestamp is invalid/);
});

// --- pagination: windows + merge -----------------------------------------

test("candleWindows splits a lookback into <=300-candle pages covering the full range with no gaps", async () => {
  const { coinbaseBars } = await loadModules();
  const to = 1_800_000_000;
  const granularity = 60; // 1-minute bars
  const from = to - 24 * 60 * 60; // 1,440 minutes, this app's real "1" lookback
  const windows = coinbaseBars.candleWindows(from, to, granularity);

  // Verified empirically: Coinbase caps a request at 300 candles regardless
  // of granularity, so 1,440 one-minute bars needs ceil(1440/300) = 5 pages.
  assert.equal(windows.length, 5);
  for (const window of windows) {
    assert.ok((window.end - window.start) / granularity <= 300, "no window may request more than the verified 300-candle cap");
  }
  // Newest first, and contiguous: each window's start is the previous window's end.
  assert.equal(windows[0].end, to);
  for (let i = 1; i < windows.length; i += 1) assert.equal(windows[i].end, windows[i - 1].start);
  assert.equal(windows[windows.length - 1].start, from);
});

test("candleWindows needs only 2 pages for the 365-bar daily lookback", async () => {
  const { coinbaseBars } = await loadModules();
  const to = 1_800_000_000;
  const granularity = 86_400;
  const from = to - 365 * 24 * 60 * 60;
  assert.equal(coinbaseBars.candleWindows(from, to, granularity).length, 2);
});

test("mergeCandlePages sorts ascending and dedupes candles that pages share at a boundary", async () => {
  const { coinbaseBars } = await loadModules();
  const older = [[300, 9, 11, 10, 10, 1], [200, 9, 11, 10, 10, 1]]; // newest-first within a page, like the real API
  const newer = [[500, 19, 21, 20, 20, 1], [400, 19, 21, 20, 20, 1], [300, 9, 11, 10, 10, 1]]; // shares t=300 with `older`
  const bars = coinbaseBars.mergeCandlePages([newer, older]);
  assert.deepEqual(bars.map((bar) => bar.time), [200, 300, 400, 500], "ascending, and t=300 must appear exactly once");
});

// --- getCoinbaseMarketBars: full pagination + freshness end to end -------

test("getCoinbaseMarketBars paginates across multiple requests and returns one ascending, deduped series", async () => {
  const { coinbaseBars } = await loadModules();
  const market = { name: "Test", symbol: "TEST", coinbaseProductId: "TEST-BARS-HOURLY" };
  const now = Date.UTC(2026, 8, 13, 12, 0, 0);
  const granularitySeconds = 3_600; // resolution "60"

  let pageRequests = 0;
  const restore = stubFetch((url) => {
    pageRequests += 1;
    const start = Math.floor(Date.parse(url.searchParams.get("start")) / 1_000);
    const end = Math.floor(Date.parse(url.searchParams.get("end")) / 1_000);
    assert.equal(Number(url.searchParams.get("granularity")), granularitySeconds);
    const rows = [];
    // Synthetic, deterministic, always-valid OHLC: one candle per bucket,
    // newest-first within the page -- exactly like the real API.
    for (let t = Math.floor(end / granularitySeconds) * granularitySeconds; t > start; t -= granularitySeconds) {
      const price = 100 + (t % 10);
      rows.push([t, price - 0.5, price + 0.5, price, price, 1]);
    }
    return rows;
  });
  try {
    const result = await coinbaseBars.getCoinbaseMarketBars(market, "60", now);
    assert.equal(result.source, "Coinbase Exchange");
    assert.equal(result.symbol, "TEST");
    assert.ok(pageRequests > 1, "a 1,440-bar hourly lookback must paginate across more than one request");
    // Ascending and strictly increasing (mergeCandlePages already dedupes).
    for (let i = 1; i < result.bars.length; i += 1) assert.ok(result.bars[i].time > result.bars[i - 1].time);
    assert.equal(result.lastBarTime, result.bars[result.bars.length - 1].time);
    assert.equal(result.freshness, "live", "the newest bar lands within the fresh-bar lag window of `now`");
  } finally {
    restore();
  }
});

test("getCoinbaseMarketBars refuses a market with no Coinbase product configured, without ever calling fetch", async () => {
  const { coinbaseBars } = await loadModules();
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return [];
  });
  try {
    await assert.rejects(
      () => coinbaseBars.getCoinbaseMarketBars({ name: "SpaceX", symbol: "SPACEX", coinbaseProductId: "" }, "D"),
      /has no Coinbase product configured/,
    );
    assert.equal(called, false);
  } finally {
    restore();
  }
});
