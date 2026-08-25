import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  Connection,
  Ed25519Program,
  Keypair,
  MessageV0,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
// Explicit .ts/.json import specifiers (with a JSON import attribute) below
// keep this module directly importable by the node:test suite (Node's native
// type-stripping ESM loader requires both), matching the convention already
// used by app/lib/series-resolver.ts and app/lib/launch-params.ts.
import deployment from "../../vsol/deployments/devnet.json" with { type: "json" };
import idl from "../../vsol/target/idl/vsol.json" with { type: "json" };
import { deriveMarketId, symbolBytes } from "../../vsol/sdk/index.ts";
import {
  VSOL_ADDRESS_LOOKUP_TABLE,
  VSOL_CONFIG,
  VSOL_LIQUIDITY,
  VSOL_PYTH_FEED_ID,
  VSOL_PYTH_UPGRADE_DEPLOYED,
  VSOL_PROGRAM_ID,
  VSOL_RETIRING_LOOKUP_TABLES,
  VSOL_RPC_URL,
  VSOL_SETTLEMENT_MINT,
} from "./vsol.ts";
import { runtimeEnv } from "./runtime-env.ts";
import { markets } from "./markets.ts";
import {
  findVsolSeriesCandidateForMarket,
  resolveAvailableVsolSeries,
  resolveVsolSeries,
  resolveVsolSeriesCatalog,
  type ResolvedVsolSeries,
} from "./series-resolver.ts";
import { LAUNCH_MAX_CONFIDENCE_BPS, LAUNCH_PRICE_SCALE } from "./launch-params.ts";
import { decodeMarketAccount } from "./vsol-market-accounts.ts";

// Re-exported: chain-catalog.ts, chain-positions.ts, and vsol-launch.ts all
// import this from vsol-server.ts. The decoder itself now lives in
// vsol-market-accounts.ts (a leaf module with no dependency on
// series-resolver.ts) so series-resolver.ts can reuse it too without an
// import cycle (vsol-server.ts already depends on series-resolver.ts) --
// see that module's header comment.
export { decodeMarketAccount };

export function getVsolConnection() {
  // Resolve this after the request route has installed Cloudflare bindings.
  return new Connection(runtimeEnv("VSOL_RPC_URL") || VSOL_RPC_URL, "confirmed");
}

const TOKEN_SCALE = 1_000_000n;
const PRICE_SCALE = 1_000_000n;
// Exact string thrown by getVsolSeriesState when the market account itself
// does not exist onchain yet. Exported so callers (and the client catalog
// consumer in TendTerminal.tsx) can recognize "just needs minting" without
// re-deriving or duplicating the literal.
export const SERIES_NOT_YET_MINTED_REASON = "This series has not been minted yet.";
// Solana's max transaction packet size (IPv6 MTU minus headers). The
// mint-on-demand path adds two instructions to an already-large fill
// transaction; if the composed size ever exceeds this, ship no path at all
// rather than a silently-broken oversized transaction.
const MAX_TRANSACTION_BYTES = 1232;
// Read on every quote (see buildVsolQuoteTransaction below), so the fetched
// AddressLookupTableAccount is cached briefly rather than refetched per
// request; a few seconds is enough to absorb request bursts while still
// noticing a freshly-extended table quickly. Keyed by table address (rather
// than a single slot) because resolution may now need either the CURRENT
// table or one of the published RETIRING tables (see
// resolveSignedVsolFillTransaction below).
const ADDRESS_LOOKUP_TABLE_CACHE_MS = 5_000;
const addressLookupTableCache = new Map<string, { account: AddressLookupTableAccount | null; expiresAt: number }>();

/**
 * Fetches (and briefly caches) an address lookup table account. Defaults to
 * the manifest-pinned CURRENT table (VSOL_ADDRESS_LOOKUP_TABLE, see
 * app/lib/vsol.ts); callers resolving a transaction that references a
 * RETIRING table pass its address explicitly. Returns null -- never throws --
 * when `tableAddress` is null, or the address does not resolve to a live
 * account onchain, so every caller can treat "no ALT" as an ordinary,
 * expected state and fall back to legacy transactions exactly as before the
 * ALT existed.
 */
export async function getVsolAddressLookupTableAccount(
  connection: Connection,
  now = Date.now(),
  tableAddress: PublicKey | null = VSOL_ADDRESS_LOOKUP_TABLE,
): Promise<AddressLookupTableAccount | null> {
  if (!tableAddress) return null;
  const cacheKey = tableAddress.toBase58();
  const cached = addressLookupTableCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.account;
  let account: AddressLookupTableAccount | null = null;
  try {
    const result = await connection.getAddressLookupTable(tableAddress);
    account = result.value ?? null;
  } catch {
    account = null;
  }
  addressLookupTableCache.set(cacheKey, { account, expiresAt: now + ADDRESS_LOOKUP_TABLE_CACHE_MS });
  return account;
}

/**
 * Composes a fill's instructions into a v0 transaction (compiled against the
 * given lookup table, so accounts also present in that table collapse into
 * 1-byte indices instead of repeated 32-byte pubkeys) when a table is
 * supplied, or a legacy Transaction -- built exactly as before the ALT
 * existed -- when it is not. Pure and synchronous: tests exercise it
 * directly with a stub AddressLookupTableAccount, no RPC involved.
 */
export function composeVsolFillTransaction(params: {
  feePayer: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
  instructions: TransactionInstruction[];
  lookupTableAccount?: AddressLookupTableAccount | null;
}): Transaction | VersionedTransaction {
  if (params.lookupTableAccount) {
    const v0Message = new TransactionMessage({
      payerKey: params.feePayer,
      recentBlockhash: params.blockhash,
      instructions: params.instructions,
    }).compileToV0Message([params.lookupTableAccount]);
    return new VersionedTransaction(v0Message);
  }
  return new Transaction({
    feePayer: params.feePayer,
    blockhash: params.blockhash,
    lastValidBlockHeight: params.lastValidBlockHeight,
  }).add(...params.instructions);
}

/** Signs either transaction shape with an additional required signer (used for the pool manager on mint-on-demand fills). */
function partialSignVsolTransaction(transaction: Transaction | VersionedTransaction, signer: Keypair) {
  if (transaction instanceof VersionedTransaction) transaction.sign([signer]);
  else transaction.partialSign(signer);
}

/** Serializes either transaction shape to the exact bytes that will go over the wire once fully signed. */
export function serializeVsolTransaction(transaction: Transaction | VersionedTransaction): Buffer {
  if (transaction instanceof VersionedTransaction) return Buffer.from(transaction.serialize());
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
}

const POOL_QUOTE_DOMAIN = Buffer.from("VSOLPLP1", "ascii");
const MARKET_SEED = Buffer.from("market");
const ORACLE_SEED = Buffer.from("oracle");
const POOL_SEED = Buffer.from("pool");
const POOL_TOKEN_SEED = Buffer.from("pool-token");
const PROVIDER_SEED = Buffer.from("provider");
const POOL_MARKET_SEED = Buffer.from("pool-market");
const POOL_NONCE_SEED = Buffer.from("pool-nonce");
const POOL_POSITION_SEED = Buffer.from("pool-position");
const POOL_POSITION_VAULT_SEED = Buffer.from("pool-position-vault");

type IdlAccount = { name: string; writable?: boolean; signer?: boolean; optional?: boolean };
type IdlInstruction = { name: string; discriminator: number[]; accounts: IdlAccount[] };
type IdlAccountDefinition = { name: string; discriminator: number[] };

function idlInstruction(name: string) {
  const instruction = (idl.instructions as IdlInstruction[]).find((entry) => entry.name === name);
  if (!instruction || instruction.discriminator.length !== 8) throw new Error(`VSOL IDL is missing ${name}`);
  return instruction;
}

function idlAccountDiscriminator(name: string) {
  const account = (idl.accounts as IdlAccountDefinition[]).find((entry) => entry.name === name);
  if (!account || account.discriminator.length !== 8) throw new Error(`VSOL IDL is missing account ${name}`);
  return Buffer.from(account.discriminator);
}

const FILL_POOL_QUOTE = idlInstruction("fill_pool_quote");
const DEPOSIT_LIQUIDITY = idlInstruction("deposit_liquidity");
const WITHDRAW_LIQUIDITY = idlInstruction("withdraw_liquidity");
const CONFIG_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("Config");
const ORACLE_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("SettlementOracle");
const POOL_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("LiquidityPool");
const PROVIDER_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("LiquidityProvider");
const POOL_MARKET_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("LiquidityPoolMarket");
const POOL_POSITION_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("PoolPosition");

// Re-exported under the historical name: callers throughout this file (and
// its consumers) still refer to a resolved series candidate as `VsolSeries`.
export type VsolSeries = ResolvedVsolSeries;

function allMarketSymbols(): string[] {
  return markets.map((market) => market.symbol);
}

// Fallback for callers (currently just vsol/scripts/web-execution-smoke.ts)
// that don't specify a series explicitly. Historically defaulted to
// whichever manifest entry happened to be the "30D" series; now resolves the
// live chain-derived 30D rung for the first configured market symbol.
async function defaultQuoteSeries(): Promise<ResolvedVsolSeries | null> {
  const defaultSymbol = markets[0]?.symbol ?? "NVDA";
  const resolution = await resolveVsolSeries(defaultSymbol, "30D");
  return resolution.available ? resolution.series : null;
}

