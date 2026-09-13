import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
// Conditional-token ("complete set") PDAs -- see the matching constants in
// vsol/programs/vsol/src/lib.rs for the full rationale. All three of
// UP_MINT_SEED/DOWN_MINT_SEED/COMPLETE_SET_VAULT_SEED derive solely from a
// market's own address, so they need no separate manifest account.
// COMPLETE_SET_TOKEN_SEED is different: it derives a *minter's own* UP/DOWN
// token account from (mint, owner), and exists only to solve
// `mint_complete_set`'s bootstrap problem (a fresh market's UP/DOWN mints
// don't exist yet, so a minter cannot pre-create a standard ATA for them).
// `burn_complete_set`/`redeem_winning` accept ANY token account the caller
// holds a balance in -- they do not require this specific derivation.
export const UP_MINT_SEED = Buffer.from("up-mint");
export const DOWN_MINT_SEED = Buffer.from("down-mint");
export const COMPLETE_SET_VAULT_SEED = Buffer.from("cs-vault");
export const COMPLETE_SET_TOKEN_SEED = Buffer.from("cs-token");
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
//
// `create_market` additionally rejects any market where this is
// disproportionately large relative to
// `MARKET_OBSERVATION_WINDOW_SECONDS + MARKET_SETTLEMENT_GRACE_SECONDS` (see
// `MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO` in vsol/programs/vsol/src/lib.rs).
// This configuration's ratio is 86_400 / (30 + 900) ≈ 93, comfortably under
// the on-chain cap of 100 -- if either of the three constants above ever
// changes, re-check that ratio still holds before deploying, or
// `initialize`/`create_market` calls using these values will start
// reverting with `InvalidSettlementStaleness`.
export const MARKET_MAX_SETTLEMENT_STALENESS_SECONDS = 86_400;

// --- Conditional-token strike ladder ----------------------------------------
//
// `strike` is a LISTED parameter on a fixed ladder, not one derived fresh
// from live spot on every pass. The market id is a hash of its parameters,
// `strike` included (see `MarketIdParams`/`deriveMarketId` below and
// `expected_market_id` in vsol/programs/vsol/src/lib.rs) -- so a strike that
// tracked spot continuously would mint a brand-new market on every keeper
// pass, one per tick, thousands of dust markets. Listed options venues solve
// this by publishing a FIXED strike ladder and adding new rungs only as spot
// moves across a step: two strikes at the same expiry are DIFFERENT
// contracts, not duplicates of one "true" strike. Tend does the same. See
// vsol/scripts/keeper.ts's discover-first `ensureMarketRung` for how this is
// applied statelessly: an already-listed rung's strike is read back from
// chain, never re-derived from spot, and `ladderStrike` is only ever called
// once, at the moment a genuinely new expiry is first minted.
//
// STEP SIZING IS PER MARKET, NOT GLOBAL. A rung should be a small but
// meaningful move -- roughly 2-3% of THAT asset's spot. Too coarse and every
// expiry lists a single strike far from the money; too fine and adjacent
// rungs fragment what little liquidity a devnet pool has across
// near-identical contracts. Both failure modes are relative to the
// underlying's own price level, so a single shared constant cannot be right
// for two assets three orders of magnitude apart: the $2.50 step below is
// 2.4% of SOL at ~$103 and 0.003% of BTC at ~$80,000, where it would list a
// rung every quarter of a basis point.
//
// The per-market steps therefore live with the rest of each market's
// configuration, in app/lib/markets.ts (`strikeLadderStep`), which is the
// single list the app, the keeper, the bootstrap and the verifier all read.
// This constant remains the SOL step and the default for callers that have
// no market in hand; see that file for the sizing of BTC and ETH.
//
// Worked example at SOL spot $101.43: ladderStrike rounds to the nearest
// $2.50 rung, giving a $102.50 strike (the $100.00 rung is $1.43 away, the
// $102.50 rung $1.07). Re-derive a step if its underlying's price level
// changes by more than about 2x.
export const STRIKE_LADDER_STEP = (5n * PRICE_SCALE) / 2n; // $2.50 — SOL, and the default.

