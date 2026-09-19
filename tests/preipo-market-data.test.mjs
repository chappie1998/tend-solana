import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";

// Offline (no network) tests for the pre-IPO tokenized-equity market-data
// layer: app/lib/preipo-market-data.ts (DexScreener spot + pair selection,
// GeckoTerminal chart bars off that same pool, realized volatility derived
// from those bars) and app/lib/market-data.ts's routing of category
// "pre-ipo" to it. `globalThis.fetch` is stubbed with an in-memory Response
// for every test that needs one -- never a real network call -- and
// restored afterward. Modeled directly on
// tests/hyperliquid-market-data.test.mjs's structure and conventions.

const root = new URL("../", import.meta.url);

async function loadModules() {
  const [preIpo, marketData, markets] = await Promise.all([
    import(new URL("app/lib/preipo-market-data.ts", root)),
    import(new URL("app/lib/market-data.ts", root)),
    import(new URL("app/lib/markets.ts", root)),
  ]);
  return { preIpo, marketData, markets };
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

// A real mint from the catalog, used across most tests below.
const REAL_MINT = "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw"; // PANTHROPIC

/**
 * The SPL mint a pre-IPO market is keyed to, read back out of `pythFeedId`
 * (which carries the mint as 32-byte on-chain identity for this category --
 * see app/lib/markets.ts). Fixtures build their `baseToken.address` from this
 * rather than hardcoding one mint, because the pair filter requires our token
 * to be the BASE: a fixture carrying the wrong mint is silently rejected and
 * the test then fails for a reason that has nothing to do with what it checks.
 */
function mintOf(markets, symbol) {
  return new PublicKey(Buffer.from(markets.marketBySymbol(symbol).pythFeedId, "hex")).toBase58();
}

function dexPair(overrides = {}) {
  return {
    chainId: "solana",
    baseToken: { address: REAL_MINT, symbol: "ANTHROPIC" },
    quoteToken: { symbol: "USDC" },
    priceUsd: "1007.53",
    pairAddress: "9thgWVMJUKiiotrVmzhEy1MWPyvkNsUSwKbp8ZFsuhA2",
    liquidity: { usd: 45695.54 },
    volume: { h24: 100000 },
    txns: { h1: { buys: 10, sells: 5 } },
    priceChange: { h1: 0.5 },
    ...overrides,
  };
}

function dexscreenerFixture(pairs) {
  return { pairs };
}


// --- selectPreIpoPair: the CRITICAL base-token/quote-symbol filter --------

test("selectPreIpoPair rejects a pair where our token is the QUOTE side (the BUTTHOLE/ANTHROPIC shape) and picks the correct USDC pair instead", async () => {
  const { preIpo } = await loadModules();
  const raw = dexscreenerFixture([
    // Our token is the QUOTE here -- must be excluded even though its
    // listed liquidity is far higher than the legitimate pair below. This is
    // the exact shape verified live against PANTHROPIC's real mint: a
    // BUTTHOLE/ANTHROPIC pair with $282k of liquidity where ANTHROPIC's
    // priceUsd would be BUTTHOLE's price, not this token's.
    dexPair({
      baseToken: { address: "ButtholeMintNotOurs11111111111111111111111", symbol: "BUTTHOLE" },
      quoteToken: { symbol: "ANTHROPIC" },
      priceUsd: "0.001894",
      liquidity: { usd: 282611.65 },
      pairAddress: "HX72xZ1CHg7cWPhGGJyHbLp3sLrpznTYmWn5AY3FVwUj",
    }),
    // A meme coin quoted in a non-qualifying "quote" that happens to also
    // name our mint as base -- still excluded, since AGI is not USDC/USDT/SOL.
    dexPair({ quoteToken: { symbol: "AGI" }, priceUsd: "0.0007265", liquidity: { usd: 125752.55 }, pairAddress: "wrong-quote-symbol" }),
    // The correct pair: our mint as BASE, quoted in USDC.
    dexPair({ priceUsd: "1007.53", liquidity: { usd: 45695.54 }, pairAddress: "9thgWVMJUKiiotrVmzhEy1MWPyvkNsUSwKbp8ZFsuhA2" }),
  ]);
  const pair = preIpo.selectPreIpoPair(raw, REAL_MINT, "PANTHROPIC");
  assert.equal(pair.priceUsd, 1007.53);
  assert.equal(pair.pairAddress, "9thgWVMJUKiiotrVmzhEy1MWPyvkNsUSwKbp8ZFsuhA2");
  assert.equal(pair.quoteSymbol, "USDC");
});

test("selectPreIpoPair picks the HIGHEST-liquidity qualifying pair among several, not just the first one", async () => {
  const { preIpo } = await loadModules();
  const raw = dexscreenerFixture([
    dexPair({ priceUsd: "1028.42", liquidity: { usd: 36420.09 }, pairAddress: "lower-liquidity-usdc" }),
    dexPair({ priceUsd: "985.073", liquidity: { usd: 176061.27 }, quoteToken: { symbol: "SOL" }, pairAddress: "highest-liquidity-sol" }),
    dexPair({ priceUsd: "1010.88", liquidity: { usd: 9198.16 }, pairAddress: "lowest-liquidity-usdc" }),
  ]);
  const pair = preIpo.selectPreIpoPair(raw, REAL_MINT, "PANTHROPIC");
  assert.equal(pair.pairAddress, "highest-liquidity-sol");
  assert.equal(pair.priceUsd, 985.073);
  assert.equal(pair.quoteSymbol, "SOL");
});

test("selectPreIpoPair rejects when no qualifying pair exists, naming the symbol", async () => {
  const { preIpo } = await loadModules();
  // Only pairs where our token is the quote, or the base is some other mint.
  const noBaseMatch = dexscreenerFixture([
    dexPair({ quoteToken: { symbol: "ANTHROPIC" }, baseToken: { address: "SomeOtherMint1111111111111111111111111111", symbol: "BUTTHOLE" } }),
  ]);
  assert.throws(() => preIpo.selectPreIpoPair(noBaseMatch, REAL_MINT, "PANTHROPIC"), /no qualifying USDC\/USDT\/SOL pair for PANTHROPIC/);

  const wrongQuote = dexscreenerFixture([dexPair({ quoteToken: { symbol: "AGI" } })]);
  assert.throws(() => preIpo.selectPreIpoPair(wrongQuote, REAL_MINT, "PANTHROPIC"), /no qualifying USDC\/USDT\/SOL pair for PANTHROPIC/);

  // No pairs at all for the mint.
  assert.throws(() => preIpo.selectPreIpoPair(dexscreenerFixture([]), REAL_MINT, "PANTHROPIC"), /no listed pairs for PANTHROPIC/);
  assert.throws(() => preIpo.selectPreIpoPair({ pairs: null }, REAL_MINT, "PANTHROPIC"), /no listed pairs for PANTHROPIC/);
  assert.throws(() => preIpo.selectPreIpoPair(null, REAL_MINT, "PANTHROPIC"), /invalid response for PANTHROPIC/);
});

test("selectPreIpoPair rejects a qualifying pair with a non-numeric or non-positive price, naming the symbol", async () => {
  const { preIpo } = await loadModules();
  const badPrice = dexscreenerFixture([dexPair({ priceUsd: "not-a-number" })]);
  assert.throws(() => preIpo.selectPreIpoPair(badPrice, REAL_MINT, "PANTHROPIC"), /invalid price for PANTHROPIC/);

  const zeroPrice = dexscreenerFixture([dexPair({ priceUsd: "0" })]);
  assert.throws(() => preIpo.selectPreIpoPair(zeroPrice, REAL_MINT, "PANTHROPIC"), /invalid price for PANTHROPIC/);
});

test("selectPreIpoPair reads volume/txns/priceChange defensively, defaulting missing fields rather than throwing", async () => {
  const { preIpo } = await loadModules();
  const raw = dexscreenerFixture([
    dexPair({ volume: undefined, txns: undefined, priceChange: undefined }),
  ]);
  const pair = preIpo.selectPreIpoPair(raw, REAL_MINT, "PANTHROPIC");
  assert.equal(pair.volumeH24, 0);
  assert.equal(pair.txnsH1, 0);
  assert.equal(pair.priceChangeH1, 0);
});

// --- getPreIpoSnapshot: one DexScreener call serves repeated requests ------

const SNAPSHOT_NOW = Date.UTC(2023, 10, 14, 0, 0, 0);

test("getPreIpoSnapshot fetches DexScreener exactly ONCE to serve concurrent requests for the same mint", async () => {
  const { preIpo, markets } = await loadModules();
  let fetchCount = 0;
  const restore = stubFetch((url) => {
    fetchCount += 1;
    assert.equal(url.hostname, "api.dexscreener.com");
    assert.match(url.pathname, /\/latest\/dex\/tokens\//);
    return dexscreenerFixture([dexPair()]);
  });
  try {
    const market = markets.marketBySymbol("PANTHROPIC");
    const [a, b, c] = await Promise.all([
      preIpo.getPreIpoSnapshot(market, SNAPSHOT_NOW),
      preIpo.getPreIpoSnapshot(market, SNAPSHOT_NOW),
      preIpo.getPreIpoSnapshot(market, SNAPSHOT_NOW),
    ]);
    assert.equal(fetchCount, 1, "three concurrent requests for the same mint must share exactly one upstream request");
    for (const snapshot of [a, b, c]) {
      assert.equal(snapshot.price, 1007.53);
      assert.equal(snapshot.source, "DEX (Solana)");
      assert.equal(snapshot.slot, null);
      assert.equal(snapshot.mode, "live");
    }
  } finally {
    restore();
  }
});

test("getPreIpoSnapshot's confidence is a liquidity-implied price-impact estimate, not a hardcoded number", async () => {
  const { preIpo, markets } = await loadModules();
  const restore = stubFetch(() => dexscreenerFixture([dexPair({ priceUsd: "1000", liquidity: { usd: 100_000 } })]));
  try {
    const market = markets.marketBySymbol("PANTHROPIC");
    const snapshot = await preIpo.getPreIpoSnapshot(market, SNAPSHOT_NOW + 60_000);
    // REFERENCE_TRADE_USD ($1,000) / $100,000 liquidity = 1% impact fraction.
    assert.ok(Math.abs(snapshot.confidenceBps - 100) < 1e-6, `expected ~100bps, got ${snapshot.confidenceBps}`);
    assert.ok(Math.abs(snapshot.confidence - 10) < 1e-6, `expected confidence ~$10 (1% of $1000), got ${snapshot.confidence}`);
    assert.match(snapshot.warning, /price impact/);
  } finally {
    restore();
  }
});

test("getPreIpoSnapshot fails honestly (naming the symbol) when DexScreener has no pair for this mint", async () => {
  const { preIpo, markets } = await loadModules();
  const restore = stubFetch(() => dexscreenerFixture([]));
  try {
    const market = markets.marketBySymbol("TOPENAI");
    await assert.rejects(() => preIpo.getPreIpoSnapshot(market, SNAPSHOT_NOW + 120_000), /no listed pairs for TOPENAI/);
  } finally {
    restore();
  }
});

// --- parseGeckoTerminalOhlcv: ohlcv_list -> MarketBar, newest-first -> ascending

test("parseGeckoTerminalOhlcv maps ohlcv_list rows to MarketBar and reorders newest-first into ascending", async () => {
  const { preIpo } = await loadModules();
  // Newest-first, as GeckoTerminal actually returns it (verified live).
  const raw = {
    data: {
      attributes: {
        ohlcv_list: [
          [300, 3, 3.1, 2.9, 3.05, 500],
          [200, 2, 2.2, 1.9, 2.1, 400],
          [100, 1, 1.1, 0.9, 1.05, 300],
        ],
      },
    },
  };
  const bars = preIpo.parseGeckoTerminalOhlcv(raw, "pool-address");
  assert.deepEqual(bars.map((bar) => bar.time), [100, 200, 300], "must be re-sorted ascending, not left newest-first");
  assert.deepEqual(bars[0], { time: 100, open: 1, high: 1.1, low: 0.9, close: 1.05 });
});

test("parseGeckoTerminalOhlcv rejects malformed, non-numeric, and OHLC-inconsistent rows, naming the pool", async () => {
  const { preIpo } = await loadModules();
  assert.throws(() => preIpo.parseGeckoTerminalOhlcv(null, "pool-x"), /invalid OHLCV response for pool pool-x/);
  assert.throws(() => preIpo.parseGeckoTerminalOhlcv({}, "pool-x"), /no ohlcv_list for pool pool-x/);
  assert.throws(
    () => preIpo.parseGeckoTerminalOhlcv({ data: { attributes: { ohlcv_list: [[1, 2]] } } }, "pool-x"),
    /malformed/,
  );
  assert.throws(
    () => preIpo.parseGeckoTerminalOhlcv({ data: { attributes: { ohlcv_list: [[1, "1", 1, 1, 1]] } } }, "pool-x"),
    /must be numbers/,
  );
  assert.throws(
    () => preIpo.parseGeckoTerminalOhlcv({ data: { attributes: { ohlcv_list: [[1, 0, 1, 1, 1]] } } }, "pool-x"),
    /prices for pool pool-x are invalid/,
  );
  // high (0.5) below open/close/low is inconsistent OHLC.
  assert.throws(
    () => preIpo.parseGeckoTerminalOhlcv({ data: { attributes: { ohlcv_list: [[1, 1, 0.5, 1, 1]] } } }, "pool-x"),
    /bounds for pool pool-x are invalid/,
  );
});

// --- getPreIpoMarketBars: reuses the pair cache's pool address ------------

test("getPreIpoMarketBars requests GeckoTerminal for the SAME pool DexScreener selected, and maps the timeframe", async () => {
  const { preIpo, markets } = await loadModules();
  const market = markets.marketBySymbol("PNEURALINK");
  let dexScreenerHits = 0;
  let geckoTerminalUrl = null;
  const restore = stubFetch((url) => {
    if (url.hostname === "api.dexscreener.com") {
      dexScreenerHits += 1;
      return dexscreenerFixture([dexPair({ pairAddress: "the-selected-pool", priceUsd: "392.13", liquidity: { usd: 71529.14 }, baseToken: { address: mintOf(markets, "PNEURALINK"), symbol: "PNEURALINK" } })]);
    }
    if (url.hostname === "api.geckoterminal.com") {
      geckoTerminalUrl = url;
      return { data: { attributes: { ohlcv_list: [[Math.floor(Date.now() / 1000) - 300, 1, 1.1, 0.9, 1.05, 10]] } } };
    }
    throw new Error(`unexpected host: ${url.hostname}`);
  });
  try {
    const bars = await preIpo.getPreIpoMarketBars(market, "60", SNAPSHOT_NOW + 180_000);
    assert.equal(dexScreenerHits, 1);
    assert.match(geckoTerminalUrl.pathname, /\/pools\/the-selected-pool\/ohlcv\/hour$/);
    assert.equal(geckoTerminalUrl.searchParams.get("aggregate"), "1");
    assert.equal(bars.source, "DEX (Solana)");
    assert.equal(bars.symbol, "PNEURALINK");
  } finally {
    restore();
  }
});

test("getPreIpoMarketBars maps every ChartResolution to GeckoTerminal's timeframe/aggregate", async () => {
  const { preIpo, markets } = await loadModules();
  const market = markets.marketBySymbol("PFIGUREAI");
  const expected = { "1": ["minute", "1"], "5": ["minute", "5"], "15": ["minute", "15"], "60": ["hour", "1"], D: ["day", "1"] };
  let now = SNAPSHOT_NOW + 500_000;
  for (const [resolution, [timeframe, aggregate]] of Object.entries(expected)) {
    now += 10_000;
    let geckoTerminalUrl = null;
    const restore = stubFetch((url) => {
      if (url.hostname === "api.dexscreener.com") return dexscreenerFixture([dexPair({ pairAddress: `pool-for-${resolution}`, baseToken: { address: mintOf(markets, "PFIGUREAI"), symbol: "PFIGUREAI" } })]);
      geckoTerminalUrl = url;
      return { data: { attributes: { ohlcv_list: [[Math.floor(now / 1000) - 60, 1, 1.1, 0.9, 1.05, 10]] } } };
    });
    try {
      await preIpo.getPreIpoMarketBars(market, resolution, now);
      assert.match(geckoTerminalUrl.pathname, new RegExp(`/ohlcv/${timeframe}$`), `resolution "${resolution}"`);
      assert.equal(geckoTerminalUrl.searchParams.get("aggregate"), aggregate, `resolution "${resolution}"`);
    } finally {
      restore();
    }
  }
});

test("getPreIpoMarketBars refuses an empty candle series rather than returning an empty-but-valid result", async () => {
  const { preIpo, markets } = await loadModules();
  const market = markets.marketBySymbol("TSPACEX");
  const restore = stubFetch((url) => {
    if (url.hostname === "api.dexscreener.com") return dexscreenerFixture([dexPair({ pairAddress: "empty-bars-pool", baseToken: { address: mintOf(markets, "TSPACEX"), symbol: "TSPACEX" } })]);
    return { data: { attributes: { ohlcv_list: [] } } };
  });
  try {
    await assert.rejects(() => preIpo.getPreIpoMarketBars(market, "D", SNAPSHOT_NOW + 700_000), /no chart data for TSPACEX/);
  } finally {
    restore();
  }
});

// --- market-data.ts: routing ------------------------------------------

test("market-data.ts routes every pre-IPO market to the DEX provider, never Coinbase, Hyperliquid, or Pyth -- for snapshot, bars, and realized volatility alike", async () => {
  const { marketData, markets } = await loadModules();
  const market = markets.marketBySymbol("TOPENAI");
  const hostsHit = [];
  const restore = stubFetch((url) => {
    hostsHit.push(url.hostname);
    if (url.hostname === "api.dexscreener.com") return dexscreenerFixture([dexPair({ pairAddress: "routing-pool", baseToken: { address: mintOf(markets, "TOPENAI"), symbol: "TOPENAI" } })]);
    if (url.hostname === "api.geckoterminal.com") {
      // 15 days of daily bars, with enough real variance to land the
      // annualized figure inside [1, 400] -- same fixture prices
      // tests/hyperliquid-market-data.test.mjs uses for the same reason.
      const prices = [100, 103, 99, 104, 98, 105, 97, 106, 96, 107, 95, 108, 94, 109, 93];
      return {
        data: {
          attributes: {
            ohlcv_list: prices.map((p, i) => [Date.UTC(2020, 0, i + 2) / 1000, p, p, p, p, 1]).reverse(),
          },
        },
      };
    }
    throw new Error(`market-data.ts routed a pre-IPO market to an unexpected host: ${url.hostname}`);
  });
  try {
    const snapshot = await marketData.getMarketSnapshot(market);
    assert.equal(snapshot.source, "DEX (Solana)");

    const bars = await marketData.getMarketBars(market, "D");
    assert.equal(bars.source, "DEX (Solana)");

    const vol = await marketData.getMarketRealizedVolatility(market);
    assert.equal(vol.source, "DEX (Solana) 20-session realized volatility");

    assert.ok(hostsHit.length > 0);
    assert.ok(
      hostsHit.every((host) => host === "api.dexscreener.com" || host === "api.geckoterminal.com"),
      `a pre-IPO market must never reach Coinbase/Hyperliquid/Pyth, got: ${hostsHit.join(", ")}`,
    );
  } finally {
    restore();
  }
});

// --- markets.ts wiring: every pre-IPO market's identity is well-formed ---

test("every pre-IPO market carries a 64-hex pythFeedId equal to its own mint's hex, an empty pythSymbol, and intradayEligible === false", async () => {
  const { markets } = await loadModules();
  const preIpoMarkets = markets.markets.filter((market) => market.category === "pre-ipo");
  assert.equal(preIpoMarkets.length, 7, "exactly seven pre-IPO markets are configured");
  const mints = new Set();
  for (const market of preIpoMarkets) {
    assert.match(market.pythFeedId, /^[0-9a-f]{64}$/, `${market.symbol}'s pythFeedId must be 64 hex chars`);
    assert.equal(market.pythSymbol, "", `${market.symbol} must not carry an invented Pyth-shaped symbol`);
    assert.equal(market.intradayEligible, false, `${market.symbol} must not be intraday-eligible`);
    assert.equal(market.coinbaseProductId, "", `${market.symbol} does not trade on Coinbase`);
    assert.equal(market.status, "live", `${market.symbol} must be tradable`);

    const mint = markets.preIpoMintFor(market);
    assert.equal(new PublicKey(mint).toBuffer().toString("hex"), market.pythFeedId);
    assert.ok(!mints.has(mint), `${market.symbol}'s mint must be unique among pre-IPO markets`);
    mints.add(mint);
  }
});

test("preIpoMintFor refuses a non-pre-IPO market and a malformed pythFeedId", async () => {
  const { markets } = await loadModules();
  const sol = markets.marketBySymbol("SOL");
  assert.throws(() => markets.preIpoMintFor(sol), /is not a pre-IPO market/);
  assert.throws(
    () => markets.preIpoMintFor({ symbol: "FAKE", category: "pre-ipo", pythFeedId: "not-hex" }),
    /not a valid 64-hex-character mint encoding/,
  );
});
