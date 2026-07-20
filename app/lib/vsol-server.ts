import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import deployment from "../../vsol/deployments/devnet.json";
import idl from "../../vsol/target/idl/vsol.json";
import {
  VSOL_CONFIG,
  VSOL_LIQUIDITY,
  VSOL_PYTH_FEED_ID,
  VSOL_PYTH_UPGRADE_DEPLOYED,
  VSOL_PROGRAM_ID,
  VSOL_RPC_URL,
  VSOL_SERIES,
  VSOL_SETTLEMENT_MINT,
} from "./vsol";
import { runtimeEnv } from "./runtime-env";

export function getVsolConnection() {
  // Resolve this after the request route has installed Cloudflare bindings.
  return new Connection(runtimeEnv("VSOL_RPC_URL") || VSOL_RPC_URL, "confirmed");
}

const TOKEN_SCALE = 1_000_000n;
const PRICE_SCALE = 1_000_000n;
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
const MARKET_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("Market");
const ORACLE_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("SettlementOracle");
const POOL_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("LiquidityPool");
const PROVIDER_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("LiquidityProvider");
const POOL_MARKET_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("LiquidityPoolMarket");
const POOL_POSITION_ACCOUNT_DISCRIMINATOR = idlAccountDiscriminator("PoolPosition");

export type VsolSeries = (typeof VSOL_SERIES)[number];

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

function decodeConfigAccount(data: Buffer) {
  expectAccount(data, 239, CONFIG_ACCOUNT_DISCRIMINATOR, "VSOL config");
  return {
    paused: data[203] === 1,
    eligibilityRequired: data[204] === 1,
    domainSeparator: data.subarray(205, 237),
    domainVersion: data.readUInt16LE(237),
  };
}

export function decodeMarketAccount(data: Buffer) {
  expectAccount(data, 277, MARKET_ACCOUNT_DISCRIMINATOR, "VSOL market");
  return {
    config: publicKeyAt(data, 9),
    marketId: data.subarray(41, 73),
    underlyingMint: publicKeyAt(data, 73),
    settlementMint: publicKeyAt(data, 105),
    oracle: publicKeyAt(data, 137),
    symbol: data.subarray(169, 185).toString("ascii").replace(/\0+$/, ""),
    priceScale: data.readBigUInt64LE(185),
    expiry: Number(data.readBigInt64LE(193)),
    observationWindowSeconds: data.readUInt32LE(201),
    settlementGraceSeconds: data.readUInt32LE(205),
    maxConfidenceBps: data.readUInt16LE(209),
    pythFeedId: data.subarray(211, 243).toString("hex"),
    settlementDecimals: data[243],
    enabled: data[244] === 1,
    creator: publicKeyAt(data, 245),
  };
}

function decodeOracleAccount(data: Buffer) {
  expectAccount(data, 142, ORACLE_ACCOUNT_DISCRIMINATOR, "VSOL oracle");
  return {
    market: publicKeyAt(data, 9),
    pythFeedId: data.subarray(105, 137).toString("hex"),
    finalized: data[141] === 1,
  };
}

