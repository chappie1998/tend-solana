import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

  assert.match(terminal, /VSOL V2 pool \+ Pyth series verified/);
  assert.match(terminal, /Execute on Solana devnet/);
  assert.match(terminal, /mock tUSDC/);
  assert.match(terminal, /fully verified Pyth update/);
  assert.match(terminal, /signSerializedSolanaTransaction/);
  assert.match(walletHelper, /signTransaction/);
  assert.doesNotMatch(terminal, /"Devnet confirmed"/);
  assert.match(chart, /lightweight-charts/);
  assert.match(chart, /CandlestickSeries/);
  assert.match(chart, /ResizeObserver/);
  assert.match(chart, /\/api\/market-bars/);
  assert.match(chart, /Charts by TradingView/);
  assert.doesNotMatch(chart, /embed-widget-advanced-chart|document\.createElement\("script"\)|<iframe|DEMO DATA|demoCandles/i);
  assert.match(chartRoute, /getPythMarketBars/);
  assert.match(chartData, /benchmarks\.pyth\.network\/v1\/shims\/tradingview\/history/);
  assert.match(chartData, /runtimeEnv\("PYTH_API_KEY"\)/);
  assert.match(chartData, /AbortController/);
  assert.doesNotMatch(chartRoute, /PYTH_API_KEY|Authorization|Bearer/);
  assert.match(markets, /deployment\.underlyingMint/);
  assert.match(markets, /b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593/);
  assert.match(markets, /Equity\.US\.NVDA\/USD/);
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
  assert.match(quotesRoute, /VSOL_PYTH_DEPLOYMENT_PENDING/);
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
  assert.match(server, /state\.pool\.equals\(VSOL_LIQUIDITY\.poolKey\)/);
  assert.match(server, /state\.market\.equals\(series\.marketKey\)/);
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
  const intraday = expiries.resolveExpiry("15M", "NVDA", now);
  assert.equal(intraday.available, true);
  assert.equal(intraday.durationMinutes, 15);
  assert.equal(intraday.observationWindowSeconds, 60);

  // Regression guard: Tend is 24/7. A Saturday-night timestamp (both a
  // weekend and outside any US equity trading window) must resolve every
  // expiry code as available, on pure UTC clock boundaries, with no mention
  // of sessions, holidays, weekends, or market hours anywhere in the surface.
  const weekendOvernight = Date.parse("2026-07-18T22:15:00Z");
  for (const code of ["15M", "1H", "EOD", "7D", "30D"]) {
    const definition = expiries.resolveExpiry(code, "NVDA", weekendOvernight);
    assert.equal(definition.available, true, `${code} must be available on a weekend/overnight timestamp`);
    assert.doesNotMatch(definition.availabilityReason, /session|holiday|weekend|market (open|close)/i);
  }
  assert.equal(new Date(expiries.resolveExpiry("15M", "NVDA", weekendOvernight).expiryAt).toISOString(), "2026-07-18T22:30:00.000Z");
  assert.equal(new Date(expiries.resolveExpiry("1H", "NVDA", weekendOvernight).expiryAt).toISOString(), "2026-07-19T00:00:00.000Z");
  const eod = expiries.resolveExpiry("EOD", "NVDA", weekendOvernight);
  // EOD's natural boundary (next UTC midnight) is also 2026-07-19T00:00:00Z here —
  // identical to 1H's boundary. The grid must not collapse the two onto one
  // market, so EOD advances by one full day (its own cadence) past the collision.
  assert.equal(new Date(eod.expiryAt).toISOString(), "2026-07-20T00:00:00.000Z");
  assert.equal(eod.label, "Next daily settlement");
  assert.equal(eod.shortLabel, "Daily");
  assert.equal(new Date(expiries.resolveExpiry("7D", "NVDA", weekendOvernight).expiryAt).toISOString(), "2026-07-26T00:00:00.000Z");
  assert.equal(new Date(expiries.resolveExpiry("30D", "NVDA", weekendOvernight).expiryAt).toISOString(), "2026-08-18T00:00:00.000Z");

  // Only a missing intraday feed can make a code unavailable, never the clock.
  const unsupportedSymbol = expiries.resolveExpiry("15M", "TSLA", now);
  assert.equal(unsupportedSymbol.available, false);
  assert.doesNotMatch(unsupportedSymbol.availabilityReason, /session|holiday|weekend/i);
});

test("expiry grid stays strictly increasing and collision-free across every UTC clock position", async () => {
  const expiries = await import(new URL("app/lib/expiries.ts", root));
  const codes = ["15M", "1H", "EOD", "7D", "30D"];

  function assertGridOrdering(atMs, label) {
    const boundaries = codes.map((code) => expiries.resolveExpiry(code, "NVDA", atMs).expiryAt);
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
  const fifteen = expiries.resolveExpiry("15M", "NVDA", now);
  const oneHour = expiries.resolveExpiry("1H", "NVDA", now);
  const eod = expiries.resolveExpiry("EOD", "NVDA", now);

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
  assert.match(earn, /signSerializedSolanaTransaction/);
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
  assert.match(marketData, /getPythSnapshot/);
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
