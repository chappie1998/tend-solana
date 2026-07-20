import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { Wallet as CoralWallet } from "@coral-xyz/anchor";
import { HermesClient } from "@pythnetwork/hermes-client";
import BN from "bn.js";
import {
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import {
  deriveConfig,
  deriveLiquidityPool,
  deriveLiquidityPoolMarket,
  deriveLiquidityPoolToken,
  deriveLiquidityProvider,
  deriveMarket,
  deriveNonce,
  deriveOracle,
  derivePoolNonce,
  derivePoolPosition,
  derivePoolPositionVault,
  derivePosition,
  derivePositionVault,
  deriveWriterToken,
  deriveWriterVault,
  calculateDepositShares,
  calculatePayout,
  deriveMarketId,
  liquidityPoolId,
  poolQuoteMessage,
  PRICE_SCALE,
  quoteMessage,
  symbolBytes,
  toAnchorQuote,
  type Quote,
  type PoolQuote,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";

// The official packages publish dual ESM/CJS builds, but solana-utils 0.6.0's
// ESM entry imports an extensionless jito-ts path that Node 24 rejects. Loading
// the package's supported CJS export avoids patching vendor code.
const require = createRequire(import.meta.url);
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver") as typeof import("@pythnetwork/pyth-solana-receiver");
const { sendTransactions } = require("@pythnetwork/solana-utils") as typeof import("@pythnetwork/solana-utils");

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");
const deploymentPath = resolve(workspace, "deployments", `${cluster}.json`);
const walletPath = process.env.SOLANA_WALLET?.replace(/^~/, homedir()) ?? resolve(homedir(), ".config/solana/id.json");
const pythFeedId = "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593";
const smokePythFeedId = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const pythFeedBytes = [...Buffer.from(pythFeedId, "hex")];
const smokePythFeedBytes = [...Buffer.from(smokePythFeedId, "hex")];
const pythReceiverProgram = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

type MarketManifest = {
  code: "15M" | "1H" | "EOD" | "7D" | "30D";
  address: string;
  oracle: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  lastTradeAt: number;
  creator: string;
};

type LiquidityPoolManifest = {
  id: string;
  address: string;
  token: string;
  quoteAuthority: string;
  settlementMint: string;
  maxUtilizationBps: number;
  maxPositionBps: number;
  authorizedMarkets: string[];
  manager: string;
};

type Deployment = {
  cluster: string;
  rpcUrl: string;
  programId: string;
  pythUpgradeDeployed: boolean;
  programUpgradeSignature?: string;
  pythReceiverProgram: string;
  pythFeedId: string;
  smokePythFeedId: string;
  config: string;
  admin: string;
  maker: string;
  buyer: string;
  creator: string;
  settlementMint: string;
  underlyingMint: string;
  writerVault: string;
  writerToken: string;
  treasuryToken: string;
  domainSeparator: number[];
  domainVersion: number;
  uiMarket: string;
  uiOracle: string;
  uiExpiry: number;
  markets: MarketManifest[];
  liquidityPools: LiquidityPoolManifest[];
  smoke: Record<string, string | number | boolean>;
  generatedAt: string;
};

const NEW_YORK = "America/New_York";
const USER_MARKET_OBSERVATION_SECONDS = 30;
const USER_MARKET_SETTLEMENT_GRACE_SECONDS = 900;
// 8-byte discriminator + Market::INIT_SPACE under the upgraded factory layout;
// accounts of any other size predate the upgrade and no longer deserialize.
const MARKET_ACCOUNT_SIZE = 277;

function newYorkParts(timestampMs: number) {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function timeZoneOffset(timestampMs: number) {
  const parts = newYorkParts(timestampMs);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    - Math.floor(timestampMs / 1_000) * 1_000;
}

function newYorkTimeToUtc(year: number, month: number, day: number, hour: number, minute: number) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return Math.floor((guess - timeZoneOffset(guess)) / 1_000);
}

function addCalendarDays(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isWeekday(parts: { year: number; month: number; day: number }) {
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function nextSessionDay(timestampSeconds: number, minimumSeconds: number) {
  const start = newYorkParts(timestampSeconds * 1_000);
  for (let offset = 0; offset < 45; offset += 1) {
    const day = addCalendarDays(start.year, start.month, start.day, offset);
    if (!isWeekday(day)) continue;
    const close = newYorkTimeToUtc(day.year, day.month, day.day, 15, 59);
    if (close >= minimumSeconds) return day;
  }
  throw new Error("Could not resolve a session-aligned expiry");
}

function rollingMarketSchedule(now: number): Array<{
  code: MarketManifest["code"];
  expiry: number;
  lastTradeAt: number;
}> {
  const nextDay = nextSessionDay(now, now + 15 * 60);
  const open = newYorkTimeToUtc(nextDay.year, nextDay.month, nextDay.day, 9, 30);
  const close = newYorkTimeToUtc(nextDay.year, nextDay.month, nextDay.day, 15, 59);

  const firstGridExpiry = (minimum: number, step: number, first: number) => {
    if (minimum <= first) return first;
    const steps = Math.ceil((minimum - first) / step);
    const candidate = first + steps * step;
    if (candidate <= close) return candidate;
    const following = nextSessionDay(close + 60, close + 60);
    return newYorkTimeToUtc(following.year, following.month, following.day, 9, 30) + step;
  };

  const fifteen = firstGridExpiry(now + 15 * 60, 15 * 60, open + 15 * 60);
  const oneHour = firstGridExpiry(now + 60 * 60, 60 * 60, open + 60 * 60);
  const eodDay = nextSessionDay(now, now + 5 * 60);
  const eod = newYorkTimeToUtc(eodDay.year, eodDay.month, eodDay.day, 15, 59);
  const sevenDay = nextSessionDay(now, now + 7 * 86_400);
  const thirtyDay = nextSessionDay(now, now + 30 * 86_400);
  const seven = newYorkTimeToUtc(sevenDay.year, sevenDay.month, sevenDay.day, 15, 59);
  const thirty = newYorkTimeToUtc(thirtyDay.year, thirtyDay.month, thirtyDay.day, 15, 59);
  return [
    { code: "15M", expiry: fifteen, lastTradeAt: fifteen - 60 },
    { code: "1H", expiry: oneHour, lastTradeAt: oneHour - 300 },
    { code: "EOD", expiry: eod, lastTradeAt: eod - 300 },
    { code: "7D", expiry: seven, lastTradeAt: seven - 300 },
    { code: "30D", expiry: thirty, lastTradeAt: thirty - 300 },
  ];
}

async function loadKeypair(path: string): Promise<Keypair> {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]));
}

async function loadOrCreateKeypair(name: string): Promise<Keypair> {
  const path = resolve(devnetDir, `${name}.json`);
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) return loadKeypair(path);
  const keypair = Keypair.generate();
  await writeFile(path, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  return keypair;
}

async function confirmAirdrop(signature: string): Promise<void> {
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, commitment);
}

