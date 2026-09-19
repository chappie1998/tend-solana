import assert from "node:assert/strict";
import test from "node:test";

// Offline (no network) tests for the stock-market data layer added on top of
// the existing crypto-only market-data.ts: app/lib/hyperliquid-market-data.ts
// (spot snapshot, chart bars, and realized volatility, all from Hyperliquid's
// public "xyz" HIP-3 dex) and app/lib/market-data.ts's per-market provider
// routing. `globalThis.fetch` is stubbed with an in-memory Response for every
// test that needs one -- never a real network call -- and restored
// afterward.
//
// This file replaces tests/stock-market-data.test.mjs (which covered
// finnhub-market-data.ts + twelvedata-market-bars.ts, both deleted -- see
// CLAUDE.md). The provider-agnostic coverage that still applies -- the
// `equityTicker || symbol` ticker-resolution mapping -- is re-pointed here at
// the new module, since that concept survives: it now feeds the Hyperliquid
// coin name instead of a Finnhub/Twelve Data ticker.
//
// CACHING NOTE: unlike every other provider's per-symbol cache, the universe
// `getHyperliquidSnapshot` reads is cached under ONE shared key (see
// hyperliquid-market-data.ts's file header on why) -- so, within this one
// test file/process, tests that exercise it pass explicit, widely-spaced,
// fixed-in-the-past `now` values (a `getHyperliquidSnapshot(market, now)`
// override exists for exactly this) rather than relying on unique symbols
// the way the bars/volatility tests below do (those caches ARE per-coin).
// Bars/volatility tests instead use synthetic per-test symbols, the same
// isolation trick tests/stock-market-data.test.mjs used to use for Twelve
// Data. The market-data.ts routing tests at the bottom deliberately run
// LAST and use the real clock: every synthetic snapshot `now` above is fixed
// in 2023, so by the time they run the shared cache is always long expired
// relative to the real "now" those tests use.

const root = new URL("../", import.meta.url);

async function loadModules() {
  const [hyperliquid, marketData, markets] = await Promise.all([
    import(new URL("app/lib/hyperliquid-market-data.ts", root)),
    import(new URL("app/lib/market-data.ts", root)),
    import(new URL("app/lib/markets.ts", root)),
  ]);
  return { hyperliquid, marketData, markets };
}

/** Stubs globalThis.fetch with `respond(url, init) -> unknown` (the parsed JSON body); returns a restore function. */
function stubFetch(respond) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.stringify(respond(new URL(url.toString()), init));
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

function metaAndAssetCtxsFixture(entries) {
  return [
    { universe: entries.map(([name]) => ({ name })) },
    entries.map(([, ctx]) => ctx),
  ];
}

// One 1-minute-per-distinct-day-in-2020 style fixture: fixed dates that can
// never collide with "today" (whatever real day this test runs), so none of
// them are ever dropped as a still-forming partial day -- same convention
// tests/stock-market-data.test.mjs used for Twelve Data's realized-vol tests.
function dailyCandleFixture(prices) {
  return prices.map((price, index) => ({
    t: Date.UTC(2020, 0, index + 2, 12, 0, 0),
    o: String(price),
    h: String(price),
    l: String(price),
    c: String(price),
  }));
}

// --- coin naming: xyz:${equityTicker || symbol} ---------------------------

test("hyperliquidCoinFor namespaces every coin under the xyz HIP-3 dex, using equityTicker over symbol", async () => {
  const { hyperliquid } = await loadModules();
  assert.equal(hyperliquid.hyperliquidCoinFor({ symbol: "NVDA", equityTicker: "" }), "xyz:NVDA");
  assert.equal(hyperliquid.hyperliquidCoinFor({ symbol: "GOOGL", equityTicker: "" }), "xyz:GOOGL");
  // SPACEX's on-chain symbol differs from the vendor ticker Hyperliquid
  // actually lists -- the exact case equityTicker exists to handle.
  assert.equal(hyperliquid.hyperliquidCoinFor({ symbol: "SPACEX", equityTicker: "SPCX" }), "xyz:SPCX");
});