export type VsolSeriesState = {
  symbol: string;
  code: VsolSeries["code"];
  market: string;
  oracle: string;
  expiry: number;
  observationWindowSeconds: number;
  lastTradeAt: number;
  enabled: boolean;
  finalized: boolean;
  poolAuthorized: boolean;
  available: boolean;
  availabilityReason: string;
};

export type VsolLiquidityState = {
  ready: boolean;
  reason?: string;
  checkedAt: string;
  pool?: {
    address: string;
    assetVault: string;
    settlementMint: string;
    quoteAuthority: string;
    decimals: number;
    availableAssetsAtoms: string;
    lockedCollateralAtoms: string;
    totalSharesAtoms: string;
    openPositions: number;
    depositsOpen: boolean;
    withdrawalsOpen: boolean;
    maxUtilizationBps: number;
    maxPositionBps: number;
  };
  provider?: {
    address: string;
    walletAssetsAtoms: string;
    sharesAtoms: string;
    redeemableAssetsAtoms: string;
  };
};

type Quote = {
  nonce: bigint;
  direction: 0 | 1;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  quoteExpiry: bigint;
};

type DecodedPool = {
  bump: number;
  tokenBump: number;
  config: PublicKey;
  settlementMint: PublicKey;
  quoteAuthority: PublicKey;
  poolId: Buffer;
  totalShares: bigint;
  lockedCollateral: bigint;
  openPositions: bigint;
  cumulativePremium: bigint;
  cumulativePayout: bigint;
  maxUtilizationBps: number;
  maxPositionBps: number;
  manager: PublicKey;
  pendingQuoteAuthority: PublicKey;
  pendingMaxUtilizationBps: number;
  pendingMaxPositionBps: number;
  /// 0n means no pending change; otherwise the unix second the manager's
  /// proposed config becomes applyable.
  pendingEffectiveAt: bigint;
  /// The pool's own internal ledger of free (unlocked) settlement tokens --
  /// NOT the raw SPL `pool_token` balance. Anyone can inflate the raw
  /// balance with a plain `spl-token transfer` that never goes through
  /// `deposit_liquidity` (a token account's owner cannot refuse incoming
  /// transfers), so the program tracks its own ledger and uses THIS value,
  /// not the physical balance, as the share-price denominator. See
  /// `total_assets` on `LiquidityPool` in vsol/programs/vsol/src/lib.rs.
  /// In ordinary operation (no donation) this equals the raw balance
  /// exactly; a donation makes the raw balance exceed this by the donated
  /// amount, which becomes inert dust never counted by any share math.
  totalAssets: bigint;
};

type PoolCore = {
  config: ReturnType<typeof decodeConfigAccount>;
  pool: DecodedPool;
  poolAssets: bigint;
  decimals: number;
};

export function encodeU64(value: bigint) {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError("u64 out of range");
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

export function encodeI64(value: bigint) {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) throw new RangeError("i64 out of range");
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(value);
  return buffer;
}

