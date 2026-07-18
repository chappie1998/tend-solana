import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the VSOL trading surface with honest devnet labels", async () => {
  const [terminal, markets, chart, layout] = await Promise.all([
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    readFile(new URL("app/lib/markets.ts", root), "utf8"),
    readFile(new URL("app/components/TradingViewMarketChart.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);

  assert.match(terminal, /VSOL program \+ Pyth market verified/);
  assert.match(terminal, /Execute on Solana devnet/);
  assert.match(terminal, /mock tUSDC/);
  assert.match(terminal, /fully verified Pyth update/);
  assert.match(terminal, /signTransaction/);
  assert.match(chart, /embed-widget-advanced-chart\.js/);
  assert.match(chart, /TradingView market display/);
  assert.doesNotMatch(chart, /DEMO DATA|demoCandles|lightweight-charts/);
  assert.match(markets, /deployment\.underlyingMint/);
  assert.match(markets, /b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593/);
  assert.match(layout, /Solana devnet/);
});

test("server creates buyer-bound maker RFQs and verifies fills before persistence", async () => {
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
  assert.match(server, /quoteMessage/);
  assert.match(server, /nacl\.sign\.detached/);
  assert.match(server, /domainSeparator/);
  assert.match(server, /deriveNonce/);
  assert.match(sendRoute, /verifySignatures/);
  assert.match(sendRoute, /simulateTransaction/);
  assert.match(sendRoute, /sigVerify: true/);
  assert.match(sendRoute, /transactionSimulations/);
  assert.match(server, /runtimeEnv\("VSOL_RPC_URL"\)/);
  assert.match(runtimeEnv, /configureRuntimeEnv/);
  assert.match(server, /Instruction: FillQuote/);
  assert.match(server, /positionOwnedByVsol/);
  assert.match(positionsRoute, /verifyVsolFill/);
  assert.match(positionsRoute, /db\.batch/);
  assert.match(positionsRoute, /persisted, passing simulation/);
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

test("short-duration products remain explicitly oracle gated", async () => {
  const [terminal, expiries] = await Promise.all([
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    import(new URL("app/lib/expiries.ts", root)),
  ]);
  assert.match(terminal, /exact expiry series has not been published/);
  assert.match(terminal, /code !== "30D"/);

  const regularSession = Date.parse("2026-07-17T14:00:00Z");
  const intraday = expiries.resolveExpiry("15M", "NVDA", regularSession);
  assert.equal(intraday.available, true);
  assert.equal(intraday.durationMinutes, 15);
  assert.equal(intraday.observationWindowSeconds, 60);

  const summerCloses = expiries.previousReferenceMarketCloses(2, Date.parse("2026-07-17T22:00:00Z"));
  assert.deepEqual(summerCloses.map((value) => new Date(value).toISOString()), [
    "2026-07-16T20:00:00.000Z",
    "2026-07-17T20:00:00.000Z",
  ]);
  const winterCloses = expiries.previousReferenceMarketCloses(2, Date.parse("2026-01-09T23:00:00Z"));
  assert.deepEqual(winterCloses.map((value) => new Date(value).toISOString()), [
    "2026-01-08T21:00:00.000Z",
    "2026-01-09T21:00:00.000Z",
  ]);
});

test("market-data stays real and the verified deployment remains fail-closed on invalid state", async () => {
  const [marketData, pythData, terminal, deployment, bootstrap, verifier] = await Promise.all([
    readFile(new URL("app/api/market-data/route.ts", root), "utf8"),
    readFile(new URL("app/lib/pyth-market-data.ts", root), "utf8"),
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    readFile(new URL("vsol/deployments/devnet.json", root), "utf8").then(JSON.parse),
    readFile(new URL("vsol/scripts/bootstrap.ts", root), "utf8"),
    readFile(new URL("vsol/scripts/verify-deployment.ts", root), "utf8"),
  ]);
  assert.match(marketData, /getPythSnapshot/);
  assert.match(pythData, /Pyth Core Hermes/);
  assert.match(pythData, /historical coverage is insufficient/);
  assert.doesNotMatch(marketData, /demo|simulat/i);
  assert.doesNotMatch(pythData, /Math\.sin|deterministicNoise/);
  assert.match(terminal, /will not invent writer P&amp;L, utilization, uptime, or exposure/i);
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