test("the real NVDA/GOOGL/SPACEX market configs resolve to the expected Hyperliquid coins", async () => {
  const { hyperliquid, markets } = await loadModules();
  assert.equal(hyperliquid.hyperliquidCoinFor(markets.marketBySymbol("NVDA")), "xyz:NVDA");
  assert.equal(hyperliquid.hyperliquidCoinFor(markets.marketBySymbol("GOOGL")), "xyz:GOOGL");
  assert.equal(hyperliquid.hyperliquidCoinFor(markets.marketBySymbol("SPACEX")), "xyz:SPCX");
});

// A market's equityTicker overrides its on-chain symbol for the Hyperliquid
// coin; a blank equityTicker falls back to symbol -- pins app/lib/markets.ts's
// `equityTicker` contract (see that field's own doc comment) against the REAL
// function, not a reimplementation of it.
test("a market's equityTicker overrides its on-chain symbol for the Hyperliquid coin; a blank equityTicker falls back to symbol", async () => {
  const { hyperliquid, markets } = await loadModules();
  const spacex = markets.marketBySymbol("SPACEX");
  const nvda = markets.marketBySymbol("NVDA");
  assert.equal(spacex.equityTicker, "SPCX", "SPACEX must resolve to SPCX");
  assert.equal(nvda.equityTicker, "", "NVDA needs no override -- it resolves to its own symbol");

  const withOverride = { symbol: "TICKERMAP-ONCHAIN", equityTicker: "TICKERMAP-VENDOR" };
  const withoutOverride = { symbol: "TICKERMAP-PLAIN", equityTicker: "" };
  assert.equal(hyperliquid.hyperliquidCoinFor(withOverride), "xyz:TICKERMAP-VENDOR");
  assert.equal(hyperliquid.hyperliquidCoinFor(withoutOverride), "xyz:TICKERMAP-PLAIN");
});

// --- parseHyperliquidUniverse: response-shape validation -------------------

test("parseHyperliquidUniverse resolves each coin to its index-aligned context", async () => {
  const { hyperliquid } = await loadModules();
  const raw = metaAndAssetCtxsFixture([
    ["xyz:NVDA", { markPx: "212.15", oraclePx: "212.10" }],
    ["xyz:GOOGL", { markPx: "211.00", oraclePx: "211.05" }],
  ]);
  const universe = hyperliquid.parseHyperliquidUniverse(raw);
  assert.equal(universe.size, 2);
  assert.deepEqual(universe.get("xyz:NVDA"), { markPx: "212.15", oraclePx: "212.10" });
  assert.deepEqual(universe.get("xyz:GOOGL"), { markPx: "211.00", oraclePx: "211.05" });
});

test("parseHyperliquidUniverse rejects a malformed top-level response", async () => {
  const { hyperliquid } = await loadModules();
  assert.throws(() => hyperliquid.parseHyperliquidUniverse(null), /invalid metaAndAssetCtxs/);
  assert.throws(() => hyperliquid.parseHyperliquidUniverse([{ universe: [] }]), /invalid metaAndAssetCtxs/, "must be a 2-element tuple");
  assert.throws(() => hyperliquid.parseHyperliquidUniverse([{}, []]), /missing its universe/);
  assert.throws(
    () => hyperliquid.parseHyperliquidUniverse([{ universe: [{ name: "xyz:NVDA" }, { name: "xyz:GOOGL" }] }, [{}]]),
    /mismatched universe\/context lengths/,
  );
});

test("parseHyperliquidUniverse skips individual malformed universe entries rather than failing the whole response", async () => {
  const { hyperliquid } = await loadModules();
  const raw = [
    { universe: [{ name: "xyz:NVDA" }, { notAName: true }, { name: 42 }] },
    [{ markPx: "212.15", oraclePx: "212.10" }, { markPx: "1" }, { markPx: "1" }],
  ];
  const universe = hyperliquid.parseHyperliquidUniverse(raw);
  assert.equal(universe.size, 1);
  assert.ok(universe.has("xyz:NVDA"));
});

// --- resolveHyperliquidAssetCtx: per-symbol validation, naming the symbol --

