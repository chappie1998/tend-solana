// Dependency-light decoder for the on-chain VSOL `Market` account, plus a
// getProgramAccounts scan that returns every live one. Lives in its own leaf
// module -- no dependency on vsol-server.ts or series-resolver.ts -- on
// purpose: vsol-server.ts already depends on series-resolver.ts (for
// resolveVsolSeries et al), so series-resolver.ts importing the decoder FROM
// vsol-server.ts would be circular (vsol-server -> series-resolver ->
// vsol-server). vsol-server.ts re-exports `decodeMarketAccount` from here so
// its existing consumers (chain-catalog.ts, chain-positions.ts, vsol-launch.ts)
// are untouched.
//
// The explicit .ts extension on the JSON import (with the import attribute)
// keeps this module directly importable by the node:test suite (Node's
// native type-stripping ESM loader requires both), matching the convention
// already used by app/lib/vsol-server.ts.

import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../../vsol/target/idl/vsol.json" with { type: "json" };
import { VSOL_PROGRAM_ID } from "./vsol.ts";

type IdlAccountDefinition = { name: string; discriminator: number[] };

function idlAccountDiscriminator(name: string): Buffer {
  const account = (idl.accounts as IdlAccountDefinition[]).find((entry) => entry.name === name);
  if (!account || account.discriminator.length !== 8) throw new Error(`VSOL IDL is missing account ${name}`);
  return Buffer.from(account.discriminator);
}

/**
 * Exported so test fixtures build their synthetic Market buffers from the
 * SAME discriminator this decoder checks against -- a fixture that computed
 * its own could drift from the decoder and let both be wrong together.
 */
export const MARKET_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("Market");

// 289 bytes: 281 (pre-strike-ladder layout) + 8 for the appended
// conditional-token `strike: u64` (see the Market struct in
// vsol/programs/vsol/src/lib.rs). Accounts of any other size predate the
// upgrade and no longer deserialize.
export const MARKET_ACCOUNT_SIZE = 289;

function publicKeyAt(data: Buffer, offset: number) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

/**
 * Pure decoder: no RPC, so it is directly unit-testable against fixture
 * buffers (see tests/helpers/vsol-market-fixture.mjs). Mirrors the `Market`
 * struct in vsol/programs/vsol/src/lib.rs byte-for-byte, `strike` included --
 * the conditional-token winner threshold, and (as of the strike-ladder
 * upgrade) the field app/lib/series-resolver.ts's chain discovery reads back
 * rather than re-deriving from spot.
 */
export function decodeMarketAccount(data: Buffer) {
  if (data.length !== MARKET_ACCOUNT_SIZE || !data.subarray(0, 8).equals(MARKET_ACCOUNT_DISCRIMINATOR)) {
    throw new Error("The VSOL market account discriminator or size is invalid");
  }
  return {
    config: publicKeyAt(data, 9),
    marketId: data.subarray(41, 73),
    underlyingMint: publicKeyAt(data, 73),
    settlementMint: publicKeyAt(data, 105),
    oracle: publicKeyAt(data, 137),
    symbol: data.subarray(169, 185).toString("ascii").replace(/\0+$/, ""),
    priceScale: data.readBigUInt64LE(185),
    expiry: Number(data.readBigInt64LE(193)),
    observationWindowSeconds: data.readUInt32LE(201),
    settlementGraceSeconds: data.readUInt32LE(205),
    maxConfidenceBps: data.readUInt16LE(209),
    pythFeedId: data.subarray(211, 243).toString("hex"),
    settlementDecimals: data[243],
    enabled: data[244] === 1,
    creator: publicKeyAt(data, 245),
    // Appended after launch: bounds how old a tier-2 last-known price may be
    // relative to `expiry` (see the two-tier settlement note on the oracle).
    maxSettlementStalenessSeconds: data.readUInt32LE(277),
    // Appended for the strike-ladder upgrade: the conditional-token winner
    // threshold this specific listing was minted at (see CreateMarketArgs::
    // strike / expected_market_id in vsol/programs/vsol/src/lib.rs). A keeper
    // (or a mint-on-demand buyer) chooses this once, at mint time; every
    // reader -- including series-resolver.ts's chain discovery -- reads it
    // back rather than re-deriving it from spot.
    strike: data.readBigUInt64LE(281),
  };
}

export type DecodedVsolMarketAccount = ReturnType<typeof decodeMarketAccount>;
export type DiscoveredVsolMarket = { address: PublicKey; market: DecodedVsolMarketAccount };

/**
 * Enumerates every live Market account program-wide via a single
 * getProgramAccounts call (dataSize filter only -- the same scanning pattern
 * app/lib/chain-catalog.ts already used for its own markets scan, and
 * app/lib/chain-positions.ts's/vsol/scripts/lib/settlement.ts's for other
 * account types). Malformed entries are skipped rather than failing the
 * whole scan -- same policy chain-catalog.ts already applies.
 */
export async function fetchAllVsolMarkets(
  connection: Connection,
  programId: PublicKey = VSOL_PROGRAM_ID,
): Promise<DiscoveredVsolMarket[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: MARKET_ACCOUNT_SIZE }],
  });
  const markets: DiscoveredVsolMarket[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      markets.push({ address: pubkey, market: decodeMarketAccount(Buffer.from(account.data)) });
    } catch {
      // Not a Market account (or a corrupt read); skip rather than fail the scan.
    }
  }
  return markets;
}
