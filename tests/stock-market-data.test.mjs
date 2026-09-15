import assert from "node:assert/strict";
import test from "node:test";

// Offline (no network) tests for the stock-market data layer added on top of
// the existing crypto-only market-data.ts: app/lib/finnhub-market-data.ts
// (spot snapshots), app/lib/twelvedata-market-bars.ts (chart bars + realized
// volatility, and the OHLC aggregation + exchange-timezone conversion it is
// built on), and app/lib/market-data.ts's per-market provider routing.
// `globalThis.fetch` is stubbed with an in-memory Response for every test
// that needs one -- never a real network call -- and restored afterward.

const root = new URL("../", import.meta.url);

async function loadModules() {
  const [twelveData, finnhub, marketData, markets] = await Promise.all([
    import(new URL("app/lib/twelvedata-market-bars.ts", root)),
    import(new URL("app/lib/finnhub-market-data.ts", root)),
    import(new URL("app/lib/market-data.ts", root)),
    import(new URL("app/lib/markets.ts", root)),
  ]);
  return { twelveData, finnhub, marketData, markets };
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

// --- aggregateBars: OHLC folding -----------------------------------------

test("aggregateBars folds ascending 1-minute bars into coarser buckets: open=first, close=last, high=max, low=min", async () => {
  const { twelveData } = await loadModules();
  const oneMinute = [
    { time: 0, open: 10, high: 11, low: 9, close: 10.5 },
    { time: 60, open: 10.5, high: 12, low: 10, close: 11.5 },
    { time: 120, open: 11.5, high: 11.6, low: 8, close: 9 },
    { time: 300, open: 20, high: 21, low: 19, close: 20.5 },
    { time: 360, open: 20.5, high: 22, low: 20, close: 21 },
  ];
  const fiveMinute = twelveData.aggregateBars(oneMinute, 300);
  assert.deepEqual(fiveMinute, [
    { time: 0, open: 10, high: 12, low: 8, close: 9 },
    { time: 300, open: 20, high: 22, low: 19, close: 21 },
  ]);
});

test("aggregateBars is a no-op-shaped identity when every bar already owns its own bucket", async () => {
  const { twelveData } = await loadModules();
  const bars = [
    { time: 0, open: 1, high: 1.1, low: 0.9, close: 1.05 },
    { time: 60, open: 1.05, high: 1.2, low: 1, close: 1.1 },
  ];
  assert.deepEqual(twelveData.aggregateBars(bars, 60), bars);
});

test("aggregateBars rejects a non-positive bucket size", async () => {
  const { twelveData } = await loadModules();
  assert.throws(() => twelveData.aggregateBars([{ time: 0, open: 1, high: 1, low: 1, close: 1 }], 0), /positive bucket size/);
  assert.throws(() => twelveData.aggregateBars([], -60), /positive bucket size/);
});

// --- exchangeTimeToEpochSeconds: exchange-local wall clock -> true UTC ----

test("exchangeTimeToEpochSeconds converts America/New_York wall-clock time to UTC correctly across DST", async () => {
  const { twelveData } = await loadModules();
  // September: Eastern Daylight Time, UTC-4.
  assert.equal(
    twelveData.exchangeTimeToEpochSeconds("2026-09-15 09:31:00", "America/New_York"),
    Date.UTC(2026, 8, 15, 13, 31, 0) / 1_000,
  );
  // January: Eastern Standard Time, UTC-5 -- a different offset than the
  // September case above, which is exactly what a hardcoded offset would
  // get wrong.
  assert.equal(
    twelveData.exchangeTimeToEpochSeconds("2026-01-15 09:31:00", "America/New_York"),
    Date.UTC(2026, 0, 15, 14, 31, 0) / 1_000,
  );
  // UTC itself: identity, sanity-checking the algorithm against a zero offset.
  assert.equal(
    twelveData.exchangeTimeToEpochSeconds("2026-06-01 00:00:00", "UTC"),
    Date.UTC(2026, 5, 1, 0, 0, 0) / 1_000,
  );
});

test("exchangeTimeToEpochSeconds rejects a malformed datetime string", async () => {
  const { twelveData } = await loadModules();
  assert.throws(() => twelveData.exchangeTimeToEpochSeconds("not-a-datetime", "America/New_York"), /not in the expected/);
  assert.throws(() => twelveData.exchangeTimeToEpochSeconds("2026-09-15", "America/New_York"), /not in the expected/);
});

// --- Twelve Data response parsing ----------------------------------------

test("parseTwelveDataResponse orders values ascending (oldest first) from Twelve Data's newest-first payload, converting via the exchange timezone", async () => {
  const { twelveData } = await loadModules();
  const raw = {
    meta: { exchange_timezone: "America/New_York" },
    status: "ok",
    values: [
      { datetime: "2026-09-15 09:32:00", open: "101", high: "102", low: "100.5", close: "101.5" },
      { datetime: "2026-09-15 09:31:00", open: "100", high: "101", low: "99.5", close: "100.5" },
    ],
  };
  const { bars, exchangeTimezone } = twelveData.parseTwelveDataResponse(raw, "NVDA");
  assert.equal(exchangeTimezone, "America/New_York");
  assert.equal(bars.length, 2);
  assert.ok(bars[0].time < bars[1].time, "must be ascending, oldest first");
  assert.equal(bars[0].time, Date.UTC(2026, 8, 15, 13, 31, 0) / 1_000);
  assert.equal(bars[0].open, 100);
  assert.equal(bars[1].close, 101.5);
});

test("parseTwelveDataResponse fails honestly for a symbol Twelve Data has no data for, e.g. a private company", async () => {
  const { twelveData } = await loadModules();
  const raw = { status: "error", code: 400, message: "**symbol** not found: SPACEX does not exist" };
  assert.throws(() => twelveData.parseTwelveDataResponse(raw, "SPACEX"), /Twelve Data has no data for SPACEX/);
});

test("parseTwelveDataResponse rejects a response missing the exchange timezone or bars", async () => {
  const { twelveData } = await loadModules();
  assert.throws(() => twelveData.parseTwelveDataResponse({ meta: {}, values: [{}], status: "ok" }, "NVDA"), /no exchange timezone/);
  assert.throws(
    () => twelveData.parseTwelveDataResponse({ meta: { exchange_timezone: "America/New_York" }, values: [], status: "ok" }, "NVDA"),
    /no bars/,
  );
});

test("parseTwelveDataBarRow rejects non-positive and OHLC-inconsistent rows", async () => {
  const { twelveData } = await loadModules();
  assert.throws(
    () => twelveData.parseTwelveDataBarRow({ datetime: "2026-09-15 09:31:00", open: "0", high: "1", low: "1", close: "1" }, "America/New_York"),
    /prices are invalid/,
  );
  assert.throws(
    () => twelveData.parseTwelveDataBarRow({ datetime: "2026-09-15 09:31:00", open: "1", high: "0.5", low: "1", close: "1" }, "America/New_York"),
    /OHLC bounds are invalid/,
  );
});

// --- getTwelveDataMarketBars: one fetch serves every resolution ----------

test("getTwelveDataMarketBars fetches the 1-minute series exactly once per symbol, deriving every resolution from it", async () => {
  const { twelveData } = await loadModules();
  const symbol = "TD-ONECALL";
  const market = { symbol };

  // 150 consecutive 1-minute bars starting 2026-09-14 09:30:00 America/New_York
  // (EDT, UTC-4), sent newest-first the way Twelve Data really orders `values`.
  const startUtcMs = Date.UTC(2026, 8, 14, 13, 30, 0); // 09:30 ET
  const values = [];
  for (let i = 0; i < 150; i += 1) {
    const etMs = startUtcMs + i * 60_000 - 4 * 60 * 60_000; // render as ET wall clock
    const d = new Date(etMs);
    const pad = (n) => String(n).padStart(2, "0");
    const datetime = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
    const price = 100 + i * 0.01;
    values.push({
      datetime,
      open: price.toFixed(4),
      high: (price + 0.05).toFixed(4),
      low: (price - 0.05).toFixed(4),
      close: (price + 0.01).toFixed(4),
    });
  }
  values.reverse();

  let fetchCount = 0;
  const restore = stubFetch((url) => {
    fetchCount += 1;
    assert.equal(url.hostname, "api.twelvedata.com");
    assert.equal(url.searchParams.get("interval"), "1min");
    assert.equal(url.searchParams.get("symbol"), symbol);
    return { meta: { exchange_timezone: "America/New_York" }, status: "ok", values };
  });
  try {
    const now = startUtcMs + 150 * 60_000;
    const [oneMin, fiveMin, hourly, daily] = await withEnv("TWELVE_DATA_API_KEY", "test-key", () => Promise.all([
      twelveData.getTwelveDataMarketBars(market, "1", now),
      twelveData.getTwelveDataMarketBars(market, "5", now),
      twelveData.getTwelveDataMarketBars(market, "60", now),
      twelveData.getTwelveDataMarketBars(market, "D", now),
    ]));

    assert.equal(fetchCount, 1, "four different resolutions must share exactly one upstream request");
    assert.equal(oneMin.bars.length, 150, "resolution \"1\" is the raw series verbatim");
    assert.equal(fiveMin.bars.length, 30, "150 one-minute bars aligned to a 5-minute boundary fold into exactly 30 bars");
    assert.equal(hourly.bars.length, 3, "13:30-15:59 UTC crosses three UTC hour buckets (13:xx partial, 14:xx, 15:xx)");
    assert.equal(daily.bars.length, 1, "the whole session sits inside one UTC calendar day");
    for (const result of [oneMin, fiveMin, hourly, daily]) {
      assert.equal(result.source, "Twelve Data");
      assert.equal(result.symbol, symbol);
    }
    // Ascending and strictly increasing at every resolution.
    for (const result of [oneMin, fiveMin, hourly, daily]) {
      for (let i = 1; i < result.bars.length; i += 1) assert.ok(result.bars[i].time > result.bars[i - 1].time);
    }
  } finally {
    restore();
  }
});

test("getTwelveDataMarketBars requires TWELVE_DATA_API_KEY and never calls fetch without it", async () => {
  const { twelveData } = await loadModules();
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return {};
  });
  try {
    await assert.rejects(
      () => withEnv("TWELVE_DATA_API_KEY", undefined, () => twelveData.getTwelveDataMarketBars({ symbol: "TD-NOKEY" }, "D")),
      /TWELVE_DATA_API_KEY is not configured/,
    );
    assert.equal(called, false);
  } finally {
    restore();
  }
});