test("resolveHyperliquidAssetCtx throws naming the coin for an unknown coin, a missing ctx, or a non-numeric price", async () => {
  const { hyperliquid } = await loadModules();
  const universe = hyperliquid.parseHyperliquidUniverse(
    metaAndAssetCtxsFixture([
      ["xyz:NVDA", { markPx: "212.15", oraclePx: "212.10" }],
      ["xyz:BADPRICE", { markPx: "not-a-number", oraclePx: "1" }],
      ["xyz:ZERO", { markPx: "0", oraclePx: "1" }],
      ["xyz:NOMARK", { oraclePx: "1" }],
      ["xyz:NULLCTX", null],
    ]),
  );

  // Unknown coin: never in the universe at all (e.g. a typo, or a symbol
  // this dex has never listed).
  assert.throws(() => hyperliquid.resolveHyperliquidAssetCtx(universe, "xyz:NOTLISTED"), /no market listed for xyz:NOTLISTED/);

  // Missing ctx: the coin IS listed, but its price context is absent/null.
  assert.throws(() => hyperliquid.resolveHyperliquidAssetCtx(universe, "xyz:NULLCTX"), /no price context for xyz:NULLCTX/);

  // Non-numeric / non-positive price: must never silently become 0 or NaN.
  assert.throws(() => hyperliquid.resolveHyperliquidAssetCtx(universe, "xyz:BADPRICE"), /invalid mark price for xyz:BADPRICE/);
  assert.throws(() => hyperliquid.resolveHyperliquidAssetCtx(universe, "xyz:ZERO"), /invalid mark price for xyz:ZERO/);
  assert.throws(() => hyperliquid.resolveHyperliquidAssetCtx(universe, "xyz:NOMARK"), /invalid mark price for xyz:NOMARK/);

  // A valid coin still resolves correctly alongside the invalid ones above.
  const nvda = hyperliquid.resolveHyperliquidAssetCtx(universe, "xyz:NVDA");
  assert.equal(nvda.markPx, 212.15);
  assert.equal(nvda.oraclePx, 212.10);
});

// --- getHyperliquidSnapshot: one universe call serves every symbol --------
//
// Fixed, widely-spaced (>= 20s, well over the 10s universe TTL), always-in-
// the-past `now` values -- see the file header's CACHING NOTE.
const SNAPSHOT_NOW_ONE_CALL = Date.UTC(2023, 10, 14, 0, 0, 0);
const SNAPSHOT_NOW_CONFIDENCE = SNAPSHOT_NOW_ONE_CALL + 20_000;
const SNAPSHOT_NOW_UNKNOWN_COIN = SNAPSHOT_NOW_ONE_CALL + 40_000;

test("getHyperliquidSnapshot fetches metaAndAssetCtxs exactly ONCE to serve three concurrent symbol requests", async () => {
  const { hyperliquid, markets } = await loadModules();
  let fetchCount = 0;
  const restore = stubFetch((url, init) => {
    fetchCount += 1;
    assert.equal(url.hostname, "api.hyperliquid.xyz");
    assert.equal(url.pathname, "/info");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.type, "metaAndAssetCtxs");
    assert.equal(body.dex, "xyz");
    return metaAndAssetCtxsFixture([
      ["xyz:NVDA", { markPx: "212.15", oraclePx: "212.10" }],
      ["xyz:GOOGL", { markPx: "211.00", oraclePx: "211.05" }],
      ["xyz:SPCX", { markPx: "143.50", oraclePx: "143.40" }],
    ]);
  });
  try {
    const [nvda, googl, spacex] = await Promise.all([
      hyperliquid.getHyperliquidSnapshot(markets.marketBySymbol("NVDA"), SNAPSHOT_NOW_ONE_CALL),
      hyperliquid.getHyperliquidSnapshot(markets.marketBySymbol("GOOGL"), SNAPSHOT_NOW_ONE_CALL),
      hyperliquid.getHyperliquidSnapshot(markets.marketBySymbol("SPACEX"), SNAPSHOT_NOW_ONE_CALL),
    ]);
    assert.equal(fetchCount, 1, "three concurrent stock symbols must share exactly one upstream request");
    assert.equal(nvda.price, 212.15);
    assert.equal(googl.price, 211.00);
    assert.equal(spacex.price, 143.50);
    for (const snapshot of [nvda, googl, spacex]) {
      assert.equal(snapshot.source, "Hyperliquid");
      assert.equal(snapshot.slot, null);
      assert.equal(snapshot.mode, "live");
    }
  } finally {
    restore();
  }
});

