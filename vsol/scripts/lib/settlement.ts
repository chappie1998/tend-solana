import { createRequire } from "node:module";
import { AnchorError, type Program } from "@anchor-lang/core";
import { Wallet as CoralWallet } from "@coral-xyz/anchor";
import type { HermesClient } from "@pythnetwork/hermes-client";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Vsol } from "../../target/types/vsol.ts";
import {
  deriveCompleteSetVault,
  deriveLiquidityPoolToken,
  derivePoolNonce,
  derivePoolPositionVault,
  VSOL_PROGRAM_ID,
} from "../../sdk/index.ts";

// --- Direct-maker Position account decoding ---------------------------------
// The on-chain account type is named `Position` (see the struct in
// vsol/programs/vsol/src/lib.rs, ~line 2351); referred to here as "direct
// position" (as opposed to `PoolPosition`) to keep the two scans and their
// results unambiguous throughout this module. `fill_quote` (still
// permissionlessly callable) opens one of these against a maker's own
// writer vault, and `settle`/`refund_unsettled` are the only instructions
// that close it -- both `has_one = market`, exactly like `PoolPosition`'s
// `settle_pool_position`/`refund_pool_position`. A market with an open
// direct Position is therefore just as unsafe to close as one with an open
// PoolPosition: `settle`'s `Settle` accounts struct loads `Market` via
// `has_one` and would fail forever once the market is gone, stranding the
// position's escrowed premium/collateral with no recovery path. The
// market-cleanup pass MUST treat both account types as equally load-bearing.
//
// Layout mirrors `Position` in vsol/target/idl/vsol.json and is reproduced
// independently here (not imported from app/, which has no decoder for this
// account type) --
//   8  discriminator
//   8  bump (u8), 9 vault_bump (u8), 10 status (u8), 11 direction (u8)
//   12 market, 44 nonce_record, 76 buyer, 108 maker, 140 settlement_mint (pubkeys)
//   172 nonce (u64), 180 strike (u64), 188 width (u64), 196 premium (u64),
//   204 max_payout (u64), 212 fee_bps (u16), 214 opened_at (i64),
//   222 quote_expiry (i64) => 230 bytes total.
export const DIRECT_POSITION_ACCOUNT_SIZE = 230;
// sha256("account:Position")[0..8].
export const DIRECT_POSITION_DISCRIMINATOR = Object.freeze([170, 188, 143, 228, 122, 64, 247, 208]);

export type DecodedDirectPosition = {
  address: string;
  market: string;
};

/**
 * Pure decoder: no RPC, so it is directly unit-testable against fixture
 * buffers. Only decodes the `market` field -- the one thing the market-cleanup
 * pass needs from this account type -- rather than the full record, since
 * this scan does not (yet) drive a direct-path settle/refund flow (see the
 * module doc in cranker.ts for what is and is not implemented there).
 */
export function decodeDirectPositionMarket(address: PublicKey, data: Buffer): DecodedDirectPosition {
  if (data.length !== DIRECT_POSITION_ACCOUNT_SIZE) {
    throw new Error("The direct position account size is invalid");
  }
  if (!data.subarray(0, 8).equals(Buffer.from(DIRECT_POSITION_DISCRIMINATOR))) {
    throw new Error("The direct position account discriminator is invalid");
  }
  return {
    address: address.toBase58(),
    market: publicKeyAt(data, 12),
  };
}

/** Enumerates every open direct-maker Position account program-wide via getProgramAccounts (dataSize filter only), the same scanning pattern fetchOpenPoolPositions uses. Malformed entries are skipped, never thrown. */
export async function fetchOpenDirectPositions(
  connection: Connection,
  programId: PublicKey = VSOL_PROGRAM_ID,
): Promise<DecodedDirectPosition[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: DIRECT_POSITION_ACCOUNT_SIZE }],
  });
  const positions: DecodedDirectPosition[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      positions.push(decodeDirectPositionMarket(pubkey, Buffer.from(account.data)));
    } catch {
      // Same size but a different account shape (or a corrupt read): not a
      // Position, so it is silently excluded rather than failing the run.
    }
  }
  return positions;
}

// --- Market account decoding (for the market-cleanup pass AND the keeper's
// discover-first rung lookup) -------------------------------------------------
// Layout mirrors `Market` in vsol/target/types/vsol.ts and the byte offsets
// documented in app/lib/vsol-server.ts's decodeMarketAccount; reproduced
// independently here (rather than imported) so this script package has no
// dependency on app/. Decodes:
//   oracle@137                            (to call close_settled_market without re-deriving it)
//   symbol@169 (16 bytes, NUL-trimmed)    (the keeper's rung fingerprint)
//   priceScale@185 (u64)                  (the keeper's rung fingerprint)
//   expiry@193 (i64)                      (to compute the close deadline / the rung's grid slot)
//   observationWindowSeconds@201 (u32)    (to compute the close deadline / the keeper's rung fingerprint)
//   settlementGraceSeconds@205 (u32)      (to compute the close deadline / the keeper's rung fingerprint)
//   maxConfidenceBps@209 (u16)            (the keeper's rung fingerprint)
//   pythFeedId@211 (32 bytes)             (the keeper's rung fingerprint)
//   enabled@244 (bool)                    (the keeper only reuses a currently-enabled rung)
//   creator@245                           (the required rent_recipient, and on devnet the same
//                                          key as the cranker's own signer)
//   maxSettlementStalenessSeconds@277 (u32) (the keeper's rung fingerprint)
//   strike@281 (u64)                      (read back, never re-derived -- see ladderStrike in
//                                          vsol/sdk/index.ts and keeper.ts's ensureMarketRung)
//   marketId@41 (32 bytes)                (surfaced as a convenience for logging/debugging;
//                                          not used to re-derive the account's own address)
export const MARKET_ACCOUNT_SIZE = 289;
// sha256("account:Market")[0..8].
export const MARKET_ACCOUNT_DISCRIMINATOR = Object.freeze([219, 190, 213, 55, 0, 227, 198, 154]);

// Reusable settlement-cranking logic for scripts/cranker.ts. Kept free of
// module-scope `main()` side effects (unlike bootstrap.ts and keeper.ts) so
// this module is directly importable by the node:test suite. The official
// Pyth packages publish dual ESM/CJS builds, but solana-utils 0.6.0's ESM
// entry imports an extensionless jito-ts path that Node 24 rejects -- this is
// the same CJS-interop workaround bootstrap.ts uses, copied minimally here
// (rather than imported from bootstrap.ts, which runs main() at module scope
// and must not be imported by this script or its tests).
const require = createRequire(import.meta.url);
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver") as typeof import("@pythnetwork/pyth-solana-receiver");
const { sendTransactions } = require("@pythnetwork/solana-utils") as typeof import("@pythnetwork/solana-utils");

// --- PoolPosition account decoding -----------------------------------------
// Layout mirrors `PoolPosition` in vsol/target/types/vsol.ts and the byte
// offsets documented in app/lib/pool-position.ts (pool@12, market@44,
// buyer@108); reproduced independently here rather than imported so this
// script package has no dependency on app/.
//   8  discriminator
//   8  bump (u8), 9 vault_bump (u8), 10 status (u8), 11 direction (u8)
//   12 pool, 44 market, 76 nonce_record, 108 buyer, 140 quote_authority,
//   172 settlement_mint (pubkeys)
//   204 nonce (u64), 212 strike (u64), 220 width (u64), 228 premium (u64),
//   236 max_payout (u64), 244 fee_bps (u16), 246 opened_at (i64),
//   254 quote_expiry (i64) => 262 bytes total.
export const POOL_POSITION_ACCOUNT_SIZE = 262;
// sha256("account:PoolPosition")[0..8].
export const POOL_POSITION_DISCRIMINATOR = Object.freeze([246, 13, 238, 156, 119, 129, 253, 135]);
// The program's PositionStatus enum has a single variant: Open = 1. Settled
// or refunded positions close their accounts, so any account matching this
// discriminator and size is always an open position.
export const POOL_POSITION_STATUS_OPEN = 1;

export type DecodedPoolPosition = {
  address: string;
  status: number;
  direction: 0 | 1;
  pool: string;
  market: string;
  nonceRecord: string;
  buyer: string;
  quoteAuthority: string;
  settlementMint: string;
  nonce: bigint;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  feeBps: number;
  openedAt: number;
  quoteExpiry: number;
};