export function encodeU16(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

export function encodeU32(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError("u32 out of range");
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function publicKeyAt(data: Buffer, offset: number) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function expectAccount(data: Buffer, size: number, discriminator: Buffer, label: string) {
  if (data.length !== size || !data.subarray(0, 8).equals(discriminator)) {
    throw new Error(`The ${label} account discriminator or size is invalid`);
  }
}

export function decodeConfigAccount(data: Buffer) {
  expectAccount(data, 239, CONFIG_ACCOUNT_DISCRIMINATOR, "VSOL config");
  return {
    treasuryOwner: publicKeyAt(data, 169),
    paused: data[203] === 1,
    eligibilityRequired: data[204] === 1,
    domainSeparator: data.subarray(205, 237),
    domainVersion: data.readUInt16LE(237),
  };
}

export function decodeOracleAccount(data: Buffer) {
  expectAccount(data, 143, ORACLE_ACCOUNT_DISCRIMINATOR, "VSOL oracle");
  return {
    market: publicKeyAt(data, 9),
    pythFeedId: data.subarray(105, 137).toString("hex"),
    finalized: data[141] === 1,
    // Appended after launch: true when the finalized price came from the
    // tier-2 last-known-price fallback rather than a fresh in-window print.
    settledFromStalePrice: data[142] === 1,
  };
}

// 266 bytes, not 258: the program appended `total_assets: u64` to
// `LiquidityPool` for the donation/first-depositor-inflation fix (see
// `total_assets`'s doc comment on `LiquidityPool` in
// vsol/programs/vsol/src/lib.rs). The length check here is EXACT, so it is a
// hard failure -- not a silent degradation -- if this drifts from the
// on-chain struct. Existing byte offsets are unchanged because the new field
// was appended at the end; verified against `8 + LiquidityPool::INIT_SPACE`
// (the real, compiled account size), not just arithmetic.
export function decodePoolAccount(data: Buffer): DecodedPool {
  expectAccount(data, 266, POOL_ACCOUNT_DISCRIMINATOR, "VSOL liquidity pool");
  return {
    bump: data[8],
    tokenBump: data[9],
    config: publicKeyAt(data, 10),
    settlementMint: publicKeyAt(data, 42),
    quoteAuthority: publicKeyAt(data, 74),
    poolId: data.subarray(106, 138),
    totalShares: data.readBigUInt64LE(138),
    lockedCollateral: data.readBigUInt64LE(146),
    openPositions: data.readBigUInt64LE(154),
    cumulativePremium: data.readBigUInt64LE(162),
    cumulativePayout: data.readBigUInt64LE(170),
    maxUtilizationBps: data.readUInt16LE(178),
    maxPositionBps: data.readUInt16LE(180),
    manager: publicKeyAt(data, 182),
    // A pending manager-proposed config change, visible to LPs so they can
    // withdraw before it takes effect -- the entire point of the timelock.
    // `pendingEffectiveAt === 0n` means "nothing pending".
    pendingQuoteAuthority: publicKeyAt(data, 214),
    pendingMaxUtilizationBps: data.readUInt16LE(246),
    pendingMaxPositionBps: data.readUInt16LE(248),
    pendingEffectiveAt: data.readBigInt64LE(250),
    totalAssets: data.readBigUInt64LE(258),
  };
}

function decodeProviderAccount(data: Buffer) {
  expectAccount(data, 97, PROVIDER_ACCOUNT_DISCRIMINATOR, "VSOL liquidity provider");
  return {
    pool: publicKeyAt(data, 9),
    owner: publicKeyAt(data, 41),
    shares: data.readBigUInt64LE(73),
  };
}

export function decodePoolMarketAccount(data: Buffer) {
  expectAccount(data, 82, POOL_MARKET_ACCOUNT_DISCRIMINATOR, "VSOL pool market");
  return {
    pool: publicKeyAt(data, 9),
    market: publicKeyAt(data, 41),
    lastTradeAt: Number(data.readBigInt64LE(73)),
    enabled: data[81] === 1,
  };
}

function derivePool(poolId: Buffer) {
  return PublicKey.findProgramAddressSync(
    [POOL_SEED, VSOL_CONFIG.toBuffer(), VSOL_SETTLEMENT_MINT.toBuffer(), poolId],
    VSOL_PROGRAM_ID,
  )[0];
}

function derivePoolToken(pool: PublicKey) {
  return PublicKey.findProgramAddressSync([POOL_TOKEN_SEED, pool.toBuffer()], VSOL_PROGRAM_ID)[0];
}

export function deriveLiquidityProvider(pool: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync([PROVIDER_SEED, pool.toBuffer(), owner.toBuffer()], VSOL_PROGRAM_ID)[0];
}

export function derivePoolMarket(pool: PublicKey, market: PublicKey) {
  return PublicKey.findProgramAddressSync([POOL_MARKET_SEED, pool.toBuffer(), market.toBuffer()], VSOL_PROGRAM_ID)[0];
}

function derivePoolNonce(pool: PublicKey, quoteAuthority: PublicKey, nonce: bigint) {
  return PublicKey.findProgramAddressSync(
    [POOL_NONCE_SEED, pool.toBuffer(), quoteAuthority.toBuffer(), encodeU64(nonce)],
    VSOL_PROGRAM_ID,
  )[0];
}

function derivePoolPosition(nonceRecord: PublicKey) {
  return PublicKey.findProgramAddressSync([POOL_POSITION_SEED, nonceRecord.toBuffer()], VSOL_PROGRAM_ID)[0];
}

function derivePoolPositionVault(position: PublicKey) {
  return PublicKey.findProgramAddressSync([POOL_POSITION_VAULT_SEED, position.toBuffer()], VSOL_PROGRAM_ID)[0];
}

function instructionFromIdl(
  definition: IdlInstruction,
  accounts: Record<string, PublicKey>,
  data: Buffer,
) {
  return new TransactionInstruction({
    programId: VSOL_PROGRAM_ID,
    keys: definition.accounts.map((account) => {
      const pubkey = accounts[account.name];
      if (!pubkey) throw new Error(`Missing VSOL instruction account ${account.name}`);
      return { pubkey, isSigner: Boolean(account.signer), isWritable: Boolean(account.writable) };
    }),
    data: Buffer.concat([Buffer.from(definition.discriminator), data]),
  });
}

/** Builds a VSOL instruction from the published IDL definition (used by the launch flows). */
export function buildVsolIdlInstruction(name: string, accounts: Record<string, PublicKey>, data: Buffer) {
  return instructionFromIdl(idlInstruction(name), accounts, data);
}

/** Reads an instruction discriminator from the published IDL. */
export function vsolInstructionDiscriminator(name: string) {
  return Buffer.from(idlInstruction(name).discriminator);
}

function poolQuoteMessage(params: {
  config: ReturnType<typeof decodeConfigAccount>;
  pool: PublicKey;
  market: PublicKey;
  buyer: PublicKey;
  quoteAuthority: PublicKey;
  quote: Quote;
}) {
  return Buffer.concat([
    POOL_QUOTE_DOMAIN,
    params.config.domainSeparator,
    encodeU16(params.config.domainVersion),
    VSOL_PROGRAM_ID.toBuffer(),
    VSOL_CONFIG.toBuffer(),
    params.pool.toBuffer(),
    params.market.toBuffer(),
    params.buyer.toBuffer(),
    params.quoteAuthority.toBuffer(),
    encodeU64(params.quote.nonce),
    Buffer.from([params.quote.direction]),
    encodeU64(params.quote.strike),
    encodeU64(params.quote.width),
    encodeU64(params.quote.premium),
    encodeU64(params.quote.maxPayout),
    encodeI64(params.quote.quoteExpiry),
  ]);
}

function quoteData(quote: Quote) {
  return Buffer.concat([
    encodeU64(quote.nonce),
    Buffer.from([quote.direction]),
    encodeU64(quote.strike),
    encodeU64(quote.width),
    encodeU64(quote.premium),
    encodeU64(quote.maxPayout),
    encodeI64(quote.quoteExpiry),
  ]);
}

function loadSecret(name: "VSOL_MAKER_SECRET_KEY" | "VSOL_FAUCET_SECRET_KEY" | "VSOL_POOL_MANAGER_SECRET_KEY") {
  const encoded = runtimeEnv(name);
  if (!encoded) throw new Error(`${name} is not configured`);
  let values: number[];
  try {
    values = encoded.startsWith("[")
      ? JSON.parse(encoded) as number[]
      : JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as number[];
  } catch {
    throw new Error(`${name} is invalid`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(values));
}

export function vsolQuoteAuthority() {
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  const authority = loadSecret("VSOL_MAKER_SECRET_KEY");
  if (!authority.publicKey.equals(VSOL_LIQUIDITY.quoteAuthorityKey)) {
    throw new Error("VSOL quote authority key does not match the published V2 liquidity pool");
  }
  return authority;
}

export function vsolMaker() {
  return vsolQuoteAuthority();
}

// Mirrors vsolQuoteAuthority exactly: loads the server-held signer and
// verifies its public key against the published V2 liquidity manifest before
// trusting it for anything. Used only by the mint-on-demand path (see
// buildVsolQuoteTransaction below) to sign `set_liquidity_pool_market` as the
// pool's manager. If VSOL_POOL_MANAGER_SECRET_KEY is absent or mismatched,
// this throws -- callers must fail closed rather than silently skip
// authorization, and ordinary fills on already-minted series never call this.
export function vsolPoolManager() {
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  const manager = loadSecret("VSOL_POOL_MANAGER_SECRET_KEY");
  if (!VSOL_LIQUIDITY.managerKey || !manager.publicKey.equals(VSOL_LIQUIDITY.managerKey)) {
    throw new Error("VSOL pool manager key does not match the published V2 liquidity pool");
  }
  return manager;
}

export function vsolFaucet() {
  return loadSecret("VSOL_FAUCET_SECRET_KEY");
}

async function clusterTime(connection: Connection) {
  const slot = await connection.getSlot("confirmed");
  const timestamp = await connection.getBlockTime(slot);
  if (timestamp === null) throw new Error("Devnet clock is unavailable");
  return timestamp;
}

export async function getVsolClusterTime(connection = getVsolConnection()) {
  return clusterTime(connection);
}

function manifestPoolId() {
  if (!VSOL_LIQUIDITY || !/^[0-9a-f]{64}$/i.test(VSOL_LIQUIDITY.id)) {
    throw new Error("The verified VSOL V2 pool id is not published");
  }
  return Buffer.from(VSOL_LIQUIDITY.id, "hex");
}

async function getPoolCore(connection: Connection): Promise<PoolCore> {
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  const [programAccount, configAccount, poolAccount, mint, poolToken] = await Promise.all([
    connection.getAccountInfo(VSOL_PROGRAM_ID, "confirmed"),
    connection.getAccountInfo(VSOL_CONFIG, "confirmed"),
    connection.getAccountInfo(VSOL_LIQUIDITY.poolKey, "confirmed"),
    getMint(connection, VSOL_SETTLEMENT_MINT, "confirmed", TOKEN_PROGRAM_ID),
    getAccount(connection, VSOL_LIQUIDITY.assetVaultKey, "confirmed", TOKEN_PROGRAM_ID),
  ]);
  if (!programAccount?.executable) throw new Error("The published VSOL program is not executable");
  if (!configAccount || !poolAccount) throw new Error("The published VSOL pool accounts are unavailable");
  if (!configAccount.owner.equals(VSOL_PROGRAM_ID) || !poolAccount.owner.equals(VSOL_PROGRAM_ID)) {
    throw new Error("The published VSOL pool is not owned by the verified program");
  }
  const config = decodeConfigAccount(Buffer.from(configAccount.data));
  const pool = decodePoolAccount(Buffer.from(poolAccount.data));
  const id = manifestPoolId();
  const expectedDomain = Buffer.from(deployment.domainSeparator);
  const exactBinding = derivePool(id).equals(VSOL_LIQUIDITY.poolKey)
    && derivePoolToken(VSOL_LIQUIDITY.poolKey).equals(VSOL_LIQUIDITY.assetVaultKey)
    && pool.poolId.equals(id)
    && pool.config.equals(VSOL_CONFIG)
    && pool.settlementMint.equals(VSOL_SETTLEMENT_MINT)
    && pool.settlementMint.equals(VSOL_LIQUIDITY.settlementMintKey)
    && pool.quoteAuthority.equals(VSOL_LIQUIDITY.quoteAuthorityKey)
    && pool.maxUtilizationBps === VSOL_LIQUIDITY.maxUtilizationBps
    && pool.maxPositionBps === VSOL_LIQUIDITY.maxPositionBps
    && !pool.manager.equals(PublicKey.default)
    && (!VSOL_LIQUIDITY.managerKey || pool.manager.equals(VSOL_LIQUIDITY.managerKey))
    && poolToken.address.equals(VSOL_LIQUIDITY.assetVaultKey)
    && poolToken.mint.equals(VSOL_SETTLEMENT_MINT)
    && poolToken.owner.equals(VSOL_LIQUIDITY.poolKey)
    && config.domainSeparator.equals(expectedDomain)
    && config.domainVersion === deployment.domainVersion;
  if (!exactBinding) throw new Error("The published V2 liquidity manifest does not match verified onchain state");
  if (config.paused) throw new Error("The VSOL protocol is paused onchain");
  // `pool.totalAssets` (the program's own ledger), NOT `poolToken.amount`
  // (the raw SPL balance): the two diverge exactly when someone has donated
  // tokens directly to the vault, and every on-chain share-price/utilization
  // calculation this app must mirror (buildVsolQuoteTransaction below, and
  // calculateDepositShares/calculateWithdrawAmount in
  // app/api/vsol/liquidity/prepare/route.ts) now uses the ledger. Using the
  // raw balance here would silently drift from what the program actually
  // computes -- with `minimumOutputAtoms` set to an exact (zero-tolerance)
  // prediction in the prepare route, that drift would fail every deposit/
  // withdrawal on-chain with SlippageExceeded, not just misreport a number.
  return { config, pool, poolAssets: pool.totalAssets, decimals: mint.decimals };
}

// Authorization for a (pool, market) pair is verified entirely on-chain here,
// never against a checked-in manifest allowlist: the pool-market PDA is
// derived from (pool, market), the account is owned by the VSOL program and
// stores both bindings, and only the pool manager can create/enable it. That
// makes the PDA derivation plus the ownership/discriminator/binding checks
// below strictly sufficient — a manifest snapshot adds no security and only
// goes stale as the keeper mints fresh rungs. `lastTradeAt` is likewise
// treated as authoritative from chain rather than compared against a
// locally-derived policy value; the caller applies it via the existing
// before-cutoff / before-expiry availability logic.
async function getPoolMarketState(series: VsolSeries, connection: Connection) {
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  const address = derivePoolMarket(VSOL_LIQUIDITY.poolKey, series.marketKey);
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account || !account.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The VSOL pool-market authorization is unavailable");
  // decodePoolMarketAccount enforces the account discriminator and exact size.
  const state = decodePoolMarketAccount(Buffer.from(account.data));
  if (!state.pool.equals(VSOL_LIQUIDITY.poolKey) || !state.market.equals(series.marketKey)) {
    throw new Error("The published pool-market authorization does not match onchain state");
  }
  return { ...state, address };
}

export async function getVsolSeriesState(series: VsolSeries, connection = getVsolConnection()): Promise<VsolSeriesState> {
  const [marketAccount, oracleAccount, poolMarket, now] = await Promise.all([
    connection.getAccountInfo(series.marketKey, "confirmed"),
    connection.getAccountInfo(series.oracleKey, "confirmed"),
    getPoolMarketState(series, connection),
    clusterTime(connection),
  ]);
  if (!marketAccount || !oracleAccount) throw new Error(SERIES_NOT_YET_MINTED_REASON);
  if (!marketAccount.owner.equals(VSOL_PROGRAM_ID) || !oracleAccount.owner.equals(VSOL_PROGRAM_ID)) {
    throw new Error("The deployed VSOL series is not owned by the verified program");
  }
  const market = decodeMarketAccount(Buffer.from(marketAccount.data));
  const oracle = decodeOracleAccount(Buffer.from(oracleAccount.data));
  const expectedMarket = PublicKey.findProgramAddressSync([MARKET_SEED, VSOL_CONFIG.toBuffer(), market.marketId], VSOL_PROGRAM_ID)[0];
  const expectedOracle = PublicKey.findProgramAddressSync([ORACLE_SEED, series.marketKey.toBuffer()], VSOL_PROGRAM_ID)[0];
  const exactBinding = expectedMarket.equals(series.marketKey)
    && expectedOracle.equals(series.oracleKey)
    && market.config.equals(VSOL_CONFIG)
    && market.settlementMint.equals(VSOL_SETTLEMENT_MINT)
    && market.oracle.equals(series.oracleKey)
    && oracle.market.equals(series.marketKey)
    && market.pythFeedId === VSOL_PYTH_FEED_ID
    && oracle.pythFeedId === VSOL_PYTH_FEED_ID
    && market.expiry === series.expiry
    && market.observationWindowSeconds === series.observationWindowSeconds
    && market.settlementGraceSeconds === series.settlementGraceSeconds
    // Chain-derived series always know their expected staleness bound (it is
    // one of the parameters hashed into the market id itself), so this check
    // is now mandatory rather than optional.
    && market.maxSettlementStalenessSeconds === series.maxSettlementStalenessSeconds;
  if (!exactBinding) throw new Error("The deployed series catalog does not match verified onchain state");
  // The on-chain lastTradeAt is authoritative (not required to equal the
  // locally-derived policy value), but it must still be a sane cutoff: a
  // pool manager can enable a pool-market with any lastTradeAt, so this
  // guards against one that sits at or past the market's own expiry.
  if (poolMarket.lastTradeAt >= market.expiry) {
    throw new Error("The onchain pool-market trade cutoff is not before its expiry");
  }

  const beforeCutoff = now < poolMarket.lastTradeAt;
  const available = market.enabled && !oracle.finalized && poolMarket.enabled && beforeCutoff && now < market.expiry;
  let availabilityReason = "Available";
  if (!market.enabled) availabilityReason = "This onchain series is disabled.";
  else if (oracle.finalized) availabilityReason = "This onchain series has already settled.";
  else if (!poolMarket.enabled) availabilityReason = "The V2 liquidity pool has disabled this series.";
  else if (!beforeCutoff) availabilityReason = "The onchain trade cutoff has passed.";
  else if (now >= market.expiry) availabilityReason = "This onchain series has expired.";
  return {
    symbol: series.symbol,
    code: series.code,
    market: series.marketKey.toBase58(),
    oracle: series.oracleKey.toBase58(),
    expiry: market.expiry,
    observationWindowSeconds: market.observationWindowSeconds,
    lastTradeAt: poolMarket.lastTradeAt,
    enabled: market.enabled,
    finalized: oracle.finalized,
    poolAuthorized: poolMarket.enabled,
    available,
    availabilityReason,
  };
}

export type VsolSeriesStateOrPlan = VsolSeriesState & { mintOnDemand: boolean };

/**
 * Like `getVsolSeriesState`, but when the market account itself does not
 * exist onchain yet, returns a synthetic "would exist" state (derived purely
 * from the already-resolved grid parameters in `series`, no chain state to
 * read yet) with `mintOnDemand: true` instead of throwing. This is the single
 * gate mint-on-demand quoting/building hangs off: checked directly against
 * the market account (not by matching an error string), so it can never be
 * confused with a genuinely broken series (wrong owner, disabled, expired,
 * or a market that exists but was never authorized for this pool -- those
 * still throw/report unavailable exactly as before).
 */
export async function getVsolSeriesStateOrPlan(series: VsolSeries, connection = getVsolConnection()): Promise<VsolSeriesStateOrPlan> {
  const marketAccount = await connection.getAccountInfo(series.marketKey, "confirmed");
  if (marketAccount) {
    const state = await getVsolSeriesState(series, connection);
    return { ...state, mintOnDemand: false };
  }
  return {
    symbol: series.symbol,
    code: series.code,
    market: series.marketKey.toBase58(),
    oracle: series.oracleKey.toBase58(),
    expiry: series.expiry,
    observationWindowSeconds: series.observationWindowSeconds,
    lastTradeAt: series.lastTradeAt,
    enabled: true,
    finalized: false,
    poolAuthorized: true,
    available: true,
    availabilityReason: "Available",
    mintOnDemand: true,
  };
}

type CreateMarketSeriesParams = {
  symbol: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  maxSettlementStalenessSeconds: number;
  // REQUIRED, deliberately not defaulted. `strike` is hashed into
  // `expected_market_id`, so it selects the market PDA -- listing a series
  // means CHOOSING a strike, exactly as choosing an expiry does. An earlier
  // version defaulted this to a placeholder so the module would compile,
  // which meant every address this encoder produced was silently wrong.
  // Callers must supply a real ladder rung; `ladderStrike(spot)` from
  // vsol/sdk is the way to land on one.
  strike: bigint;
};

/**
 * Builds the `create_market` instruction for a series, deriving its market id
 * (and PDA addresses) the exact same way the onchain factory and
 * app/lib/series-resolver.ts do. Shared by three callers so there is exactly
 * one encoder: app/lib/vsol-launch.ts's standalone Launch-a-series flow,
 * buildVsolQuoteTransaction's mint-on-demand path below, and
 * inspectVsolFillTransaction's strict re-derivation of a signed mint-and-fill
 * transaction's create_market instruction. Lives here (not in vsol-launch.ts,
 * which already depends on this module) so no import cycle is introduced.
 *
 * When `expected` is supplied, the derived market/oracle must match it
 * exactly or this throws -- a defense-in-depth guard for callers that already
 * know the target address (the mint-on-demand and inspector paths), so any
 * future drift between this encoder and app/lib/series-resolver.ts's PDA
 * derivation fails loudly instead of silently minting the wrong address.
 */
export async function buildCreateMarketInstruction(params: {
  creator: PublicKey;
  series: CreateMarketSeriesParams;
  expected?: { market: PublicKey; oracle: PublicKey };
}) {
  const symbol = symbolBytes(params.series.symbol);
  const { strike } = params.series;
  // create_market rejects a non-positive strike (VsolError::InvalidStrike),
  // and a wrong-but-positive one silently derives a different market. Fail
  // here rather than at the cluster.
  if (strike <= 0n) {
    throw new Error("A series must be listed at a positive strike (see STRIKE_LADDER_STEP in vsol/sdk).");
  }
  const marketId = await deriveMarketId({
    pythFeedId: Buffer.from(VSOL_PYTH_FEED_ID, "hex"),
    settlementMint: VSOL_SETTLEMENT_MINT,
    expiry: BigInt(params.series.expiry),
    observationWindowSeconds: params.series.observationWindowSeconds,
    settlementGraceSeconds: params.series.settlementGraceSeconds,
    priceScale: LAUNCH_PRICE_SCALE,
    maxConfidenceBps: LAUNCH_MAX_CONFIDENCE_BPS,
    symbol,
    maxSettlementStalenessSeconds: params.series.maxSettlementStalenessSeconds,
    strike,
  });
  const market = PublicKey.findProgramAddressSync([MARKET_SEED, VSOL_CONFIG.toBuffer(), marketId], VSOL_PROGRAM_ID)[0];
  const oracle = PublicKey.findProgramAddressSync([ORACLE_SEED, market.toBuffer()], VSOL_PROGRAM_ID)[0];
  if (params.expected && (!market.equals(params.expected.market) || !oracle.equals(params.expected.oracle))) {
    throw new Error("The derived market parameters do not match the resolved series");
  }
  const data = Buffer.concat([
    marketId,
    new PublicKey(deployment.underlyingMint).toBuffer(),
    Buffer.from(symbol),
    encodeU64(LAUNCH_PRICE_SCALE),
    encodeI64(BigInt(params.series.expiry)),
    encodeU32(params.series.observationWindowSeconds),
    encodeU32(params.series.settlementGraceSeconds),
    encodeU16(LAUNCH_MAX_CONFIDENCE_BPS),
    Buffer.from(VSOL_PYTH_FEED_ID, "hex"),
    encodeU32(params.series.maxSettlementStalenessSeconds),
    // Must stay last: matches the Borsh field order of `CreateMarketArgs` in
    // vsol/programs/vsol/src/lib.rs, where `strike` was appended after
    // `max_settlement_staleness_seconds`. See CreateMarketSeriesParams.strike's
    // TODO above -- the VALUE encoded here is not trustworthy, only the
    // length/shape is correct.
    encodeU64(strike),
  ]);
  const instruction = instructionFromIdl(idlInstruction("create_market"), {
    creator: params.creator,
    config: VSOL_CONFIG,
    market,
    oracle,
    settlement_mint: VSOL_SETTLEMENT_MINT,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  }, data);
  return { instruction, market, oracle, marketId };
}

/**
 * Resolves the current rolling grid for every configured market symbol and
 * verifies each rung on-chain. Every (symbol, code) pair always appears in
 * the result — a code the grid currently rules out, or whose derived market
 * has not been minted yet, or that fails verification, surfaces as
 * `available: false` with an honest reason. A single bad rung never takes
 * down the rest of the catalog (each is checked and reported independently).
 */
export async function getVsolSeriesStates(connection = getVsolConnection()): Promise<VsolSeriesState[]> {
  const resolutions = await resolveVsolSeriesCatalog(allMarketSymbols());
  return Promise.all(resolutions.map(async (resolution): Promise<VsolSeriesState> => {
    if (!resolution.available) {
      return {
        symbol: resolution.symbol,
        code: resolution.code,
        market: "",
        oracle: "",
        expiry: 0,
        observationWindowSeconds: 0,
        lastTradeAt: 0,
        enabled: false,
        finalized: false,
        poolAuthorized: false,
        available: false,
        availabilityReason: resolution.reason,
      };
    }
    try {
      return await getVsolSeriesState(resolution.series, connection);
    } catch (error) {
      const { series } = resolution;
      return {
        symbol: series.symbol,
        code: series.code,
        market: series.marketKey.toBase58(),
        oracle: series.oracleKey.toBase58(),
        expiry: series.expiry,
        observationWindowSeconds: series.observationWindowSeconds,
        lastTradeAt: series.lastTradeAt,
        enabled: false,
        finalized: false,
        poolAuthorized: false,
        available: false,
        availabilityReason: describeRpcFailure(error, SERIES_NOT_YET_MINTED_REASON),
      };
    }
  }));
}

export async function getVsolLiquidityState(owner?: PublicKey, connection = getVsolConnection()): Promise<VsolLiquidityState> {
  const checkedAt = new Date().toISOString();
  const core = await getPoolCore(connection);
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  const noObligations = core.pool.openPositions === 0n && core.pool.lockedCollateral === 0n;
  const state: VsolLiquidityState = {
    ready: true,
    checkedAt,
    pool: {
      address: VSOL_LIQUIDITY.poolKey.toBase58(),
      assetVault: VSOL_LIQUIDITY.assetVaultKey.toBase58(),
      settlementMint: VSOL_SETTLEMENT_MINT.toBase58(),
      quoteAuthority: core.pool.quoteAuthority.toBase58(),
      decimals: core.decimals,
      availableAssetsAtoms: core.poolAssets.toString(),
      lockedCollateralAtoms: core.pool.lockedCollateral.toString(),
      totalSharesAtoms: core.pool.totalShares.toString(),
      openPositions: Number(core.pool.openPositions),
      depositsOpen: noObligations,
      withdrawalsOpen: noObligations,
      maxUtilizationBps: core.pool.maxUtilizationBps,
      maxPositionBps: core.pool.maxPositionBps,
    },
  };
  if (!owner) return state;

  const providerAddress = deriveLiquidityProvider(VSOL_LIQUIDITY.poolKey, owner);
  const walletToken = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, owner);
  const [providerAccount, walletAccountInfo] = await Promise.all([
    connection.getAccountInfo(providerAddress, "confirmed"),
    connection.getAccountInfo(walletToken, "confirmed"),
  ]);
  let shares = 0n;
  if (providerAccount) {
    if (!providerAccount.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The provider ledger is not owned by the verified VSOL program");
    const provider = decodeProviderAccount(Buffer.from(providerAccount.data));
    if (!provider.pool.equals(VSOL_LIQUIDITY.poolKey) || !provider.owner.equals(owner)) {
      throw new Error("The provider ledger PDA does not match its onchain contents");
    }
    shares = provider.shares;
  }
  let walletAssets = 0n;
  if (walletAccountInfo) {
    const wallet = await getAccount(connection, walletToken, "confirmed", TOKEN_PROGRAM_ID);
    if (!wallet.owner.equals(owner) || !wallet.mint.equals(VSOL_SETTLEMENT_MINT)) {
      throw new Error("The wallet settlement token account is invalid");
    }
    walletAssets = wallet.amount;
  }
  // Same +1/+1 virtual-offset conversion as calculateWithdrawAmount below,
  // inlined (rather than calling it) because this is a best-effort display
  // estimate for a dust-sized holding shares could legitimately round to
  // zero here, and this call site must not throw for that -- unlike the
  // prepare route, nothing downstream depends on this being an exact,
  // zero-tolerance prediction.
  const redeemable = shares > 0n && core.pool.totalShares > 0n
    ? (shares * (core.poolAssets + 1n)) / (core.pool.totalShares + 1n)
    : 0n;
  state.provider = {
    address: providerAddress.toBase58(),
    walletAssetsAtoms: walletAssets.toString(),
    sharesAtoms: shares.toString(),
    redeemableAssetsAtoms: redeemable.toString(),
  };
  return state;
}

function randomNonce() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).readBigUInt64LE();
}

export async function buildVsolQuoteTransaction(params: {
  buyer: PublicKey;
  series?: VsolSeries;
  direction: "up" | "down";
  strike: number;
  cap: number;
  premium: number;
  maxPayout: number;
}) {
  if (!VSOL_PYTH_UPGRADE_DEPLOYED) throw new Error("The Pyth-bound VSOL deployment has not passed devnet verification");
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  const series = params.series ?? await defaultQuoteSeries();
  if (!series) throw new Error("No verified VSOL V2 quote series is published");
  const connection = getVsolConnection();
  const authority = vsolQuoteAuthority();
  const [core, seriesState] = await Promise.all([
    getPoolCore(connection),
    getVsolSeriesStateOrPlan(series, connection),
  ]);
  if (!seriesState.available) throw new Error(seriesState.availabilityReason);

  // Mint-on-demand: the market this rung resolves to does not exist onchain
  // yet. Rather than fail, the buyer becomes the market's creator (paying its
  // rent) and the pool manager authorizes it in the same transaction, ahead
  // of the existing Ed25519 + fill_pool_quote pair. The pool manager key is
  // loaded fresh here (never persisted beyond this call) and fails closed --
  // with VSOL_POOL_MANAGER_SECRET_KEY unset or mismatched, vsolPoolManager()
  // throws and this whole quote attempt fails honestly; ordinary fills on
  // already-minted series never reach this branch at all.
  const poolMarket = derivePoolMarket(VSOL_LIQUIDITY.poolKey, series.marketKey);
  let poolManager: Keypair | null = null;
  let mintInstructions: TransactionInstruction[] = [];
  if (seriesState.mintOnDemand) {
    try {
      poolManager = vsolPoolManager();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The pool manager key is not configured";
      const wrapped = new Error(`Mint-on-demand is unavailable: ${message}`);
      wrapped.name = "VsolPoolManagerUnavailable";
      throw wrapped;
    }
    const created = await buildCreateMarketInstruction({
      creator: params.buyer,
      series,
      expected: { market: series.marketKey, oracle: series.oracleKey },
    });
    const authorizeData = Buffer.concat([encodeI64(BigInt(series.lastTradeAt)), Buffer.from([1])]);
    const authorizeInstruction = instructionFromIdl(idlInstruction("set_liquidity_pool_market"), {
      manager: poolManager.publicKey,
      config: VSOL_CONFIG,
      pool: VSOL_LIQUIDITY.poolKey,
      market: series.marketKey,
      pool_market: poolMarket,
      system_program: SystemProgram.programId,
    }, authorizeData);
    mintInstructions = [created.instruction, authorizeInstruction];
  }

  const buyerSource = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, params.buyer);
  if (!(await connection.getAccountInfo(buyerSource, "confirmed"))) {
    const error = new Error("Claim devnet test USDC before requesting an executable quote");
    error.name = "VsolTestFundsRequired";
    throw error;
  }
  const buyerToken = await getAccount(connection, buyerSource, "confirmed", TOKEN_PROGRAM_ID);
  if (!buyerToken.owner.equals(params.buyer) || !buyerToken.mint.equals(VSOL_SETTLEMENT_MINT)) {
    throw new Error("The buyer settlement account is invalid");
  }

  const now = await clusterTime(connection);
  const quoteExpiry = BigInt(Math.min(now + 30, seriesState.lastTradeAt, seriesState.expiry - 1));
  if (quoteExpiry <= BigInt(now + 5)) throw new Error("The current devnet series is too close to its trade cutoff");

  const maxPayout = BigInt(Math.round(params.maxPayout * Number(TOKEN_SCALE)));
  const premium = BigInt(Math.max(1, Math.ceil(params.premium * Number(TOKEN_SCALE))));
  if (buyerToken.amount < premium) throw new Error("The wallet does not have enough devnet tUSDC for this premium");
  const totalCollateral = core.poolAssets + core.pool.lockedCollateral;
  const utilizationLimit = totalCollateral * BigInt(core.pool.maxUtilizationBps) / 10_000n;
  const positionLimit = totalCollateral * BigInt(core.pool.maxPositionBps) / 10_000n;
  if (maxPayout > core.poolAssets) throw new Error("The V2 pool has insufficient available collateral");
  if (maxPayout > positionLimit) throw new Error("The quote exceeds the V2 pool per-position risk limit");
  if (core.pool.lockedCollateral + maxPayout > utilizationLimit) throw new Error("The quote exceeds the V2 pool utilization limit");

  const quote: Quote = {
    nonce: randomNonce(),
    direction: params.direction === "up" ? 0 : 1,
    strike: BigInt(Math.round(params.strike * Number(PRICE_SCALE))),
    width: BigInt(Math.max(1, Math.round(Math.abs(params.cap - params.strike) * Number(PRICE_SCALE)))),
    premium,
    maxPayout,
    quoteExpiry,
  };
  const nonceRecord = derivePoolNonce(VSOL_LIQUIDITY.poolKey, authority.publicKey, quote.nonce);
  const position = derivePoolPosition(nonceRecord);
  const positionVault = derivePoolPositionVault(position);
  const message = poolQuoteMessage({
    config: core.config,
    pool: VSOL_LIQUIDITY.poolKey,
    market: series.marketKey,
    buyer: params.buyer,
    quoteAuthority: authority.publicKey,
    quote,
  });
  const makerSignature = nacl.sign.detached(message, authority.secretKey);
  const signatureInstruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: authority.publicKey.toBytes(),
    message,
    signature: makerSignature,
  });
  const fillInstruction = instructionFromIdl(FILL_POOL_QUOTE, {
    buyer: params.buyer,
    quote_authority: authority.publicKey,
    config: VSOL_CONFIG,
    pool: VSOL_LIQUIDITY.poolKey,
    market: series.marketKey,
    pool_market: poolMarket,
    settlement_mint: VSOL_SETTLEMENT_MINT,
    pool_token: VSOL_LIQUIDITY.assetVaultKey,
    buyer_source: buyerSource,
    nonce_record: nonceRecord,
    position,
    position_vault: positionVault,
    eligibility: VSOL_PROGRAM_ID,
    instructions_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  }, quoteData(quote));
  const latest = await connection.getLatestBlockhash("confirmed");
  // When the manifest publishes an ALT, compile as a v0 transaction so
  // repeated 32-byte account keys collapse into 1-byte indices -- this is
  // what lets the 4-instruction mint-on-demand shape (otherwise ~1469 bytes)
  // fit under the 1232-byte packet limit. Falls back to the exact legacy
  // shape used before the ALT existed whenever no table is available.
  const lookupTableAccount = await getVsolAddressLookupTableAccount(connection);
  const transaction = composeVsolFillTransaction({
    feePayer: params.buyer,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    instructions: [...mintInstructions, signatureInstruction, fillInstruction],
    lookupTableAccount,
  });
  // The pool manager is a required signer on set_liquidity_pool_market; sign
  // now server-side (the buyer signs everything else, including this
  // instruction's other accounts, in their wallet next).
  if (poolManager) partialSignVsolTransaction(transaction, poolManager);

  const serialized = serializeVsolTransaction(transaction);
  if (serialized.length > MAX_TRANSACTION_BYTES) {
    // Do not ship a silently-broken oversized transaction: fail the quote
    // honestly so the caller reports the series as unavailable rather than
    // handing the wallet something that can never fit in a packet -- this
    // can now only genuinely happen when no ALT is published at all, since
    // ALT compression brings even the mint-on-demand shape back under the
    // limit (see the size-measurement test in tests/vsol-versioned-fill.test.mjs).
    const error = new Error(
      `Minting this series requires a ${serialized.length}-byte transaction, over Solana's ${MAX_TRANSACTION_BYTES}-byte packet limit. A versioned transaction or address lookup table is required before this series can trade.`,
    );
    error.name = "VsolTransactionTooLarge";
    throw error;
  }

  return {
    transaction: serialized.toString("base64"),
    positionAddress: position.toBase58(),
    nonce: quote.nonce.toString(),
    marketAddress: series.marketKey.toBase58(),
    poolAddress: VSOL_LIQUIDITY.poolKey.toBase58(),
    mintOnDemand: seriesState.mintOnDemand,
  };
}

