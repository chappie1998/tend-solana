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

  assert.match(terminal, /VSOL program verified/);
  assert.match(terminal, /Execute on Solana devnet/);
  assert.match(terminal, /mock tUSDC/);
  assert.match(terminal, /controlled oracle/);
  assert.match(terminal, /signTransaction/);
  assert.match(chart, /lightweight-charts/);
  assert.match(chart, /Charts by TradingView/);
  assert.match(chart, /DEMO DATA/);
  assert.match(markets, /deployment\.underlyingMint/);
  assert.match(layout, /Solana devnet/);
});

test("server creates buyer-bound maker RFQs and verifies fills before persistence", async () => {
  const [quotesRoute, positionsRoute, sendRoute, server, schema] = await Promise.all([
    readFile(new URL("app/api/quotes/route.ts", root), "utf8"),
    readFile(new URL("app/api/positions/route.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/send/route.ts", root), "utf8"),
    readFile(new URL("app/lib/vsol-server.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
  ]);

  assert.match(quotesRoute, /buildVsolQuoteTransaction/);
  assert.match(quotesRoute, /VSOL_TEST_FUNDS_REQUIRED/);
  assert.match(server, /quoteMessage/);
  assert.match(server, /nacl\.sign\.detached/);
  assert.match(server, /domainSeparator/);
  assert.match(server, /deriveNonce/);
  assert.match(sendRoute, /verifySignatures/);
  assert.match(sendRoute, /isVsolFillTransaction/);
  assert.match(server, /Instruction: FillQuote/);
  assert.match(server, /positionOwnedByVsol/);
  assert.match(positionsRoute, /verifyVsolFill/);
  assert.match(positionsRoute, /db\.batch/);
  assert.match(schema, /uniqueIndex\("positions_quote_unique_idx"\)/);
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
  assert.match(signature, /solana_sdk_ids::ed25519_program::ID/);
  assert.match(math, /checked_mul/);
  assert.match(math, /settlement_conserves_escrow/);
});

test("short-duration products remain explicitly oracle gated", async () => {
  const [terminal, expiries] = await Promise.all([
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    import(new URL("app/lib/expiries.ts", root)),
  ]);
  assert.match(terminal, /protocol-ready but not published/);
  assert.match(terminal, /code !== "30D"/);

  const regularSession = Date.parse("2026-07-17T14:00:00Z");
  const intraday = expiries.resolveExpiry("15M", "NVDA", regularSession);
  assert.equal(intraday.available, true);
  assert.equal(intraday.durationMinutes, 15);
  assert.equal(intraday.observationWindowSeconds, 60);
});