function publicKeyAt(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

/** Pure decoder: no RPC, so it is directly unit-testable against fixture buffers. */
export function decodePoolPositionAccount(address: PublicKey, data: Buffer): DecodedPoolPosition {
  if (data.length !== POOL_POSITION_ACCOUNT_SIZE) {
    throw new Error("The pool position account size is invalid");
  }
  if (!data.subarray(0, 8).equals(Buffer.from(POOL_POSITION_DISCRIMINATOR))) {
    throw new Error("The pool position account discriminator is invalid");
  }
  const direction = data[11];
  if (direction !== 0 && direction !== 1) throw new Error("The pool position direction is invalid");
  return {
    address: address.toBase58(),
    status: data[10],
    direction,
    pool: publicKeyAt(data, 12),
    market: publicKeyAt(data, 44),
    nonceRecord: publicKeyAt(data, 76),
    buyer: publicKeyAt(data, 108),
    quoteAuthority: publicKeyAt(data, 140),
    settlementMint: publicKeyAt(data, 172),
    nonce: data.readBigUInt64LE(204),
    strike: data.readBigUInt64LE(212),
    width: data.readBigUInt64LE(220),
    premium: data.readBigUInt64LE(228),
    maxPayout: data.readBigUInt64LE(236),
    feeBps: data.readUInt16LE(244),
    openedAt: Number(data.readBigInt64LE(246)),
    quoteExpiry: Number(data.readBigInt64LE(254)),
  };
}

/** Enumerates every open PoolPosition account program-wide via getProgramAccounts (dataSize filter only -- no owner/pool filter, since the cranker settles for any buyer in any pool). Malformed entries are skipped, never thrown. */
export async function fetchOpenPoolPositions(
  connection: Connection,
  programId: PublicKey = VSOL_PROGRAM_ID,
): Promise<DecodedPoolPosition[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: POOL_POSITION_ACCOUNT_SIZE }],
  });
  const positions: DecodedPoolPosition[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      positions.push(decodePoolPositionAccount(pubkey, Buffer.from(account.data)));
    } catch {
      // Same size but a different account shape (or a corrupt read): not a
      // PoolPosition, so it is silently excluded rather than failing the run.
    }
  }
  return positions;
}

export type DecodedMarketForCleanup = {
  address: string;
  oracle: string;
  creator: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  // --- Added for the keeper's discover-first rung lookup (see
  // ensureMarketRung in scripts/keeper.ts): enough to match an existing
  // on-chain market against a rung's (feed, symbol, policy) fingerprint
  // without re-deriving its address, and to read back the strike it was
  // actually listed at rather than re-computing it from live spot.
  marketId: string;
  symbol: string;
  pythFeedId: string;
  maxConfidenceBps: number;
  priceScale: bigint;
  maxSettlementStalenessSeconds: number;
  enabled: boolean;
  strike: bigint;
};

/** Pure decoder: no RPC, so it is directly unit-testable against fixture buffers. */
export function decodeMarketAccountForCleanup(address: PublicKey, data: Buffer): DecodedMarketForCleanup {
  if (data.length !== MARKET_ACCOUNT_SIZE) {
    throw new Error("The market account size is invalid");
  }
  if (!data.subarray(0, 8).equals(Buffer.from(MARKET_ACCOUNT_DISCRIMINATOR))) {
    throw new Error("The market account discriminator is invalid");
  }
  return {
    address: address.toBase58(),
    oracle: publicKeyAt(data, 137),
    expiry: Number(data.readBigInt64LE(193)),
    observationWindowSeconds: data.readUInt32LE(201),
    settlementGraceSeconds: data.readUInt32LE(205),
    creator: publicKeyAt(data, 245),
    marketId: data.subarray(41, 73).toString("hex"),
    symbol: data.subarray(169, 185).toString("ascii").replace(/\0+$/, ""),
    pythFeedId: data.subarray(211, 243).toString("hex"),
    maxConfidenceBps: data.readUInt16LE(209),
    priceScale: data.readBigUInt64LE(185),
    maxSettlementStalenessSeconds: data.readUInt32LE(277),
    enabled: data[244] === 1,
    strike: data.readBigUInt64LE(281),
  };
}

/**
 * Enumerates every Market account program-wide via getProgramAccounts (dataSize
 * filter only), the same scanning pattern fetchOpenPoolPositions uses for
 * PoolPosition accounts. Malformed entries are skipped, never thrown. A market
 * that has already been closed (its account no longer exists) simply does not
 * appear in the result -- that is precisely what makes "already closed" safe
 * to treat as a non-candidate rather than an error (see
 * selectMarketCloseCandidates below).
 */
export async function fetchAllMarkets(
  connection: Connection,
  programId: PublicKey = VSOL_PROGRAM_ID,
): Promise<DecodedMarketForCleanup[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: MARKET_ACCOUNT_SIZE }],
  });
  const markets: DecodedMarketForCleanup[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      markets.push(decodeMarketAccountForCleanup(pubkey, Buffer.from(account.data)));
    } catch {
      // Same size but a different account shape (or a corrupt read): not a
      // Market, so it is silently excluded rather than failing the run.
    }
  }
  return markets;
}

// --- Pure decision logic (no RPC; the unit-tested core) --------------------

export type MarketWindow = {
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
};

/**
 * `observation_end` in `publish_pyth_settlement`: `expiry + observation_window_seconds`.
 * Split out from `computeSettlementDeadline` (which additionally adds
 * `settlement_grace_seconds`) because it is also, on its own, the exact
 * upper bound of tier 1's acceptance window (`publish_time <= observation_end`)
 * -- both `selectViableSettlementTier` and `fetchPythUpdateForSettlement`
 * need that instant by itself, not bundled with the grace period.
 */
export function computeObservationEnd(market: MarketWindow): number {
  return market.expiry + market.observationWindowSeconds;
}

/**
 * The FULL settlement deadline: expiry + observation window + settlement
 * grace. This is exactly the instant `refund_unsettled`/`refund_pool_position`
 * first become callable on-chain, and the base `computeMarketCloseDeadline`
 * builds on.
 *
 * This is NOT, on its own, "the instant publish_pyth_settlement stops
 * accepting" -- tier 1 remains acceptable at any time up to
 * `computeFinalSettlementDeadline`, and tier 2 (the last-known-price
 * fallback) only opens `SETTLEMENT_REFUND_PRIORITY_SECONDS` after this
 * instant (see `computeTierTwoOpenAt`) and stays open until that same final
 * deadline. `decideMarketPublishAction` uses the wider bound so the cranker
 * keeps attempting `publish_pyth_settlement` for as long as the on-chain
 * instruction could still accept it, not just up to this earlier instant.
 */
export function computeSettlementDeadline(market: MarketWindow): number {
  return computeObservationEnd(market) + market.settlementGraceSeconds;
}

/**
 * MUST match `SETTLEMENT_REFUND_PRIORITY_SECONDS` in
 * vsol/programs/vsol/src/lib.rs. Deliberately separates tier 2's on-chain
 * gate from `refund_unsettled`/`refund_pool_position`'s deadline
 * (`computeSettlementDeadline`), which both become callable at exactly that
 * instant: without this buffer, tier 2 would become eligible in the exact
 * same instant as the refund path, making the outcome for a position still
 * open at that boundary depend on ambiguous same-slot transaction-ordering
 * luck. Refund deliberately wins the tie -- see the on-chain constant's doc
 * comment for the full rationale.
 */
export const SETTLEMENT_REFUND_PRIORITY_SECONDS = 60;

export type PublishWindow = MarketWindow & { maxSettlementStalenessSeconds: number };

/**
 * The instant tier 2 (the last-known-price fallback) may first be used
 * on-chain. Mirrors `tier_two_open_at` in `publish_pyth_settlement`.
 */
export function computeTierTwoOpenAt(market: MarketWindow): number {
  return computeSettlementDeadline(market) + SETTLEMENT_REFUND_PRIORITY_SECONDS;
}

/**
 * The instant `publish_pyth_settlement` closes for good -- neither tier can
 * publish past this. Mirrors `final_deadline` on-chain:
 * `computeSettlementDeadline` PLUS the market's own
 * `maxSettlementStalenessSeconds`. Deliberately NOT
 * `computeTierTwoOpenAt(market) + maxSettlementStalenessSeconds` -- the
 * priority buffer trims tier 2's window from the front only, so it never
 * pushes this back edge later (see the on-chain doc comment for why that
 * matters: it keeps this within `MARKET_CLEANUP_BUFFER_SECONDS` of
 * `computeSettlementDeadline` for every legal market).
 */
export function computeFinalSettlementDeadline(market: PublishWindow): number {
  return computeSettlementDeadline(market) + market.maxSettlementStalenessSeconds;
}

/**
 * MUST match `MARKET_CLEANUP_BUFFER_SECONDS` in
 * vsol/programs/vsol/src/lib.rs. The on-chain instruction refuses to close a
 * market until this much time has passed BEYOND the settlement deadline, so a
 * cleaner that used the bare deadline would just burn fees on transactions
 * that revert with `MarketNotCloseable` for a week.
 */
export const MARKET_CLEANUP_BUFFER_SECONDS = 604_800;

/**
 * The instant `close_settled_market` will actually accept, as opposed to the
 * instant a stranded position becomes refundable
 * (`computeSettlementDeadline`). These are deliberately NOT the same moment:
 * closing at the refund deadline races in-flight refunds and permanently
 * strands their escrow.
 */
