// Builds synthetic 289-byte `Market` account buffers for the chain-discovery
// tests, so they can exercise app/lib/series-resolver.ts's real matching and
// at-the-money selection logic without an RPC connection.
//
// Offsets mirror the `Market` struct in vsol/programs/vsol/src/lib.rs exactly
// (the same table app/lib/vsol-market-accounts.ts decodes). Reproduced here
// rather than derived from the decoder so a silent drift in ONE of them shows
// up as a failing test instead of two mistakes cancelling out.

import { PublicKey } from "@solana/web3.js";

export const MARKET_ACCOUNT_SIZE = 289;

/**
 * `discriminator` must be the real 8-byte `Market` discriminator; pass the
 * one app/lib/vsol-market-accounts.ts computes from the IDL so the fixture
 * can never disagree with the decoder about what a Market looks like.
 */
export function buildMarketAccountBuffer({
  discriminator,
  config,
  marketId = Buffer.alloc(32, 7),
  underlyingMint = PublicKey.default,
  settlementMint,
  oracle,
  symbol,
  priceScale,
  expiry,
  observationWindowSeconds,
  settlementGraceSeconds,
  maxConfidenceBps,
  pythFeedId,
  settlementDecimals = 6,
  enabled = true,
  creator = PublicKey.default,
  maxSettlementStalenessSeconds,
  strike,
}) {
  const data = Buffer.alloc(MARKET_ACCOUNT_SIZE);
  Buffer.from(discriminator).copy(data, 0);
  data[8] = 255; // bump
  config.toBuffer().copy(data, 9);
  Buffer.from(marketId).copy(data, 41);
  underlyingMint.toBuffer().copy(data, 73);
  settlementMint.toBuffer().copy(data, 105);
  oracle.toBuffer().copy(data, 137);
  Buffer.from(symbol, "ascii").copy(data, 169);
  data.writeBigUInt64LE(BigInt(priceScale), 185);
  data.writeBigInt64LE(BigInt(expiry), 193);
  data.writeUInt32LE(observationWindowSeconds, 201);
  data.writeUInt32LE(settlementGraceSeconds, 205);
  data.writeUInt16LE(maxConfidenceBps, 209);
  Buffer.from(pythFeedId, "hex").copy(data, 211);
  data[243] = settlementDecimals;
  data[244] = enabled ? 1 : 0;
  creator.toBuffer().copy(data, 245);
  data.writeUInt32LE(maxSettlementStalenessSeconds, 277);
  data.writeBigUInt64LE(BigInt(strike), 281);
  return data;
}

/**
 * A stub standing in for @solana/web3.js's Connection, exposing only the one
 * method chain discovery calls. Returns `entries` verbatim, so a test decides
 * exactly which markets "exist".
 */
export function stubConnection(entries) {
  return {
    async getProgramAccounts() {
      return entries.map(({ address, data }) => ({ pubkey: address, account: { data } }));
    },
  };
}