export type LiquidityActionKind = "deposit" | "withdraw";

export async function buildVsolLiquidityTransaction(params: {
  owner: PublicKey;
  action: LiquidityActionKind;
  inputAtoms: bigint;
  minimumOutputAtoms: bigint;
  deadline: bigint;
  connection?: Connection;
}) {
  const connection = params.connection ?? getVsolConnection();
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  await getPoolCore(connection);
  const providerPosition = deriveLiquidityProvider(VSOL_LIQUIDITY.poolKey, params.owner);
  const ownerToken = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, params.owner);
  const definition = params.action === "deposit" ? DEPOSIT_LIQUIDITY : WITHDRAW_LIQUIDITY;
  const data = Buffer.concat([
    encodeU64(params.inputAtoms),
    encodeU64(params.minimumOutputAtoms),
    encodeI64(params.deadline),
  ]);
  const instruction = instructionFromIdl(definition, params.action === "deposit" ? {
    provider: params.owner,
    config: VSOL_CONFIG,
    settlement_mint: VSOL_SETTLEMENT_MINT,
    pool: VSOL_LIQUIDITY.poolKey,
    pool_token: VSOL_LIQUIDITY.assetVaultKey,
    provider_position: providerPosition,
    provider_source: ownerToken,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  } : {
    provider: params.owner,
    config: VSOL_CONFIG,
    settlement_mint: VSOL_SETTLEMENT_MINT,
    pool: VSOL_LIQUIDITY.poolKey,
    pool_token: VSOL_LIQUIDITY.assetVaultKey,
    provider_position: providerPosition,
    provider_destination: ownerToken,
    token_program: TOKEN_PROGRAM_ID,
  }, data);
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: params.owner,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(instruction);
  return {
    transaction,
    providerAddress: providerPosition.toBase58(),
    ownerTokenAddress: ownerToken.toBase58(),
  };
}