async function ensureAdminFunds(admin: Keypair): Promise<void> {
  const balance = await connection.getBalance(admin.publicKey, commitment);
  const minimum = cluster === "localnet" ? 5 * LAMPORTS_PER_SOL : 2 * LAMPORTS_PER_SOL;
  if (balance >= minimum) return;
  console.log(`Admin balance is ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL; requesting dev funds...`);
  try {
    await confirmAirdrop(await connection.requestAirdrop(admin.publicKey, 2 * LAMPORTS_PER_SOL));
  } catch (error) {
    throw new Error(`VSOL needs at least 2 devnet SOL in ${admin.publicKey.toBase58()}. Airdrop failed: ${String(error)}`);
  }
}

async function ensureSignerFunds(admin: Keypair, signer: Keypair): Promise<void> {
  if ((await connection.getBalance(signer.publicKey, commitment)) >= 50_000_000) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: signer.publicKey, lamports: 100_000_000 }),
  );
  await sendAndConfirmTransaction(connection, tx, [admin], { commitment });
}

function programFor(signer: Keypair): Program<Vsol> {
  const provider = new AnchorProvider(connection, new AnchorWallet(signer), { commitment, preflightCommitment: commitment });
  return new Program<Vsol>(idl, provider);
}

async function accountExists(address: PublicKey): Promise<boolean> {
  return (await connection.getAccountInfo(address, commitment)) !== null;
}

async function ensureMint(admin: Keypair, mint: Keypair, decimals: number): Promise<PublicKey> {
  try {
    await getMint(connection, mint.publicKey, commitment, TOKEN_PROGRAM_ID);
    return mint.publicKey;
  } catch {
    return createMint(connection, admin, admin.publicKey, admin.publicKey, decimals, mint, { commitment }, TOKEN_PROGRAM_ID);
  }
}

async function ensureTokenBalance(
  payer: Keypair,
  mintAuthority: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  minimum: bigint,
) {
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner,
    false,
    commitment,
    { commitment },
    TOKEN_PROGRAM_ID,
  );
  const current = (await getAccount(connection, account.address, commitment, TOKEN_PROGRAM_ID)).amount;
  if (current < minimum) {
    await mintTo(
      connection,
      payer,
      mint,
      account.address,
      mintAuthority,
      minimum - current,
      [],
      { commitment },
      TOKEN_PROGRAM_ID,
    );
  }
  return account.address;
}