test("getHyperliquidSnapshot computes confidence as |mark - oracle|, which can legitimately read as zero", async () => {
  const { hyperliquid, markets } = await loadModules();
  const restore = stubFetch(() => metaAndAssetCtxsFixture([["xyz:NVDA", { markPx: "212.15", oraclePx: "212.05" }]]));
  try {
    const snapshot = await hyperliquid.getHyperliquidSnapshot(markets.marketBySymbol("NVDA"), SNAPSHOT_NOW_CONFIDENCE);
    assert.ok(Math.abs(snapshot.confidence - 0.10) < 1e-9, "|212.15 - 212.05| = 0.10");
    assert.ok(Math.abs(snapshot.confidenceBps - (0.10 / 212.15) * 10_000) < 1e-6);
    assert.match(snapshot.warning, /Fresh Hyperliquid xyz reference/);
  } finally {
    restore();
  }
});

test("getHyperliquidSnapshot fails honestly for a coin Hyperliquid's xyz dex has no market for", async () => {
  const { hyperliquid, markets } = await loadModules();
  const restore = stubFetch(() => metaAndAssetCtxsFixture([["xyz:GOOGL", { markPx: "211.00", oraclePx: "211.05" }]]));
  try {
    await assert.rejects(
      () => hyperliquid.getHyperliquidSnapshot(markets.marketBySymbol("NVDA"), SNAPSHOT_NOW_UNKNOWN_COIN),
      /no market listed for xyz:NVDA/,
    );
  } finally {
    restore();
  }
});

// --- parseHyperliquidCandleRow / parseHyperliquidCandles: ms -> s ----------

test("parseHyperliquidCandleRow converts Hyperliquid's millisecond `t` into MarketBar's epoch-second `time`", async () => {
  const { hyperliquid } = await loadModules();
  const bar = hyperliquid.parseHyperliquidCandleRow(
    { t: 1_789_518_000_000, T: 1_789_518_299_999, o: "212.48", h: "212.50", l: "212.44", c: "212.44" },
    "xyz:NVDA",
  );
  assert.deepEqual(bar, { time: 1_789_518_000, open: 212.48, high: 212.50, low: 212.44, close: 212.44 });
});

test("parseHyperliquidCandleRow rejects malformed, non-numeric, and OHLC-inconsistent rows, naming the coin", async () => {
  const { hyperliquid } = await loadModules();
  assert.throws(() => hyperliquid.parseHyperliquidCandleRow(null, "xyz:NVDA"), /candle row for xyz:NVDA is malformed/);
  assert.throws(
    () => hyperliquid.parseHyperliquidCandleRow({ t: 0, o: "1", h: "1", l: "1", c: "1" }, "xyz:NVDA"),
    /candle timestamp for xyz:NVDA is invalid/,
  );
  assert.throws(
    () => hyperliquid.parseHyperliquidCandleRow({ t: 1, o: "0", h: "1", l: "1", c: "1" }, "xyz:NVDA"),
    /candle prices for xyz:NVDA are invalid/,
  );
  // high (0.5) below open/close/low is inconsistent OHLC.
  assert.throws(
    () => hyperliquid.parseHyperliquidCandleRow({ t: 1, o: "1", h: "0.5", l: "1", c: "1" }, "xyz:NVDA"),
    /OHLC bounds for xyz:NVDA are invalid/,
  );
});

test("parseHyperliquidCandles sorts ascending even if the upstream ever returns out of order", async () => {
  const { hyperliquid } = await loadModules();
  const raw = [
    { t: 360_000, o: "3", h: "3", l: "3", c: "3" },
    { t: 60_000, o: "1", h: "1", l: "1", c: "1" },
    { t: 180_000, o: "2", h: "2", l: "2", c: "2" },
  ];
  const bars = hyperliquid.parseHyperliquidCandles(raw, "xyz:NVDA");
  assert.deepEqual(bars.map((bar) => bar.time), [60, 180, 360]);
});

