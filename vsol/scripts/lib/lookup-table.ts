import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Shared between create-lookup-table.ts and verify-deployment.ts so both
// scripts agree, byte for byte, on which accounts an address lookup table
// (ALT) must hold to be useful for a fill transaction. scripts/keeper.ts does
// not import this module: it only needs to append a freshly created market's
// address and oracle to whatever table the manifest already publishes, not
// the full stable set.

/**
 * Solana v0 transactions cap how many new addresses a single
 * extend-lookup-table instruction can add (the instruction itself has to fit
 * in a transaction alongside its own account keys). ~30 per call is the
 * conventional safe ceiling; a table can still grow to the protocol max of
 * 256 addresses across multiple extend calls.
 */
export const MAX_ADDRESSES_PER_EXTEND = 30;

export type StableAddressEntry = {
  label: string;
  address: PublicKey;
};

/**
 * The fixed set of accounts every fill touches, regardless of which rolling
 * market it trades: the program itself, its global config, the one passive
 * liquidity pool and its token vault, the settlement mint, the protocol
 * treasury token account, and the handful of well-known Solana programs and
 * sysvars every fill's Ed25519-verified quote path references. Per-market
 * addresses (the market and its oracle) are NOT stable -- the rolling grid
 * mints new ones continuously -- so scripts/keeper.ts appends those
 * separately as each market is created.
 *
 * Every address here is read from the deployment manifest (which itself
 * records on-chain-derived addresses written by bootstrap.ts) rather than
 * re-derived or hardcoded, so this can never drift from the deployment it
 * describes.
 */
export function stableFillAddresses(deployment: Record<string, unknown>): StableAddressEntry[] {
  const liquidityPools = deployment.liquidityPools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(liquidityPools) || liquidityPools.length === 0) {
    throw new Error(
      "Cannot compute the ALT's stable address set: the manifest has no liquidity pools yet. Run \"npm run devnet:bootstrap\" first.",
    );
  }
  // The deployment currently maintains exactly one passive liquidity pool
  // ("main-v3"); every fill against it touches that pool and its token
  // vault. If a second pool is ever launched, this should be revisited to
  // decide which pool(s) are actually load-bearing for the ALT.
  const mainPool = liquidityPools[0];

  return [
    { label: "programId", address: new PublicKey(String(deployment.programId)) },
    { label: "config", address: new PublicKey(String(deployment.config)) },
    { label: "mainPool", address: new PublicKey(String(mainPool.address)) },
    { label: "mainPoolToken", address: new PublicKey(String(mainPool.token)) },
    { label: "settlementMint", address: new PublicKey(String(deployment.settlementMint)) },
    { label: "treasuryToken", address: new PublicKey(String(deployment.treasuryToken)) },
    { label: "ed25519Program", address: Ed25519Program.programId },
    { label: "tokenProgram", address: TOKEN_PROGRAM_ID },
    { label: "systemProgram", address: SystemProgram.programId },
    { label: "rentSysvar", address: SYSVAR_RENT_PUBKEY },
    { label: "instructionsSysvar", address: SYSVAR_INSTRUCTIONS_PUBKEY },
  ];
}

/** Addresses in `candidates` that are not already present in `existing`. */
export function missingAddresses(existing: PublicKey[], candidates: PublicKey[]): PublicKey[] {
  const existingSet = new Set(existing.map((address) => address.toBase58()));
  return candidates.filter((address) => !existingSet.has(address.toBase58()));
}
