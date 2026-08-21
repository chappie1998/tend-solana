import { createRequire } from "node:module";
import { AnchorError, type Program } from "@anchor-lang/core";
import { Wallet as CoralWallet } from "@coral-xyz/anchor";
import type { HermesClient } from "@pythnetwork/hermes-client";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Vsol } from "../../target/types/vsol.ts";
import {
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

// --- Market account decoding (for the market-cleanup pass) ------------------
// Layout mirrors `Market` in vsol/target/types/vsol.ts and the byte offsets
// documented in app/lib/vsol-server.ts's decodeMarketAccount; reproduced
// independently here (rather than imported) so this script package has no
// dependency on app/. Only the fields the cleanup pass actually needs are
// decoded: oracle@137 (to call close_settled_market without re-deriving it),
// expiry@193 / observationWindowSeconds@201 / settlementGraceSeconds@205 (to
// compute the close deadline), and creator@245 (the required rent_recipient
// and, on devnet, the same key as the cranker's own signer).
export const MARKET_ACCOUNT_SIZE = 281;
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
  return market.expiry + market.observationWindowSeconds + market.settlementGraceSeconds;
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
  maxPerRun: number;
}): DecodedMarketForCleanup[] {
  const candidates = params.markets.filter((market) => {
    if (params.now <= computeMarketCloseDeadline(market)) return false;
    if (params.marketsWithOpenPositions.has(market.address)) return false;
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
      pool: null,
      poolMarket: null,
      rentRecipient: params.rentRecipient,
    })
    .rpc();
}