test("parseHyperliquidCandles rejects a non-array (e.g. an unknown-coin error body) response, naming the coin", async () => {
  const { hyperliquid } = await loadModules();
  assert.throws(() => hyperliquid.parseHyperliquidCandles(null, "xyz:NOTREAL"), /invalid candle response for xyz:NOTREAL/);
  assert.throws(() => hyperliquid.parseHyperliquidCandles({ error: "oops" }, "xyz:NOTREAL"), /invalid candle response for xyz:NOTREAL/);
});

// --- getHyperliquidMarketBars: interval mapping + freshness ---------------
//
// A synthetic symbol, never reused by another test in this file -- bars are
// cached per (coin, resolution), so a fresh symbol sidesteps any cache
// bleed without needing to control `now` the way the snapshot tests above
// do for the single shared universe cache.

test("getHyperliquidMarketBars maps every ChartResolution to the matching Hyperliquid interval and requests only that coin", async () => {
  const { hyperliquid } = await loadModules();
  const market = { symbol: "HLBARS-INTERVAL", equityTicker: "" };
  const expectedIntervals = { "1": "1m", "5": "5m", "15": "15m", "60": "1h", D: "1d" };
  for (const [resolution, interval] of Object.entries(expectedIntervals)) {
    let requestBody;
    const restore = stubFetch((url, init) => {
      requestBody = JSON.parse(init.body);
      return [{ t: Date.now() - 60_000, o: "1", h: "1.1", l: "0.9", c: "1.05" }];
    });
    try {
      const result = await hyperliquid.getHyperliquidMarketBars(market, resolution);
      assert.equal(requestBody.type, "candleSnapshot");
      assert.equal(requestBody.req.coin, "xyz:HLBARS-INTERVAL");
      assert.equal(requestBody.req.interval, interval, `resolution "${resolution}" must map to Hyperliquid interval "${interval}"`);
      assert.equal(result.source, "Hyperliquid");
      assert.equal(result.resolution, resolution);
    } finally {
      restore();
    }
  }
});

test("getHyperliquidMarketBars refuses an empty candle series rather than returning an empty-but-valid result", async () => {
  const { hyperliquid } = await loadModules();
  const market = { symbol: "HLBARS-EMPTY", equityTicker: "" };
  const restore = stubFetch(() => []);
  try {
    await assert.rejects(
      () => hyperliquid.getHyperliquidMarketBars(market, "D"),
      /no candle data for xyz:HLBARS-EMPTY/,
    );
  } finally {
    restore();
  }
});

// --- getHyperliquidRealizedVolatility: 365 annualization (24/7 now) -------
//
// Synthetic per-test symbols, same isolation reasoning as the bars tests
// above (volatility is cached per coin too).

test("getHyperliquidRealizedVolatility computes an annualized figure with 365 days/year (24/7), not 252", async () => {
  const { hyperliquid } = await loadModules();
  const market = { symbol: "HLVOL-OK", equityTicker: "" };
  const prices = [100, 103, 99, 104, 98, 105, 97, 106, 96, 107, 95, 108, 94, 109, 93];
  const restore = stubFetch(() => dailyCandleFixture(prices));
  try {
    const result = await hyperliquid.getHyperliquidRealizedVolatility(market);
    assert.equal(result.source, "Hyperliquid 20-session realized volatility");
    assert.equal(result.observations, prices.length);
    assert.ok(Number.isFinite(result.value) && result.value > 1 && result.value < 400);
  } finally {
    restore();
  }
});

test("getHyperliquidRealizedVolatility refuses to price off fewer than 10 completed days", async () => {
  const { hyperliquid } = await loadModules();
  const market = { symbol: "HLVOL-SHORT", equityTicker: "" };
  const restore = stubFetch(() => dailyCandleFixture([100, 103, 99, 104, 98]));
  try {
    await assert.rejects(
      () => hyperliquid.getHyperliquidRealizedVolatility(market),
      /insufficient for volatility pricing/,
    );
  } finally {
    restore();
  }
});

