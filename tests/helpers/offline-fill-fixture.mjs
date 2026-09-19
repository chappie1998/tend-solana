import assert from "node:assert/strict";
import { Connection } from "@solana/web3.js";
import { buildMarketAccountBuffer } from "./vsol-market-fixture.mjs";
import { deriveVsolSeriesCandidate } from "../../app/lib/series-resolver.ts";
import { MARKET_ACCOUNT_DISCRIMINATOR } from "../../app/lib/vsol-market-accounts.ts";
import { pythFeedIdFor } from "../../app/lib/markets.ts";
import { VSOL_CONFIG, VSOL_PROGRAM_ID, VSOL_SETTLEMENT_MINT } from "../../app/lib/vsol.ts";

// Fix the clock and chain-discovery boundary. Transaction encoding, PDA
// derivation, signing, and inspection continue to use the production code.
export async function installOfflineFillFixture(t) {
  const now = Date.parse("2026-09-12T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const series = await deriveVsolSeriesCandidate("SOL", "30D", now, 105_000_000n);
  const data = buildMarketAccountBuffer({
    discriminator: MARKET_ACCOUNT_DISCRIMINATOR,
    config: VSOL_CONFIG,
    settlementMint: VSOL_SETTLEMENT_MINT,
    oracle: series.oracleKey,
    symbol: "SOL",
    priceScale: 1_000_000n,
    expiry: series.expiry,
    observationWindowSeconds: 30,
    settlementGraceSeconds: 900,
    maxConfidenceBps: 500,
    pythFeedId: pythFeedIdFor("SOL"),
    maxSettlementStalenessSeconds: 86_400,
    strike: 105_000_000n,
  });
  t.mock.method(Connection.prototype, "getProgramAccounts", async (program) => {
    assert.ok(program.equals(VSOL_PROGRAM_ID));
    return [{
      pubkey: series.marketKey,
      account: { data, owner: VSOL_PROGRAM_ID, executable: false, lamports: 3_000_000, rentEpoch: 0 },
    }];
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request in offline fill tests");
  });
}