// --- getTwelveDataRealizedVolatility --------------------------------------

// One 1-minute bar per distinct calendar day is enough to produce that many
// daily bars once aggregated -- these dates are all in January 2020 so they
// can never collide with "today" (whatever today really is when this runs)
// and get dropped as a still-forming partial day.
function dailyFixtureValues(prices) {
  return prices.map((price, index) => ({
    datetime: `2020-01-${String(index + 2).padStart(2, "0")} 09:30:00`,
    open: String(price),
    high: String(price),
    low: String(price),
    close: String(price),
  }));
}

test("getTwelveDataRealizedVolatility computes an annualized figure with 252 (equity) sessions/year, not 365", async () => {
  const { twelveData } = await loadModules();
  const symbol = "TD-VOL-OK";
  const prices = [100, 103, 99, 104, 98, 105, 97, 106, 96, 107, 95, 108, 94, 109, 93];
  const restore = stubFetch(() => ({
    meta: { exchange_timezone: "America/New_York" },
    status: "ok",
    values: dailyFixtureValues(prices).reverse(),
  }));
  try {
    const result = await withEnv("TWELVE_DATA_API_KEY", "test-key", () => twelveData.getTwelveDataRealizedVolatility({ symbol }));
    assert.equal(result.source, "Twelve Data 20-session realized volatility");
    assert.equal(result.observations, prices.length);
    assert.ok(Number.isFinite(result.value) && result.value > 1 && result.value < 400);
  } finally {
    restore();
  }
});