function exactKeys(instruction: TransactionInstruction, expected: PublicKey[]) {
  return instruction.keys.length === expected.length
    && expected.every((key, index) => instruction.keys[index]?.pubkey.equals(key));
}

export function inspectVsolLiquidityTransaction(transaction: Transaction) {
  if (!VSOL_LIQUIDITY || transaction.instructions.length !== 1 || !transaction.feePayer) return null;
  const instruction = transaction.instructions[0];
  if (!instruction.programId.equals(VSOL_PROGRAM_ID) || instruction.data.length !== 32) return null;
  const owner = transaction.feePayer;
  const provider = deriveLiquidityProvider(VSOL_LIQUIDITY.poolKey, owner);
  const token = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, owner);
  const discriminator = Buffer.from(instruction.data).subarray(0, 8);
  let action: LiquidityActionKind;
  let expected: PublicKey[];
  if (discriminator.equals(Buffer.from(DEPOSIT_LIQUIDITY.discriminator))) {
    action = "deposit";
    expected = [owner, VSOL_CONFIG, VSOL_SETTLEMENT_MINT, VSOL_LIQUIDITY.poolKey, VSOL_LIQUIDITY.assetVaultKey, provider, token, TOKEN_PROGRAM_ID, SystemProgram.programId];
  } else if (discriminator.equals(Buffer.from(WITHDRAW_LIQUIDITY.discriminator))) {
    action = "withdraw";
    expected = [owner, VSOL_CONFIG, VSOL_SETTLEMENT_MINT, VSOL_LIQUIDITY.poolKey, VSOL_LIQUIDITY.assetVaultKey, provider, token, TOKEN_PROGRAM_ID];
  } else {
    return null;
  }
  if (!exactKeys(instruction, expected) || !instruction.keys[0]?.isSigner) return null;
  const inputAtoms = Buffer.from(instruction.data).readBigUInt64LE(8);
  const minimumOutputAtoms = Buffer.from(instruction.data).readBigUInt64LE(16);
  const deadline = Buffer.from(instruction.data).readBigInt64LE(24);
  if (inputAtoms === 0n || minimumOutputAtoms === 0n) return null;
  return { action, owner, provider, inputAtoms, minimumOutputAtoms, deadline };
}