async function createMarket(params: {
  creatorProgram: Program<Vsol>;
  creator: Keypair;
  config: PublicKey;
  settlementMint: PublicKey;
  underlyingMint: PublicKey;
  symbol: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  pythFeedId: number[];
}) {
  const symbol = symbolBytes(params.symbol);
  // The program enforces the deterministic factory id, so the id must be the
  // parameter hash rather than a label digest.
  const id = await deriveMarketId({
    pythFeedId: params.pythFeedId,
    settlementMint: params.settlementMint,
    expiry: BigInt(params.expiry),
    observationWindowSeconds: params.observationWindowSeconds,
    settlementGraceSeconds: params.settlementGraceSeconds,
    priceScale: PRICE_SCALE,
    maxConfidenceBps: 500,
    symbol,
  });
  const market = deriveMarket(params.config, id);
  const oracle = deriveOracle(market);
  if (!(await accountExists(market))) {
    await params.creatorProgram.methods
      .createMarket({
        marketId: [...id],
        underlyingMint: params.underlyingMint,
        symbol,
        priceScale: new BN(PRICE_SCALE.toString()),
        expiry: new BN(params.expiry),
        observationWindowSeconds: params.observationWindowSeconds,
        settlementGraceSeconds: params.settlementGraceSeconds,
        maxConfidenceBps: 500,
        pythFeedId: params.pythFeedId,
      })
      .accountsStrict({
        creator: params.creator.publicKey,
        config: params.config,
        market,
        oracle,
        settlementMint: params.settlementMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
  return { id, market, oracle };
}

async function ensureLiquidityPool(params: {
  creatorProgram: Program<Vsol>;
  creator: Keypair;
  config: PublicKey;
  settlementMint: PublicKey;
  quoteAuthority: PublicKey;
  label: string;
  maxUtilizationBps: number;
  maxPositionBps: number;
}) {
  const id = liquidityPoolId(params.label);
  const pool = deriveLiquidityPool(params.config, params.settlementMint, id);
  const poolToken = deriveLiquidityPoolToken(pool);
  if (!(await accountExists(pool))) {
    await params.creatorProgram.methods
      .initializeLiquidityPool({
        poolId: [...id],
        quoteAuthority: params.quoteAuthority,
        maxUtilizationBps: params.maxUtilizationBps,
        maxPositionBps: params.maxPositionBps,
      })
      .accountsStrict({
        creator: params.creator.publicKey,
        config: params.config,
        settlementMint: params.settlementMint,
        pool,
        poolToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }
  return { id, pool, poolToken };
}

async function authorizePoolMarket(params: {
  managerProgram: Program<Vsol>;
  manager: Keypair;
  config: PublicKey;
  pool: PublicKey;
  market: PublicKey;
  lastTradeAt: number;
}) {
  const poolMarket = deriveLiquidityPoolMarket(params.pool, params.market);
  const existing = await params.managerProgram.account.liquidityPoolMarket.fetchNullable(poolMarket);
  if (!existing || !existing.enabled || existing.lastTradeAt.toNumber() !== params.lastTradeAt) {
    await params.managerProgram.methods
      .setLiquidityPoolMarket({ lastTradeAt: new BN(params.lastTradeAt), enabled: true })
      .accountsStrict({
        manager: params.manager.publicKey,
        config: params.config,
        pool: params.pool,
        market: params.market,
        poolMarket,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
  return poolMarket;
}

async function buildFill(params: {
  buyerProgram: Program<Vsol>;
  buyer: Keypair;
  buyerSource: PublicKey;
  maker: Keypair;
  config: PublicKey;
  market: PublicKey;
  settlementMint: PublicKey;
  writerVault: PublicKey;
  writerToken: PublicKey;
  quote: Quote;
  domainSeparator: Uint8Array;
  domainVersion: number;
}) {
  const nonceRecord = deriveNonce(params.config, params.maker.publicKey, params.quote.nonce);
  const position = derivePosition(nonceRecord);
  const positionVault = derivePositionVault(position);
  const message = quoteMessage({
    domainSeparator: params.domainSeparator,
    domainVersion: params.domainVersion,
    config: params.config,
    market: params.market,
    buyer: params.buyer.publicKey,
    maker: params.maker.publicKey,
    quote: params.quote,
  });
  const signatureInstruction = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: params.maker.secretKey,
    message,
  });
  const fillInstruction = await params.buyerProgram.methods
    .fillQuote(toAnchorQuote(params.quote))
    .accountsStrict({
      buyer: params.buyer.publicKey,
      maker: params.maker.publicKey,
      config: params.config,
      market: params.market,
      settlementMint: params.settlementMint,
      writerVault: params.writerVault,
      writerToken: params.writerToken,
      buyerSource: params.buyerSource,
      nonceRecord,
      position,
      positionVault,
      eligibility: null,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { transaction: new Transaction().add(signatureInstruction, fillInstruction), nonceRecord, position, positionVault };
}

function toAnchorPoolQuote(quote: PoolQuote) {
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

async function buildPoolFill(params: {
  buyerProgram: Program<Vsol>;
  buyer: Keypair;
  buyerSource: PublicKey;
  quoteAuthority: Keypair;
  config: PublicKey;
  pool: PublicKey;
  poolMarket: PublicKey;
  poolToken: PublicKey;
  market: PublicKey;
  settlementMint: PublicKey;
  quote: PoolQuote;
  domainSeparator: Uint8Array;
  domainVersion: number;
}) {
  const nonceRecord = derivePoolNonce(params.pool, params.quoteAuthority.publicKey, params.quote.nonce);
  const position = derivePoolPosition(nonceRecord);
  const positionVault = derivePoolPositionVault(position);
  const message = poolQuoteMessage({
    domainSeparator: params.domainSeparator,
    domainVersion: params.domainVersion,
    config: params.config,
    pool: params.pool,
    market: params.market,
    buyer: params.buyer.publicKey,
    quoteAuthority: params.quoteAuthority.publicKey,
    quote: params.quote,
  });
  const signatureInstruction = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: params.quoteAuthority.secretKey,
    message,
  });
  const fillInstruction = await params.buyerProgram.methods
    .fillPoolQuote(toAnchorPoolQuote(params.quote))
    .accountsStrict({
      buyer: params.buyer.publicKey,
      quoteAuthority: params.quoteAuthority.publicKey,
      config: params.config,
      pool: params.pool,
      market: params.market,
      poolMarket: params.poolMarket,
      settlementMint: params.settlementMint,
      poolToken: params.poolToken,
      buyerSource: params.buyerSource,
      nonceRecord,
      position,
      positionVault,
      eligibility: null,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { transaction: new Transaction().add(signatureInstruction, fillInstruction), nonceRecord, position, positionVault };
}

async function clusterUnixTime(): Promise<number> {
  const slot = await connection.getSlot(commitment);
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error(`No block time is available for slot ${slot}`);
  return blockTime;
}

async function waitUntil(timestamp: number, label: string): Promise<void> {
  let chainTime = await clusterUnixTime();
  while (chainTime <= timestamp) {
    const remaining = timestamp - chainTime + 1;
    process.stdout.write(`\r${label}: ${remaining}s `);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(1_000, remaining * 1_000)));
    chainTime = await clusterUnixTime();
  }
  process.stdout.write("\n");
}

async function pythUpdateAtOrAfter(feedId: string, expiry: number) {
  const client = new HermesClient(process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network", {
    accessToken: process.env.PYTH_API_KEY?.trim() || undefined,
    timeout: 20_000,
    httpRetries: 3,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const update = await client.getLatestPriceUpdates([feedId], { encoding: "base64", parsed: true });
    const parsed = update.parsed?.[0];
    if (parsed && parsed.id.toLowerCase() === feedId && parsed.price.publish_time >= expiry) return { update, parsed };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Pyth did not publish feed ${feedId} inside the settlement observation window`);
}

async function publishPythSettlement(params: {
  adminProgram: Program<Vsol>;
  admin: Keypair;
  config: PublicKey;
  market: PublicKey;
  oracle: PublicKey;
  feedId: string;
  expiry: number;
}) {
  const { update, parsed } = await pythUpdateAtOrAfter(params.feedId, params.expiry);
  if (update.binary.encoding !== "base64" || !update.binary.data.length) throw new Error("Hermes returned no base64 Pyth update");
  const wallet = new CoralWallet(params.admin);
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates(update.binary.data);
  let priceUpdate: PublicKey | undefined;
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (feedId: string) => PublicKey) => {
    // The receiver SDK indexes accumulator updates by canonical 0x-prefixed feed ID.
    const updateAccount = getPriceUpdateAccount(`0x${params.feedId}`);
    priceUpdate = updateAccount;
    return [{
      instruction: await params.adminProgram.methods
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
    connection,
    wallet,
    30,
  );
  if (!priceUpdate || !signatures.length) throw new Error("Pyth settlement transactions did not complete");
  return {
    publishSignature: signatures[signatures.length - 1],
    pythPriceUpdate: priceUpdate.toBase58(),
    pythPublishTime: parsed.price.publish_time,
    pythPrice: parsed.price.price,
    pythConfidence: parsed.price.conf,
    pythExponent: parsed.price.expo,
  };
}

async function main(): Promise<void> {
  console.log(`VSOL bootstrap on ${cluster} through the configured RPC`);
  const previousDeployment = existsSync(deploymentPath)
    ? JSON.parse(await readFile(deploymentPath, "utf8")) as Partial<Deployment>
    : {};
  const admin = await loadKeypair(walletPath);
  const maker = await loadOrCreateKeypair(`${cluster}-maker`);
  const buyer = await loadOrCreateKeypair(`${cluster}-buyer`);
  // A dedicated non-admin signer creates every market and pool to prove the
  // factory paths are permissionless on a live cluster.
  const creator = await loadOrCreateKeypair(`${cluster}-creator`);
  const settlementMintKeypair = await loadOrCreateKeypair(`${cluster}-mock-usdc-mint`);
  const underlyingMintKeypair = await loadOrCreateKeypair(`${cluster}-mock-rwa-mint`);
  await ensureAdminFunds(admin);
  await ensureSignerFunds(admin, maker);
  await ensureSignerFunds(admin, buyer);
  await ensureSignerFunds(admin, creator);

  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);

  const adminProgram = programFor(admin);
  const makerProgram = programFor(maker);
  const buyerProgram = programFor(buyer);
  const creatorProgram = programFor(creator);
  const config = deriveConfig();
  const genesisDomain = new PublicKey(await connection.getGenesisHash()).toBytes();
  if (!(await accountExists(config))) {
    await adminProgram.methods
      .initializeConfig({
        pauseAuthority: admin.publicKey,
        oracleAuthority: admin.publicKey,
        eligibilityAuthority: admin.publicKey,
        treasuryOwner: admin.publicKey,
        feeBps: 25,
        eligibilityRequired: false,
        domainSeparator: [...genesisDomain],
      })
      .accountsStrict({ admin: admin.publicKey, config, systemProgram: SystemProgram.programId })
      .rpc();
  }
  const configAccount = await adminProgram.account.config.fetch(config);
  const domainSeparator = Uint8Array.from(configAccount.domainSeparator);
  const domainVersion = configAccount.domainVersion;

  const settlementMint = await ensureMint(admin, settlementMintKeypair, 6);
  const underlyingMint = await ensureMint(admin, underlyingMintKeypair, 6);
  const faucetPath = resolve(devnetDir, `${cluster}-faucet.json`);
  const settlementMintAuthority = existsSync(faucetPath) ? await loadKeypair(faucetPath) : admin;
  const settlementMintAccount = await getMint(connection, settlementMint, commitment, TOKEN_PROGRAM_ID);
  if (!settlementMintAccount.mintAuthority?.equals(settlementMintAuthority.publicKey)) {
    throw new Error(`Configured mock-USDC authority ${settlementMintAuthority.publicKey.toBase58()} does not control ${settlementMint.toBase58()}`);
  }
  const makerToken = await ensureTokenBalance(
    admin,
    settlementMintAuthority,
    settlementMint,
    maker.publicKey,
    100_000n * 1_000_000n,
  );
  const buyerToken = await ensureTokenBalance(
    admin,
    settlementMintAuthority,
    settlementMint,
    buyer.publicKey,
    100_000n * 1_000_000n,
  );
  const treasuryToken = await ensureTokenBalance(admin, settlementMintAuthority, settlementMint, admin.publicKey, 0n);

  const writerVault = deriveWriterVault(config, maker.publicKey, settlementMint);
  const writerToken = deriveWriterToken(writerVault);
  if (!(await accountExists(writerVault))) {
    await makerProgram.methods
      .initializeWriterVault()
      .accountsStrict({
        maker: maker.publicKey,
        config,
        settlementMint,
        writerVault,
        writerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }
  const writerLiquidity = (await getAccount(connection, writerToken, commitment, TOKEN_PROGRAM_ID)).amount;
  if (writerLiquidity < 30_000n * 1_000_000n) {
    await makerProgram.methods
      .depositWriter(new BN((30_000n * 1_000_000n - writerLiquidity).toString()))
      .accountsStrict({
        config,
        maker: maker.publicKey,
        settlementMint,
        writerVault,
        writerToken,
        makerSource: makerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  const now = await clusterUnixTime();
  const schedule = rollingMarketSchedule(now);
  const catalog: Array<MarketManifest & { marketKey: PublicKey; oracleKey: PublicKey }> = [];
  for (const series of schedule) {
    const created = await createMarket({
      creatorProgram,
      creator,
      config,
      settlementMint,
      underlyingMint,
      symbol: "NVDA",
      expiry: series.expiry,
      observationWindowSeconds: USER_MARKET_OBSERVATION_SECONDS,
      settlementGraceSeconds: USER_MARKET_SETTLEMENT_GRACE_SECONDS,
      pythFeedId: pythFeedBytes,
    });
    catalog.push({
      code: series.code,
      address: created.market.toBase58(),
      oracle: created.oracle.toBase58(),
      expiry: series.expiry,
      observationWindowSeconds: USER_MARKET_OBSERVATION_SECONDS,
      settlementGraceSeconds: USER_MARKET_SETTLEMENT_GRACE_SECONDS,
      lastTradeAt: series.lastTradeAt,
      creator: creator.publicKey.toBase58(),
      marketKey: created.market,
      oracleKey: created.oracle,
    });
  }
  const uiSeries = catalog.find((series) => series.code === "30D");
  if (!uiSeries) throw new Error("The rolling catalog did not create a 30D market");
  const uiExpiry = uiSeries.expiry;
  const ui = { market: uiSeries.marketKey, oracle: uiSeries.oracleKey };

  if (previousDeployment.uiMarket && previousDeployment.uiMarket !== ui.market.toBase58()) {
    const unsafeMarket = new PublicKey(previousDeployment.uiMarket);
    const unsafeInfo = await connection.getAccountInfo(unsafeMarket, commitment);
    if (unsafeInfo && unsafeInfo.data.length !== MARKET_ACCOUNT_SIZE) {
      // Pre-upgrade layout: the upgraded program rejects it at deserialization,
      // so the account is inert (untradeable) and cannot and need not be disabled.
      console.log(`Skipping legacy UI market ${unsafeMarket.toBase58()}: stale pre-upgrade account layout is inert`);
    } else if (unsafeInfo) {
      const unsafeAccount = await adminProgram.account.market.fetchNullable(unsafeMarket);
      if (unsafeAccount?.enabled) {
        await adminProgram.methods
          .setMarketEnabled(false)
          .accountsStrict({ admin: admin.publicKey, config, market: unsafeMarket })
          .rpc();
      }
    }
  }

  const mainPool = await ensureLiquidityPool({
    creatorProgram,
    creator,
    config,
    settlementMint,
    quoteAuthority: maker.publicKey,
    label: `${cluster}:tUSDC:main-v3`,
    maxUtilizationBps: 8_000,
    maxPositionBps: 2_500,
  });
  const mainProvider = deriveLiquidityProvider(mainPool.pool, maker.publicKey);
  const mainPoolBalance = (await getAccount(connection, mainPool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount;
  const mainPoolTarget = 20_000n * 1_000_000n;
  if (mainPoolBalance < mainPoolTarget) {
    const mainPoolAccount = await adminProgram.account.liquidityPool.fetch(mainPool.pool);
    const depositAmount = mainPoolTarget - mainPoolBalance;
    const minimumShares = calculateDepositShares(
      depositAmount,
      BigInt(mainPoolAccount.totalShares.toString()),
      mainPoolBalance,
    );
    await makerProgram.methods
      .depositLiquidity(
        new BN(depositAmount.toString()),
        new BN(minimumShares.toString()),
        new BN(now + 600),
      )
      .accountsStrict({
        provider: maker.publicKey,
        config,
        settlementMint,
        pool: mainPool.pool,
        poolToken: mainPool.poolToken,
        providerPosition: mainProvider,
        providerSource: makerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
  for (const series of catalog) {
    await authorizePoolMarket({
      managerProgram: creatorProgram,
      manager: creator,
      config,
      pool: mainPool.pool,
      market: series.marketKey,
      lastTradeAt: series.lastTradeAt,
    });
  }

  const smokeExpiry = (await clusterUnixTime()) + (cluster === "localnet" ? 30 : 75);
  const runId = `${Date.now()}`;
  const successMarket = await createMarket({
    creatorProgram,
    creator,
    config,
    settlementMint,
    underlyingMint,
    symbol: "VSOL-TEST",
    expiry: smokeExpiry,
    observationWindowSeconds: 120,
    settlementGraceSeconds: 600,
    pythFeedId: smokePythFeedBytes,
  });
  const refundMarket = await createMarket({
    creatorProgram,
    creator,
    config,
    settlementMint,
    underlyingMint,
    symbol: "VSOL-TEST",
    expiry: smokeExpiry,
    observationWindowSeconds: 5,
    settlementGraceSeconds: 15,
    pythFeedId: smokePythFeedBytes,
  });

  const smokePool = await ensureLiquidityPool({
    creatorProgram,
    creator,
    config,
    settlementMint,
    quoteAuthority: maker.publicKey,
    label: `${cluster}:smoke-v3:${runId}`,
    maxUtilizationBps: 8_000,
    maxPositionBps: 5_000,
  });
  const smokeProvider = deriveLiquidityProvider(smokePool.pool, maker.publicKey);
  const smokeDeposit = 12_000n * 1_000_000n;
  await makerProgram.methods
    .depositLiquidity(
      new BN(smokeDeposit.toString()),
      new BN(smokeDeposit.toString()),
      new BN(smokeExpiry - 10),
    )
    .accountsStrict({
      provider: maker.publicKey,
      config,
      settlementMint,
      pool: smokePool.pool,
      poolToken: smokePool.poolToken,
      providerPosition: smokeProvider,
      providerSource: makerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const successPoolMarket = await authorizePoolMarket({
    managerProgram: creatorProgram,
    manager: creator,
    config,
    pool: smokePool.pool,
    market: successMarket.market,
    lastTradeAt: smokeExpiry - 5,
  });
  const refundPoolMarket = await authorizePoolMarket({
    managerProgram: creatorProgram,
    manager: creator,
    config,
    pool: smokePool.pool,
    market: refundMarket.market,
    lastTradeAt: smokeExpiry - 5,
  });

  const quoteExpiry = BigInt(smokeExpiry - 5);
  const successQuote: Quote = {
    nonce: BigInt(Date.now()),
    direction: 0,
    strike: 100n * PRICE_SCALE,
    width: 10n * PRICE_SCALE,
    premium: 500n * 1_000_000n,
    maxPayout: 5_000n * 1_000_000n,
    quoteExpiry,
  };
  const refundQuote: Quote = {
    nonce: successQuote.nonce + 1n,
    direction: 1,
    strike: 100n * PRICE_SCALE,
    width: 10n * PRICE_SCALE,
    premium: 100n * 1_000_000n,
    maxPayout: 1_000n * 1_000_000n,
    quoteExpiry,
  };
  const poolSuccessQuote: PoolQuote = { ...successQuote, nonce: successQuote.nonce + 10n };
  const poolRefundQuote: PoolQuote = { ...refundQuote, nonce: successQuote.nonce + 11n };

  const successFill = await buildFill({
    buyerProgram,
    buyer,
    buyerSource: buyerToken,
    maker,
    config,
    market: successMarket.market,
    settlementMint,
    writerVault,
    writerToken,
    quote: successQuote,
    domainSeparator,
    domainVersion,
  });
  const successFillSignature = await sendAndConfirmTransaction(connection, successFill.transaction, [buyer], { commitment });
  const refundFill = await buildFill({
    buyerProgram,
    buyer,
    buyerSource: buyerToken,
    maker,
    config,
    market: refundMarket.market,
    settlementMint,
    writerVault,
    writerToken,
    quote: refundQuote,
    domainSeparator,
    domainVersion,
  });
  const refundFillSignature = await sendAndConfirmTransaction(connection, refundFill.transaction, [buyer], { commitment });

  const poolSuccessFill = await buildPoolFill({
    buyerProgram,
    buyer,
    buyerSource: buyerToken,
    quoteAuthority: maker,
    config,
    pool: smokePool.pool,
    poolMarket: successPoolMarket,
    poolToken: smokePool.poolToken,
    market: successMarket.market,
    settlementMint,
    quote: poolSuccessQuote,
    domainSeparator,
    domainVersion,
  });
  const poolSuccessFillSignature = await sendAndConfirmTransaction(
    connection,
    poolSuccessFill.transaction,
    [buyer],
    { commitment },
  );
  const poolRefundFill = await buildPoolFill({
    buyerProgram,
    buyer,
    buyerSource: buyerToken,
    quoteAuthority: maker,
    config,
    pool: smokePool.pool,
    poolMarket: refundPoolMarket,
    poolToken: smokePool.poolToken,
    market: refundMarket.market,
    settlementMint,
    quote: poolRefundQuote,
    domainSeparator,
    domainVersion,
  });
  const poolRefundFillSignature = await sendAndConfirmTransaction(
    connection,
    poolRefundFill.transaction,
    [buyer],
    { commitment },
  );

  let replayRejected = false;
  try {
    await sendAndConfirmTransaction(connection, successFill.transaction, [buyer], { commitment });
  } catch {
    replayRejected = true;
  }
  if (!replayRejected) throw new Error("A filled maker nonce was replayable");
  let poolReplayRejected = false;
  try {
    await sendAndConfirmTransaction(connection, poolSuccessFill.transaction, [buyer], { commitment });
  } catch {
    poolReplayRejected = true;
  }
  if (!poolReplayRejected) throw new Error("A filled pool quote nonce was replayable");

  await waitUntil(smokeExpiry, "Waiting for settlement observation");
  const pythSettlement = await publishPythSettlement({
    adminProgram,
    admin,
    config,
    market: successMarket.market,
    oracle: successMarket.oracle,
    feedId: smokePythFeedId,
    expiry: smokeExpiry,
  });

  const settleSignature = await adminProgram.methods
    .settle()
    .accountsStrict({
      cranker: admin.publicKey,
      config,
      market: successMarket.market,
      oracle: successMarket.oracle,
      nonceRecord: successFill.nonceRecord,
      position: successFill.position,
      positionVault: successFill.positionVault,
      settlementMint,
      buyerDestination: buyerToken,
      makerDestination: makerToken,
      treasuryDestination: treasuryToken,
      rentRecipient: buyer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  if (await accountExists(successFill.position)) throw new Error("Settled position account did not close");
  if (await accountExists(successFill.positionVault)) throw new Error("Settled token vault did not close");

  const poolSettleSignature = await adminProgram.methods
    .settlePoolPosition()
    .accountsStrict({
      cranker: admin.publicKey,
      config,
      pool: smokePool.pool,
      market: successMarket.market,
      oracle: successMarket.oracle,
      nonceRecord: poolSuccessFill.nonceRecord,
      position: poolSuccessFill.position,
      positionVault: poolSuccessFill.positionVault,
      settlementMint,
      buyerDestination: buyerToken,
      poolToken: smokePool.poolToken,
      treasuryDestination: treasuryToken,
      rentRecipient: buyer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  if (await accountExists(poolSuccessFill.position)) throw new Error("Settled pool position account did not close");
  if (await accountExists(poolSuccessFill.positionVault)) throw new Error("Settled pool token vault did not close");

  const refundDeadline = smokeExpiry + 5 + 15;
  await waitUntil(refundDeadline, "Waiting for oracle-timeout refund");
  const refundSignature = await adminProgram.methods
    .refundUnsettled()
    .accountsStrict({
      cranker: admin.publicKey,
      market: refundMarket.market,
      oracle: refundMarket.oracle,
      nonceRecord: refundFill.nonceRecord,
      position: refundFill.position,
      positionVault: refundFill.positionVault,
      settlementMint,
      buyerDestination: buyerToken,
      makerDestination: makerToken,
      rentRecipient: buyer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  if (await accountExists(refundFill.position)) throw new Error("Refunded position account did not close");
  if (await accountExists(refundFill.positionVault)) throw new Error("Refunded token vault did not close");

  const poolRefundSignature = await adminProgram.methods
    .refundPoolPosition()
    .accountsStrict({
      cranker: admin.publicKey,
      config,
      pool: smokePool.pool,
      market: refundMarket.market,
      oracle: refundMarket.oracle,
      nonceRecord: poolRefundFill.nonceRecord,
      position: poolRefundFill.position,
      positionVault: poolRefundFill.positionVault,
      settlementMint,
      buyerDestination: buyerToken,
      poolToken: smokePool.poolToken,
      rentRecipient: buyer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  if (await accountExists(poolRefundFill.position)) throw new Error("Refunded pool position account did not close");
  if (await accountExists(poolRefundFill.positionVault)) throw new Error("Refunded pool token vault did not close");

  const poolAccount = await adminProgram.account.liquidityPool.fetch(smokePool.pool);
  if (!poolAccount.openPositions.isZero() || !poolAccount.lockedCollateral.isZero()) {
    throw new Error("Pool obligations did not return to zero after settle and refund");
  }
  const pythExponent = Number(pythSettlement.pythExponent);
  const normalizedPythPrice = pythExponent >= 0
    ? BigInt(pythSettlement.pythPrice) * PRICE_SCALE * (10n ** BigInt(pythExponent))
    : BigInt(pythSettlement.pythPrice) * PRICE_SCALE / (10n ** BigInt(Math.abs(pythExponent)));
  const expectedPayout = calculatePayout(poolSuccessQuote, normalizedPythPrice);
  const feeBps = BigInt(configAccount.feeBps);
  const fee = (poolSuccessQuote.premium * feeBps + 9_999n) / 10_000n;
  const expectedPoolAssets = smokeDeposit + poolSuccessQuote.premium - expectedPayout - fee;
  const settledPoolAssets = (await getAccount(connection, smokePool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount;
  if (settledPoolAssets !== expectedPoolAssets) {
    throw new Error(`Pool conservation failed: expected ${expectedPoolAssets}, received ${settledPoolAssets}`);
  }
  const providerBeforeWithdraw = await adminProgram.account.liquidityProvider.fetch(smokeProvider);
  const poolWithdrawSignature = await makerProgram.methods
    .withdrawLiquidity(
      providerBeforeWithdraw.shares,
      new BN(expectedPoolAssets.toString()),
      new BN((await clusterUnixTime()) + 600),
    )
    .accountsStrict({
      provider: maker.publicKey,
      config,
      settlementMint,
      pool: smokePool.pool,
      poolToken: smokePool.poolToken,
      providerPosition: smokeProvider,
      providerDestination: makerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  if ((await getAccount(connection, smokePool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount !== 0n) {
    throw new Error("Pool withdrawal did not return all realized assets to the provider");
  }

  const deployment: Deployment = {
    cluster,
    rpcUrl: cluster === "devnet" ? "https://api.devnet.solana.com" : rpcUrl,
    programId: VSOL_PROGRAM_ID.toBase58(),
    pythUpgradeDeployed: true,
    programUpgradeSignature: previousDeployment.programUpgradeSignature,
    pythReceiverProgram,
    pythFeedId,
    smokePythFeedId,
    config: config.toBase58(),
    admin: admin.publicKey.toBase58(),
    maker: maker.publicKey.toBase58(),
    buyer: buyer.publicKey.toBase58(),
    creator: creator.publicKey.toBase58(),
    settlementMint: settlementMint.toBase58(),
    underlyingMint: underlyingMint.toBase58(),
    writerVault: writerVault.toBase58(),
    writerToken: writerToken.toBase58(),
    treasuryToken: treasuryToken.toBase58(),
    domainSeparator: [...domainSeparator],
    domainVersion,
    uiMarket: ui.market.toBase58(),
    uiOracle: ui.oracle.toBase58(),
    uiExpiry,
    markets: catalog.map((series) => ({
      code: series.code,
      address: series.address,
      oracle: series.oracle,
      expiry: series.expiry,
      observationWindowSeconds: series.observationWindowSeconds,
      settlementGraceSeconds: series.settlementGraceSeconds,
      lastTradeAt: series.lastTradeAt,
      creator: creator.publicKey.toBase58(),
    })),
    liquidityPools: [{
      id: Buffer.from(mainPool.id).toString("hex"),
      address: mainPool.pool.toBase58(),
      token: mainPool.poolToken.toBase58(),
      quoteAuthority: maker.publicKey.toBase58(),
      settlementMint: settlementMint.toBase58(),
      maxUtilizationBps: 8_000,
      maxPositionBps: 2_500,
      authorizedMarkets: catalog.map((series) => series.address),
      manager: creator.publicKey.toBase58(),
    }],
    smoke: {
      ...(previousDeployment.smoke ?? {}),
      successFillSignature,
      refundFillSignature,
      poolSuccessFillSignature,
      poolRefundFillSignature,
      successMarket: successMarket.market.toBase58(),
      successOracle: successMarket.oracle.toBase58(),
      refundMarket: refundMarket.market.toBase58(),
      refundOracle: refundMarket.oracle.toBase58(),
      publishSignature: pythSettlement.publishSignature,
      pythPriceUpdate: pythSettlement.pythPriceUpdate,
      pythPublishTime: pythSettlement.pythPublishTime,
      pythPrice: pythSettlement.pythPrice,
      pythConfidence: pythSettlement.pythConfidence,
      pythExponent: pythSettlement.pythExponent,
      settleSignature,
      poolSettleSignature,
      refundSignature,
      poolRefundSignature,
      poolWithdrawSignature,
      replayRejected,
      poolReplayRejected,
      successPositionClosed: !(await accountExists(successFill.position)),
      refundPositionClosed: !(await accountExists(refundFill.position)),
      poolSuccessPositionClosed: !(await accountExists(poolSuccessFill.position)),
      poolRefundPositionClosed: !(await accountExists(poolRefundFill.position)),
      smokePool: smokePool.pool.toBase58(),
      smokePoolToken: smokePool.poolToken.toBase58(),
      smokeProvider: smokeProvider.toBase58(),
      poolConservationVerified: settledPoolAssets === expectedPoolAssets,
      poolObligationsCleared: poolAccount.openPositions.isZero() && poolAccount.lockedCollateral.isZero(),
      poolWithdrawalCleared: (await getAccount(connection, smokePool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount === 0n,
    },
    generatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(deploymentPath), { recursive: true });
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
