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

/**
 * The address lookup table (ALT) program enforces a hard 256-address cap and
 * has no way to delete individual entries. This deployment holds 11 stable
 * addresses plus 2 per minted market, so at the grid's continuous mint rate
 * the table fills in roughly 120 markets. scripts/create-lookup-table.ts
 * rotates to a fresh table once the active one's stored-address count reaches
 * this threshold, leaving headroom (256 - 230 = 26 slots, i.e. ~13 more
 * markets) to finish any in-flight quotes before the old table is fully
 * retired -- see ROTATION_ADDRESS_THRESHOLD's usage in
 * shouldRotateLookupTable below.
 */
export const ROTATION_ADDRESS_THRESHOLD = 230;

/**
 * The AddressLookupTable program will not accept close_lookup_table until the
 * deactivation slot has aged out of the runtime's 512-entry SlotHashes
 * history (current_slot >= deactivation_slot + 512). scripts/keeper.ts must
 * not attempt a close before this elapses -- see isLookupTableReadyToClose.
 */
export const ALT_DEACTIVATION_COOLDOWN_SLOTS = 512;

/** Sentinel `deactivationSlot` value an ALT account holds while still active (never deactivated). Mirrors @solana/web3.js's AddressLookupTableAccount.isActive(). */
export const ALT_NOT_DEACTIVATED_SENTINEL = 0xffffffffffffffffn;

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

/**
 * The subset of `deployment.markets` fields rotation cares about. Deliberately
 * a structural (not nominal) type so callers can pass the manifest's raw
 * `markets` array entries directly without a cast.
 */
export type ManifestMarketEntry = {
  code: string;
  address: string;
  oracle: string;
  expiry: number;
  settlementGraceSeconds?: number;
  maxSettlementStalenessSeconds?: number;
};

/**
 * A table rotated out of active service (see create-lookup-table.ts) but not
 * yet safe to deactivate/close: not-yet-settled positions quoted moments
 * before rotation may still resolve indices against it. Stored in the
 * manifest's `retiringLookupTables` array (see the ExtendedDeployment comment
 * in app/lib/vsol.ts for the full manifest-shape documentation) alongside
 * `addressLookupTable`, which always means "the CURRENT active table".
 */
export type RetiringLookupTableEntry = {
  address: string;
  /**
   * The unix-seconds instant after which every market that was live in this
   * table at rotation time has both expired and cleared its settlement grace
   * and max-staleness window -- i.e. every position that could still
   * reference this table's indices has had a chance to settle. Computed as
   * the maximum of (expiry + settlementGraceSeconds + maxSettlementStalenessSeconds)
   * across every market that was live at rotation time (see
   * latestLiveMarketOutliveDeadline below); NOT merely the bare expiry.
   */
  outliveExpiry: number;
  /** ISO timestamp this table was retired from active service (informational). */
  retiredAt: string;
};

/** A market's absolute settlement deadline: the latest instant its onchain settlement could still land. */
function marketSettlementDeadline(market: ManifestMarketEntry): number {
  return market.expiry + (market.settlementGraceSeconds ?? 0) + (market.maxSettlementStalenessSeconds ?? 0);
}

/**
 * Market+oracle addresses for every manifest market entry that has not yet
 * expired as of `nowUnixSeconds`. Used to seed a freshly rotated ALT so it
 * carries forward every rung that can still legitimately trade -- markets
 * that have already expired are never trade targets again and are
 * intentionally excluded, keeping the fresh table as small as possible.
 */
export function liveMarketFillAddresses(markets: ManifestMarketEntry[], nowUnixSeconds: number): PublicKey[] {
  const addresses: PublicKey[] = [];
  for (const market of markets) {
    if (market.expiry > nowUnixSeconds) {
      addresses.push(new PublicKey(market.address), new PublicKey(market.oracle));
    }
  }
  return addresses;
}

/**
 * The latest settlement deadline (see marketSettlementDeadline) among markets
 * that are live as of `nowUnixSeconds` -- i.e. the instant a table being
 * rotated out right now must outlive before every position that could
 * reference it has had a chance to settle. Returns `nowUnixSeconds` itself
 * (nothing to outlive) when no market is currently live.
 */
export function latestLiveMarketOutliveDeadline(markets: ManifestMarketEntry[], nowUnixSeconds: number): number {
  const deadlines = markets.filter((market) => market.expiry > nowUnixSeconds).map(marketSettlementDeadline);
  return deadlines.length > 0 ? Math.max(...deadlines) : nowUnixSeconds;
}

/** True once the active table's stored-address count has reached the rotation threshold. */
export function shouldRotateLookupTable(storedAddressCount: number, threshold: number = ROTATION_ADDRESS_THRESHOLD): boolean {
  return storedAddressCount >= threshold;
}

/** True once every market that could still reference `retiring` has had a chance to settle. */
export function isLookupTableSafeToDeactivate(retiring: Pick<RetiringLookupTableEntry, "outliveExpiry">, nowUnixSeconds: number): boolean {
  return nowUnixSeconds > retiring.outliveExpiry;
}

/**
 * True once an already-deactivated table's mandatory cooldown has elapsed and
 * close_lookup_table will be accepted onchain. `deactivationSlot` must be a
 * real (non-sentinel) slot -- callers should check
 * `deactivationSlot !== ALT_NOT_DEACTIVATED_SENTINEL` (or AddressLookupTableAccount.isActive())
 * first.
 */
export function isLookupTableReadyToClose(
  deactivationSlot: bigint,
  currentSlot: number | bigint,
  cooldownSlots: number = ALT_DEACTIVATION_COOLDOWN_SLOTS,
): boolean {
  return BigInt(currentSlot) >= deactivationSlot + BigInt(cooldownSlots);
}
