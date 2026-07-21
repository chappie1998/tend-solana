import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const VSOL_PROGRAM_ID = new PublicKey("2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v");
export const CONFIG_SEED = Buffer.from("config");
export const MARKET_SEED = Buffer.from("market");
export const ORACLE_SEED = Buffer.from("oracle");
export const WRITER_SEED = Buffer.from("writer");
export const WRITER_TOKEN_SEED = Buffer.from("writer-token");
export const NONCE_SEED = Buffer.from("nonce");
export const POSITION_SEED = Buffer.from("position");
export const POSITION_VAULT_SEED = Buffer.from("position-vault");
export const ELIGIBILITY_SEED = Buffer.from("eligibility");
export const POOL_SEED = Buffer.from("pool");
export const POOL_TOKEN_SEED = Buffer.from("pool-token");
export const PROVIDER_SEED = Buffer.from("provider");
export const POOL_MARKET_SEED = Buffer.from("pool-market");
export const POOL_NONCE_SEED = Buffer.from("pool-nonce");
export const POOL_POSITION_SEED = Buffer.from("pool-position");
export const POOL_POSITION_VAULT_SEED = Buffer.from("pool-position-vault");
export const QUOTE_DOMAIN = Buffer.from("VSOLRFQ1", "ascii");
export const POOL_QUOTE_DOMAIN = Buffer.from("VSOLPLP1", "ascii");
// Distinct from the fill domains above so a signed early-close buyback quote
// can never be replayed as (or confused with) a fill quote.
export const POOL_BUYBACK_DOMAIN = Buffer.from("VSOLCLS1", "ascii");
export const MARKET_ID_DOMAIN = Buffer.from("VSOLMKT1", "ascii");
export const PRICE_SCALE = 1_000_000n;

// Rolling-series policy constants shared by the app's permissionless launch
// flow (app/lib/launch-params.ts) and the devnet bootstrap/keeper scripts
// (vsol/scripts/bootstrap.ts, vsol/scripts/keeper.ts). All three feed
// deriveMarketId above, so a single shared home keeps them from ever drifting
// — a divergence there would make the app derive different market addresses
// than the keeper mints, and the UI would silently see nothing.
export const MARKET_OBSERVATION_WINDOW_SECONDS = 30;
export const MARKET_SETTLEMENT_GRACE_SECONDS = 900;
export const MARKET_MAX_CONFIDENCE_BPS = 500;
// Tier 2's last-known-price fallback window: 24h is generous enough to cover
// a full overnight/weekend gap in the Pyth equities feed while still keeping
// a hard ceiling on how old a settlement print can be.
export const MARKET_MAX_SETTLEMENT_STALENESS_SECONDS = 86_400;

export type Quote = {
  nonce: bigint;
  direction: 0 | 1;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  quoteExpiry: bigint;
};

export type PoolQuote = Quote;

// A one-shot, pool-`quoteAuthority`-signed offer to buy back an open pool
// position before expiry. `buybackAmount` is what the pool pays the buyer;
// `minProceeds` is the buyer's slippage guard, bound into the same signed
// message so it can't be tampered with independently of `buybackAmount`.
export type PoolBuyback = {
  buybackAmount: bigint;
  minProceeds: bigint;
  quoteExpiry: bigint;
};

function u64(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError("u64 out of range");
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value);
  return result;
}

function i64(value: bigint): Buffer {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) throw new RangeError("i64 out of range");
  const result = Buffer.alloc(8);
  result.writeBigInt64LE(value);
  return result;
}

function u32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError("u32 out of range");
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function u16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError("u16 out of range");
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value);
  return result;
}

export function quoteMessage(params: {
  domainSeparator: Uint8Array;
  domainVersion: number;
  config: PublicKey;
  market: PublicKey;
  buyer: PublicKey;
  maker: PublicKey;
  quote: Quote;
  programId?: PublicKey;
}): Buffer {
  const programId = params.programId ?? VSOL_PROGRAM_ID;
  const { quote } = params;
  if (params.domainSeparator.length !== 32) throw new RangeError("domain separator must be 32 bytes");
  if (!Number.isInteger(params.domainVersion) || params.domainVersion < 0 || params.domainVersion > 65_535) {
    throw new RangeError("domain version must be a u16");
  }
  const domainVersion = Buffer.alloc(2);
  domainVersion.writeUInt16LE(params.domainVersion);
  return Buffer.concat([
    QUOTE_DOMAIN,
    Buffer.from(params.domainSeparator),
    domainVersion,
    programId.toBuffer(),
    params.config.toBuffer(),
    params.market.toBuffer(),
    params.buyer.toBuffer(),
    params.maker.toBuffer(),
    u64(quote.nonce),
    Buffer.from([quote.direction]),
    u64(quote.strike),
    u64(quote.width),
    u64(quote.premium),
    u64(quote.maxPayout),
    i64(quote.quoteExpiry),
  ]);
}

