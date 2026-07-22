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

// --- Pure decision logic (no RPC; the unit-tested core) --------------------

export type MarketWindow = {
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
};

/** Tier-1/tier-2 aside, a market can no longer accept a fresh oracle publish once expiry + observation window + settlement grace has elapsed -- past that, only refund_pool_position applies. */
export function computeSettlementDeadline(market: MarketWindow): number {
  return market.expiry + market.observationWindowSeconds + market.settlementGraceSeconds;
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

export type MarketPublishDecision = { kind: "publish" } | { kind: "skip"; reason: string };

/**
 * Whether it is even worth attempting `publish_pyth_settlement` for a market
 * this pass, given only chain state (no Pyth price yet -- that is fetched
 * only after this says "publish"). The program itself decides tier-1 vs
 * tier-2 acceptability once a real price update is presented; this just
 * rules out the cases that are certain to fail or are unnecessary.
 */
export function decideMarketPublishAction(
  params: MarketWindow & { now: number; oracleFinalized: boolean },
): MarketPublishDecision {
  if (params.oracleFinalized) return { kind: "skip", reason: "oracle already finalized" };
  if (params.now < params.expiry) return { kind: "skip", reason: "market has not expired yet" };
  if (params.now > computeSettlementDeadline(params)) {
    return { kind: "skip", reason: "settlement window has closed; refund_pool_position applies instead" };
  }
  return { kind: "publish" };
}

export type PoolPositionDecision = { kind: "settle" } | { kind: "refund" } | { kind: "skip"; reason: string };

/** Decides the action for a single expired open position given the oracle's current finalized state and the market's settlement deadline. */
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