export async function verifyVsolFill(signature: string, buyer: PublicKey, position: PublicKey, expectedMarket?: PublicKey) {
  const connection = getVsolConnection();
  let result = null;
  for (let attempt = 0; attempt < 6 && !result; attempt += 1) {
    result = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!result) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!result || result.meta?.err || !VSOL_LIQUIDITY) return false;
  const liquidity = VSOL_LIQUIDITY;
  const keys = result.transaction.message.accountKeys;
  const buyerSigned = keys.some((key) => key.pubkey.equals(buyer) && key.signer);
  const invokesProgram = keys.some((key) => key.pubkey.equals(VSOL_PROGRAM_ID));
  const createsPosition = keys.some((key) => key.pubkey.equals(position));
  const usesPool = keys.some((key) => key.pubkey.equals(liquidity.poolKey));
  const usesExpectedMarket = !expectedMarket || keys.some((key) => key.pubkey.equals(expectedMarket));
  const fillLogged = result.meta?.logMessages?.some((line) => line.includes("Instruction: FillPoolQuote")) ?? false;
  const positionAccount = await connection.getAccountInfo(position, "confirmed");
  if (!positionAccount?.owner.equals(VSOL_PROGRAM_ID)) return false;
  const data = Buffer.from(positionAccount.data);
  if (data.length !== 262 || !data.subarray(0, 8).equals(POOL_POSITION_ACCOUNT_DISCRIMINATOR)) return false;
  const exactPosition = publicKeyAt(data, 12).equals(liquidity.poolKey)
    && (!expectedMarket || publicKeyAt(data, 44).equals(expectedMarket))
    && publicKeyAt(data, 108).equals(buyer)
    && publicKeyAt(data, 140).equals(liquidity.quoteAuthorityKey)
    && publicKeyAt(data, 172).equals(VSOL_SETTLEMENT_MINT);
  return buyerSigned && invokesProgram && createsPosition && usesPool && usesExpectedMarket && fillLogged && exactPosition;
}

// A transaction's instructions, normalized to fully-resolved account keys --
// identical in shape whether they came from a legacy Transaction (whose
// TransactionInstruction.keys are already resolved pubkeys) or from a v0
// VersionedTransaction whose lookup-table indices have been resolved against
// the manifest-pinned ALT (see resolveSignedVsolTransaction below). Every
// inspection function below operates purely on this shape, so the same
// strict checks run identically regardless of transaction version.
export type ResolvedInstructionAccount = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
export type ResolvedInstruction = { programId: PublicKey; keys: ResolvedInstructionAccount[]; data: Buffer };
export type ResolvedFillTransaction = { feePayer: PublicKey; instructions: ResolvedInstruction[] };