test("getTwelveDataRealizedVolatility refuses to price off fewer than 10 completed sessions", async () => {
  const { twelveData } = await loadModules();
  const symbol = "TD-VOL-SHORT";
  const prices = [100, 103, 99, 104, 98];
  const restore = stubFetch(() => ({
    meta: { exchange_timezone: "America/New_York" },
    status: "ok",
    values: dailyFixtureValues(prices).reverse(),
  }));
  try {
    await assert.rejects(
      () => withEnv("TWELVE_DATA_API_KEY", "test-key", () => twelveData.getTwelveDataRealizedVolatility({ symbol })),
      /insufficient for volatility pricing/,
    );
  } finally {
    restore();
  }
});

// --- Finnhub quote parsing + snapshot -------------------------------------

test("parseFinnhubQuote extracts price/high/low/time and rejects Finnhub's zero-valued 'no data' response", async () => {
  const { finnhub } = await loadModules();
  const parsed = finnhub.parseFinnhubQuote({ c: 212.11, h: 213.94, l: 211.63, o: 212.4875, pc: 210.96, t: 1_757_930_000 }, "NVDA");
  assert.equal(parsed.price, 212.11);
  assert.equal(parsed.high, 213.94);
  assert.equal(parsed.low, 211.63);
  assert.equal(parsed.publishTime, 1_757_930_000);

  // Finnhub's actual "no data for this symbol" response is HTTP 200 with
  // every field zeroed -- the path a private company like SpaceX takes, and
  // it must fail honestly here rather than report a $0 price.
  assert.throws(() => finnhub.parseFinnhubQuote({ c: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 }, "SPACEX"), /Finnhub has no quote for SPACEX/);
  assert.throws(() => finnhub.parseFinnhubQuote(null, "NVDA"), /invalid quote/);
});