export function decodePoolAccount(data: Buffer): DecodedPool {
  expectAccount(data, 214, POOL_ACCOUNT_DISCRIMINATOR, "VSOL liquidity pool");
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

function loadSecret(name: "VSOL_MAKER_SECRET_KEY" | "VSOL_FAUCET_SECRET_KEY") {
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
  return { config, pool, poolAssets: poolToken.amount, decimals: mint.decimals };
}

async function getPoolMarketState(series: VsolSeries, connection: Connection) {
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  if (!VSOL_LIQUIDITY.authorizedMarketKeys.some((market) => market.equals(series.marketKey))) {
    throw new Error("This series is not authorized in the published V2 pool manifest");
  }
  const address = derivePoolMarket(VSOL_LIQUIDITY.poolKey, series.marketKey);
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account || !account.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The VSOL pool-market authorization is unavailable");
  const state = decodePoolMarketAccount(Buffer.from(account.data));
  if (!state.pool.equals(VSOL_LIQUIDITY.poolKey)
      || !state.market.equals(series.marketKey)
      || state.lastTradeAt !== series.lastTradeAt) {
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
  if (!marketAccount || !oracleAccount) throw new Error("The deployed VSOL series accounts are unavailable");
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
    && market.settlementGraceSeconds === series.settlementGraceSeconds;
  if (!exactBinding) throw new Error("The deployed series catalog does not match verified onchain state");

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

export async function getVsolSeriesStates() {
  if (!VSOL_SERIES.length) throw new Error("No verified VSOL V2 series are published");
  const connection = getVsolConnection();
  return Promise.all(VSOL_SERIES.map((series) => getVsolSeriesState(series, connection)));
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
  const redeemable = shares > 0n && core.pool.totalShares > 0n
    ? shares * core.poolAssets / core.pool.totalShares
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
  const series = params.series ?? VSOL_SERIES.find((entry) => entry.code === "30D");
  if (!series) throw new Error("No verified VSOL V2 quote series is published");
  const connection = getVsolConnection();
  const authority = vsolQuoteAuthority();
  const [core, seriesState] = await Promise.all([
    getPoolCore(connection),
    getVsolSeriesState(series, connection),
  ]);
  if (!seriesState.available) throw new Error(seriesState.availabilityReason);

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
  const poolMarket = derivePoolMarket(VSOL_LIQUIDITY.poolKey, series.marketKey);
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
  const transaction = new Transaction({
    feePayer: params.buyer,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(signatureInstruction, fillInstruction);
  return {
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    positionAddress: position.toBase58(),
    nonce: quote.nonce.toString(),
    marketAddress: series.marketKey.toBase58(),
    poolAddress: VSOL_LIQUIDITY.poolKey.toBase58(),
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

export function isVsolFillTransaction(transaction: Transaction) {
  if (transaction.instructions.length !== 2 || !VSOL_LIQUIDITY) return false;
  const [signatureInstruction, fillInstruction] = transaction.instructions;
  return signatureInstruction.programId.equals(Ed25519Program.programId)
    && fillInstruction.programId.equals(VSOL_PROGRAM_ID)
    && Buffer.from(fillInstruction.data).subarray(0, 8).equals(Buffer.from(FILL_POOL_QUOTE.discriminator));
}

export function inspectVsolFillTransaction(transaction: Transaction) {
  if (!isVsolFillTransaction(transaction) || !VSOL_LIQUIDITY) return null;
  const fill = transaction.instructions[1];
  if (fill.keys.length !== FILL_POOL_QUOTE.accounts.length) return null;
  const buyer = fill.keys[0];
  const quoteAuthority = fill.keys[1];
  const pool = fill.keys[3];
  const market = fill.keys[4];
  const poolMarket = fill.keys[5];
  const nonceRecord = fill.keys[9];
  const position = fill.keys[10];
  const verifiedSeries = VSOL_SERIES.find((series) => series.marketKey.equals(market.pubkey));
  if (!verifiedSeries
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

export function calculateDepositShares(amount: bigint, totalShares: bigint, totalAssets: bigint) {
  if (amount <= 0n || totalShares < 0n || totalAssets < 0n) throw new RangeError("Invalid pool share parameters");
  if (totalShares === 0n) return amount;
  if (totalAssets === 0n) throw new RangeError("The liquidity pool is insolvent");
  const result = amount * totalShares / totalAssets;
  if (result === 0n) throw new RangeError("The deposit is too small to mint a pool share");
  return result;
}

export function calculateWithdrawAmount(shares: bigint, totalShares: bigint, totalAssets: bigint) {
  if (shares <= 0n || totalShares <= 0n || shares > totalShares || totalAssets < 0n) throw new RangeError("Invalid pool share parameters");
  const result = shares * totalAssets / totalShares;
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
