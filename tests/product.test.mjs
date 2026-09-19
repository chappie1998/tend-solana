import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withSyntheticComingSoonMarket } from "./helpers/synthetic-coming-soon-market.mjs";

const root = new URL("../", import.meta.url);

test("ships the VSOL trading surface with honest devnet labels", async () => {
  const [terminal, walletHelper, markets, chart, chartRoute, chartData, layout] = await Promise.all([
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    readFile(new URL("app/lib/solana-wallet.ts", root), "utf8"),
    readFile(new URL("app/lib/markets.ts", root), "utf8"),
    readFile(new URL("app/components/TradingViewMarketChart.tsx", root), "utf8"),
    readFile(new URL("app/api/market-bars/route.ts", root), "utf8"),
    readFile(new URL("app/lib/pyth-market-bars.ts", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);

  // The always-on "everything is verified" banner is gone: it sat at the top of
  // the trading surface restating a healthy state that needs no action. What
  // has to survive is the EXCEPTION -- VsolStatus now renders only once
  // execution is degraded -- so pin those labels, and assert the healthy
  // banner stays gone so a revert cannot quietly reinstate the noise.
  assert.match(terminal, /Execution unavailable/);
  assert.match(terminal, /Settlement upgrade pending/);
  assert.doesNotMatch(terminal, /VSOL V2 pool \+ Pyth series verified/);
  assert.match(terminal, /Execute on Solana devnet/);
  assert.match(terminal, /mock tUSDC/);
  assert.match(terminal, /centrally signed Coinbase or Hyperliquid reference/);
  assert.match(layout, /metadataBase: new URL\("https:\/\/solana\.usetend\.xyz"\)/);
  // Wallet connection + signing go through the wallet-adapter-backed bridge
  // (see app/lib/wallet-bridge.tsx), not the legacy injected-wallet helper
  // this used to call directly -- that helper is kept only for
  // tests/vsol-versioned-fill.test.mjs's legacy/v0 round-trip coverage.
  assert.match(terminal, /bridge\.signTransactionBase64/);
  assert.match(walletHelper, /signTransaction/);
  assert.doesNotMatch(terminal, /"Devnet confirmed"/);
  assert.match(chart, /lightweight-charts/);
  assert.match(chart, /CandlestickSeries/);
  assert.match(chart, /ResizeObserver/);
  assert.match(chart, /\/api\/market-bars/);
  assert.match(chart, /Charts by TradingView/);
  assert.doesNotMatch(chart, /embed-widget-advanced-chart|document\.createElement\("script"\)|<iframe|DEMO DATA|demoCandles/i);
  assert.match(chartRoute, /getMarketBars/);
  // Pyth RETIRED the Benchmarks TradingView shim in the 2026-08-26 Core
  // upgrade; it now 404s. This assertion used to pin that dead URL, i.e. it
  // asserted the bug. Pin the live endpoint instead, and assert the retired
  // one is gone so a revert cannot pass.
  assert.match(chartData, /pyth\.dourolabs\.app\/v1\/fixed_rate@200ms\/history/);
  assert.doesNotMatch(chartData, /benchmarks\.pyth\.network\/v1\/shims\/tradingview/);
  assert.match(chartData, /runtimeEnv\("PYTH_API_KEY"\)/);
  assert.match(chartData, /AbortController/);
  assert.doesNotMatch(chartRoute, /PYTH_API_KEY|Authorization|Bearer/);
  assert.match(markets, /deployment\.underlyingMint/);
  // Crypto.SOL/USD -- the live devnet settlement feed. Pyth's schedule for it
  // is "O,O,O,O,O,O,O" (all seven days, no holiday closures), which is what a
  // 24/7 expiry grid requires. NOT Equity.US.NVDA/USD, whose 0930-1600
  // weekday schedule left ~80% of the grid settling on an already-known price.
  assert.match(markets, /ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d/);
  assert.match(markets, /Crypto\.SOL\/USD/);
  // Settlement and display must stay on the SAME feed: showing one price and
  // settling on another is the failure this pins against. Checked against the
  // pythSymbol FIELDS specifically, not the whole file -- the prose in
  // markets.ts legitimately names the equity feed when explaining why it is
  // not entitled here.
  const displaySymbols = [...markets.matchAll(/pythSymbol:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(displaySymbols, [
    "Crypto.SOL/USD",
    "Crypto.BTC/USD",
    "Crypto.ETH/USD",
    "Crypto.NVDAX/USD",
    "Crypto.GOOGLX/USD",
    "Equity.Index.SPCX/USD",
  ]);
  // Six markets, six feeds. SpaceX used to be the exception here -- it carried
  // an empty pythSymbol because it was a private company with no feed at all.
  // It IPO'd on NASDAQ 2026-06-12 (ticker SPCX) and Pyth publishes it, so that
  // exception is gone and the field is populated like every other market's.
  assert.equal(displaySymbols.length, 6);
  // The real rule this has always encoded is "no SESSION-BOUND equity feed":
  // Equity.US.* goes dark outside regular trading hours (the NVDA equity feed
  // was dark ~81% of the week, which is why nothing here binds one). It is NOT
  // "the string Equity is forbidden" -- Equity.Index.* is Pyth's explicitly
  // 24/7 price for the same ticker ("PYTH PRICE IN USD FOR SPCX 24/7"), which
  // is exactly what a round-the-clock grid needs. Pin the session-bound prefix
  // so widening this to Equity.US.* still fails.
  assert.ok(
    displaySymbols.every((symbol) => !symbol.startsWith("Equity.US.")),
    "no market may display a session-bound Equity.US.* feed",
  );
  assert.match(layout, /Solana devnet/);
});

test("validates real Pyth UDF candles before they reach the chart", async () => {
  const bars = await import(new URL("app/lib/market-bars.ts", root));
  const valid = {
    s: "ok",
    t: [1_700_000_000, 1_700_000_300],
    o: [200, 201],
    h: [202, 203],
    l: [199, 200],
    c: [201, 202],
  };
  assert.deepEqual(bars.parsePythUdfBars(valid), [
    { time: 1_700_000_000, open: 200, high: 202, low: 199, close: 201 },
    { time: 1_700_000_300, open: 201, high: 203, low: 200, close: 202 },
  ]);
  assert.equal(bars.isChartResolution("5"), true);
  assert.equal(bars.isChartResolution("2"), false);
  assert.throws(() => bars.parsePythUdfBars({ ...valid, c: [201] }), /mismatched lengths/);
  assert.throws(() => bars.parsePythUdfBars({ ...valid, t: [1_700_000_300, 1_700_000_000] }), /timestamps are invalid/);
  assert.throws(() => bars.parsePythUdfBars({ ...valid, h: [198, 203] }), /OHLC bounds are invalid/);
  assert.throws(() => bars.parsePythUdfBars({ ...valid, o: [true, 201] }), /must be numbers/);
  assert.throws(() => bars.parsePythUdfBars({ ...valid, s: "no_data" }), /no chart data/);
});

test("server creates buyer-bound V2 pool RFQs and verifies fills before persistence", async () => {
  const [quotesRoute, positionsRoute, sendRoute, server, schema, runtimeEnv] = await Promise.all([
    readFile(new URL("app/api/quotes/route.ts", root), "utf8"),
    readFile(new URL("app/api/positions/route.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/send/route.ts", root), "utf8"),
    readFile(new URL("app/lib/vsol-server.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("app/lib/runtime-env.ts", root), "utf8"),
  ]);

  assert.match(quotesRoute, /buildVsolQuoteTransaction/);
  assert.match(quotesRoute, /VSOL_TEST_FUNDS_REQUIRED/);
  assert.match(quotesRoute, /VSOL_CUSTOM_SETTLEMENT_DEPLOYMENT_PENDING/);
  assert.match(server, /poolQuoteMessage/);
  assert.match(server, /nacl\.sign\.detached/);
  assert.match(server, /domainSeparator/);
  assert.match(server, /derivePoolNonce/);
  assert.match(sendRoute, /verifySignatures/);
  assert.match(sendRoute, /simulateTransaction/);
  assert.match(sendRoute, /sigVerify: true/);
  assert.match(sendRoute, /transactionSimulations/);
  assert.match(server, /runtimeEnv\("VSOL_RPC_URL"\)/);
  assert.match(server, /export function getVsolConnection/);
  assert.match(runtimeEnv, /configureRuntimeEnv/);
  assert.match(server, /Instruction: FillPoolQuote/);
  assert.match(server, /POOL_POSITION_ACCOUNT_DISCRIMINATOR/);
  assert.match(server, /FILL_POOL_QUOTE/);
  // Pool-market authorization is verified live on-chain — PDA derivation plus
  // program ownership plus the decoded pool/market bindings — never against a
  // checked-in manifest allowlist (which would reject any rung the keeper
  // authorized after the last bootstrap snapshot).
  assert.doesNotMatch(server, /authorizedMarketKeys/);
  assert.match(server, /derivePoolMarket\(VSOL_LIQUIDITY\.poolKey, series\.marketKey\)/);
  assert.match(server, /decodedPoolMarket\.pool\.equals\(VSOL_LIQUIDITY\.poolKey\)/);
  assert.match(server, /decodedPoolMarket\.market\.equals\(series\.marketKey\)/);
  assert.match(positionsRoute, /verifyVsolFill/);
  assert.match(positionsRoute, /db\.batch/);
  assert.match(positionsRoute, /persisted, passing simulation/);
  assert.match(positionsRoute, /innerJoin\(transactionSimulations/);
  assert.match(positionsRoute, /submissionStatus, "confirmed"/);
  assert.match(schema, /uniqueIndex\("positions_quote_unique_idx"\)/);
  assert.match(schema, /transaction_simulations/);
});

test("faucet is isolated to mock assets and same-origin calls", async () => {
  const [faucet, env, gitignore] = await Promise.all([
    readFile(new URL("app/api/vsol/faucet/route.ts", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
    readFile(new URL("vsol/.gitignore", root), "utf8"),
  ]);

  assert.match(faucet, /sameOrigin/);
  assert.match(faucet, /VSOL_SETTLEMENT_MINT/);
  assert.match(faucet, /mint\.mintAuthority.*faucet\.publicKey/);
  assert.match(env, /Never use a mainnet, admin, or personally funded wallet/);
  assert.doesNotMatch(env, /api-key=/);
  assert.match(gitignore, /\.devnet/);
});

test("program covers collateral, replay, signature, pause, and refund invariants", async () => {
  const source = await readFile(new URL("vsol/programs/vsol/src/lib.rs", root), "utf8");
  const pyth = await readFile(new URL("vsol/programs/vsol/src/pyth.rs", root), "utf8");
  const signature = await readFile(new URL("vsol/programs/vsol/src/signature.rs", root), "utf8");
  const math = await readFile(new URL("vsol/programs/vsol/src/math.rs", root), "utf8");

  assert.match(source, /writer_token\.amount >= quote\.max_payout/);
  assert.match(source, /verify_preceding_ed25519_instruction/);
  assert.match(source, /domain_separator/);
  assert.match(source, /NonceStatus::Filled/);
  assert.match(source, /position\.fee_bps = config\.fee_bps/);
  assert.match(source, /calculate_fee\(position\.premium, position\.fee_bps\)/);
  assert.match(source, /pub fn refund_unsettled/);
  assert.match(source, /pub fn set_pause/);
  assert.match(source, /pub fn publish_pyth_settlement/);
  assert.match(source, /pyth_price\.publish_time >= market\.expiry/);
  assert.match(pyth, /PYTH_RECEIVER_PROGRAM_ID/);
  assert.match(pyth, /FULL_VERIFICATION_VARIANT/);
  assert.match(pyth, /feed_id == expected_feed_id/);
  assert.match(signature, /solana_sdk_ids::ed25519_program::ID/);
  assert.match(math, /checked_mul/);
  assert.match(math, /settlement_conserves_escrow/);
});

test("short-duration products stay oracle gated but never session gated", async () => {
  const [terminal, quotesRoute, expiries] = await Promise.all([
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    readFile(new URL("app/api/quotes/route.ts", root), "utf8"),
    import(new URL("app/lib/expiries.ts", root)),
  ]);
  assert.match(terminal, /No verified.*onchain series is published/);
  assert.doesNotMatch(quotesRoute, /expiryCode\s*!==\s*["']30D["']/);
  assert.doesNotMatch(quotesRoute, /snapshot\.mode\s*!==\s*["']live["']/);

  const now = Date.parse("2026-07-17T14:00:00Z");
  const intraday = expiries.resolveExpiry("15M", "SOL", now);
  assert.equal(intraday.available, true);
  assert.equal(intraday.durationMinutes, 15);
  assert.equal(intraday.observationWindowSeconds, 60);

  // Regression guard: Tend is 24/7. A Saturday-night timestamp (both a
  // weekend and outside any US equity trading window) must resolve every
  // expiry code as available, on pure UTC clock boundaries, with no mention
  // of sessions, holidays, weekends, or market hours anywhere in the surface.
  const weekendOvernight = Date.parse("2026-07-18T22:15:00Z");
  for (const code of ["15M", "1H", "EOD", "7D", "30D"]) {
    const definition = expiries.resolveExpiry(code, "SOL", weekendOvernight);
    assert.equal(definition.available, true, `${code} must be available on a weekend/overnight timestamp`);
    assert.doesNotMatch(definition.availabilityReason, /session|holiday|weekend|market (open|close)/i);
  }
  assert.equal(new Date(expiries.resolveExpiry("15M", "SOL", weekendOvernight).expiryAt).toISOString(), "2026-07-18T22:30:00.000Z");
  assert.equal(new Date(expiries.resolveExpiry("1H", "SOL", weekendOvernight).expiryAt).toISOString(), "2026-07-19T00:00:00.000Z");
  const eod = expiries.resolveExpiry("EOD", "SOL", weekendOvernight);
  // EOD's natural boundary (next UTC midnight) is also 2026-07-19T00:00:00Z here —
  // identical to 1H's boundary. The grid must not collapse the two onto one
  // market, so EOD advances by one full day (its own cadence) past the collision.
  assert.equal(new Date(eod.expiryAt).toISOString(), "2026-07-20T00:00:00.000Z");
  assert.equal(eod.label, "Next daily settlement");
  assert.equal(eod.shortLabel, "Daily");
  assert.equal(new Date(expiries.resolveExpiry("7D", "SOL", weekendOvernight).expiryAt).toISOString(), "2026-07-26T00:00:00.000Z");
  assert.equal(new Date(expiries.resolveExpiry("30D", "SOL", weekendOvernight).expiryAt).toISOString(), "2026-08-18T00:00:00.000Z");

  // Only a missing intraday feed can make a code unavailable, never the clock.
  const unsupportedSymbol = expiries.resolveExpiry("15M", "TSLA", now);
  assert.equal(unsupportedSymbol.available, false);
  assert.doesNotMatch(unsupportedSymbol.availabilityReason, /session|holiday|weekend/i);
});

test("SOL is live and tradable, and the coming-soon status gate still blocks a non-live market from trading", async () => {
  const [markets, expiries, quotesRoute, terminal] = await Promise.all([
    import(new URL("app/lib/markets.ts", root)),
    import(new URL("app/lib/expiries.ts", root)),
    readFile(new URL("app/api/quotes/route.ts", root), "utf8"),
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
  ]);

  const sol = markets.marketBySymbol("SOL");

  // SOL is the live devnet market: entitled 24/7 crypto feed, tradable.
  assert.ok(sol, "SOL must be a configured market");
  assert.equal(sol.status, "live");
  assert.equal(sol.pythSymbol, "Crypto.SOL/USD");
  assert.equal(sol.pythFeedId, "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");
  assert.equal(markets.isTradableSymbol("SOL"), true);
  assert.ok(markets.liveMarkets.some((market) => market.symbol === "SOL"));

  // SPACEX -- this test's former "coming soon" example -- IPO'd on NASDAQ
  // and is now `status: "live"` (see app/lib/markets.ts): every market in
  // the catalog is live today, so there is no real symbol left to prove a
  // coming-soon market can never trade. That gate (`status` controls
  // tradability, enforced in resolveExpiry and threaded through the quote
  // path and the series resolver) is still real, load-bearing code, so
  // exercise it with a synthetic coming-soon Market pushed into the live
  // catalog for the span of this assertion -- see
  // tests/helpers/synthetic-coming-soon-market.mjs for why that is the only
  // available seam (every consumer resolves a market BY SYMBOL against the
  // real catalog array, never by accepting an injected Market object).
  await withSyntheticComingSoonMarket(markets, async (soon) => {
    assert.equal(markets.isTradableSymbol(soon.symbol), false);
    assert.equal(markets.tradableMarketBySymbol(soon.symbol), undefined);
    assert.ok(!markets.liveMarkets.some((market) => market.symbol === soon.symbol), "a coming-soon market must never reach the live set");

    // The gate that actually enforces it: EVERY expiry code -- intraday and
    // standard -- resolves unavailable for a coming-soon symbol, which is
    // what makes deriveLaunchSeriesParams throw and keeps the symbol out of
    // the series resolver, the launch flow and the quote path.
    const now = Date.parse("2026-07-17T14:00:00Z");
    for (const code of expiries.expiryCodes) {
      const live = expiries.resolveExpiry(code, "SOL", now);
      assert.equal(live.available, true, `${code} must be available for the live market`);
      const comingSoon = expiries.resolveExpiry(code, soon.symbol, now);
      assert.equal(comingSoon.available, false, `${code} must be unavailable for a coming-soon market`);
      assert.equal(comingSoon.availabilityReason, soon.statusNote);
      // Still never a calendar excuse -- Tend is 24/7 for crypto, and the
      // fixture's own reason is a status blocker, never a trading-hours one.
      assert.doesNotMatch(comingSoon.availabilityReason, /session|holiday|weekend|market (open|close)/i);
    }
  });

  // The quote path must resolve through the tradable lookup, not the display
  // one: a coming-soon symbol must never produce a quote.
  assert.match(quotesRoute, /tradableMarketBySymbol/);
  assert.doesNotMatch(quotesRoute, /\bmarketBySymbol\(/);

  // The intraday gate reads the market config, never a hardcoded ticker.
  const expiriesSource = await readFile(new URL("app/lib/expiries.ts", root), "utf8");
  // The assignment specifically -- the prose above it legitimately quotes the
  // old hardcoded test while explaining why it was wrong.
  assert.doesNotMatch(expiriesSource, /const intradayEligible = symbol ===/);
  assert.match(expiriesSource, /market\.intradayEligible/);

  // The selector still supports rendering a coming-soon market, disabled and
  // labelled -- generic UI logic, not conditioned on any specific symbol, so
  // it stays in place even though nothing in the catalog exercises it today.
  assert.match(terminal, /Coming soon/);
  assert.match(terminal, /disabled=\{!item\.tradable\}/);
});

test("the catalog is three categories: pre-IPO DEX tokens, Hyperliquid-priced stocks, and Coinbase-priced crypto -- all live", async () => {
  const [markets, expiries, terminal] = await Promise.all([
    import(new URL("app/lib/markets.ts", root)),
    import(new URL("app/lib/expiries.ts", root)),
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
  ]);

  const bySymbol = Object.fromEntries(markets.markets.map((market) => [market.symbol, market]));
  assert.deepEqual(Object.keys(bySymbol), ["SOL", "BTC", "ETH", "NVDA", "GOOGL", "SPACEX", "TOPENAI", "TKALSHI", "TSPACEX", "POPENAI", "PANTHROPIC", "PNEURALINK", "PFIGUREAI"]);
  // Pre-IPO tokens are a third category, priced off live Solana DEX trading
  // (see app/lib/preipo-market-data.ts). Their `pythFeedId` deliberately
  // carries the SPL mint as 32-byte on-chain identity, NOT a Pyth feed --
  // Pyth publishes nothing for them, and an empty id makes pythFeedIdFor
  // throw inside the market-PDA derivation, which would leave a market
  // looking live while being structurally unmintable.
  const preIpoSymbols = ["TOPENAI", "TKALSHI", "TSPACEX", "POPENAI", "PANTHROPIC", "PNEURALINK", "PFIGUREAI"];
  for (const symbol of preIpoSymbols) {
    const m = bySymbol[symbol];
    assert.equal(m.category, "pre-ipo", `${symbol} is a pre-IPO market`);
    assert.equal(m.status, "live");
    assert.match(m.pythFeedId, /^[0-9a-f]{64}$/, `${symbol} carries its mint as identity`);
    assert.equal(m.coinbaseProductId, "");
    // Thin books ($71k-$656k) plus permissionless settlement with no on-chain
    // width floor: a 15-minute binary here is cheap to push at the settlement
    // instant, so these markets offer standard tenors only.
    assert.equal(m.intradayEligible, false, `${symbol} must not offer intraday tenors`);
  }
  assert.equal(new Set(preIpoSymbols.map((s2) => bySymbol[s2].pythFeedId)).size, preIpoSymbols.length,
    "no two pre-IPO markets may share a mint");

  // Crypto: all three genuinely tradable, each on its OWN entitled 24/7 feed.
  // The per-symbol feed matters beyond labelling -- the feed id is hashed into
  // every market id, so two markets sharing one would derive the same address.
  const crypto = ["SOL", "BTC", "ETH"];
  const feedIds = new Set();
  for (const symbol of crypto) {
    const market = bySymbol[symbol];
    assert.equal(market.category, "crypto", `${symbol} belongs to the crypto category`);
    assert.equal(market.status, "live", `${symbol} must be tradable`);
    assert.equal(market.statusNote, "", "a live market has no blocking reason to show");
    assert.equal(markets.isTradableSymbol(symbol), true);
    assert.match(market.pythSymbol, /^Crypto\./, "every live feed must be a 24/7 crypto feed");
    assert.match(market.pythFeedId, /^[0-9a-f]{64}$/);
    feedIds.add(market.pythFeedId);
    assert.match(market.blurb, /Coinbase Exchange/, `${symbol}'s blurb must name its custom-oracle reference`);
  }
  assert.equal(feedIds.size, 3, "no two markets may share a Pyth feed id");
  assert.deepEqual(markets.liveMarkets.filter((market) => market.category === "crypto").map((market) => market.symbol), crypto);

  // Stocks: NVDA, GOOGL and -- as of SPACEX's 2026-06-12 NASDAQ IPO -- SPACEX
  // too are all tradable now, priced off Hyperliquid's "xyz" HIP-3 dex
  // instead of Pyth. NVDA/GOOGL's Pyth entitlement gap never closed (see
  // their entries in markets.ts), it just stopped being the thing that gates
  // trading here. The catalog carries zero coming-soon markets today -- see
  // the previous test for how the coming-soon GATE itself is still exercised
  // with a synthetic fixture.
  const liveStockSymbols = ["NVDA", "GOOGL", "SPACEX"];
  for (const symbol of liveStockSymbols) {
    const market = bySymbol[symbol];
    assert.equal(market.category, "stocks", `${symbol} belongs to the stocks category`);
    assert.equal(market.status, "live", `${symbol} must be tradable`);
    assert.equal(market.statusNote, "", "a live market has no blocking reason to show");
    assert.equal(market.statusTag, "", "a live market has no blocking tag to show");
    assert.equal(markets.isTradableSymbol(symbol), true);
    assert.equal(markets.tradableMarketBySymbol(symbol), market);
    assert.equal(market.coinbaseProductId, "", `${symbol} does not trade on Coinbase`);
    assert.doesNotMatch(market.blurb, /Pyth/, `${symbol}'s blurb must not claim a Pyth price it does not have`);
    assert.match(market.blurb, /Hyperliquid/i, `${symbol}'s blurb must name its real price source`);
    assert.equal(market.assetClass, "US equity");
  }
  // EVERY live market carries a real Pyth feed id as settlement-identity
  // metadata (see the field's own doc comment), even though no stock BLURB
  // claims a Pyth price this deployment cannot read -- Hyperliquid's "xyz"
  // dex is the real source and settlement runs on the custom oracle.
  //
  // SPACEX used to be the exception, blank because SpaceX was private. It
  // IPO'd on NASDAQ 2026-06-12 as SPCX and Pyth publishes it, so it is
  // populated now. That is not cosmetic: `pythFeedIdFor` feeds the market-PDA
  // derivation in series-resolver.ts and THROWS on a blank, so a live market
  // with no feed id could never have a series minted, quoted or settled -- it
  // would look tradable and fail structurally.
  for (const symbol of liveStockSymbols) {
    assert.match(bySymbol[symbol].pythFeedId, /^[0-9a-f]{64}$/, `${symbol}'s Pyth feed id is recorded`);
  }
  // SPACEX binds Pyth's 24/7 index feed, never the session-bound Equity.US.*
  // one -- see the display-symbol assertion earlier in this file for why.
  assert.equal(bySymbol.SPACEX.pythSymbol, "Equity.Index.SPCX/USD");
  // pythFeedIdFor must still refuse a market with no feed rather than hand
  // back an empty one that would derive a market id from 32 zero bytes. No
  // real market is blank any more, so pin the guarantee against a symbol that
  // genuinely has no metadata -- the behaviour is what matters, not which
  // market happens to trigger it.
  assert.throws(() => markets.pythFeedIdFor("NOT_A_MARKET"), /No market metadata is configured/i);
  assert.equal(
    new Set(liveStockSymbols.map((symbol) => bySymbol[symbol].pythFeedId)).size,
    liveStockSymbols.length,
    "no two stock markets may share a Pyth feed id",
  );
  assert.deepEqual(markets.liveMarkets.map((market) => market.symbol), [...crypto, ...liveStockSymbols, ...preIpoSymbols]);

  // The ladder step is per market and roughly 2-3% of that asset's spot.
  // Measured 2026-09-05/09-16: SOL $103.36, BTC $80,016, ETH $2,473.52,
  // NVDA/GOOGL ~$210, SPACEX ~$143. Every live market's step is load-bearing
  // now: the keeper and mint-on-demand actually list strikes off it.
  const scale = 1_000_000n;
  assert.equal(markets.strikeLadderStepFor("SOL"), 2n * scale + scale / 2n); // $2.50
  assert.equal(markets.strikeLadderStepFor("BTC"), 2_000n * scale);          // $2,000
  assert.equal(markets.strikeLadderStepFor("ETH"), 50n * scale);             // $50
  assert.equal(markets.strikeLadderStepFor("NVDA"), 5n * scale);             // $5.00
  assert.equal(markets.strikeLadderStepFor("GOOGL"), 5n * scale);            // $5.00
  assert.equal(markets.strikeLadderStepFor("SPACEX"), 2n * scale + scale / 2n); // $2.50
  for (const [symbol, spot] of [["SOL", 103.36], ["BTC", 80016], ["ETH", 2473.52], ["NVDA", 210], ["GOOGL", 210]]) {
    const pct = (Number(markets.strikeLadderStepFor(symbol)) / Number(scale)) / spot * 100;
    assert.ok(pct >= 2 && pct <= 3, `${symbol}'s ladder step is ${pct.toFixed(2)}% of spot, outside the 2-3% band`);
  }
  // SPACEX is excluded from the 2-3% band check above: its own $2.50 step
  // against the ~$143.49 spot markets.ts's SPACEX entry cites (see that
  // entry and CLAUDE.md) is ~1.74%, not the "~2%" the entry's own comment claims --
  // just under the band every other listing here was sized to. Pinned as the
  // real, current value rather than fudging the band to cover it; worth
  // reconciling in markets.ts (a wider step, e.g. $3.00-3.25, would land back
  // in band), but that is a markets.ts config edit, out of scope for a
  // tests-only change.
  const spacexPct = (Number(markets.strikeLadderStepFor("SPACEX")) / Number(scale)) / 143.49 * 100;
  assert.ok(spacexPct > 1.5 && spacexPct < 2, `SPACEX's ladder step is ${spacexPct.toFixed(2)}% of spot -- update this pin if markets.ts's step or blurb spot changes`);

  // Every live market is tradable at every code the grid itself allows --
  // status is the only gate consulted here, never category. NVDA/GOOGL/
  // SPACEX used to be the exception (a stock's tradability was also
  // clock-gated to regular trading hours -- see tests/expiries.test.mjs's
  // header for why that gate is gone), so this now holds identically for
  // stocks and crypto: 24/7, with no trading-hours language anywhere in the
  // reason a code IS available.
  const now = Date.parse("2026-07-17T14:00:00Z");
  for (const code of expiries.expiryCodes) {
    for (const symbol of [...crypto, ...liveStockSymbols]) {
      const definition = expiries.resolveExpiry(code, symbol, now);
      assert.equal(definition.available, true, `${symbol}/${code} must be tradable`);
      assert.doesNotMatch(definition.availabilityReason, /trading hours|frozen|session|holiday|weekend/i);
    }
  }

  // Grouping is config-driven: the view renders marketsByCategory, and never
  // re-derives the groups (or worse, uses a category as a tradability test).
  // Stocks lead deliberately (CATEGORY_LABELS in markets.ts is the single
  // place that decides) -- pinned so the order stays an explicit config
  // decision rather than something a refactor can silently flip. Order is
  // presentation only: nothing reads it as a tradability signal.
  assert.deepEqual(markets.marketsByCategory.map((group) => group.category), ["pre-ipo", "stocks", "crypto"]);
  assert.deepEqual(markets.marketsByCategory.map((group) => group.label), ["Pre-IPO", "Stocks", "Crypto"]);
  assert.deepEqual(markets.marketsByCategory.map((group) => group.markets.length), [7, 3, 3]);
  assert.match(terminal, /marketsByCategory/);
  assert.match(terminal, /asset-group-head/);
  // WHICH kind of blocker a coming-soon market has is rendered, not just
  // tooltipped -- as the two-word `statusTag`, so these untradable rows never
  // outweigh the tradable ones. The authoritative sentence stays reachable as
  // the chip's title, and stays the same string the gates return. This
  // rendering path is generic UI logic (keyed off `item.tradable`/
  // `item.statusTag`/`item.statusNote`, never a specific symbol), so it stays
  // pinned even though the catalog has nothing coming-soon to show it with.
  assert.match(terminal, /asset-chip-note/);
  assert.match(terminal, /\{item\.statusTag\}/);
  assert.match(terminal, /title=\{item\.tradable \? undefined : item\.statusNote\}/);
  // Every live market carries neither statusTag nor statusNote -- the
  // coming-soon pairing convention itself (a non-live market must carry
  // BOTH, with statusTag capped at 20 chars) is exercised with a synthetic
  // fixture, since the real catalog has nothing non-live to check it against.
  assert.ok(markets.markets.every((market) => market.status === "live"), "the catalog carries zero coming-soon markets today");
  assert.ok(markets.markets.every((market) => market.statusTag === "" && market.statusNote === ""));
  await withSyntheticComingSoonMarket(markets, async (soon) => {
    assert.ok(soon.statusTag.length > 0 && soon.statusTag.length <= 20);
    assert.ok(soon.statusNote.length > 0);
  });
});

test("expiry grid stays strictly increasing and collision-free across every UTC clock position", async () => {
  const expiries = await import(new URL("app/lib/expiries.ts", root));
  const codes = ["15M", "1H", "EOD", "7D", "30D"];

  function assertGridOrdering(atMs, label) {
    const boundaries = codes.map((code) => expiries.resolveExpiry(code, "SOL", atMs).expiryAt);
    for (let i = 1; i < boundaries.length; i += 1) {
      assert.ok(
        boundaries[i] > boundaries[i - 1],
        `${label}: ${codes[i]} (${new Date(boundaries[i]).toISOString()}) must be strictly after ` +
          `${codes[i - 1]} (${new Date(boundaries[i - 1]).toISOString()})`,
      );
    }
    const distinct = new Set(boundaries);
    assert.equal(distinct.size, boundaries.length, `${label}: all five expiries must be distinct, got ${boundaries.join(", ")}`);
  }

  // The exact collision that shipped: bootstrap ran at 2026-07-20T22:49 UTC,
  // where the next hourly boundary (00:00) coincided with the next UTC
  // midnight (00:00), collapsing 1H and EOD onto the same market PDA.
  assertGridOrdering(Date.parse("2026-07-20T22:49:00Z"), "pinned 22:49 UTC collision case");

  // Sweep every 7 minutes across 48+ hours (crossing multiple UTC midnights
  // and every hourly boundary, including the full 22:00-00:00 band on both
  // days) to prove the ordering holds by construction, not just at one
  // hand-picked instant.
  const sweepStart = Date.parse("2026-07-20T00:00:00Z");
  const sevenMinutes = 7 * 60_000;
  const sweepDurationMs = 50 * 60 * 60_000; // 50 hours
  for (let elapsed = 0; elapsed <= sweepDurationMs; elapsed += sevenMinutes) {
    const at = sweepStart + elapsed;
    assertGridOrdering(at, `sweep at ${new Date(at).toISOString()}`);
  }
});

test("expiry chip details disambiguate by calendar day, never just time-of-day", async () => {
  const expiries = await import(new URL("app/lib/expiries.ts", root));

  // Pinned real case: 1H lands on the next UTC midnight, EOD on the one after —
  // a full day apart — while 15M stays inside the current UTC calendar day.
  // Before the fix, 1H and EOD both formatted as time-only ("12:00 AM UTC")
  // and were indistinguishable on the chips despite expiring a day apart.
  const now = Date.parse("2026-07-21T22:57:00Z");
  const fifteen = expiries.resolveExpiry("15M", "SOL", now);
  const oneHour = expiries.resolveExpiry("1H", "SOL", now);
  const eod = expiries.resolveExpiry("EOD", "SOL", now);

  assert.equal(new Date(fifteen.expiryAt).toISOString(), "2026-07-21T23:15:00.000Z");
  assert.equal(new Date(oneHour.expiryAt).toISOString(), "2026-07-22T00:00:00.000Z");
  assert.equal(new Date(eod.expiryAt).toISOString(), "2026-07-23T00:00:00.000Z");

  // Two codes resolving to different UTC calendar days must never produce the
  // same detail string.
  assert.notEqual(oneHour.detail, eod.detail);
  assert.equal(oneHour.detail, "Jul 22, 12:00 AM UTC");
  assert.equal(eod.detail, "Jul 23, 12:00 AM UTC");

  // The same-day code (15M, still on 2026-07-21) stays time-only — no date
  // noise added when there is no ambiguity to resolve.
  assert.equal(fifteen.detail, "11:15 PM UTC");
  assert.doesNotMatch(fifteen.detail, /Jul/);

  // formatExpiryDetail is the single source of truth both expiries.ts and
  // TendTerminal.tsx must call, so the two surfaces can never disagree on the
  // same (code, expiryAt, now) triple.
  assert.equal(expiries.formatExpiryDetail("1H", oneHour.expiryAt, now), oneHour.detail);
  assert.equal(expiries.formatExpiryDetail("EOD", eod.expiryAt, now), eod.detail);
});

test("liquidity page uses real V2 pool state, wallet signatures, persisted simulation, and post-state reconciliation", async () => {
  const [terminal, earn, server, prepare, send, history, schema, migration] = await Promise.all([
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    readFile(new URL("app/components/EarnView.tsx", root), "utf8"),
    readFile(new URL("app/lib/vsol-server.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/liquidity/prepare/route.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/liquidity/send/route.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/liquidity/history/route.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("drizzle/0005_lush_la_nuit.sql", root), "utf8"),
  ]);
  assert.match(terminal, /<EarnView walletAddress=/);
  assert.match(earn, /no invented APY/i);
  assert.match(earn, /bridge\.signTransactionBase64/);
  assert.match(earn, /\/api\/vsol\/liquidity\/prepare/);
  assert.match(server, /deposit_liquidity/);
  assert.match(server, /withdraw_liquidity/);
  assert.match(server, /decodePoolAccount/);
  assert.match(server, /deriveLiquidityProvider/);
  assert.match(prepare, /transactionMessageHash/);
  assert.match(prepare, /minimumOutputAtoms/);
  assert.match(send, /simulateTransaction/);
  assert.match(send, /sigVerify: true/);
  assert.match(send, /postWallet/);
  assert.match(send, /postPool/);
  assert.match(send, /postShares/);
  assert.match(history, /simulationStatus, "passed"/);
  assert.match(schema, /liquidity_actions/);
  assert.match(migration, /CREATE TABLE `liquidity_actions`/);
  assert.doesNotMatch(earn, /estimated yield|simulated liquidity/i);
});

test("market-data stays real and the verified deployment remains fail-closed on invalid state", async () => {
  const [marketData, pythData, earn, deployment, bootstrap, verifier] = await Promise.all([
    readFile(new URL("app/api/market-data/route.ts", root), "utf8"),
    readFile(new URL("app/lib/pyth-market-data.ts", root), "utf8"),
    readFile(new URL("app/components/EarnView.tsx", root), "utf8"),
    readFile(new URL("vsol/deployments/devnet.json", root), "utf8").then(JSON.parse),
    readFile(new URL("vsol/scripts/bootstrap.ts", root), "utf8"),
    readFile(new URL("vsol/scripts/verify-deployment.ts", root), "utf8"),
  ]);
  assert.match(marketData, /getMarketSnapshot/);
  assert.match(pythData, /Pyth Core Hermes/);
  assert.match(pythData, /historical coverage is insufficient/);
  assert.doesNotMatch(marketData, /demo|simulat/i);
  assert.doesNotMatch(pythData, /Math\.sin|deterministicNoise/);
  assert.match(earn, /no invented APY/i);
  assert.equal(deployment.pythUpgradeDeployed, true);
  assert.equal(deployment.smoke.replayRejected, true);
  assert.equal(deployment.smoke.successPositionClosed, true);
  assert.equal(deployment.smoke.refundPositionClosed, true);
  assert.match(bootstrap, /pythUpgradeDeployed: true/);
  assert.match(verifier, /pythUpgradeDeployed !== true/);
});

test("maker pricing remains bounded under extreme real volatility inputs", async () => {
  const { quoteFor, definedRiskPayout } = await import(new URL("app/lib/options.ts", root));
  const quotes = [2, 5, 10].map((payoff) => quoteFor({
    spot: 200,
    amount: 1_000,
    durationMinutes: 43_200,
    direction: "up",
    payoff,
    volatility: 400,
  }));
  assert.ok(quotes.every((quote) => quote.premium >= 1 && quote.premium <= quote.maxPayout * 0.95));
  assert.ok(quotes[0].premium > quotes[1].premium && quotes[1].premium > quotes[2].premium);
  assert.equal(definedRiskPayout({ direction: "up", settlement: quotes[0].cap + 100, strike: quotes[0].strike, cap: quotes[0].cap, maxPayout: 1_000 }), 1_000);
});

test("the quote route validates the payoff tier against the tenor's OWN ladder, not a fixed [2,5,10] list", async () => {
  const [quotesRoute, options] = await Promise.all([
    readFile(new URL("app/api/quotes/route.ts", root), "utf8"),
    import(new URL("app/lib/options.ts", root)),
  ]);
  // The route resolves the ACTUAL onchain duration before it can know which
  // tiers are for sale (payoffTiersFor(durationMinutes)) -- so it must
  // import and call payoffTiersFor, and must NOT hardcode the old
  // [2, 5, 10] list anywhere (it used to, in two places: the stake-bounds
  // fallback and the strict tier check).
  assert.match(quotesRoute, /payoffTiersFor/);
  assert.doesNotMatch(quotesRoute, /\[2,\s*5,\s*10\]/);
  assert.deepEqual(options.payoffTiersFor(15), [1.5, 2, 3]);
  assert.deepEqual(options.payoffTiersFor(1_440), [2, 5, 10]);
});