export function poolQuoteMessage(params: {
  domainSeparator: Uint8Array;
  domainVersion: number;
  config: PublicKey;
  pool: PublicKey;
  market: PublicKey;
  buyer: PublicKey;
  quoteAuthority: PublicKey;
  quote: PoolQuote;
  programId?: PublicKey;
}): Buffer {
  const programId = params.programId ?? VSOL_PROGRAM_ID;
  const { quote } = params;
  if (params.domainSeparator.length !== 32) throw new RangeError("domain separator must be 32 bytes");
  if (!Number.isInteger(params.domainVersion) || params.domainVersion < 0 || params.domainVersion > 65_535) {
    throw new RangeError("domain version must be a u16");
  }
  const domainVersion = Buffer.alloc(2);
  domainVersion.writeUInt16LE(params.domainVersion);
  return Buffer.concat([
    POOL_QUOTE_DOMAIN,
    Buffer.from(params.domainSeparator),
    domainVersion,
    programId.toBuffer(),
    params.config.toBuffer(),
    params.pool.toBuffer(),
    params.market.toBuffer(),
    params.buyer.toBuffer(),
    params.quoteAuthority.toBuffer(),
    u64(quote.nonce),
    Buffer.from([quote.direction]),
    u64(quote.strike),
    u64(quote.width),
    u64(quote.premium),
    u64(quote.maxPayout),
    i64(quote.quoteExpiry),
  ]);
}

export function poolBuybackMessage(params: {
  domainSeparator: Uint8Array;
  domainVersion: number;
  config: PublicKey;
  pool: PublicKey;
  market: PublicKey;
  position: PublicKey;
  buyer: PublicKey;
  quoteAuthority: PublicKey;
  buyback: PoolBuyback;
  programId?: PublicKey;
}): Buffer {
  const programId = params.programId ?? VSOL_PROGRAM_ID;
  const { buyback } = params;
  if (params.domainSeparator.length !== 32) throw new RangeError("domain separator must be 32 bytes");
  if (!Number.isInteger(params.domainVersion) || params.domainVersion < 0 || params.domainVersion > 65_535) {
    throw new RangeError("domain version must be a u16");
  }
  const domainVersion = Buffer.alloc(2);
  domainVersion.writeUInt16LE(params.domainVersion);
  return Buffer.concat([
    POOL_BUYBACK_DOMAIN,
    Buffer.from(params.domainSeparator),
    domainVersion,
    programId.toBuffer(),
    params.config.toBuffer(),
    params.pool.toBuffer(),
    params.market.toBuffer(),
    params.position.toBuffer(),
    params.buyer.toBuffer(),
    params.quoteAuthority.toBuffer(),
    u64(buyback.buybackAmount),
    u64(buyback.minProceeds),
    i64(buyback.quoteExpiry),
  ]);
}

export function toAnchorPoolBuyback(buyback: PoolBuyback) {
  return {
    buybackAmount: new BN(buyback.buybackAmount.toString()),
    minProceeds: new BN(buyback.minProceeds.toString()),
    quoteExpiry: new BN(buyback.quoteExpiry.toString()),
  };
}

export function toAnchorQuote(quote: Quote) {
  return {
    nonce: new BN(quote.nonce.toString()),
    direction: quote.direction,
    strike: new BN(quote.strike.toString()),
    width: new BN(quote.width.toString()),
    premium: new BN(quote.premium.toString()),
    maxPayout: new BN(quote.maxPayout.toString()),
    quoteExpiry: new BN(quote.quoteExpiry.toString()),
  };
}

export function marketId(label: string): Buffer {
  return createHash("sha256").update(`vsol-market:${label}`).digest();
}

export type MarketIdParams = {
  pythFeedId: Uint8Array | number[];
  settlementMint: PublicKey;
  expiry: bigint;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  priceScale: bigint;
  maxConfidenceBps: number;
  symbol: Uint8Array | number[];
  maxSettlementStalenessSeconds: number;
};

