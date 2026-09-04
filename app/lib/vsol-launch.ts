// Server-side builders and inspectors for the permissionless Launch flows:
// create a series (create_market), create a pool (initialize_liquidity_pool),
// and authorize a series for a pool (set_liquidity_pool_market). The wallet
// signs as creator/manager — this server never holds those keys.

import { Connection, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PRICE_SCALE,
  deriveLiquidityPool,
  deriveLiquidityPoolMarket,
  deriveLiquidityPoolToken,
  ladderStrike,
} from "../../vsol/sdk";
import { VSOL_CONFIG, VSOL_PROGRAM_ID, VSOL_SETTLEMENT_MINT } from "./vsol";
import {
  buildCreateMarketInstruction,
  buildVsolIdlInstruction,
  decodeMarketAccount,
  decodePoolAccount,
  encodeI64,
  encodeU16,
  getVsolClusterTime,
  getVsolConnection,
  vsolInstructionDiscriminator,
} from "./vsol-server";
import {
  LAUNCH_MIN_LEAD_SECONDS,
  deriveLaunchSeriesParams,
  validatePoolRiskLimits,
  type LaunchSeriesParams,
} from "./launch-params";
import type { ExpiryCode } from "./expiries";
import { liveMarkets, tradableMarketBySymbol } from "./markets";
import { getPythSnapshot } from "./pyth-market-data";

export type LaunchKind = "create_market" | "create_pool" | "authorize_market";

// +8 for the appended conditional-token `strike: u64` (see CreateMarketArgs
// in vsol/programs/vsol/src/lib.rs and buildCreateMarketInstruction's
// encoder in vsol-server.ts, which now always encodes it as the last field).
const CREATE_MARKET_DATA_LENGTH = 8 + 32 + 32 + 16 + 8 + 8 + 4 + 4 + 2 + 32 + 4 + 8;
const CREATE_POOL_DATA_LENGTH = 8 + 32 + 32 + 2 + 2;
const AUTHORIZE_MARKET_DATA_LENGTH = 8 + 8 + 1;

async function withBlockhash(connection: Connection, feePayer: PublicKey, transaction: Transaction) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = feePayer;
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
  return transaction;
}

/**
 * The symbol Launch lists series for. Read from the market config (the first
 * LIVE market) rather than hardcoded: Launch has no symbol picker yet, and a
 * hardcoded ticker here would keep minting series for a market that is no
 * longer the tradable one.
 */
export function launchSymbol(): string {
  const symbol = liveMarkets[0]?.symbol;
  if (!symbol) throw new Error("No live market is configured, so no series can be launched.");
  return symbol;
}

/**
 * Live spot for `symbol`, in PRICE_SCALE atoms, for choosing a ladder rung.
 * Deliberately fails loudly rather than falling back to a guess: a launched
 * series is permanent and its strike selects its address, so listing one at
 * a fabricated strike is worse than not listing it at all.
 */
async function fetchLadderSpot(symbol: string): Promise<bigint> {
  // tradableMarketBySymbol, not a raw lookup: a coming-soon market has no
  // entitled Pyth feed, so there is no spot to round into a ladder rung.
  const market = tradableMarketBySymbol(symbol);
  if (!market) throw new Error(`${symbol} is not a tradable Tend market`);
  const snapshot = await getPythSnapshot(market);
  if (!Number.isFinite(snapshot.price) || snapshot.price <= 0) {
    throw new Error("Pyth has no usable spot price right now, so a strike cannot be chosen. Try again shortly.");
  }
  return BigInt(Math.round(snapshot.price * Number(PRICE_SCALE)));
}

export async function buildCreateMarketTransaction(params: {
  creator: PublicKey;
  code: ExpiryCode;
  connection?: Connection;
}) {
  const connection = params.connection ?? getVsolConnection();
  const series: LaunchSeriesParams = deriveLaunchSeriesParams(params.code, launchSymbol(), Date.now());
  const now = await getVsolClusterTime(connection);
  if (series.expiry < now + LAUNCH_MIN_LEAD_SECONDS) {
    throw new Error("The selected grid expiry is already inside the onchain lead window. Pick a later expiry.");
  }
  // Listing a series means CHOOSING a strike, so it is supplied explicitly
  // here rather than defaulted: `strike` is hashed into the market id, and a
  // wrong-but-positive value silently derives a different market. Launch has
  // no strike picker yet, so it lists the at-the-money ladder rung -- the
  // same rung the keeper would pick for a new expiry, which keeps a
  // hand-launched series on the same ladder as the automatic ones instead of
  // fragmenting the chain onto an off-grid strike.
  const spot = await fetchLadderSpot(launchSymbol());
  const strike = ladderStrike(spot);
  // Shared with the mint-on-demand quote path (app/lib/vsol-server.ts) and its
  // send-path inspector, so there is exactly one create_market encoder.
  const { instruction, market, oracle, marketId } = await buildCreateMarketInstruction({
    creator: params.creator,
    series: { ...series, strike },
  });
  const existing = await connection.getAccountInfo(market, "confirmed");
  if (existing) {
    throw new Error("A series with these exact parameters already exists on-chain. Identical series share one deterministic address.");
  }
  const transaction = await withBlockhash(connection, params.creator, new Transaction().add(instruction));
  return {
    transaction,
    marketAddress: market.toBase58(),
    oracleAddress: oracle.toBase58(),
    marketId: marketId.toString("hex"),
    series,
  };
}