function normalizeFillTransaction(input: Transaction | ResolvedFillTransaction): ResolvedFillTransaction | null {
  if (!(input instanceof Transaction)) return input;
  if (!input.feePayer) return null;
  return {
    feePayer: input.feePayer,
    instructions: input.instructions.map((instruction) => ({
      programId: instruction.programId,
      keys: instruction.keys.map((key) => ({ pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable })),
      data: Buffer.from(instruction.data),
    })),
  };
}

export function isVsolFillTransaction(input: Transaction | ResolvedFillTransaction) {
  const transaction = normalizeFillTransaction(input);
  if (!transaction || transaction.instructions.length !== 2 || !VSOL_LIQUIDITY) return false;
  const [signatureInstruction, fillInstruction] = transaction.instructions;
  return signatureInstruction.programId.equals(Ed25519Program.programId)
    && fillInstruction.programId.equals(VSOL_PROGRAM_ID)
    && fillInstruction.data.subarray(0, 8).equals(Buffer.from(FILL_POOL_QUOTE.discriminator));
}

// The mint-on-demand shape: create_market, set_liquidity_pool_market, then
// the same Ed25519 + fill_pool_quote pair as an ordinary fill. Exact order,
// exact program ids, exact discriminators -- any other shape (missing an
// instruction, extra instructions, or these four out of order) is rejected
// by construction, since this check (and inspectVsolFillTransaction below)
// only ever reads instructions at these four fixed indices.
export function isVsolMintAndFillTransaction(input: Transaction | ResolvedFillTransaction) {
  const transaction = normalizeFillTransaction(input);
  if (!transaction || transaction.instructions.length !== 4 || !VSOL_LIQUIDITY) return false;
  const [createInstruction, authorizeInstruction, signatureInstruction, fillInstruction] = transaction.instructions;
  return createInstruction.programId.equals(VSOL_PROGRAM_ID)
    && createInstruction.data.subarray(0, 8).equals(vsolInstructionDiscriminator("create_market"))
    && authorizeInstruction.programId.equals(VSOL_PROGRAM_ID)
    && authorizeInstruction.data.subarray(0, 8).equals(vsolInstructionDiscriminator("set_liquidity_pool_market"))
    && signatureInstruction.programId.equals(Ed25519Program.programId)
    && fillInstruction.programId.equals(VSOL_PROGRAM_ID)
    && fillInstruction.data.subarray(0, 8).equals(Buffer.from(FILL_POOL_QUOTE.discriminator));
}

/**
 * Verifies the Ed25519 + fill_pool_quote pair against a series the caller has
 * already independently verified as a legitimate current rolling-grid rung.
 * Shared by both the plain-fill and mint-and-fill inspection paths below --
 * the fill instruction itself is checked identically either way.
 */
function verifyFillInstruction(fill: ResolvedInstruction, verifiedSeries: VsolSeries) {
  if (!VSOL_LIQUIDITY) return null;
  if (fill.keys.length !== FILL_POOL_QUOTE.accounts.length) return null;
  const buyer = fill.keys[0];
  const quoteAuthority = fill.keys[1];
  const pool = fill.keys[3];
  const market = fill.keys[4];
  const poolMarket = fill.keys[5];
  const nonceRecord = fill.keys[9];
  const position = fill.keys[10];
  if (!market.pubkey.equals(verifiedSeries.marketKey)
      || !buyer.isSigner || !buyer.isWritable
      || !quoteAuthority.pubkey.equals(VSOL_LIQUIDITY.quoteAuthorityKey)
      || !pool.pubkey.equals(VSOL_LIQUIDITY.poolKey)
      || !poolMarket.pubkey.equals(derivePoolMarket(VSOL_LIQUIDITY.poolKey, market.pubkey))
      || !fill.keys[2].pubkey.equals(VSOL_CONFIG)
      || !fill.keys[6].pubkey.equals(VSOL_SETTLEMENT_MINT)
      || !fill.keys[7].pubkey.equals(VSOL_LIQUIDITY.assetVaultKey)
      || !fill.keys[8].pubkey.equals(getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, buyer.pubkey))
      || !fill.keys[12].pubkey.equals(VSOL_PROGRAM_ID)
      || !fill.keys[13].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)
      || !fill.keys[14].pubkey.equals(TOKEN_PROGRAM_ID)
      || !fill.keys[15].pubkey.equals(SystemProgram.programId)
      || !fill.keys[16].pubkey.equals(SYSVAR_RENT_PUBKEY)) return null;
  const data = Buffer.from(fill.data);
  if (data.length !== 57) return null;
  const nonce = data.readBigUInt64LE(8);
  if (!nonceRecord.pubkey.equals(derivePoolNonce(VSOL_LIQUIDITY.poolKey, quoteAuthority.pubkey, nonce))) return null;
  if (!position.pubkey.equals(derivePoolPosition(nonceRecord.pubkey))) return null;
  if (!fill.keys[11].pubkey.equals(derivePoolPositionVault(position.pubkey))) return null;
  return { buyer: buyer.pubkey, pool: pool.pubkey, market: market.pubkey, position: position.pubkey };
}

/**
 * Re-derives the create_market instruction that MUST have been used to mint
 * `verifiedSeries` -- with `creator` bound to the signed-in buyer -- and
 * compares it byte-for-byte (program id, full data buffer, and every account
 * pubkey/signer/writable flag) against the instruction actually present in
 * the transaction. This is what stops a buyer from minting a market on
 * arbitrary terms and trading against the pool: the only args that can pass
 * are the exact resolved grid parameters for `verifiedSeries` (current
 * rolling-grid rung), because that's the only input buildCreateMarketInstruction
 * is given here.
 */
async function verifyCreateMarketInstruction(instruction: ResolvedInstruction, creator: PublicKey, verifiedSeries: VsolSeries) {
  const expected = await buildCreateMarketInstruction({
    creator,
    series: verifiedSeries,
    expected: { market: verifiedSeries.marketKey, oracle: verifiedSeries.oracleKey },
  });
  if (!instruction.programId.equals(expected.instruction.programId)) return false;
  if (!instruction.data.equals(Buffer.from(expected.instruction.data))) return false;
  if (instruction.keys.length !== expected.instruction.keys.length) return false;
  for (let i = 0; i < instruction.keys.length; i += 1) {
    if (!instruction.keys[i].pubkey.equals(expected.instruction.keys[i].pubkey)) return false;
    if (instruction.keys[i].isSigner !== expected.instruction.keys[i].isSigner) return false;
    if (instruction.keys[i].isWritable !== expected.instruction.keys[i].isWritable) return false;
  }
  return true;
}

/**
 * Verifies set_liquidity_pool_market binds exactly the expected pool, the
 * expected (newly-minted) market, and the expected `lastTradeAt` cutoff for
 * `verifiedSeries` -- and, when the manifest publishes a manager key, that
 * the signing manager is that exact key (not merely "some signer").
 */
function verifyAuthorizeMarketInstruction(instruction: ResolvedInstruction, verifiedSeries: VsolSeries) {
  if (!VSOL_LIQUIDITY) return false;
  if (!instruction.programId.equals(VSOL_PROGRAM_ID)) return false;
  if (instruction.keys.length !== 6) return false;
  const manager = instruction.keys[0];
  const poolMarket = derivePoolMarket(VSOL_LIQUIDITY.poolKey, verifiedSeries.marketKey);
  const expectedData = Buffer.concat([
    vsolInstructionDiscriminator("set_liquidity_pool_market"),
    encodeI64(BigInt(verifiedSeries.lastTradeAt)),
    Buffer.from([1]),
  ]);
  if (!instruction.data.equals(expectedData)) return false;
  if (!manager.isSigner || !manager.isWritable) return false;
  if (VSOL_LIQUIDITY.managerKey && !manager.pubkey.equals(VSOL_LIQUIDITY.managerKey)) return false;
  if (!instruction.keys[1].pubkey.equals(VSOL_CONFIG)) return false;
  if (!instruction.keys[2].pubkey.equals(VSOL_LIQUIDITY.poolKey)) return false;
  if (!instruction.keys[3].pubkey.equals(verifiedSeries.marketKey)) return false;
  if (!instruction.keys[4].pubkey.equals(poolMarket)) return false;
  if (!instruction.keys[5].pubkey.equals(SystemProgram.programId)) return false;
  return true;
}

export async function inspectVsolFillTransaction(input: Transaction | ResolvedFillTransaction) {
  if (!VSOL_LIQUIDITY) return null;
  const transaction = normalizeFillTransaction(input);
  if (!transaction) return null;

  if (isVsolFillTransaction(transaction)) {
    const fill = transaction.instructions[1];
    const market = fill.keys[4]?.pubkey;
    if (!market) return null;
    // Chain-derived: re-resolve the current rolling grid rather than trusting
    // a checked-in manifest, so this check can never pass a fill for a market
    // that a stale snapshot would have missed (or reject a legitimate current
    // rung the snapshot hadn't caught up with yet).
    const currentSeries = await resolveAvailableVsolSeries(allMarketSymbols());
    const verifiedSeries = currentSeries.find((series) => series.marketKey.equals(market));
    if (!verifiedSeries) return null;
    return verifyFillInstruction(fill, verifiedSeries);
  }

  if (isVsolMintAndFillTransaction(transaction)) {
    const [createInstruction, authorizeInstruction, , fillInstruction] = transaction.instructions;
    const market = fillInstruction.keys[4]?.pubkey;
    const buyer = fillInstruction.keys[0];
    if (!market || !buyer?.isSigner) return null;
    const currentSeries = await resolveAvailableVsolSeries(allMarketSymbols());
    const verifiedSeries = currentSeries.find((series) => series.marketKey.equals(market));
    if (!verifiedSeries) return null;
    if (!(await verifyCreateMarketInstruction(createInstruction, buyer.pubkey, verifiedSeries))) return null;
    if (!verifyAuthorizeMarketInstruction(authorizeInstruction, verifiedSeries)) return null;
    return verifyFillInstruction(fillInstruction, verifiedSeries);
  }

  return null;
}