// Mirrors the on-chain `expected_market_id` check byte-for-byte, so identical
// series parameters always bind to the same permissionless factory PDA.
export async function deriveMarketId(params: MarketIdParams): Promise<Buffer> {
  const pythFeedId = Buffer.from(params.pythFeedId);
  const symbol = Buffer.from(params.symbol);
  if (pythFeedId.length !== 32) throw new RangeError("pythFeedId must be 32 bytes");
  if (symbol.length !== 16) throw new RangeError("symbol must be 16 bytes");
  const message = Buffer.concat([
    MARKET_ID_DOMAIN,
    pythFeedId,
    params.settlementMint.toBuffer(),
    i64(params.expiry),
    u32(params.observationWindowSeconds),
    u32(params.settlementGraceSeconds),
    u64(params.priceScale),
    u16(params.maxConfidenceBps),
    symbol,
    u32(params.maxSettlementStalenessSeconds),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", message);
  return Buffer.from(digest);
}

export function liquidityPoolId(label: string): Buffer {
  return createHash("sha256").update(`vsol-pool:${label}`).digest();
}

export function symbolBytes(symbol: string): number[] {
  const encoded = Buffer.from(symbol, "ascii");
  if (encoded.length === 0 || encoded.length > 16) throw new RangeError("symbol must be 1-16 ASCII bytes");
  return [...encoded, ...Buffer.alloc(16 - encoded.length)];
}

export function deriveConfig(programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
}

export function deriveMarket(config: PublicKey, id: Uint8Array, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([MARKET_SEED, config.toBuffer(), Buffer.from(id)], programId)[0];
}

export function deriveOracle(market: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([ORACLE_SEED, market.toBuffer()], programId)[0];
}

export function deriveWriterVault(config: PublicKey, maker: PublicKey, mint: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([WRITER_SEED, config.toBuffer(), maker.toBuffer(), mint.toBuffer()], programId)[0];
}

export function deriveWriterToken(writerVault: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([WRITER_TOKEN_SEED, writerVault.toBuffer()], programId)[0];
}

export function deriveNonce(config: PublicKey, maker: PublicKey, nonce: bigint, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([NONCE_SEED, config.toBuffer(), maker.toBuffer(), u64(nonce)], programId)[0];
}

export function derivePosition(nonceRecord: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([POSITION_SEED, nonceRecord.toBuffer()], programId)[0];
}

export function derivePositionVault(position: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([POSITION_VAULT_SEED, position.toBuffer()], programId)[0];
}

export function deriveEligibility(config: PublicKey, wallet: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([ELIGIBILITY_SEED, config.toBuffer(), wallet.toBuffer()], programId)[0];
}

export function deriveLiquidityPool(
  config: PublicKey,
  mint: PublicKey,
  id: Uint8Array,
  programId = VSOL_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POOL_SEED, config.toBuffer(), mint.toBuffer(), Buffer.from(id)],
    programId,
  )[0];
}

export function deriveLiquidityPoolToken(pool: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([POOL_TOKEN_SEED, pool.toBuffer()], programId)[0];
}

export function deriveLiquidityProvider(pool: PublicKey, owner: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([PROVIDER_SEED, pool.toBuffer(), owner.toBuffer()], programId)[0];
}

export function deriveLiquidityPoolMarket(pool: PublicKey, market: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([POOL_MARKET_SEED, pool.toBuffer(), market.toBuffer()], programId)[0];
}

export function derivePoolNonce(
  pool: PublicKey,
  quoteAuthority: PublicKey,
  nonce: bigint,
  programId = VSOL_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POOL_NONCE_SEED, pool.toBuffer(), quoteAuthority.toBuffer(), u64(nonce)],
    programId,
  )[0];
}

export function derivePoolPosition(nonceRecord: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([POOL_POSITION_SEED, nonceRecord.toBuffer()], programId)[0];
}

export function derivePoolPositionVault(position: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([POOL_POSITION_VAULT_SEED, position.toBuffer()], programId)[0];
}

export function calculateDepositShares(amount: bigint, totalShares: bigint, totalAssets: bigint): bigint {
  if (amount <= 0n || totalShares < 0n || totalAssets < 0n) throw new RangeError("invalid pool share parameters");
  if (totalShares === 0n) return amount;
  if (totalAssets === 0n) throw new RangeError("pool is insolvent");
  const shares = (amount * totalShares) / totalAssets;
  if (shares === 0n) throw new RangeError("deposit is too small");
  return shares;
}

export function calculateWithdrawAmount(shares: bigint, totalShares: bigint, totalAssets: bigint): bigint {
  if (shares <= 0n || totalShares <= 0n || shares > totalShares || totalAssets < 0n) {
    throw new RangeError("invalid pool share parameters");
  }
  const amount = (shares * totalAssets) / totalShares;
  if (amount === 0n) throw new RangeError("withdrawal is too small");
  return amount;
}

export function calculatePayout(quote: Pick<Quote, "direction" | "strike" | "width" | "maxPayout">, price: bigint): bigint {
  if (quote.width <= 0n || quote.maxPayout <= 0n) throw new RangeError("invalid payout parameters");
  const rawDelta = quote.direction === 0 ? price - quote.strike : quote.strike - price;
  const delta = rawDelta <= 0n ? 0n : rawDelta >= quote.width ? quote.width : rawDelta;
  return (quote.maxPayout * delta) / quote.width;
}
