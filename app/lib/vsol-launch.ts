// Server-side builders and inspectors for the permissionless Launch flows:
// create a series (create_market), create a pool (initialize_liquidity_pool),
// and authorize a series for a pool (set_liquidity_pool_market). The wallet
// signs as creator/manager — this server never holds those keys.

import { Connection, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  deriveLiquidityPool,
  deriveLiquidityPoolMarket,
  deriveLiquidityPoolToken,
  deriveMarket,
  deriveMarketId,
  deriveOracle,
  symbolBytes,
} from "../../vsol/sdk";
import deployment from "../../vsol/deployments/devnet.json";
import { VSOL_CONFIG, VSOL_PROGRAM_ID, VSOL_PYTH_FEED_ID, VSOL_SETTLEMENT_MINT } from "./vsol";
import {
  buildVsolIdlInstruction,
  decodeMarketAccount,
  decodePoolAccount,
  encodeI64,
  encodeU16,
  encodeU64,
  encodeU32,
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

export type LaunchKind = "create_market" | "create_pool" | "authorize_market";

const CREATE_MARKET_DATA_LENGTH = 8 + 32 + 32 + 16 + 8 + 8 + 4 + 4 + 2 + 32 + 4;
const CREATE_POOL_DATA_LENGTH = 8 + 32 + 32 + 2 + 2;
const AUTHORIZE_MARKET_DATA_LENGTH = 8 + 8 + 1;

async function withBlockhash(connection: Connection, feePayer: PublicKey, transaction: Transaction) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = feePayer;
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
  return transaction;
}

export async function buildCreateMarketTransaction(params: {
  creator: PublicKey;
  code: ExpiryCode;
  connection?: Connection;
}) {
  const connection = params.connection ?? getVsolConnection();
  const series: LaunchSeriesParams = deriveLaunchSeriesParams(params.code, "NVDA", Date.now());
  const now = await getVsolClusterTime(connection);
  if (series.expiry < now + LAUNCH_MIN_LEAD_SECONDS) {
    throw new Error("The selected grid expiry is already inside the onchain lead window. Pick a later expiry.");
  }
  const symbol = symbolBytes(series.symbol);
  const marketId = await deriveMarketId({
    pythFeedId: Buffer.from(VSOL_PYTH_FEED_ID, "hex"),
    settlementMint: VSOL_SETTLEMENT_MINT,
    expiry: BigInt(series.expiry),
    observationWindowSeconds: series.observationWindowSeconds,
    settlementGraceSeconds: series.settlementGraceSeconds,
    priceScale: series.priceScale,
    maxConfidenceBps: series.maxConfidenceBps,
    symbol,
    maxSettlementStalenessSeconds: series.maxSettlementStalenessSeconds,
  });
  const market = deriveMarket(VSOL_CONFIG, marketId);
  const oracle = deriveOracle(market);
  const existing = await connection.getAccountInfo(market, "confirmed");
  if (existing) {
    throw new Error("A series with these exact parameters already exists on-chain. Identical series share one deterministic address.");
  }
  const data = Buffer.concat([
    marketId,
    new PublicKey(deployment.underlyingMint).toBuffer(),
    Buffer.from(symbol),
    encodeU64(series.priceScale),
    encodeI64(BigInt(series.expiry)),
    encodeU32(series.observationWindowSeconds),
    encodeU32(series.settlementGraceSeconds),
    encodeU16(series.maxConfidenceBps),
    Buffer.from(VSOL_PYTH_FEED_ID, "hex"),
    // Must stay last: matches the Borsh field order of `CreateMarketArgs` in
    // vsol/programs/vsol/src/lib.rs, where this field was appended after
    // `pyth_feed_id` to keep the on-chain layout backward compatible.
    encodeU32(series.maxSettlementStalenessSeconds),
  ]);
  const instruction = buildVsolIdlInstruction("create_market", {
    creator: params.creator,
    config: VSOL_CONFIG,
    market,
    oracle,
    settlement_mint: VSOL_SETTLEMENT_MINT,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  }, data);
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