/**
 * Rounds `referencePrice` to the nearest rung of a `step`-sized ladder,
 * clamped to a minimum of one step -- `create_market` requires `strike > 0`
 * (see `VsolError::InvalidStrike` in lib.rs), so a reference price inside the
 * first half-step above zero must not round down to a rejected zero strike.
 *
 * `step` defaults to `STRIKE_LADDER_STEP` (SOL's) only so callers that
 * genuinely have no market in hand keep working. Anything pricing a SPECIFIC
 * market must pass that market's own `strikeLadderStep` from
 * app/lib/markets.ts -- a BTC rung laddered on SOL's $2.50 step is not a
 * ladder at all.
 *
 * Pure, no I/O: callers own fetching `referencePrice` (e.g. the latest Pyth
 * price for the market's feed, converted to `PRICE_SCALE` atoms) and must
 * call this at most once per newly discovered expiry -- see the module note
 * above for why calling it on every pass would drift and mint duplicate
 * ladder rungs.
 */
export function ladderStrike(referencePrice: bigint, step: bigint = STRIKE_LADDER_STEP): bigint {
  if (step <= 0n) throw new RangeError("A strike ladder step must be positive");
  if (referencePrice <= 0n) return step;
  const halfStep = step / 2n;
  const rounded = ((referencePrice + halfStep) / step) * step;
  return rounded < step ? step : rounded;
}

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
  // The conditional-token winner threshold (see `upWins` below and
  // `CreateMarketArgs::strike` in src/lib.rs). Part of the id hash so two
  // markets identical in every other parameter but a different strike are
  // distinct series, not the same PDA.
  strike: bigint;
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
    u64(params.strike),
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

// --- Conditional tokens ("complete sets") ---

export function deriveUpMint(market: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([UP_MINT_SEED, market.toBuffer()], programId)[0];
}

export function deriveDownMint(market: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([DOWN_MINT_SEED, market.toBuffer()], programId)[0];
}

export function deriveCompleteSetVault(market: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([COMPLETE_SET_VAULT_SEED, market.toBuffer()], programId)[0];
}

/// The deterministic address `mintCompleteSet` mints a minter's own UP/DOWN
/// tokens into (see `COMPLETE_SET_TOKEN_SEED`'s doc comment above).
/// `burnCompleteSet`/`redeemWinning` accept this OR any other token account
/// the caller holds a balance in -- it is not the only valid source/target
/// for those two.
export function deriveCompleteSetToken(mint: PublicKey, owner: PublicKey, programId = VSOL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([COMPLETE_SET_TOKEN_SEED, mint.toBuffer(), owner.toBuffer()], programId)[0];
}

// The conditional-token winner rule, mirroring `math::up_wins` in
// vsol/programs/vsol/src/math.rs byte-for-byte: UP wins if the finalized
// price is *strictly* above the market's strike, DOWN otherwise (an exact
// tie resolves to DOWN). Lets a client predict the winner -- and therefore
// which mint `redeemWinning` will accept -- from a market/oracle account it
// has already fetched, without waiting on-chain for the actual redemption
// attempt.
export function upWins(settlementPrice: bigint, strike: bigint): boolean {
  return settlementPrice > strike;
}

async function anchorInstructionDiscriminator(name: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(`global:${name}`, "utf8"));
  return Buffer.from(digest).subarray(0, 8);
}

export type MintCompleteSetAccounts = {
  minter: PublicKey;
  config: PublicKey;
  market: PublicKey;
  settlementMint: PublicKey;
  upMint: PublicKey;
  downMint: PublicKey;
  collateralVault: PublicKey;
  minterSource: PublicKey;
  minterUpToken: PublicKey;
  minterDownToken: PublicKey;
};