export function computeMarketCloseDeadline(market: MarketWindow): number {
  return computeSettlementDeadline(market) + MARKET_CLEANUP_BUFFER_SECONDS;
}

/** Filters decoded positions down to those whose market has passed expiry, given a map of market address -> expiry (unix seconds) and the current clock. Positions whose market is absent from the map are excluded (caller logs those separately as "market unreadable"). */
export function filterExpiredOpenPositions(
  positions: readonly DecodedPoolPosition[],
  marketExpiries: ReadonlyMap<string, number>,
  now: number,
): DecodedPoolPosition[] {
  return positions.filter((position) => {
    const expiry = marketExpiries.get(position.market);
    return expiry !== undefined && now >= expiry;
  });
}

/** Groups positions by their market address, preserving encounter order within each group. */
export function groupPositionsByMarket(
  positions: readonly DecodedPoolPosition[],
): Map<string, DecodedPoolPosition[]> {
  const groups = new Map<string, DecodedPoolPosition[]>();
  for (const position of positions) {
    const existing = groups.get(position.market);
    if (existing) existing.push(position);
    else groups.set(position.market, [position]);
  }
  return groups;
}

/**
 * Builds the "markets with an open position" set selectMarketCloseCandidates
 * uses for its stranding-prevention check. Two account types reference a
 * market via `has_one = market` and both must count: pool-backed
 * `PoolPosition` and direct-maker `Position` (see decodeDirectPositionMarket's
 * doc comment for why the latter is just as load-bearing -- `settle` and
 * `refund_unsettled` both load `Market` via `has_one` exactly like
 * `settle_pool_position`/`refund_pool_position` do). Pulling this into its
 * own pure, exported function (rather than inlining `new Set([...a, ...b])`
 * at the call site) makes the union itself directly unit-testable: a
 * regression that drops one of the two input arrays here is exactly the bug
 * class this function exists to catch.
 */
export function marketsWithOpenPositions(params: {
  poolPositions: readonly DecodedPoolPosition[];
  directPositions: readonly DecodedDirectPosition[];
}): Set<string> {
  return new Set([
    ...params.poolPositions.map((position) => position.market),
    ...params.directPositions.map((position) => position.market),
  ]);
}

// --- Conditional-token ("complete set") collateral vault --------------------
// FINDING 1 fix: `close_settled_market` now requires the market's collateral
// vault (see `COMPLETE_SET_VAULT_SEED` / `deriveCompleteSetVault`) to be
// either never-created or fully drained before it will close -- see
// `CloseSettledMarket::collateral_vault`'s doc comment in
// vsol/programs/vsol/src/lib.rs. This section gives the off-chain cleanup
// pass the SAME exclusion, so it stops burning fees retrying
// `close_settled_market` forever against a market it can no longer close
// (rather than relying on every caller to discover that the hard way from a
// `MarketHasOutstandingCollateral` revert).

// Standard SPL Token `Account` layout: mint(32) + owner(32) + amount(8) +
// ... -- `amount` is the only field this cleanup pass needs.
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_MIN_SIZE = TOKEN_ACCOUNT_AMOUNT_OFFSET + 8;

/**
 * Pure decoder: no RPC, so it is directly unit-testable against fixture
 * buffers. Only decodes `amount` -- the one field this cleanup pass needs
 * from the collateral vault.
 */