test("getFinnhubSnapshot requires FINNHUB_API_KEY and never calls fetch without it", async () => {
  const { finnhub } = await loadModules();
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return {};
  });
  try {
    await assert.rejects(
      () => withEnv("FINNHUB_API_KEY", undefined, () => finnhub.getFinnhubSnapshot({ symbol: "FH-NOKEY" })),
      /FINNHUB_API_KEY is not configured/,
    );
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test("getFinnhubSnapshot computes confidence as half the day's high-low range, and labels itself Finnhub", async () => {
  const { finnhub } = await loadModules();
  const restore = stubFetch(() => ({ c: 200, h: 210, l: 190, o: 195, pc: 198, t: Math.floor(Date.now() / 1_000) }));
  try {
    const snapshot = await withEnv("FINNHUB_API_KEY", "test-key", () => finnhub.getFinnhubSnapshot({ symbol: "FH-LIVE" }));
    assert.equal(snapshot.price, 200);
    assert.equal(snapshot.source, "Finnhub");
    assert.equal(snapshot.slot, null);
    assert.ok(Math.abs(snapshot.confidence - 10) < 1e-9, "(210-190)/2 = 10");
    assert.equal(snapshot.mode, "live");
    assert.match(snapshot.warning, /Fresh Finnhub reference/);
  } finally {
    restore();
  }
});

test("getFinnhubSnapshot fails honestly for a symbol Finnhub has no quote for", async () => {
  const { finnhub } = await loadModules();
  const restore = stubFetch(() => ({ c: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 }));
  try {
    await assert.rejects(
      () => withEnv("FINNHUB_API_KEY", "test-key", () => finnhub.getFinnhubSnapshot({ symbol: "FH-NODATA" })),
      /Finnhub has no quote for FH-NODATA/,
    );
  } finally {
    restore();
  }
});

// --- market-data.ts: per-market routing -----------------------------------

test("market-data.ts routes crypto to Coinbase and stocks to Finnhub -- never the other family, and a stock's equityTicker overrides its on-chain symbol", async () => {
  // SPACEX is now a live, publicly traded market (NASDAQ: SPCX -- see
  // app/lib/markets.ts), so it no longer serves as an example of a stock
  // that "fails honestly". What is still real and worth pinning: routing
  // never crosses category families, and a stock whose `equityTicker`
  // differs from its on-chain `symbol` (SPACEX -> SPCX) must resolve
  // off-chain requests through the VENDOR ticker, not the permanent
  // on-chain one -- see the dedicated ticker-mapping test below for the
  // pure-function version of this same guarantee.
  const { marketData, markets } = await loadModules();
  const hostsHit = [];
  let lastFinnhubSymbol;
  const restore = stubFetch((url) => {
    hostsHit.push(url.hostname);
    if (url.hostname === "api.exchange.coinbase.com") {
      return { ask: "101.42", bid: "101.38", price: "101.40", time: new Date().toISOString() };
    }
    if (url.hostname === "finnhub.io") {
      lastFinnhubSymbol = url.searchParams.get("symbol");
      return { c: 212.11, h: 213.94, l: 211.63, o: 212.4875, pc: 210.96, t: Math.floor(Date.now() / 1_000) };
    }
    throw new Error(`unexpected host reached in this test: ${url.hostname}`);
  });
  try {
    await withEnv("MARKET_DATA_PROVIDER", undefined, () => marketData.getMarketSnapshot(markets.marketBySymbol("SOL")));
    assert.deepEqual(hostsHit, ["api.exchange.coinbase.com"], "crypto must still resolve to Coinbase");

    hostsHit.length = 0;
    const nvdaSnapshot = await withEnv("FINNHUB_API_KEY", "test-key", () => marketData.getMarketSnapshot(markets.marketBySymbol("NVDA")));
    assert.deepEqual(hostsHit, ["finnhub.io"], "a stock market must never reach Coinbase");
    assert.equal(nvdaSnapshot.source, "Finnhub");
    // NVDA's equityTicker is blank, so Finnhub is asked for its own symbol.
    assert.equal(lastFinnhubSymbol, "NVDA");

    // SPACEX carries symbol "SPACEX" (permanent on-chain identity, hashed
    // into the market PDA and the CustomPriceFeed seed) but equityTicker
    // "SPCX" (the vendor's own spelling -- it trades as SPCX on NASDAQ).
    // The Finnhub request must go out for SPCX, never the raw on-chain
    // symbol, and must still never touch Coinbase.
    hostsHit.length = 0;
    const spacexSnapshot = await withEnv("FINNHUB_API_KEY", "test-key", () => marketData.getMarketSnapshot(markets.marketBySymbol("SPACEX")));
    assert.deepEqual(hostsHit, ["finnhub.io"], "a stock market must never reach Coinbase, SPACEX included");
    assert.equal(lastFinnhubSymbol, "SPCX", "SPACEX must resolve through its equityTicker, not its on-chain symbol");
    assert.equal(spacexSnapshot.source, "Finnhub");
  } finally {
    restore();
  }
});

test("market-data.ts routes stock chart bars to Twelve Data, never Coinbase or Pyth", async () => {
  const { marketData, markets } = await loadModules();
  const hostsHit = [];
  const restore = stubFetch((url) => {
    hostsHit.push(url.hostname);
    return {
      meta: { exchange_timezone: "America/New_York" },
      status: "ok",
      values: [{ datetime: "2026-09-15 09:31:00", open: "212.4", high: "213.9", low: "211.6", close: "212.1" }],
    };
  });
  try {
    const result = await withEnv("TWELVE_DATA_API_KEY", "test-key", () => marketData.getMarketBars(markets.marketBySymbol("GOOGL"), "5"));
    assert.deepEqual(hostsHit, ["api.twelvedata.com"]);
    assert.equal(result.source, "Twelve Data");
  } finally {
    restore();
  }
});

// --- ticker mapping: equityTicker overrides symbol for off-chain vendors ---
//
// Pins app/lib/markets.ts's `equityTicker` contract so it cannot silently
// regress: `symbol` is permanent on-chain identity (hashed into the market
// PDA and the CustomPriceFeed seed), but Finnhub/Twelve Data know some
// markets by a different spelling. Both getFinnhubSnapshot and
// getTwelveDataMarketBars carry their own private `tickerFor(market)`
// helper (`market.equityTicker || market.symbol`) -- this test exercises
// the REAL functions with a stubbed fetch (never the network) so a change to
// either helper's actual behavior fails here, not just a reimplementation of
// it.

test("a market's equityTicker overrides its on-chain symbol for every off-chain vendor request; a blank equityTicker falls back to symbol", async () => {
  const { finnhub, twelveData, markets } = await loadModules();
  const spacex = markets.marketBySymbol("SPACEX");
  const nvda = markets.marketBySymbol("NVDA");
  // The concrete mapping this whole test exists to pin: SPACEX -> SPCX,
  // NVDA -> NVDA (no override needed). The end-to-end network-param proof for
  // these exact two real markets already lives in the "market-data.ts routes
  // crypto to Coinbase..." test above; asserting the config fields directly
  // here (rather than re-issuing the same getFinnhubSnapshot calls) avoids
  // colliding with that test's already-warm 5s snapshot cache for "SPCX"/
  // "NVDA" while still pinning the exact real values.
  assert.equal(spacex.equityTicker, "SPCX", "SPACEX must resolve to SPCX");
  assert.equal(nvda.equityTicker, "", "NVDA needs no override -- it resolves to its own symbol");

  // The general RULE (equityTicker || symbol), exercised end-to-end through
  // both real vendor functions with fresh, uniquely-named fixtures so this
  // test's own fetch calls can never be served from another test's cache.
  const withOverride = { symbol: "TICKERMAP-ONCHAIN", equityTicker: "TICKERMAP-VENDOR" };
  const withoutOverride = { symbol: "TICKERMAP-PLAIN", equityTicker: "" };

  let finnhubSymbol;
  const restoreFinnhub = stubFetch((url) => {
    finnhubSymbol = url.searchParams.get("symbol");
    return { c: 100, h: 101, l: 99, o: 100, pc: 100, t: Math.floor(Date.now() / 1_000) };
  });
  try {
    await withEnv("FINNHUB_API_KEY", "test-key", () => finnhub.getFinnhubSnapshot(withOverride));
    assert.equal(finnhubSymbol, "TICKERMAP-VENDOR", "a set equityTicker must resolve to IT, not the on-chain symbol");
    await withEnv("FINNHUB_API_KEY", "test-key", () => finnhub.getFinnhubSnapshot(withoutOverride));
    assert.equal(finnhubSymbol, "TICKERMAP-PLAIN", "a blank equityTicker must fall back to symbol");
  } finally {
    restoreFinnhub();
  }

  let twelveDataSymbol;
  const restoreTwelveData = stubFetch((url) => {
    twelveDataSymbol = url.searchParams.get("symbol");
    return {
      meta: { exchange_timezone: "America/New_York" },
      status: "ok",
      values: [{ datetime: "2026-09-15 09:31:00", open: "1", high: "1", low: "1", close: "1" }],
    };
  });
  try {
    await withEnv("TWELVE_DATA_API_KEY", "test-key", () => twelveData.getTwelveDataMarketBars(withOverride, "D"));
    assert.equal(twelveDataSymbol, "TICKERMAP-VENDOR", "a set equityTicker must resolve to IT, not the on-chain symbol");
    await withEnv("TWELVE_DATA_API_KEY", "test-key", () => twelveData.getTwelveDataMarketBars(withoutOverride, "D"));
    assert.equal(twelveDataSymbol, "TICKERMAP-PLAIN", "a blank equityTicker must fall back to symbol");
  } finally {
    restoreTwelveData();
  }
});