/**
 * Detects whether raw signed-transaction bytes are a legacy or a v0
 * (versioned) transaction. VersionedTransaction.deserialize understands both
 * wire formats (it reads the message version prefix internally), so this is
 * a cheap, side-effect-free probe rather than a second real parse.
 */
function isVersionedVsolTransactionBytes(raw: Buffer): boolean {
  try {
    return VersionedTransaction.deserialize(raw).message.version !== "legacy";
  } catch {
    return false;
  }
}

/**
 * Verifies every required signature on a v0 transaction against its message
 * bytes and each signer's static account key -- VersionedTransaction has no
 * built-in verifySignatures() (unlike the legacy Transaction class), so this
 * mirrors Transaction.verifySignatures()'s default (requireAllSignatures =
 * true) semantics by hand: every required signer must have a present,
 * non-placeholder, valid signature.
 */
function verifyVersionedVsolSignatures(transaction: VersionedTransaction): boolean {
  const { message } = transaction;
  const numRequiredSignatures = message.header.numRequiredSignatures;
  if (transaction.signatures.length !== numRequiredSignatures) return false;
  const messageBytes = message.serialize();
  for (let index = 0; index < numRequiredSignatures; index += 1) {
    const signature = transaction.signatures[index];
    const signerKey = message.staticAccountKeys[index];
    if (!signature || signature.length !== 64 || !signerKey) return false;
    if (signature.every((byte) => byte === 0)) return false; // unsigned placeholder, not a real signature
    if (!nacl.sign.detached.verify(messageBytes, signature, signerKey.toBytes())) return false;
  }
  return true;
}

/**
 * Accepts a signed VSOL fill transaction as raw, base64-decoded bytes in
 * EITHER wire format and returns it normalized to fully-resolved account
 * keys, or null on any malformed input, missing/invalid signature, or an
 * untrusted lookup table reference.
 *
 * SECURITY: a v0 transaction's `addressTableLookups` name which lookup
 * table(s) its account-key indices resolve against. Those indices are
 * entirely client-chosen -- if this function resolved them using whatever
 * table the client's transaction happened to name, an attacker could publish
 * their own table mapping every index to accounts of their choosing (their
 * own "pool", their own "quote authority", their own destination token
 * account, ...) and every downstream check in inspectVsolFillTransaction
 * would dutifully validate a fabricated transaction against attacker-chosen
 * accounts, since those checks only ever see whatever pubkeys they're handed
 * here. So: resolution below uses ONLY a table this deployment explicitly
 * trusts -- the CURRENT manifest-pinned VSOL_ADDRESS_LOOKUP_TABLE, or one of
 * the published VSOL_RETIRING_LOOKUP_TABLES (app/lib/vsol.ts) -- fetched
 * independently by this server, never the client's transaction bytes. A
 * retiring table is trusted here (never for compiling new fills, only for
 * resolving an already-signed one) because a quote issued moments before a
 * rotation may have been compiled against the table that was still current
 * at quote time; it stays trusted until vsol/scripts/keeper.ts closes it
 * onchain, at which point getAddressLookupTable simply stops resolving it and
 * this falls back to the "no such table" rejection path below. Any
 * transaction whose addressTableLookups reference a table outside {current}
 * ∪ {retiring} -- or that reference more than one distinct table, which
 * composeVsolFillTransaction never produces -- is rejected outright, before a
 * single account key is resolved.
 *
 * `trustedLookupTables` defaults to exactly {VSOL_ADDRESS_LOOKUP_TABLE} ∪
 * {every VSOL_RETIRING_LOOKUP_TABLES address} -- production callers never
 * pass it. Tests pass a synthetic list so the retiring-table acceptance path
 * and the foreign-table rejection path can both be exercised directly,
 * independent of whatever this deployment's manifest currently publishes.
 */
export async function resolveSignedVsolFillTransaction(
  raw: Buffer,
  connection: Connection,
  trustedLookupTables: readonly (PublicKey | null)[] = [
    VSOL_ADDRESS_LOOKUP_TABLE,
    ...VSOL_RETIRING_LOOKUP_TABLES.map((entry) => entry.address),
  ],
): Promise<ResolvedFillTransaction | null> {
  if (!isVersionedVsolTransactionBytes(raw)) {
    let transaction: Transaction;
    try {
      transaction = Transaction.from(raw);
    } catch {
      return null;
    }
    if (!transaction.feePayer || !transaction.verifySignatures()) return null;
    return normalizeFillTransaction(transaction);
  }

  let versioned: VersionedTransaction;
  try {
    versioned = VersionedTransaction.deserialize(raw);
  } catch {
    return null;
  }
  if (versioned.message.version === "legacy") return null;
  // Narrowed (not merely asserted): the check above already ruled out
  // "legacy", so this is exactly the MessageV0 branch of the VersionedMessage
  // union -- kept as a local so every access below resolves against the same
  // narrowed type.
  const message: MessageV0 = versioned.message;
  if (!verifyVersionedVsolSignatures(versioned)) return null;

  const lookups = message.addressTableLookups;
  let lookupTableAccount: AddressLookupTableAccount | null = null;
  if (lookups.length > 0) {
    // Fail closed: a transaction must reference exactly one table (the shape
    // every table composeVsolFillTransaction ever produces), and that table
    // must be either the current active one or a still-published retiring
    // one -- anything else (a foreign table, or a mix of more than one
    // distinct table address) is rejected before a single account key is
    // resolved.
    const referencedTableKeys = new Set(lookups.map((lookup) => lookup.accountKey.toBase58()));
    if (referencedTableKeys.size !== 1) return null;
    const referencedTable = lookups[0].accountKey;
    const isTrusted = trustedLookupTables.some((table) => table?.equals(referencedTable) ?? false);
    if (!isTrusted) return null;
    lookupTableAccount = await getVsolAddressLookupTableAccount(connection, Date.now(), referencedTable);
    if (!lookupTableAccount) return null;
  }

  let accountKeys;
  try {
    accountKeys = message.getAccountKeys({
      addressLookupTableAccounts: lookupTableAccount ? [lookupTableAccount] : [],
    });
  } catch {
    return null;
  }
  const feePayer = accountKeys.get(0);
  if (!feePayer) return null;

  const instructions: ResolvedInstruction[] = [];
  for (const compiled of message.compiledInstructions) {
    const programId = accountKeys.get(compiled.programIdIndex);
    if (!programId) return null;
    const keys: ResolvedInstructionAccount[] = [];
    for (const accountIndex of compiled.accountKeyIndexes) {
      const pubkey = accountKeys.get(accountIndex);
      if (!pubkey) return null;
      keys.push({
        pubkey,
        isSigner: message.isAccountSigner(accountIndex),
        isWritable: message.isAccountWritable(accountIndex),
      });
    }
    instructions.push({ programId, keys, data: Buffer.from(compiled.data) });
  }
  return { feePayer, instructions };
}

// Mirrors the on-chain `calculate_deposit_shares`/`calculate_withdraw_amount`
// (vsol/programs/vsol/src/math.rs) EXACTLY, including the +1/+1 virtual
// shares/assets offset -- this is the "prepare" API route's only source for
// `minimumOutputAtoms` (app/api/vsol/liquidity/prepare/route.ts), which is
// passed on-chain as `min_shares_out`/`min_amount_out` with ZERO slippage
// tolerance (set to the predicted value itself, not a buffered floor). Any
// drift from the on-chain formula here does not just misreport a number --
// it fails every deposit/withdrawal on-chain with SlippageExceeded.
export function calculateDepositShares(amount: bigint, totalShares: bigint, totalAssets: bigint) {
  if (amount <= 0n || totalShares < 0n || totalAssets < 0n) throw new RangeError("Invalid pool share parameters");
  if (totalAssets === 0n && totalShares > 0n) throw new RangeError("The liquidity pool is insolvent");
  const result = amount * (totalShares + 1n) / (totalAssets + 1n);
  if (result === 0n) throw new RangeError("The deposit is too small to mint a pool share");
  return result;
}

export function calculateWithdrawAmount(shares: bigint, totalShares: bigint, totalAssets: bigint) {
  if (shares <= 0n || totalShares <= 0n || shares > totalShares || totalAssets < 0n) throw new RangeError("Invalid pool share parameters");
  const result = shares * (totalAssets + 1n) / (totalShares + 1n);
  if (result === 0n) throw new RangeError("The withdrawal is too small");
  return result;
}

export function describeRpcFailure(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (/403|forbidden|blocked/i.test(message)) {
    return "The devnet RPC endpoint refused this server's connection (403). Set VSOL_RPC_URL to a private Solana devnet RPC.";
  }
  if (/429|rate.?limit/i.test(message)) {
    return "The devnet RPC endpoint is rate-limiting this server. Retry shortly or set VSOL_RPC_URL to a private RPC.";
  }
  return message.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 300);
}

export function parsePublicKey(value: unknown) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

export function decodeSignedTransaction(encoded: string) {
  if (!encoded || encoded.length > 25_000) throw new Error("Invalid transaction payload");
  return Buffer.from(encoded, "base64");
}