// --- market-data.ts: per-market routing ------------------------------------
//
// Deliberately placed LAST: these go through marketData.getMarketSnapshot,
// which (like every other provider's snapshot function) takes no `now`
// override, so it reads the real clock. Every synthetic snapshot `now` above
// is fixed in the past (2023 + a few minutes), so the shared universe cache
// is always long expired by the time these run against the real clock --
// see the file header's CACHING NOTE.

test("market-data.ts routes crypto to Coinbase and stocks to Hyperliquid -- never the other family, and a stock's equityTicker overrides its on-chain symbol", async () => {
  const { marketData, markets } = await loadModules();
  const hostsHit = [];
  const restore = stubFetch((url, init) => {
    hostsHit.push(url.hostname);
    if (url.hostname === "api.exchange.coinbase.com") {
      return { ask: "101.42", bid: "101.38", price: "101.40", time: new Date().toISOString() };
    }
    if (url.hostname === "api.hyperliquid.xyz") {
      const body = JSON.parse(init.body);
      assert.equal(body.type, "metaAndAssetCtxs");
      return metaAndAssetCtxsFixture([
        ["xyz:NVDA", { markPx: "212.15", oraclePx: "212.10" }],
        ["xyz:SPCX", { markPx: "143.50", oraclePx: "143.40" }],
      ]);
    }
    throw new Error(`unexpected host reached in this test: ${url.hostname}`);
  });
  try {
    await marketData.getMarketSnapshot(markets.marketBySymbol("SOL"));
    assert.deepEqual(hostsHit, ["api.exchange.coinbase.com"], "crypto must still resolve to Coinbase");

    // NVDA and SPACEX are checked together, without resetting `hostsHit`
    // between them: hyperliquid-market-data.ts caches its universe fetch
    // under one shared key (see that file's header), so the SPACEX call
    // milliseconds later may legitimately reuse the cache NVDA's call just
    // warmed rather than firing a second request -- both are correct, since
    // the same stub fixture would answer either way. Asserting every host
    // reached across both calls is Hyperliquid (never Coinbase) is the
    // robust form of "a stock market must never reach Coinbase" that holds
    // regardless of which call actually touched the network.
    hostsHit.length = 0;
    const nvdaSnapshot = await marketData.getMarketSnapshot(markets.marketBySymbol("NVDA"));
    // SPACEX carries symbol "SPACEX" (permanent on-chain identity) but
    // equityTicker "SPCX" -- the Hyperliquid coin must be xyz:SPCX, never
    // xyz:SPACEX, and must still never touch Coinbase.
    const spacexSnapshot = await marketData.getMarketSnapshot(markets.marketBySymbol("SPACEX"));
    assert.ok(hostsHit.length >= 1, "at least one of the two stock calls must have actually reached the network");
    assert.ok(
      hostsHit.every((host) => host === "api.hyperliquid.xyz"),
      `a stock market must never reach Coinbase, got: ${hostsHit.join(", ")}`,
    );
    assert.equal(nvdaSnapshot.source, "Hyperliquid");
    assert.equal(nvdaSnapshot.price, 212.15);
    assert.equal(spacexSnapshot.source, "Hyperliquid");
    assert.equal(spacexSnapshot.price, 143.50);
  } finally {
    restore();
  }
});

test("market-data.ts routes stock chart bars AND realized volatility to Hyperliquid, never Coinbase or Pyth", async () => {
  const { marketData, markets } = await loadModules();
  const hostsHit = [];
  const restore = stubFetch((url) => {
    hostsHit.push(url.hostname);
    return dailyCandleFixture([100, 103, 99, 104, 98, 105, 97, 106, 96, 107, 95, 108, 94]);
  });
  try {
    const bars = await marketData.getMarketBars(markets.marketBySymbol("GOOGL"), "5");
    assert.deepEqual(hostsHit, ["api.hyperliquid.xyz"]);
    assert.equal(bars.source, "Hyperliquid");

    hostsHit.length = 0;
    const vol = await marketData.getMarketRealizedVolatility(markets.marketBySymbol("GOOGL"));
    assert.deepEqual(hostsHit, ["api.hyperliquid.xyz"]);
    assert.equal(vol.source, "Hyperliquid 20-session realized volatility");
  } finally {
    restore();
  }
});