export async function buildInitializePoolTransaction(params: {
  creator: PublicKey;
  quoteAuthority: PublicKey;
  maxUtilizationBps: number;
  maxPositionBps: number;
  connection?: Connection;
}) {
  const connection = params.connection ?? getVsolConnection();
  validatePoolRiskLimits(params.maxUtilizationBps, params.maxPositionBps);
  if (params.quoteAuthority.equals(PublicKey.default)) throw new Error("The pool quote authority must be a real key.");
  const poolIdBytes = new Uint8Array(32);
  crypto.getRandomValues(poolIdBytes);
  const poolId = Buffer.from(poolIdBytes);
  const pool = deriveLiquidityPool(VSOL_CONFIG, VSOL_SETTLEMENT_MINT, poolId);
  const poolToken = deriveLiquidityPoolToken(pool);
  const data = Buffer.concat([
    poolId,
    params.quoteAuthority.toBuffer(),
    encodeU16(params.maxUtilizationBps),
    encodeU16(params.maxPositionBps),
  ]);
  const instruction = buildVsolIdlInstruction("initialize_liquidity_pool", {
    creator: params.creator,
    config: VSOL_CONFIG,
    settlement_mint: VSOL_SETTLEMENT_MINT,
    pool,
    pool_token: poolToken,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  }, data);
  const transaction = await withBlockhash(connection, params.creator, new Transaction().add(instruction));
  return {
    transaction,
    poolAddress: pool.toBase58(),
    poolTokenAddress: poolToken.toBase58(),
    poolId: poolId.toString("hex"),
  };
}

export async function buildAuthorizeMarketTransaction(params: {
  manager: PublicKey;
  pool: PublicKey;
  market: PublicKey;
  connection?: Connection;
}) {
  const connection = params.connection ?? getVsolConnection();
  const [poolAccount, marketAccount, now] = await Promise.all([
    connection.getAccountInfo(params.pool, "confirmed"),
    connection.getAccountInfo(params.market, "confirmed"),
    getVsolClusterTime(connection),
  ]);
  if (!poolAccount?.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The pool account was not found on the verified program.");
  if (!marketAccount?.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The market account was not found on the verified program.");
  const pool = decodePoolAccount(Buffer.from(poolAccount.data));
  const market = decodeMarketAccount(Buffer.from(marketAccount.data));
  if (!pool.manager.equals(params.manager)) {
    throw new Error("Only the pool manager wallet can authorize series for this pool.");
  }
  // Mirror the standard-grid trade lock; the program requires
  // now + lead <= lastTradeAt < expiry.
  const lastTradeAt = market.expiry - 300;
  if (lastTradeAt < now + LAUNCH_MIN_LEAD_SECONDS) {
    throw new Error("This series is too close to expiry to authorize for trading.");
  }
  const poolMarket = deriveLiquidityPoolMarket(params.pool, params.market);
  const data = Buffer.concat([encodeI64(BigInt(lastTradeAt)), Buffer.from([1])]);
  const instruction = buildVsolIdlInstruction("set_liquidity_pool_market", {
    manager: params.manager,
    config: VSOL_CONFIG,
    pool: params.pool,
    market: params.market,
    pool_market: poolMarket,
    system_program: SystemProgram.programId,
  }, data);
  const transaction = await withBlockhash(connection, params.manager, new Transaction().add(instruction));
  return {
    transaction,
    poolMarketAddress: poolMarket.toBase58(),
    lastTradeAt,
  };
}

const LAUNCH_DISCRIMINATORS: { kind: LaunchKind; name: string; dataLength: number; accountCount: number; targetIndex: number; secondaryIndex: number }[] = [
  { kind: "create_market", name: "create_market", dataLength: CREATE_MARKET_DATA_LENGTH, accountCount: 7, targetIndex: 2, secondaryIndex: 3 },
  { kind: "create_pool", name: "initialize_liquidity_pool", dataLength: CREATE_POOL_DATA_LENGTH, accountCount: 8, targetIndex: 3, secondaryIndex: 4 },
  { kind: "authorize_market", name: "set_liquidity_pool_market", dataLength: AUTHORIZE_MARKET_DATA_LENGTH, accountCount: 6, targetIndex: 4, secondaryIndex: 3 },
];

/**
 * Shape check for signed launch transactions. The prepare→send pipeline binds
 * the exact transaction bytes via message hash; this inspection re-validates
 * the instruction family, signer, and bound addresses before simulation.
 */
export function inspectVsolLaunchTransaction(transaction: Transaction) {
  if (transaction.instructions.length !== 1 || !transaction.feePayer) return null;
  const instruction = transaction.instructions[0];
  if (!instruction.programId.equals(VSOL_PROGRAM_ID)) return null;
  const discriminator = Buffer.from(instruction.data).subarray(0, 8);
  for (const definition of LAUNCH_DISCRIMINATORS) {
    if (!discriminator.equals(vsolInstructionDiscriminator(definition.name))) continue;
    if (instruction.data.length !== definition.dataLength) return null;
    if (instruction.keys.length !== definition.accountCount) return null;
    const signer = instruction.keys[0];
    if (!signer.isSigner || !signer.pubkey.equals(transaction.feePayer)) return null;
    if (!instruction.keys[1].pubkey.equals(VSOL_CONFIG)) return null;
    return {
      kind: definition.kind,
      signer: signer.pubkey,
      targetAddress: instruction.keys[definition.targetIndex].pubkey,
      secondaryAddress: instruction.keys[definition.secondaryIndex].pubkey,
    };
  }
  return null;
}