export function decodeTokenAccountAmount(data: Buffer): bigint {
  if (data.length < TOKEN_ACCOUNT_MIN_SIZE) {
    throw new Error("The token account size is invalid");
  }
  return data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

/**
 * Fetches each market's complete-set collateral vault balance in one batched
 * `getMultipleAccountsInfo` call. A market whose vault PDA does not exist at
 * all (nobody ever called `mint_complete_set` against it) maps to `0n` --
 * exactly the same "nothing to check" state the on-chain handler treats an
 * empty/uninitialized vault as (see `CloseSettledMarket::collateral_vault`'s
 * doc comment). A vault account that exists but fails to decode (wrong size,
 * unexpected shape) is treated as non-zero/unsafe-to-close rather than
 * silently skipped -- unlike the position/market decoders above, silently
 * excluding a malformed vault here would be excluding it from a SAFETY
 * check, not from a candidate list, so the conservative failure direction is
 * reversed.
 */
export async function fetchCollateralVaultBalances(
  connection: Connection,
  markets: readonly PublicKey[],
  programId: PublicKey = VSOL_PROGRAM_ID,
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  if (markets.length === 0) return result;
  const vaults = markets.map((market) => deriveCompleteSetVault(market, programId));
  const accounts = await connection.getMultipleAccountsInfo(vaults, { commitment: "confirmed" });
  markets.forEach((market, index) => {
    const account = accounts[index];
    if (!account) {
      result.set(market.toBase58(), 0n);
      return;
    }
    try {
      result.set(market.toBase58(), decodeTokenAccountAmount(Buffer.from(account.data)));
    } catch {
      // Exists but doesn't decode as a token account: treat as non-zero so
      // it excludes the market from closing rather than risking stranding it.
      result.set(market.toBase58(), 1n);
    }
  });
  return result;
}

/**
 * Builds the "markets with outstanding collateral" set
 * `selectMarketCloseCandidates` uses for its FINDING 1 exclusion, given a
 * balance map from `fetchCollateralVaultBalances`. Pulled into its own pure,
 * exported, unit-tested function for the same reason `marketsWithOpenPositions`
 * is: it isolates "which markets are unsafe to close" from "how their
 * balances were fetched", so the filtering logic is testable with plain
 * fixture data instead of a live RPC connection.
 */
export function marketsWithOutstandingCollateral(balances: ReadonlyMap<string, bigint>): Set<string> {
  const result = new Set<string>();
  for (const [market, balance] of balances) {
    if (balance > 0n) result.add(market);
  }
  return result;
}

/**
 * The market-cleanup safety predicate. `close_settled_market` cannot verify
 * on-chain that no open position still references the market (positions are
 * PDAs keyed by nonce, not enumerable from the market), so this predicate is
 * the only thing standing between a candidate market and a permanently
 * stranded position. A market is a close candidate ONLY IF, ALL of:
 *
 *   1. Its close deadline has fully elapsed: `now > computeMarketCloseDeadline(market)`
 *      (`expiry + observationWindowSeconds + settlementGraceSeconds +
 *      MARKET_CLEANUP_BUFFER_SECONDS`), using the same strict `>` the
 *      on-chain instruction itself requires. NOTE this is deliberately LATER
 *      than `computeSettlementDeadline` -- that earlier instant is when a
 *      stranded position first becomes refundable, and closing there would
 *      race the refund and strand its escrow forever.
 *   2. Its address is NOT in `marketsWithOpenPositions` -- the
 *      stranding-prevention check. This set MUST be built from a position
 *      scan the caller took at or after the moment it decided to run
 *      cleanup this pass (see cranker.ts, which re-scans open positions
 *      immediately after the settle/refund phase and only then computes this
 *      set and calls this function), so that a position just settled or
 *      refunded this same pass has already dropped out of it before this
 *      predicate runs.
 *   3. Its address is NOT in `marketsWithOutstandingCollateral` -- the
 *      FINDING 1 exclusion, mirroring the on-chain handler's own
 *      `MarketHasOutstandingCollateral` check (see
 *      `CloseSettledMarket::collateral_vault`'s doc comment in lib.rs). This
 *      is a cheap, exact mirror (unlike point 2's position scan, this vault
 *      balance really is fully enumerable from the market alone) -- it
 *      exists here purely so this cleanup pass does not keep re-attempting
 *      (and paying transaction fees for) a `close_settled_market` call the
 *      chain will simply revert, not because the on-chain check is
 *      insufficient on its own.
 *
 * "Already closed" requires no explicit branch here: a closed market's
 * account no longer exists on-chain, so it is simply absent from the
 * `markets` array the caller passes in (see fetchAllMarkets), never present
 * with some "closed" flag to check.
 *
 * The result is capped at `maxPerRun`, preserving `markets` order, so a large
 * backlog of closeable markets cannot make a single run unbounded.
 */
export function selectMarketCloseCandidates(params: {
  markets: readonly DecodedMarketForCleanup[];
  now: number;
  marketsWithOpenPositions: ReadonlySet<string>;
  marketsWithOutstandingCollateral: ReadonlySet<string>;
  maxPerRun: number;
}): DecodedMarketForCleanup[] {
  const candidates = params.markets.filter((market) => {
    if (params.now <= computeMarketCloseDeadline(market)) return false;
    if (params.marketsWithOpenPositions.has(market.address)) return false;
    if (params.marketsWithOutstandingCollateral.has(market.address)) return false;
    return true;
  });
  return candidates.slice(0, Math.max(0, params.maxPerRun));
}

export type MarketPublishDecision = { kind: "publish" } | { kind: "skip"; reason: string };

/**
 * Whether it is even worth attempting `publish_pyth_settlement` for a market
 * this pass, given only chain state (no Pyth price yet -- that is fetched
 * only after this says "publish"). The program itself decides tier-1 vs
 * tier-2 acceptability once a real price update is presented; this just
 * rules out the cases that are certain to fail or are unnecessary.
 *
 * Uses `computeFinalSettlementDeadline`, NOT the earlier
 * `computeSettlementDeadline`: the on-chain instruction keeps accepting
 * tier-1 prints (and, after `computeTierTwoOpenAt`, tier-2 prints) all the
 * way out to the final deadline, so stopping at the earlier bound would
 * make the cranker give up on legitimate settlements it could still land --
 * in particular every tier-2 case, which by definition only becomes
 * reachable after `computeSettlementDeadline`. Attempting `publish` inside
 * that window when nothing is actually acceptable yet is not a correctness
 * problem: the on-chain program rejects with `InvalidObservationTime`,
 * which the caller already treats as an ordinary skip (see
 * `describeSettlementError`).
 */
export function decideMarketPublishAction(
  params: PublishWindow & { now: number; oracleFinalized: boolean },
): MarketPublishDecision {
  if (params.oracleFinalized) return { kind: "skip", reason: "oracle already finalized" };
  if (params.now < params.expiry) return { kind: "skip", reason: "market has not expired yet" };
  if (params.now > computeFinalSettlementDeadline(params)) {
    return { kind: "skip", reason: "settlement window has closed; refund_pool_position applies instead" };
  }
  return { kind: "publish" };
}

export type ViableSettlementTier = "tier-one" | "tier-two";

/**
 * Which settlement tier -- if either -- `publish_pyth_settlement` could
 * currently accept a print for, given only wall-clock timing (no Pyth price
 * fetched yet). This is the fix for a confirmed live bug: the cranker used
 * to always fetch "the latest Hermes print" for every publish attempt, which
 * only ever satisfies tier 1 (and only on the rare cranker pass that happens
 * to land inside the 30-second observation window), and can NEVER satisfy
 * tier 2 -- tier 2 requires a print AT OR BEFORE `expiry`, and "the latest
 * print" is by construction never before `expiry` once the market has
 * expired. Measured on the live deployment: 13 of 14 expired markets had
 * unfinalized oracles as a direct result. This function tells
 * `fetchPythUpdateForSettlement` which Hermes query strategy is even worth
 * trying, so it stops blindly fetching "latest" and instead fetches the
 * print the currently-open tier actually needs.
 *
 * Built entirely from the SAME pure helpers `decideMarketPublishAction`
 * already uses (`computeObservationEnd`, `computeTierTwoOpenAt`,
 * `computeFinalSettlementDeadline`) -- this does not re-derive or restate
 * any timing rule, and does not change what `decideMarketPublishAction`
 * itself decides (that function still owns "is a publish attempt even worth
 * making at all", e.g. the `oracleFinalized` check this function does not
 * repeat).
 *
 * Returns:
 *  - `"tier-one"`: `now` is within `[expiry, observation_end]`. A print
 *    fetched right now ("whatever Hermes has right now") is expected to
 *    land inside the tier-1 window, since Hermes' latest print trails `now`
 *    by at most a few seconds while the feed is actively publishing.
 *  - `"tier-two"`: tier 2's own gate (`computeTierTwoOpenAt`) has opened,
 *    and the final settlement deadline has not yet passed.
 *  - `null`: neither -- either before `expiry`, in the gap between
 *    `observation_end` and `computeTierTwoOpenAt` (exactly
 *    `SETTLEMENT_REFUND_PRIORITY_SECONDS` wide) where nothing
 *    chain-acceptable can be freshly fetched, or past
 *    `computeFinalSettlementDeadline` altogether.
 */
export function selectViableSettlementTier(
  params: PublishWindow & { now: number },
): ViableSettlementTier | null {
  const { now } = params;
  if (now < params.expiry) return null;
  if (now <= computeObservationEnd(params)) return "tier-one";
  if (now > computeTierTwoOpenAt(params) && now <= computeFinalSettlementDeadline(params)) {
    return "tier-two";
  }
  return null;
}

/**
 * Builds the "publish-attempt set": the markets `runSettlementPhase` should
 * even bother calling `decideMarketPublishAction` for this pass.
 *
 * FIX for a confirmed live bug: `runSettlementPhase` used to build its ENTIRE
 * work list from `fetchOpenPoolPositions` -- `[...new Set(positions.map(p =>
 * p.market))]` -- so a market reachable from no `PoolPosition` and no direct
 * `Position` was never enumerated at all. A v2 conditional-token market is
 * exactly that: its only on-chain state is two SPL mints (UP/DOWN) and a
 * complete-set collateral vault, no position account of either kind. Such a
 * market's oracle was therefore NEVER finalized by this cranker, so
 * `redeem_winning` reverted with `OracleNotFinalized` forever, and holders'
 * only recourse was `redeem_unresolved` once `final_deadline` passed -- which
 * pays pro-rata 50/50 regardless of who actually won. That silently turned
 * the product into a coin flip for every conditional-token market. This
 * function is the enumeration fix: it adds "has a non-zero complete-set
 * vault" as an independent reason a market belongs in the publish-attempt
 * set, alongside "has an open position" (pool-backed OR direct-maker -- see
 * `marketsWithOpenPositions`).
 *
 * A market belongs in the set when ALL of:
 *   1. It has passed expiry: `now >= market.expiry` (inclusive, matching
 *      `filterExpiredOpenPositions` and `decideMarketPublishAction`'s own
 *      `now < expiry` skip check).
 *   2. Its oracle is not already finalized -- a finalized oracle needs no
 *      further publish attempt (`decideMarketPublishAction` would just skip
 *      it), so excluding it here avoids the wasted Hermes fetch + tx attempt
 *      for every already-settled market on the whole deployment.
 *   3. It has something at stake: its address is in `marketsWithOpenPositions`
 *      OR in `marketsWithOutstandingCollateral`.
 *
 * This is deliberately a COARSE pre-filter, not a replacement for
 * `decideMarketPublishAction`: it decides ONLY which markets are worth
 * calling that function for, never how the tier-1/tier-2/final-deadline
 * timing itself is decided -- that logic is unchanged and unweakened.
 *
 * IMPORTANT -- what this function is deliberately NOT used for: gating
 * whether a market's already-open positions get their settle/refund
 * decision made. A market whose oracle was already finalized (by a prior
 * pass, a concurrent cranker, or the buyer's own settlement call) is
 * EXCLUDED from this set by rule 2 above, yet may still have an open
 * position waiting on `settle_pool_position`/`refund_pool_position`. The
 * caller must keep driving that loop from its own expired-position scan
 * (unioned with this set), never from this set alone, or settlement would
 * regress for exactly that already-finalized case.
 *
 * Every market address appears at most once in the input `markets` array
 * (one account per market), so the result is deduplicated by construction:
 * a market present in BOTH `marketsWithOpenPositions` and
 * `marketsWithOutstandingCollateral` is selected exactly once, never twice.
 */
export function selectMarketsNeedingSettlementAttempt(params: {
  markets: readonly DecodedMarketForCleanup[];
  now: number;
  marketsWithFinalizedOracle: ReadonlySet<string>;
  marketsWithOpenPositions: ReadonlySet<string>;
  marketsWithOutstandingCollateral: ReadonlySet<string>;
}): DecodedMarketForCleanup[] {
  return params.markets.filter((market) => {
    if (params.now < market.expiry) return false;
    if (params.marketsWithFinalizedOracle.has(market.address)) return false;
    return (
      params.marketsWithOpenPositions.has(market.address) ||
      params.marketsWithOutstandingCollateral.has(market.address)
    );
  });
}

export type PoolPositionDecision = { kind: "settle" } | { kind: "refund" } | { kind: "skip"; reason: string };

/**
 * Decides the action for a single expired open position given the oracle's
 * current finalized state and the market's settlement deadline.
 *
 * Deliberately still gates "refund" on the bare `computeSettlementDeadline`
 * (unchanged), not on `computeTierTwoOpenAt` or `computeFinalSettlementDeadline`:
 * this is the "refund wins the tie" half of the settle/refund race decision
 * described on `SETTLEMENT_REFUND_PRIORITY_SECONDS`. The on-chain refund
 * path opens at exactly `computeSettlementDeadline` regardless of whether a
 * tier-2 print might show up later, so this cranker mirrors that: it does
 * not hold a position open waiting on the mere possibility of a tier-2
 * settlement once refunding is already legal. A finalized oracle (tier 1 or
 * tier 2, from this cranker's own publish attempt or anyone else's) always
 * takes priority over a refund, at any time -- see the `oracleFinalized`
 * check ordered first below.
 */
export function decidePositionAction(
  params: MarketWindow & { now: number; oracleFinalized: boolean },
): PoolPositionDecision {
  if (params.now < params.expiry) return { kind: "skip", reason: "market has not expired yet" };
  if (params.oracleFinalized) return { kind: "settle" };
  if (params.now > computeSettlementDeadline(params)) return { kind: "refund" };
  return { kind: "skip", reason: "oracle not finalized and the settlement window is still open" };
}

// --- Chain state fetch helpers (thin wrappers over the Anchor account namespace) ---

export type MarketState = {
  oracle: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  maxSettlementStalenessSeconds: number;
  pythFeedId: string;
  enabled: boolean;
};

/** Fetches and flattens Market accounts (keyed by base58 address) via the Anchor account namespace, mirroring bootstrap.ts's `.account.X.fetch` pattern. Markets that no longer exist are simply absent from the returned map. */
export async function fetchMarketStates(
  program: Program<Vsol>,
  marketAddresses: readonly PublicKey[],
): Promise<Map<string, MarketState>> {
  const result = new Map<string, MarketState>();
  if (marketAddresses.length === 0) return result;
  const accounts = await program.account.market.fetchMultiple([...marketAddresses]);
  accounts.forEach((account, index) => {
    if (!account) return;
    result.set(marketAddresses[index].toBase58(), {
      oracle: account.oracle.toBase58(),
      expiry: account.expiry.toNumber(),
      observationWindowSeconds: account.observationWindowSeconds,
      settlementGraceSeconds: account.settlementGraceSeconds,
      maxSettlementStalenessSeconds: account.maxSettlementStalenessSeconds,
      pythFeedId: Buffer.from(account.pythFeedId).toString("hex"),
      enabled: account.enabled,
    });
  });
  return result;
}

export type OracleState = { finalized: boolean };

/** Fetches and flattens SettlementOracle accounts (keyed by base58 address). Oracles that no longer exist are absent from the returned map -- callers should treat that defensively (not as "finalized: false"). */
export async function fetchOracleStates(
  program: Program<Vsol>,
  oracleAddresses: readonly PublicKey[],
): Promise<Map<string, OracleState>> {
  const result = new Map<string, OracleState>();
  if (oracleAddresses.length === 0) return result;
  const accounts = await program.account.settlementOracle.fetchMultiple([...oracleAddresses]);
  accounts.forEach((account, index) => {
    if (!account) return;
    result.set(oracleAddresses[index].toBase58(), { finalized: account.finalized });
  });
  return result;
}

// --- Logging helpers ---------------------------------------------------------

/** Redacts a secret (e.g. the configured RPC URL) from a log line. Pure two-arg form (unlike keeper.ts's closure-based redact()) so it has no module-scope environment dependency and stays trivially testable. */
export function redact(text: string, secret: string): string {
  return secret.length > 0 ? text.split(secret).join("[redacted]") : text;
}

/** Extracts the on-chain error code (e.g. "OracleAlreadyFinalized") from an AnchorError, if the error is one. */
export function anchorErrorCode(error: unknown): string | undefined {
  return error instanceof AnchorError ? error.error.errorCode.code : undefined;
}

/** Formats an error for a one-line skip/failure log, redacting the RPC URL and surfacing the Anchor error code (the skip taxonomy: OracleAlreadyFinalized / OracleNotFinalized / InvalidObservationTime / SettlementWindowOpen / SettlementWindowClosed / PositionNotOpen / CollateralMismatch, or a raw message for anything else, e.g. a lost close race). */
export function describeSettlementError(error: unknown, secret: string): string {
  const code = anchorErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return redact(code ? `${code}: ${message}` : message, secret);
}

// --- Pyth publish flow (mirrors bootstrap.ts's publishPythSettlement) -------

export type PythUpdate = Awaited<ReturnType<HermesClient["getLatestPriceUpdates"]>>;

/** Fetches whatever Hermes currently has for a feed (a single call, no retry loop -- unlike bootstrap.ts's pythUpdateAtOrAfter, which is written for a short-lived smoke market and waits for a print at/after a known expiry). The cranker runs on an interval, so "nothing acceptable yet" is simply retried next pass rather than blocked on here. */
export async function fetchLatestPythUpdate(
  hermes: HermesClient,
  feedId: string,
): Promise<{ update: PythUpdate; publishTime: number }> {
  const update = await hermes.getLatestPriceUpdates([feedId], { encoding: "base64", parsed: true });
  const parsed = update.parsed?.[0];
  if (!parsed || parsed.id.toLowerCase() !== feedId.toLowerCase()) {
    throw new Error(`Hermes returned no update for feed ${feedId}`);
  }
  if (update.binary.encoding !== "base64" || !update.binary.data.length) {
    throw new Error("Hermes returned no base64 Pyth update");
  }
  return { update, publishTime: parsed.price.publish_time };
}

// --- Tier-appropriate Pyth fetch (the actual bug fix) ------------------------
// `fetchLatestPythUpdate` above always returns the NEWEST print, which
// `publish_pyth_settlement` only accepts under tier 1, and only on the rare
// cranker pass that happens to land inside the 30-second observation window
// -- it can never satisfy tier 2 (see `selectViableSettlementTier`'s doc
// comment for the confirmed live impact). The functions below fetch the
// print the CURRENTLY VIABLE tier actually needs instead of always asking
// Hermes for "latest".

// The print search walks the feed's ACTUAL print sequence rather than a
// timestamp grid. Two earlier strategies failed against the live feed and are
// recorded here so neither is reintroduced:
//
//   * A binary search for "the latest timestamp with any data" is INVALID.
//     Binary search needs "data at T implies data at every earlier T in
//     range", but the NVDA feed only publishes during US equity hours, so
//     availability across [expiry - staleness, expiry] is dark -> live ->
//     dark. There is no cutoff to converge on; it lands correctly only by
//     luck.
//   * Walking back on a FIXED stride (60s) hops over prints. The measured
//     acceptable print sat 916s from the anchor -- not a multiple of 60 -- so
//     a 60s grid stepped straight past it and reported a false negative after
//     46 probes.
//
// Instead: anchor at the feed's newest print (one getLatestPriceUpdates call,
// no search at all), then after each rejection resume at
// `returnedPublishTime - 1`, which lands on a real print every time. A dark
// gap is escaped by widening the step geometrically. Measured: 3 probes,
// where the old strategy burned 46 and still failed.

export type PythSettlementFetchResult =
  | {
      ok: true;
      tier: ViableSettlementTier;
      update: PythUpdate;
      publishTime: number;
      ageSeconds: number;
      probeCount: number;
    }
  | { ok: false; reason: string };

// --- Confidence-aware print selection (the SECOND confirmed live bug) ------
// "The latest print that exists" is not the same thing as "the latest print
// the chain will ACCEPT". A live tier-2 settlement was rejected on-chain with
// error 6039 (`OracleConfidenceTooWide`) because the print tier 2 selected --
// Hermes' latest print at/before expiry -- was the feed's FINAL print at
// market close, where Pyth blows its own confidence band open. Measured live
// against feed b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593:
// the 20:00:19Z closing print carries conf_bps 887 against a 500 bps market
// bound, while the 19:45:00Z print ~15 minutes earlier carries conf_bps 5. For
// any market expiring while the feed is dark (equities trade roughly 19% of
// the week), "latest print at or before expiry" IS that closing print, so
// tier-2 (and, at an expiry landing exactly at the close, tier-1) selection
// was predictably picking a print the program is guaranteed to reject.
//
// Confidence is NOT monotonic in time, so a plain binary search cannot locate
// "the latest print satisfying the acceptance predicate" the way
// the anchor is the feed's newest print, located without any search.
// The fix keeps that binary search exactly as-is (to find a starting anchor)
// and adds a small bounded walk BACKWARDS from that anchor
// (`walkPrintSequenceForAcceptablePrint`), re-testing the full acceptance
// predicate (`isSettlementPrintAcceptable`: time bounds AND confidence) at
// each step, stopping at the first passing print.

/** MUST match `BPS_DENOMINATOR` in vsol/programs/vsol/src/lib.rs. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * A single Pyth print, parsed to the fields `isSettlementPrintAcceptable`
 * needs: Hermes' own `price`/`conf` (NOT the on-chain normalized scale).
 * `normalize_pyth_price` in lib.rs scales both proportionally by the same
 * factor, so the confidence-to-price RATIO the `OracleConfidenceTooWide`
 * check depends on is identical whichever scale it is evaluated at -- see the
 * `confidence_bps`/`max_confidence` check immediately after that function in
 * `publish_pyth_settlement`.
 */
export type SettlementPrintCandidate = {
  publishTime: number;
  price: bigint;
  conf: bigint;
};

/**
 * `conf * BPS_DENOMINATOR / price`, floored -- the same ratio
 * `publish_pyth_settlement` computes (as `confidence_bps`, compared against
 * `max_confidence_bps * price`) but expressed as a single bps number for
 * logging/diagnostics. A non-positive price can never satisfy the on-chain
 * check (see `isSettlementPrintAcceptable`), so it is reported as
 * `Number.POSITIVE_INFINITY` here rather than dividing by zero or a negative
 * number.
 */
export function confidenceBpsOf(candidate: SettlementPrintCandidate): number {
  if (candidate.price <= 0n) return Number.POSITIVE_INFINITY;
  return Number((candidate.conf * BPS_DENOMINATOR) / candidate.price);
}

export type PrintAcceptabilityReason =
  | "publish_time_before_lower_bound"
  | "publish_time_after_upper_bound"
  | "staleness_exceeds_bound"
  | "confidence_too_wide";

export type PrintAcceptabilityResult = { ok: true } | { ok: false; reason: PrintAcceptabilityReason; detail: string };

/**
 * THE fix for the confirmed live `OracleConfidenceTooWide` rejection: mirrors
 * every on-chain acceptance condition `publish_pyth_settlement` checks for a
 * given tier, so a caller can test a candidate print BEFORE spending a
 * transaction on it -- exactly as the pre-existing tier bound checks used to
 * do for timing alone. Pure and network-free by design (per this module's
 * pure-core/thin-RPC-shell split), so it is directly unit-testable against
 * the real measured numbers from the live failure.
 *
 * tier === "tier-one": `publish_time` must fall within
 * `[expiry, observation_end]` (mirrors `tier_one_ok`'s two `publish_time`
 * bounds -- NOT its separate `publish_time <= now` freshness bound, which
 * depends on wall-clock `now` rather than the print alone and is enforced by
 * the RPC shell after a candidate is picked, not by this pure predicate).
 *
 * tier === "tier-two": `publish_time` must be at or before `expiry`, AND
 * `expiry - publish_time` must not exceed `window.maxSettlementStalenessSeconds`
 * (mirrors `tier_two_ok`'s two bounds exactly).
 *
 * Both tiers, in addition: `conf * BPS_DENOMINATOR <= price * maxConfidenceBps`
 * -- the exact `OracleConfidenceTooWide` check, evaluated directly on Hermes'
 * parsed price/conf (see `SettlementPrintCandidate`'s doc comment for why
 * that is equivalent to the on-chain normalized-scale check).
 */
export function isSettlementPrintAcceptable(params: {
  tier: ViableSettlementTier;
  candidate: SettlementPrintCandidate;
  window: PublishWindow;
  maxConfidenceBps: number;
}): PrintAcceptabilityResult {
  const { tier, candidate, window, maxConfidenceBps } = params;
  const { publishTime, price, conf } = candidate;

  if (tier === "tier-one") {
    const observationEnd = computeObservationEnd(window);
    if (publishTime < window.expiry) {
      return {
        ok: false,
        reason: "publish_time_before_lower_bound",
        detail: `publish_time ${publishTime} is before expiry ${window.expiry}`,
      };
    }
    if (publishTime > observationEnd) {
      return {
        ok: false,
        reason: "publish_time_after_upper_bound",
        detail: `publish_time ${publishTime} is after observation_end ${observationEnd}`,
      };
    }
  } else {
    if (publishTime > window.expiry) {
      return {
        ok: false,
        reason: "publish_time_after_upper_bound",
        detail: `publish_time ${publishTime} is after expiry ${window.expiry}`,
      };
    }
    const staleness = window.expiry - publishTime;
    if (staleness > window.maxSettlementStalenessSeconds) {
      return {
        ok: false,
        reason: "staleness_exceeds_bound",
        detail: `staleness ${staleness}s (expiry ${window.expiry} - publish_time ${publishTime}) exceeds the ${window.maxSettlementStalenessSeconds}s bound`,
      };
    }
  }

  // Mirrors `confidence_bps <= max_confidence` in publish_pyth_settlement
  // exactly (see BPS_DENOMINATOR's doc comment for why the raw Hermes scale
  // is equivalent to the on-chain normalized scale here).
  if (conf * BPS_DENOMINATOR > price * BigInt(maxConfidenceBps)) {
    return {
      ok: false,
      reason: "confidence_too_wide",
      detail: `confidence ${confidenceBpsOf(candidate)} bps (price ${price}, conf ${conf}) exceeds the ${maxConfidenceBps} bps bound`,
    };
  }
  return { ok: true };
}

/** Injected fetch for `walkPrintSequenceForAcceptablePrint`: resolves the parsed candidate AND an arbitrary caller-supplied payload (the raw `PythUpdate`, for the RPC shell) together, or `null` if Hermes has nothing at `timestamp`. Mirrors `TimestampProbe<T>`'s injection pattern above. */
/**
 * The three-valued result of probing Hermes at one timestamp.
 *
 * Three-valued deliberately. An earlier version used `T | null` with a
 * blanket `catch { return null }`, which made a transient `fetch failed` or
 * 429 indistinguishable from Hermes' genuine 404 "Update data not found" --
 * a live run ended with `fetch failed` and reported "no print available"
 * for a range that demonstrably contained acceptable prints. A 404 is DATA
 * ("the feed published nothing here"); anything else is an error and must
 * surface as one, never as absence.
 */
export type SettlementPrintProbeResult<T> =
  | { kind: "print"; candidate: SettlementPrintCandidate; value: T }
  | { kind: "absent" };

export type SettlementPrintProbe<T> = (timestamp: number) => Promise<SettlementPrintProbeResult<T>>;

export type SettlementPrintWalkResult<T> =
  | { ok: true; candidate: SettlementPrintCandidate; value: T; probeCount: number }
  | { ok: false; reason: "no_print_available"; detail: string; probeCount: number }
  | {
      ok: false;
      reason: "confidence_too_wide";
      detail: string;
      probeCount: number;
      bestConfBps: number;
      maxConfidenceBps: number;
    };

/** First step used to escape a dark gap (a stretch where the feed published nothing). */
export const SETTLEMENT_PRINT_GAP_STEP_SECONDS = 60;
/** Each successive 404 multiplies the gap step by this, so a multi-hour overnight gap costs a handful of probes rather than hundreds. */
export const SETTLEMENT_PRINT_GAP_GROWTH = 4;
/** Ceiling on the gap step, so the walk cannot leap over an entire trading session. */
export const SETTLEMENT_PRINT_GAP_MAX_SECONDS = 3_600;
/** Hard cap on probes for one settlement attempt. The measured live case needs 2 here; the cap only bounds pathological feeds. */
export const SETTLEMENT_PRINT_MAX_PROBES = 40;

/**
 * Walks backwards from `startTimestamp` looking for the newest print that
 * satisfies the FULL on-chain acceptance predicate (time bounds AND
 * confidence), never probing below `lowerBound`.
 *
 * The walk steps onto real prints rather than a timestamp grid: after a
 * print is rejected, the next probe is at `publishTime - 1`, which is by
 * construction the newest instant that could hold a different print. Only a
 * 404 (a genuine gap in publication) advances by a synthetic step, and that
 * step widens geometrically so an overnight gap is crossed cheaply.
 *
 * Why not a binary search: confidence is not monotonic in time, and neither
 * is availability for an equities feed -- see the note above this section.
 *
 * Errors from `probe` are NOT caught here. A network failure must propagate
 * rather than masquerade as "the feed published nothing".
 *
 * Distinguishes its two failure modes so an operator can act on them: no
 * print existed anywhere in range (`no_print_available`) versus prints
 * existed but every one was too wide (`confidence_too_wide`, carrying the
 * best observed bps and the bound it was measured against).
 */
export async function walkPrintSequenceForAcceptablePrint<T>(params: {
  probe: SettlementPrintProbe<T>;
  tier: ViableSettlementTier;
  window: PublishWindow;
  maxConfidenceBps: number;
  startTimestamp: number;
  lowerBound: number;
  maxProbes?: number;
}): Promise<SettlementPrintWalkResult<T>> {
  const maxProbes = params.maxProbes ?? SETTLEMENT_PRINT_MAX_PROBES;

  let timestamp = params.startTimestamp;
  let gapStep = SETTLEMENT_PRINT_GAP_STEP_SECONDS;
  let probeCount = 0;
  let anyPrintFound = false;
  let bestConfBps: number | null = null;

  while (timestamp >= params.lowerBound && probeCount < maxProbes) {
    probeCount += 1;
    // eslint-disable-next-line no-await-in-loop -- inherently sequential: each probe's target depends on the previous print's publish time.
    const probed = await params.probe(timestamp);

    if (probed.kind === "absent") {
      // A gap in publication. Jump back by a widening step to cross it.
      timestamp -= gapStep;
      gapStep = Math.min(gapStep * SETTLEMENT_PRINT_GAP_GROWTH, SETTLEMENT_PRINT_GAP_MAX_SECONDS);
      continue;
    }

    // Landed on a real print: reset the gap stride.
    gapStep = SETTLEMENT_PRINT_GAP_STEP_SECONDS;
    anyPrintFound = true;

    const acceptability = isSettlementPrintAcceptable({
      tier: params.tier,
      candidate: probed.candidate,
      window: params.window,
      maxConfidenceBps: params.maxConfidenceBps,
    });
    if (acceptability.ok) {
      return { ok: true, candidate: probed.candidate, value: probed.value, probeCount };
    }

    const confBps = confidenceBpsOf(probed.candidate);
    if (bestConfBps === null || confBps < bestConfBps) bestConfBps = confBps;

    // Resume at the instant just before this print, which lands on a real
    // print rather than an arbitrary grid position.
    const next = probed.candidate.publishTime - 1;
    timestamp = next < timestamp ? next : timestamp - 1;
  }

  if (!anyPrintFound) {
    return {
      ok: false,
      reason: "no_print_available",
      detail: `no print was available at any of the ${probeCount} timestamp(s) probed walking back from ${params.startTimestamp} (floor ${params.lowerBound})`,
      probeCount,
    };
  }
  return {
    ok: false,
    reason: "confidence_too_wide",
    detail: `${probeCount} print(s) probed walking back from ${params.startTimestamp}; the best candidate carried ${bestConfBps} bps confidence, exceeding the ${params.maxConfidenceBps} bps bound`,
    probeCount,
    bestConfBps: bestConfBps ?? Number.POSITIVE_INFINITY,
    maxConfidenceBps: params.maxConfidenceBps,
  };
}

/** Parses a Hermes update into the fields both the tier bound checks and the confidence check need. Returns `null` for a missing/mismatched/empty update -- the same "not usable" contract the walk's probe relies on. */
function parseSettlementPrintCandidate(update: PythUpdate, feedId: string): SettlementPrintCandidate | null {
  const parsed = update.parsed?.[0];
  if (!parsed || parsed.id.toLowerCase() !== feedId.toLowerCase()) return null;
  if (update.binary.encoding !== "base64" || !update.binary.data.length) return null;
  return {
    publishTime: parsed.price.publish_time,
    price: BigInt(parsed.price.price),
    conf: BigInt(parsed.price.conf),
  };
}

/**
 * True only for Hermes' "this feed published nothing at that timestamp"
 * response (HTTP 404 / "Update data not found"), which is DATA, not a
 * failure. Everything else -- timeouts, 429s, connection resets -- is a real
 * error and must propagate.
 *
 * This distinction is the fix for a confirmed false negative: a blanket
 * `catch { return null }` let a `fetch failed` masquerade as "the feed has no
 * print here", and a live cranker run consequently reported "no tier-two
 * print available" for a range that contained perfectly good prints.
 */
function isHermesNoDataError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /update data not found/i.test(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetches the print `tier` needs for `window`.
 *
 * Anchors on the feed's newest print via a single `getLatestPriceUpdates`
 * (clamped to the tier's upper bound) rather than searching for one, then
 * walks the real print sequence backwards testing the FULL acceptance
 * predicate -- time bounds AND confidence -- at each step. See the note
 * above `walkPrintSequenceForAcceptablePrint` for why the two earlier
 * search strategies (binary search, fixed-stride walk) were both wrong.
 *
 * Every result this returns has already been validated against the exact
 * on-chain acceptance bounds (`tier_one_ok`/`tier_two_ok` AND
 * `OracleConfidenceTooWide`) in `publish_pyth_settlement`, so a caller that
 * posts what this returns can never hit either kind of on-chain rejection
 * from a bad print choice; only a genuine race (a concurrent run finalizing
 * the oracle first, `OracleAlreadyFinalized`) remains possible.
 *
 * The picked candidate is additionally checked against `publish_time <= now`
 * for tier one -- `tier_one_ok`'s third bound, which depends on wall-clock
 * `now` rather than the print alone, so it cannot live inside
 * `isSettlementPrintAcceptable` (a pure function of the candidate and the
 * market window only).
 */
async function fetchViablePrint(
  hermes: HermesClient,
  feedId: string,
  tier: ViableSettlementTier,
  window: PublishWindow,
  maxConfidenceBps: number,
  now: number,
): Promise<PythSettlementFetchResult> {
  const observationEnd = computeObservationEnd(window);
  const lowerBound = tier === "tier-one" ? window.expiry : window.expiry - window.maxSettlementStalenessSeconds;
  const upperBound = tier === "tier-one" ? observationEnd : window.expiry;

  // The anchor: the newest print the feed has, clamped to this tier's upper
  // bound. One call, no search -- and for the overnight/tier-2 case this
  // lands directly on the last print before the feed went dark, which is
  // exactly where the walk wants to start.
  let anchor: number;
  try {
    const latest = await hermes.getLatestPriceUpdates([feedId], { encoding: "base64", parsed: true });
    const parsed = parseSettlementPrintCandidate(latest, feedId);
    anchor = parsed ? Math.min(upperBound, parsed.publishTime) : upperBound;
  } catch {
    // Hermes could not serve "latest" at all. Fall back to probing from the
    // tier's own upper bound; the walk below handles a 404 there by stepping
    // back, so this degrades rather than failing outright.
    anchor = upperBound;
  }

  let probeErrors = 0;
  const probe: SettlementPrintProbe<PythUpdate> = async (timestamp) => {
    let update: PythUpdate;
    try {
      update = await hermes.getPriceUpdatesAtTimestamp(timestamp, [feedId], { encoding: "base64", parsed: true });
    } catch (error) {
      // ONLY a 404 means "the feed published nothing at this timestamp".
      // Anything else (timeout, 429, connection reset) is an error and must
      // not be reported as absence -- see SettlementPrintProbeResult.
      if (isHermesNoDataError(error)) return { kind: "absent" };
      probeErrors += 1;
      throw error;
    }
    const candidate = parseSettlementPrintCandidate(update, feedId);
    return candidate ? { kind: "print", candidate, value: update } : { kind: "absent" };
  };

  let walkResult;
  try {
    walkResult = await walkPrintSequenceForAcceptablePrint({
      probe,
      tier,
      window,
      maxConfidenceBps,
      startTimestamp: anchor,
      lowerBound,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `Hermes failed while searching for a ${tier} print in [${lowerBound}, ${anchor}] (${probeErrors} probe error(s)): ${describeError(error)}`,
    };
  }

  if (!walkResult.ok) {
    if (walkResult.reason === "no_print_available") {
      return {
        ok: false,
        reason: `no ${tier} print available in Hermes for [${lowerBound}, ${anchor}] after ${walkResult.probeCount} probe(s)`,
      };
    }
    return {
      ok: false,
      reason:
        `${tier} print(s) found in [${lowerBound}, ${anchor}] but every candidate fails the confidence bound -- ` +
        `best candidate ${walkResult.bestConfBps} bps exceeds the ${walkResult.maxConfidenceBps} bps bound ` +
        `(${walkResult.probeCount} probe(s))`,
    };
  }

  const { publishTime } = walkResult.candidate;
  if (tier === "tier-one" && publishTime > now) {
    return { ok: false, reason: `tier-one candidate publish_time ${publishTime} is after now ${now}` };
  }

  return {
    ok: true,
    tier,
    update: walkResult.value,
    publishTime,
    ageSeconds: Math.max(0, now - publishTime),
    probeCount: walkResult.probeCount,
  };
}

/**
 * Replaces `fetchLatestPythUpdate` for the settlement publish path: fetches
 * the Pyth update appropriate to whichever tier `selectViableSettlementTier`
 * says is currently viable for `window` at `now`, rather than blindly
 * fetching "the latest print" (which only ever satisfies tier 1, and never
 * tier 2 -- see that function's doc comment for the confirmed live impact),
 * and -- as of the `OracleConfidenceTooWide` fix above -- never a print whose
 * confidence band the market's own `maxConfidenceBps` would reject either.
 *
 * `maxConfidenceBps` is threaded through from the caller's decoded market
 * state (`DecodedMarketForCleanup.maxConfidenceBps` / `market.max_confidence_bps`
 * on-chain) as its own parameter, rather than folded into `window`, since
 * none of `PublishWindow`'s other consumers (`decideMarketPublishAction`,
 * `selectViableSettlementTier`, the deadline helpers) need it.
 *
 * Every result this returns has ALREADY been validated against the exact
 * on-chain acceptance bounds (`tier_one_ok`/`tier_two_ok` AND
 * `OracleConfidenceTooWide` in `publish_pyth_settlement`) -- so a caller that
 * posts what this returns can never hit a tier- or confidence-related
 * on-chain rejection; only a genuine race (a concurrent run finalizing the
 * oracle first, `OracleAlreadyFinalized`) remains possible.
 * `fetchLatestPythUpdate` is left in place for `keeper.ts`, which uses it for
 * an unrelated purpose (reading the current spot price to derive a strike,
 * not settlement) and is not wrong there -- just wrong for this call site.
 */
export async function fetchPythUpdateForSettlement(
  hermes: HermesClient,
  feedId: string,
  window: PublishWindow,
  maxConfidenceBps: number,
  now: number,
): Promise<PythSettlementFetchResult> {
  const tier = selectViableSettlementTier({ ...window, now });
  if (tier === null) {
    return { ok: false, reason: "neither settlement tier is currently viable for this market" };
  }
  return fetchViablePrint(hermes, feedId, tier, window, maxConfidenceBps, now);
}

/**
 * Converts a Pyth parsed price (an integer mantissa plus a base-10 exponent,
 * e.g. `{ price: "123456789012", expo: -8 }`) into VSOL's `PRICE_SCALE`
 * (1e6) fixed-point atoms: `price * 10^expo * priceScale`, computed entirely
 * in `bigint` arithmetic so it never picks up floating-point drift. Pyth
 * equity/crypto feeds virtually always publish a negative `expo` (the
 * mantissa is an integer many places larger than the human-readable price),
 * but a non-negative `expo` is handled too for completeness.
 *
 * This is the same normalization bootstrap.ts's smoke-settlement flow does
 * inline (see its `normalizedPythPrice` computation); pulled out here as a
 * pure, exported, unit-tested function because scripts/keeper.ts's
 * discover-first rung creation needs the identical conversion to turn a
 * fresh Hermes spot price into a `ladderStrike` input (see
 * `STRIKE_LADDER_STEP`/`ladderStrike` in ../../sdk/index.ts).
 */
export function pythPriceToScaledAtoms(price: bigint, expo: number, priceScale: bigint): bigint {
  return expo >= 0
    ? price * priceScale * (10n ** BigInt(expo))
    : price * priceScale / (10n ** BigInt(-expo));
}

/**
 * Publishes a Pyth settlement for a market: posts the update through the
 * receiver and calls `publish_pyth_settlement` in the same transaction
 * bundle, exactly as bootstrap.ts's publishPythSettlement does. The program
 * itself enforces the two-tier acceptance rule (a fresh in-window print, or
 * -- once the observation window has elapsed -- a last-known pre-expiry
 * price within max_settlement_staleness_seconds); this function does not
 * attempt to replicate that logic client-side. A rejection (neither tier
 * satisfiable, or the oracle was finalized by a concurrent run first) throws
 * an AnchorError the caller classifies via describeSettlementError and
 * treats as a skip, not a failure.
 */
export async function publishSettlementForMarket(params: {
  connection: Connection;
  cranker: Keypair;
  program: Program<Vsol>;
  config: PublicKey;
  market: PublicKey;
  oracle: PublicKey;
  feedId: string;
  update: PythUpdate;
}): Promise<{ signature: string; priceUpdate: string }> {
  const wallet = new CoralWallet(params.cranker);
  const receiver = new PythSolanaReceiver({ connection: params.connection, wallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates(params.update.binary.data);
  let priceUpdate: PublicKey | undefined;
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (feedId: string) => PublicKey) => {
    // The receiver SDK indexes accumulator updates by canonical 0x-prefixed feed ID.
    const updateAccount = getPriceUpdateAccount(`0x${params.feedId}`);
    priceUpdate = updateAccount;
    return [{
      instruction: await params.program.methods
        .publishPythSettlement()
        .accountsStrict({
          config: params.config,
          market: params.market,
          oracle: params.oracle,
          priceUpdate: updateAccount,
        })
        .instruction(),
      signers: [],
    }];
  });
  const signatures = await sendTransactions(
    await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 10_000, tightComputeBudget: true }),
    params.connection,
    wallet,
    30,
  );
  if (!priceUpdate || !signatures.length) throw new Error("Pyth settlement transactions did not complete");
  return { signature: signatures[signatures.length - 1], priceUpdate: priceUpdate.toBase58() };
}

// --- Settle / refund flows ---------------------------------------------------
// Both derive every account deterministically from the decoded position
// itself (pool, market, quote_authority, nonce) plus the config's treasury
// owner, so no external manifest or pool allowlist is required -- exactly
// the same permissionless-discovery property publish_pyth_settlement has.

function settlementMintAta(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner);
}

/** Calls settle_pool_position, paying the buyer their payout (and the maker/pool the remainder plus the protocol fee to the treasury). The cranker signer pays the transaction fee; it receives no payout itself. */
export async function settlePoolPositionOnChain(params: {
  program: Program<Vsol>;
  cranker: PublicKey;
  config: PublicKey;
  oracle: PublicKey;
  treasuryOwner: PublicKey;
  position: DecodedPoolPosition;
}): Promise<string> {
  const pool = new PublicKey(params.position.pool);
  const market = new PublicKey(params.position.market);
  const settlementMint = new PublicKey(params.position.settlementMint);
  const buyer = new PublicKey(params.position.buyer);
  const quoteAuthority = new PublicKey(params.position.quoteAuthority);
  const positionAddress = new PublicKey(params.position.address);
  const nonceRecord = derivePoolNonce(pool, quoteAuthority, params.position.nonce);
  const positionVault = derivePoolPositionVault(positionAddress);
  const poolToken = deriveLiquidityPoolToken(pool);
  const buyerDestination = settlementMintAta(settlementMint, buyer);
  const treasuryDestination = settlementMintAta(settlementMint, params.treasuryOwner);
  return params.program.methods
    .settlePoolPosition()
    .accountsStrict({
      cranker: params.cranker,
      config: params.config,
      pool,
      market,
      oracle: params.oracle,
      nonceRecord,
      position: positionAddress,
      positionVault,
      settlementMint,
      buyerDestination,
      poolToken,
      treasuryDestination,
      rentRecipient: buyer,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

/** Calls refund_pool_position, returning the buyer's premium and the pool's locked collateral to their sources. No treasury fee applies to a refund (the trade never settled). */
export async function refundPoolPositionOnChain(params: {
  program: Program<Vsol>;
  cranker: PublicKey;
  config: PublicKey;
  oracle: PublicKey;
  position: DecodedPoolPosition;
}): Promise<string> {
  const pool = new PublicKey(params.position.pool);
  const market = new PublicKey(params.position.market);
  const settlementMint = new PublicKey(params.position.settlementMint);
  const buyer = new PublicKey(params.position.buyer);
  const quoteAuthority = new PublicKey(params.position.quoteAuthority);
  const positionAddress = new PublicKey(params.position.address);
  const nonceRecord = derivePoolNonce(pool, quoteAuthority, params.position.nonce);
  const positionVault = derivePoolPositionVault(positionAddress);
  const poolToken = deriveLiquidityPoolToken(pool);
  const buyerDestination = settlementMintAta(settlementMint, buyer);
  return params.program.methods
    .refundPoolPosition()
    .accountsStrict({
      cranker: params.cranker,
      config: params.config,
      pool,
      market,
      oracle: params.oracle,
      nonceRecord,
      position: positionAddress,
      positionVault,
      settlementMint,
      buyerDestination,
      poolToken,
      rentRecipient: buyer,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

// --- Market cleanup ----------------------------------------------------------

/**
 * Calls close_settled_market for a market already proven safe by
 * selectMarketCloseCandidates. Deliberately omits the optional pool/pool_market
 * pair -- disabling a pool-market authorization requires an idle pool and is
 * fragile, and the instruction's safety does not depend on it (fill_quote and
 * fill_pool_quote both hard-require `now < market.expiry`, so no new position
 * can open past the close deadline regardless of pool_market.enabled; see the
 * instruction's own doc comment in lib.rs). `authority` and `rentRecipient`
 * are both the caller-supplied signer; the program enforces authority ==
 * market.creator || config.admin, and separately enforces rent_recipient ==
 * market.creator by address constraint, so passing a signer that is not the
 * market's creator (and not config.admin) simply fails with Unauthorized,
 * which the caller treats as a skip.
 *
 * `collateralVault` is derived from `market`, not caller-supplied: it is
 * always the market's own `deriveCompleteSetVault(market)` PDA (see
 * `CloseSettledMarket::collateral_vault`'s doc comment in lib.rs -- the
 * on-chain handler itself is what checks its balance, this is just the
 * account address). The caller (`selectMarketCloseCandidates`) should
 * already have proven this market is safe to close via
 * `marketsWithOutstandingCollateral` before calling this function, but the
 * on-chain check is the actual backstop regardless.
 */
export async function closeSettledMarketOnChain(params: {
  program: Program<Vsol>;
  authority: PublicKey;
  config: PublicKey;
  market: PublicKey;
  oracle: PublicKey;
  rentRecipient: PublicKey;
}): Promise<string> {
  return params.program.methods
    .closeSettledMarket()
    .accountsStrict({
      authority: params.authority,
      config: params.config,
      market: params.market,
      oracle: params.oracle,
      collateralVault: deriveCompleteSetVault(params.market),
      pool: null,
      poolMarket: null,
      rentRecipient: params.rentRecipient,
    })
    .rpc();
}