// Builds a `mint_complete_set` instruction. Account order and writability
// mirror the `MintCompleteSet` Anchor context in src/lib.rs exactly --
// Solana matches accounts by position, not name -- and the 8-byte
// discriminator is Anchor's own convention (`sha256("global:<name>")[..8]`),
// verified against the program's own generated IDL
// (`target/idl/vsol.json`) for this exact instruction.
export async function buildMintCompleteSetInstruction(
  accounts: MintCompleteSetAccounts,
  amount: bigint,
  programId = VSOL_PROGRAM_ID,
): Promise<TransactionInstruction> {
  const data = Buffer.concat([await anchorInstructionDiscriminator("mint_complete_set"), u64(amount)]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.minter, isSigner: true, isWritable: true },
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.market, isSigner: false, isWritable: false },
      { pubkey: accounts.settlementMint, isSigner: false, isWritable: false },
      { pubkey: accounts.upMint, isSigner: false, isWritable: true },
      { pubkey: accounts.downMint, isSigner: false, isWritable: true },
      { pubkey: accounts.collateralVault, isSigner: false, isWritable: true },
      { pubkey: accounts.minterSource, isSigner: false, isWritable: true },
      { pubkey: accounts.minterUpToken, isSigner: false, isWritable: true },
      { pubkey: accounts.minterDownToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export type BurnCompleteSetAccounts = {
  burner: PublicKey;
  config: PublicKey;
  market: PublicKey;
  settlementMint: PublicKey;
  upMint: PublicKey;
  downMint: PublicKey;
  collateralVault: PublicKey;
  burnerUpToken: PublicKey;
  burnerDownToken: PublicKey;
  burnerDestination: PublicKey;
};

// Mirrors the `BurnCompleteSet` Anchor context exactly. Callable before OR
// after settlement -- see `burn_complete_set`'s doc comment in src/lib.rs.
export async function buildBurnCompleteSetInstruction(
  accounts: BurnCompleteSetAccounts,
  amount: bigint,
  programId = VSOL_PROGRAM_ID,
): Promise<TransactionInstruction> {
  const data = Buffer.concat([await anchorInstructionDiscriminator("burn_complete_set"), u64(amount)]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.burner, isSigner: true, isWritable: false },
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.market, isSigner: false, isWritable: false },
      { pubkey: accounts.settlementMint, isSigner: false, isWritable: false },
      { pubkey: accounts.upMint, isSigner: false, isWritable: true },
      { pubkey: accounts.downMint, isSigner: false, isWritable: true },
      { pubkey: accounts.collateralVault, isSigner: false, isWritable: true },
      { pubkey: accounts.burnerUpToken, isSigner: false, isWritable: true },
      { pubkey: accounts.burnerDownToken, isSigner: false, isWritable: true },
      { pubkey: accounts.burnerDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export type RedeemWinningAccounts = {
  redeemer: PublicKey;
  config: PublicKey;
  market: PublicKey;
  oracle: PublicKey;
  settlementMint: PublicKey;
  upMint: PublicKey;
  downMint: PublicKey;
  collateralVault: PublicKey;
  redeemerToken: PublicKey;
  redeemerDestination: PublicKey;
};

// Mirrors the `RedeemWinning` Anchor context exactly. `redeemerToken` must
// hold the WINNING side (see `upWins`) -- the program rejects the losing
// side with `LosingSideNotRedeemable`, and rejects any redemption at all
// before the oracle finalizes with `OracleNotFinalized`.
export async function buildRedeemWinningInstruction(
  accounts: RedeemWinningAccounts,
  amount: bigint,
  programId = VSOL_PROGRAM_ID,
): Promise<TransactionInstruction> {
  const data = Buffer.concat([await anchorInstructionDiscriminator("redeem_winning"), u64(amount)]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.redeemer, isSigner: true, isWritable: false },
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.market, isSigner: false, isWritable: false },
      { pubkey: accounts.oracle, isSigner: false, isWritable: false },
      { pubkey: accounts.settlementMint, isSigner: false, isWritable: false },
      { pubkey: accounts.upMint, isSigner: false, isWritable: true },
      { pubkey: accounts.downMint, isSigner: false, isWritable: true },
      { pubkey: accounts.collateralVault, isSigner: false, isWritable: true },
      { pubkey: accounts.redeemerToken, isSigner: false, isWritable: true },
      { pubkey: accounts.redeemerDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export type RedeemUnresolvedAccounts = {
  redeemer: PublicKey;
  config: PublicKey;
  market: PublicKey;
  oracle: PublicKey;
  settlementMint: PublicKey;
  upMint: PublicKey;
  downMint: PublicKey;
  collateralVault: PublicKey;
  redeemerToken: PublicKey;
  redeemerDestination: PublicKey;
};

// Mirrors the `RedeemUnresolved` Anchor context exactly (same account order
// as `RedeemWinning` -- see `redeem_unresolved`'s doc comment in src/lib.rs).
// `redeemerToken` may hold EITHER side; the program validates it belongs to
// `upMint` or `downMint` itself and rejects anything else with
// `InvalidConditionalTokenMint`. Only callable once
// `finalSettlementDeadline` has passed AND the oracle is still unfinalized
// -- see that function's doc comment for why this is the exact complement
// of `publishPythSettlement`'s own acceptance window, not merely close to it.
export async function buildRedeemUnresolvedInstruction(
  accounts: RedeemUnresolvedAccounts,
  amount: bigint,
  programId = VSOL_PROGRAM_ID,
): Promise<TransactionInstruction> {
  const data = Buffer.concat([await anchorInstructionDiscriminator("redeem_unresolved"), u64(amount)]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.redeemer, isSigner: true, isWritable: false },
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.market, isSigner: false, isWritable: false },
      { pubkey: accounts.oracle, isSigner: false, isWritable: false },
      { pubkey: accounts.settlementMint, isSigner: false, isWritable: false },
      { pubkey: accounts.upMint, isSigner: false, isWritable: true },
      { pubkey: accounts.downMint, isSigner: false, isWritable: true },
      { pubkey: accounts.collateralVault, isSigner: false, isWritable: true },
      { pubkey: accounts.redeemerToken, isSigner: false, isWritable: true },
      { pubkey: accounts.redeemerDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// Mirrors the on-chain `calculate_deposit_shares`/`calculate_withdraw_amount`
// (vsol/programs/vsol/src/math.rs) byte-for-byte, including the virtual
// shares/assets offset: every conversion adds 1 to both `totalShares` and
// `totalAssets` (OpenZeppelin ERC-4626's `_decimalsOffset() == 0`
// convention). This is belt-and-braces on top of the on-chain
// `LiquidityPool.totalAssets` ledger, which is the primary fix for the
// donation/first-depositor inflation attack -- `totalAssets` tracks only
// what actually moved through `depositLiquidity`/`withdrawLiquidity`/etc,
// never the raw (donation-inflatable) SPL token balance. The virtual offset
// additionally bounds the very first depositor's exposure to rounding, even
// if the ledger were somehow wrong. See `calculate_deposit_shares`'s doc
// comment in math.rs for the full rationale.
export function calculateDepositShares(amount: bigint, totalShares: bigint, totalAssets: bigint): bigint {
  if (amount <= 0n || totalShares < 0n || totalAssets < 0n) throw new RangeError("invalid pool share parameters");
  if (totalAssets === 0n && totalShares > 0n) throw new RangeError("pool is insolvent");
  const shares = (amount * (totalShares + 1n)) / (totalAssets + 1n);
  if (shares === 0n) throw new RangeError("deposit is too small");
  return shares;
}

export function calculateWithdrawAmount(shares: bigint, totalShares: bigint, totalAssets: bigint): bigint {
  if (shares <= 0n || totalShares <= 0n || shares > totalShares || totalAssets < 0n) {
    throw new RangeError("invalid pool share parameters");
  }
  const amount = (shares * (totalAssets + 1n)) / (totalShares + 1n);
  if (amount === 0n) throw new RangeError("withdrawal is too small");
  return amount;
}

/// MUST match `MARKET_CLEANUP_BUFFER_SECONDS` in
/// vsol/programs/vsol/src/lib.rs (and the copy in scripts/lib/settlement.ts).
export const MARKET_CLEANUP_BUFFER_SECONDS = 604_800n;

// Mirrors the on-chain `refund_unsettled`/`refund_pool_position` deadline
// byte-for-byte: `expiry + observation_window_seconds +
// settlement_grace_seconds`. This is when a position whose oracle never
// finalized first becomes refundable.
//
// NOTE this is NOT when a market becomes closeable -- see
// `marketCloseableAfter` below, which adds the cleanup buffer on top.
export function settlementDeadline(params: {
  expiry: bigint;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
}): bigint {
  return params.expiry + BigInt(params.observationWindowSeconds) + BigInt(params.settlementGraceSeconds);
}

// Mirrors the on-chain `close_settled_market` deadline: the settlement
// deadline PLUS `MARKET_CLEANUP_BUFFER_SECONDS`. The instruction requires
// `now > deadline` (strictly), so an off-chain cleaner should treat this
// value as "not yet safe to close" and only call `close_settled_market` once
// the cluster clock has moved *past* it.
//
// The buffer exists because closing a market makes `settle`/`refund_*`
// permanently unconstructible for any position still referencing it. Closing
// at the settlement deadline itself -- which this function used to return --
// races in-flight refunds and strands their escrow forever.
export function marketCloseableAfter(params: {
  expiry: bigint;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
}): bigint {
  return settlementDeadline(params) + MARKET_CLEANUP_BUFFER_SECONDS;
}

// Mirrors the on-chain `final_settlement_deadline` (vsol/programs/vsol/src/lib.rs)
// byte-for-byte: `settlementDeadline` PLUS `maxSettlementStalenessSeconds`.
// This is the exact instant `publishPythSettlement` can no longer ever
// finalize the oracle again, and therefore the exact instant
// `redeemUnresolved`'s pro-rata escape hatch opens (on-chain:
// `now > finalSettlementDeadline`). These two conditions MUST be exact
// complements -- see `redeemUnresolved`'s doc comment in src/lib.rs for what
// goes wrong (a real insolvency, not just a race) if a caller uses the
// earlier `settlementDeadline` instead.
export function finalSettlementDeadline(params: {
  expiry: bigint;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  maxSettlementStalenessSeconds: number;
}): bigint {
  return settlementDeadline(params) + BigInt(params.maxSettlementStalenessSeconds);
}

export function calculatePayout(quote: Pick<Quote, "direction" | "strike" | "width" | "maxPayout">, price: bigint): bigint {
  if (quote.width <= 0n || quote.maxPayout <= 0n) throw new RangeError("invalid payout parameters");
  const rawDelta = quote.direction === 0 ? price - quote.strike : quote.strike - price;
  const delta = rawDelta <= 0n ? 0n : rawDelta >= quote.width ? quote.width : rawDelta;
  return (quote.maxPayout * delta) / quote.width;
}

// MUST match MAX_POOL_UTILIZATION_BPS in vsol/programs/vsol/src/lib.rs.
//
// Hard ceiling on `maxUtilizationBps` for every liquidity pool, regardless of
// what its (permissionless, therefore untrusted) manager configures: no pool
// can ever be set up to back positions with more than 80% of its capital.
//
// This is blast-radius reduction, NOT a fix -- it stops a single fill from
// draining the whole pool in one shot, but a manager who controls
// `quoteAuthority` can still drain it geometrically across repeated
// fill/close cycles. The real defense against a hostile config change is
// the timelock below.
export const MAX_POOL_UTILIZATION_BPS = 8_000;

// MUST match POOL_UPDATE_TIMELOCK_SECONDS in vsol/programs/vsol/src/lib.rs.
//
// How long after `updateLiquidityPool` proposes raising a risk cap or
// rotating `quoteAuthority` before `applyLiquidityPoolUpdate` may commit it.
// Lowering a cap with `quoteAuthority` unchanged is exempt from this delay
// and applies immediately -- see `isPoolUpdateTightening` below, which
// mirrors that branch condition.
export const POOL_UPDATE_TIMELOCK_SECONDS = 86_400n;

// Mirrors `update_liquidity_pool`'s immediate-vs-timelocked branch condition
// byte-for-byte: lowering (or leaving unchanged) both caps, with
// `quoteAuthority` left unchanged, applies immediately; anything else --
// raising either cap, or rotating `quoteAuthority` at all -- is timelocked.
// Lets an off-chain caller predict which path a proposed change will take
// before submitting `updateLiquidityPool`.
export function isPoolUpdateTightening(params: {
  currentQuoteAuthority: PublicKey;
  currentMaxUtilizationBps: number;
  currentMaxPositionBps: number;
  nextQuoteAuthority: PublicKey;
  nextMaxUtilizationBps: number;
  nextMaxPositionBps: number;
}): boolean {
  return (
    params.nextQuoteAuthority.equals(params.currentQuoteAuthority) &&
    params.nextMaxUtilizationBps <= params.currentMaxUtilizationBps &&
    params.nextMaxPositionBps <= params.currentMaxPositionBps
  );
}

// Mirrors the on-chain "no pending change" sentinel used throughout
// `LiquidityPool.pendingEffectiveAt`: Anchor zero-initializes new pool
// accounts to exactly this state, and both `applyLiquidityPoolUpdate` and
// `cancelPendingPoolUpdate` reset back to it.
export function isPoolUpdatePending(pendingEffectiveAt: bigint): boolean {
  return pendingEffectiveAt !== 0n;
}

// Mirrors `update_liquidity_pool`'s timelock computation byte-for-byte:
// `now + POOL_UPDATE_TIMELOCK_SECONDS`. Useful for predicting
// `pendingEffectiveAt` before submitting the transaction, or for rendering
// "unlocks at" UI copy from a pending change already observed on-chain.
export function poolUpdateEffectiveAt(now: bigint): bigint {
  return now + POOL_UPDATE_TIMELOCK_SECONDS;
}
