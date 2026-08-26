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
import { rollingMarketSchedule, type SeriesCode } from "./lib/expiry-grid.ts";
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
  ladderStrike,
  liquidityPoolId,
  MARKET_MAX_CONFIDENCE_BPS,
  MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
  MARKET_OBSERVATION_WINDOW_SECONDS as USER_MARKET_OBSERVATION_SECONDS,
  MARKET_SETTLEMENT_GRACE_SECONDS as USER_MARKET_SETTLEMENT_GRACE_SECONDS,
  poolBuybackMessage,
  poolQuoteMessage,
  PRICE_SCALE,
  quoteMessage,
  symbolBytes,
  toAnchorPoolBuyback,
  toAnchorQuote,
  type Quote,
  type PoolQuote,
  type PoolBuyback,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";
import { pythPriceToScaledAtoms } from "./lib/settlement.ts";

// The official packages publish dual ESM/CJS builds, but solana-utils 0.6.0's
// ESM entry imports an extensionless jito-ts path that Node 24 rejects. Loading
// the package's supported CJS export avoids patching vendor code.
const require = createRequire(import.meta.url);
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver") as typeof import("@pythnetwork/pyth-solana-receiver");
const { sendTransactions } = require("@pythnetwork/solana-utils") as typeof import("@pythnetwork/solana-utils");

// VSOL_SKIP_SMOKE=1 skips the entire adversarial smoke lifecycle (smoke
// markets, fills, real-time settlement waits, refunds, the early-close
// buyback) and writes the deployment manifest immediately after the real
// deployment artifacts (config, mints, rolling market catalog, main
// liquidity pool) are on chain, with smokeStatus: "skipped". Honest
// tradeoff: the resulting manifest is a usable record of what got deployed,
// but carries none of the adversarial verification that smokeStatus:
// "passed" certifies -- no proof that fills, settlement, refunds, replay
// rejection, or the early-close buyback actually work end-to-end against
// this cluster. Reach for it when the deployment artifacts are what you
// need, or when a flaky public RPC makes the multi-minute lifecycle
// unreachable -- it is never a substitute for a full run before anything
// that depends on the smoke lifecycle having actually passed.
const skipSmoke = process.env.VSOL_SKIP_SMOKE === "1";
const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
// A longer initial confirmation timeout (web3.js defaults to 60s/30s
// depending on confirmation strategy) gives public RPC endpoints room to
// recover from the 429 rate-limiting and dropped connections that make the
// smoke lifecycle's confirmations flaky. commitment is threaded through
// from the single `commitment` const above rather than re-hardcoded here.
const connection = new Connection(rpcUrl, { commitment, confirmTransactionInitialTimeout: 120_000 });
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");
const deploymentPath = resolve(workspace, "deployments", `${cluster}.json`);
const walletPath = process.env.SOLANA_WALLET?.replace(/^~/, homedir()) ?? resolve(homedir(), ".config/solana/id.json");
// Crypto.NVDAX/USD (tokenized NVDA), not the equity feed -- see the long
// note on PYTH_FEED_ID in scripts/keeper.ts for why the equity feed cannot
// settle a 24/7 grid.
const pythFeedId = "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f";
const smokePythFeedId = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const pythFeedBytes = [...Buffer.from(pythFeedId, "hex")];
const smokePythFeedBytes = [...Buffer.from(smokePythFeedId, "hex")];
// The three VSOL-TEST smoke markets are deterministic test fixtures on a
// mock feed (their settlement price is whatever the smoke Pyth publisher
// happens to post, unrelated to any real underlying) -- they must NOT
// depend on live spot the way the rolling NVDA catalog does. A fixed
// constant keeps their strike reproducible across runs.
const SMOKE_MARKET_STRIKE = 100n * PRICE_SCALE;
const pythReceiverProgram = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

type MarketManifest = {
  code: SeriesCode;
  address: string;
  oracle: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  maxSettlementStalenessSeconds: number;
  lastTradeAt: number;
  creator: string;
  // The conditional-token winner threshold this rung was listed at -- a
  // fixed ladder rung, not a value re-derivable from the manifest alone. See
  // STRIKE_LADDER_STEP/ladderStrike in ../sdk/index.ts.
  strike: string;
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
  closePoolPositionDeployed: boolean;
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
  // Whether the adversarial smoke lifecycle (smoke markets, fills,
  // settlement, refunds, early-close buyback) ran and passed for this
  // manifest -- "passed" is the only status `smoke` below carries real
  // evidence for. "not-run" means the deployment artifacts above are real
  // and on chain, but the manifest was written before the lifecycle
  // completed (e.g. the process died partway through it, or is still
  // running). "skipped" means VSOL_SKIP_SMOKE=1 deliberately bypassed the
  // lifecycle. scripts/verify-deployment.ts is fail-closed on this field.
  smokeStatus: "skipped" | "passed" | "not-run";
  smoke: Record<string, string | number | boolean>;
  generatedAt: string;
};

// The fields every manifest write shares, regardless of whether the smoke
// lifecycle has run yet. Built once in main() as soon as the real deployment
// artifacts (config, mints, rolling market catalog, main liquidity pool) are
// known, and reused by both the phase-1 (pre-smoke) and phase-2 (post-smoke)
// writes below so the ~20-field object literal never has to be duplicated.
type DeploymentArtifacts = Omit<Deployment, "smokeStatus" | "smoke" | "generatedAt">;

async function writeDeploymentManifest(deployment: Deployment, phase: string): Promise<void> {
  await mkdir(dirname(deploymentPath), { recursive: true });
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`Deployment manifest written (${phase}, smokeStatus: ${deployment.smokeStatus}) -> ${deploymentPath}`);
}

// USER_MARKET_OBSERVATION_SECONDS, USER_MARKET_SETTLEMENT_GRACE_SECONDS, and
// MARKET_MAX_SETTLEMENT_STALENESS_SECONDS now live in ../sdk/index.ts (see the
// import above) — the single shared home with app/lib/launch-params.ts and
// vsol/scripts/keeper.ts, so this script and the app can never derive
// different market ids from the same rolling-grid parameters.
// 8-byte discriminator + Market::INIT_SPACE under the upgraded factory layout
// (277 bytes through max_settlement_staleness_seconds, +8 for the appended
// conditional-token strike u64); accounts of any other size predate the
// upgrade and no longer deserialize.
const MARKET_ACCOUNT_SIZE = 289;

// Tend is a 24/7 protocol: there is no market calendar here. Rolling market
// expiries are pure UTC clock boundaries, mirroring app/lib/expiries.ts. The
// grid itself (rollingMarketSchedule and its helpers) lives in
// ./lib/expiry-grid.ts so this script and scripts/keeper.ts can never drift.

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
  maxSettlementStalenessSeconds: number;
  pythFeedId: number[];
  // The conditional-token winner threshold -- a listed ladder rung (see
  // STRIKE_LADDER_STEP/ladderStrike in ../sdk/index.ts), never derived here.
  // Callers own picking it: the rolling catalog ladders live spot once
  // before its loop, and the smoke markets use a fixed constant (see main()
  // below for both).
  strike: bigint;
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
    maxConfidenceBps: MARKET_MAX_CONFIDENCE_BPS,
    symbol,
    maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
    strike: params.strike,
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
        maxConfidenceBps: MARKET_MAX_CONFIDENCE_BPS,
        pythFeedId: params.pythFeedId,
        maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
        strike: new BN(params.strike.toString()),
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
  return { id, market, oracle, strike: params.strike };
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

async function buildPoolClose(params: {
  buyerProgram: Program<Vsol>;
  buyer: Keypair;
  buyerDestination: PublicKey;
  quoteAuthority: Keypair;
  config: PublicKey;
  pool: PublicKey;
  market: PublicKey;
  oracle: PublicKey;
  position: PublicKey;
  positionVault: PublicKey;
  settlementMint: PublicKey;
  poolToken: PublicKey;
  treasuryDestination: PublicKey;
  buyback: PoolBuyback;
  domainSeparator: Uint8Array;
  domainVersion: number;
}) {
  const message = poolBuybackMessage({
    domainSeparator: params.domainSeparator,
    domainVersion: params.domainVersion,
    config: params.config,
    pool: params.pool,
    market: params.market,
    position: params.position,
    buyer: params.buyer.publicKey,
    quoteAuthority: params.quoteAuthority.publicKey,
    buyback: params.buyback,
  });
  const signatureInstruction = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: params.quoteAuthority.secretKey,
    message,
  });
  const closeInstruction = await params.buyerProgram.methods
    .closePoolPosition(toAnchorPoolBuyback(params.buyback))
    .accountsStrict({
      buyer: params.buyer.publicKey,
      config: params.config,
      pool: params.pool,
      market: params.market,
      oracle: params.oracle,
      position: params.position,
      positionVault: params.positionVault,
      settlementMint: params.settlementMint,
      buyerDestination: params.buyerDestination,
      poolToken: params.poolToken,
      treasuryDestination: params.treasuryDestination,
      rentRecipient: params.buyer.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return new Transaction().add(signatureInstruction, closeInstruction);
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

// Matches only the transient, network-level failure shapes actually observed
// against the public devnet RPC: a stale blockhash by send time, 429 rate
// limiting, and dropped connections (surfaced either directly or as a fetch
// failure's cause). Deliberately narrow -- an AnchorError or other custom
// program error (a real protocol failure) never matches any of these and so
// is never retried; it must surface on the first attempt, unchanged.
const TRANSIENT_RPC_ERROR_PATTERNS = [
  /blockhash not found/i,
  /\b429\b/,
  /too many requests/i,
  /ECONNRESET/i,
  /fetch failed/i,
];

// Error `cause` chains (e.g. `TypeError: fetch failed` wrapping the
// underlying `Error: read ECONNRESET`) are where the network-level detail
// actually lives, so match against the whole chain rather than just the
// outermost message.
function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join(" | ");
}

function isTransientRpcError(error: unknown): boolean {
  const description = describeErrorChain(error);
  return TRANSIENT_RPC_ERROR_PATTERNS.some((pattern) => pattern.test(description));
}

// Bounded-retry wrapper around sendAndConfirmTransaction for the smoke
// lifecycle, which runs several minutes of real-time transactions against a
// cluster that has, in practice, 429'd and dropped connections mid-run.
// connection.sendTransaction (called internally by sendAndConfirmTransaction)
// already fetches a fresh blockhash and re-signs on every invocation, so
// simply calling it again is sufficient to recover from an expired
// blockhash -- no manual blockhash/signature surgery is needed here. Retries
// ONLY on isTransientRpcError; any other failure (in particular a program
// error) is rethrown immediately and unchanged on the first attempt. This is
// not a blanket try/catch -- it exists to survive network flake, not to hide
// protocol bugs.
async function sendAndConfirmWithRetry(
  transaction: Transaction,
  signers: Keypair[],
  label: string,
  maxAttempts = 4,
): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendAndConfirmTransaction(connection, transaction, signers, { commitment });
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientRpcError(error)) throw error;
      const backoffMs = Math.min(500 * 2 ** (attempt - 1), 8_000);
      console.warn(
        `  ${label}: transient RPC error on attempt ${attempt}/${maxAttempts} (${describeErrorChain(error)}), retrying in ${backoffMs}ms`,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, backoffMs));
    }
  }
  // Unreachable: the final iteration (attempt === maxAttempts) always
  // returns or throws inside the loop body above.
  throw new Error(`${label}: exhausted retries without a terminal result`);
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

  // The conditional-token strike is a listed ladder rung, not something
  // re-derived per rung on every pass -- see STRIKE_LADDER_STEP/ladderStrike's
  // doc comment in ../sdk/index.ts. Fetch spot ONCE for this whole bootstrap
  // pass and reuse the one resulting strike for all five rolling rungs, so a
  // single catalog snapshot never straddles two different ladder rungs for
  // what is meant to be one coherent listing moment. Reuses the existing
  // pythUpdateAtOrAfter plumbing (below) with expiry=0, which is trivially
  // satisfied by the very first Hermes response -- i.e. "whatever Hermes has
  // right now", the same semantics fetchLatestPythUpdate gives the cranker
  // and keeper.
  const { parsed: rollingSpotUpdate } = await pythUpdateAtOrAfter(pythFeedId, 0);
  const rollingSpot = pythPriceToScaledAtoms(
    BigInt(rollingSpotUpdate.price.price),
    rollingSpotUpdate.price.expo,
    PRICE_SCALE,
  );
  const rollingStrike = ladderStrike(rollingSpot);
  console.log(`Rolling NVDA catalog strike: ${rollingStrike.toString()} (spot ${rollingSpot.toString()} at PRICE_SCALE)`);

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
      maxSettlementStalenessSeconds: MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
      pythFeedId: pythFeedBytes,
      strike: rollingStrike,
    });
    catalog.push({
      code: series.code,
      address: created.market.toBase58(),
      oracle: created.oracle.toBase58(),
      expiry: series.expiry,
      observationWindowSeconds: USER_MARKET_OBSERVATION_SECONDS,
      settlementGraceSeconds: USER_MARKET_SETTLEMENT_GRACE_SECONDS,
      maxSettlementStalenessSeconds: MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
      lastTradeAt: series.lastTradeAt,
      creator: creator.publicKey.toBase58(),
      strike: rollingStrike.toString(),
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
    label: `${cluster}:tUSDC:main-v6`,
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

  // --- Phase 1: the real deployment is done. Write the manifest now. ---
  // Everything above this point (config, mints, the rolling market catalog,
  // the main liquidity pool) is idempotent and is already live on chain by
  // the time this runs. Everything below is an adversarial smoke-test
  // lifecycle -- a test suite, not a deployment step. A transient RPC
  // failure anywhere in that test suite must never cost us the record of
  // what was just deployed, so the manifest is written here, before the
  // suite starts, and rewritten (not appended) once it finishes.
  const deploymentArtifacts: DeploymentArtifacts = {
    cluster,
    rpcUrl: cluster === "devnet" ? "https://api.devnet.solana.com" : rpcUrl,
    programId: VSOL_PROGRAM_ID.toBase58(),
    pythUpgradeDeployed: true,
    closePoolPositionDeployed: true,
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
      maxSettlementStalenessSeconds: series.maxSettlementStalenessSeconds,
      lastTradeAt: series.lastTradeAt,
      creator: creator.publicKey.toBase58(),
      strike: series.strike,
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
  };
  await writeDeploymentManifest(
    {
      ...deploymentArtifacts,
      smokeStatus: skipSmoke ? "skipped" : "not-run",
      smoke: {},
      generatedAt: new Date().toISOString(),
    },
    "phase 1: deployment artifacts, before the smoke lifecycle",
  );

  if (skipSmoke) {
    console.log(
      "VSOL_SKIP_SMOKE=1: skipping the adversarial smoke lifecycle. "
      + "The manifest above is a real, usable deployment record but carries no smoke verification (smokeStatus: \"skipped\").",
    );
    return;
  }

  const smokeExpiry = (await clusterUnixTime()) + (cluster === "localnet" ? 30 : 75);
  const runId = `${Date.now()}`;
  // Staleness must respect the program's MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO
  // (create_market): max_staleness <= (observation_window + settlement_grace) * 100.
  // The smoke markets deliberately use tiny windows so the adversarial lifecycle
  // runs in seconds rather than 15 minutes, so the 24h production staleness would
  // exceed the ratio by 1.2x and 43x respectively and be rejected. Scale it to the
  // window instead of pinning it — these markets never need a long last-known-price
  // fallback, they expire within the run.
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
    // (120 + 600) * 10 — well inside the ratio bound. See the note above.
    maxSettlementStalenessSeconds: 7_200,
    pythFeedId: smokePythFeedBytes,
    strike: SMOKE_MARKET_STRIKE,
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
    // (5 + 15) * 10 — well inside the ratio bound. See the note above.
    maxSettlementStalenessSeconds: 200,
    pythFeedId: smokePythFeedBytes,
    strike: SMOKE_MARKET_STRIKE,
  });

  const smokePool = await ensureLiquidityPool({
    creatorProgram,
    creator,
    config,
    settlementMint,
    quoteAuthority: maker.publicKey,
    label: `${cluster}:smoke-v6:${runId}`,
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
  const successFillSignature = await sendAndConfirmWithRetry(successFill.transaction, [buyer], "success fill");
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
  const refundFillSignature = await sendAndConfirmWithRetry(refundFill.transaction, [buyer], "refund fill");

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
  const poolSuccessFillSignature = await sendAndConfirmWithRetry(poolSuccessFill.transaction, [buyer], "pool success fill");
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
  const poolRefundFillSignature = await sendAndConfirmWithRetry(poolRefundFill.transaction, [buyer], "pool refund fill");

  // These two replay checks are deliberately NOT sendAndConfirmWithRetry:
  // the whole point is that the program itself rejects the resend (a
  // consumed nonce), so retrying on failure would retry the very outcome
  // the assertion below requires.
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

  // --- Early-close (buyback) smoke lifecycle ---
  // Runs on its own market so it cannot disturb the settle/refund lifecycles
  // above: a pool position is opened and then bought back by the pool's own
  // quote authority before the market expires, proving `close_pool_position`
  // (an Ed25519-authenticated one-shot buyback quote, domain VSOLCLS1) works
  // end-to-end against a live cluster.
  const closeExpiry = (await clusterUnixTime()) + (cluster === "localnet" ? 90 : 300);
  const closeMarket = await createMarket({
    creatorProgram,
    creator,
    config,
    settlementMint,
    underlyingMint,
    symbol: "VSOL-TEST",
    expiry: closeExpiry,
    observationWindowSeconds: 120,
    settlementGraceSeconds: 600,
    // (120 + 600) * 10 — well inside the ratio bound. See the note above.
    maxSettlementStalenessSeconds: 7_200,
    pythFeedId: smokePythFeedBytes,
    strike: SMOKE_MARKET_STRIKE,
  });
  const closePoolMarket = await authorizePoolMarket({
    managerProgram: creatorProgram,
    manager: creator,
    config,
    pool: smokePool.pool,
    market: closeMarket.market,
    lastTradeAt: closeExpiry - 10,
  });
  // Top up the smoke pool so it can lock collateral for this quote without
  // touching the balance the settle/refund conservation check above already
  // verified.
  const closeDeposit = 5_000n * 1_000_000n;
  const poolBeforeCloseDeposit = await adminProgram.account.liquidityPool.fetch(smokePool.pool);
  const poolAssetsBeforeCloseDeposit = (await getAccount(connection, smokePool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount;
  const closeMinShares = calculateDepositShares(
    closeDeposit,
    BigInt(poolBeforeCloseDeposit.totalShares.toString()),
    poolAssetsBeforeCloseDeposit,
  );
  await makerProgram.methods
    .depositLiquidity(
      new BN(closeDeposit.toString()),
      new BN(closeMinShares.toString()),
      new BN((await clusterUnixTime()) + 600),
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

  // Pre-fill obligations: the position we are about to open and then close
  // early must leave the pool's locked collateral and open-position count
  // exactly where they started.
  const poolBeforeCloseFill = await adminProgram.account.liquidityPool.fetch(smokePool.pool);
  const lockedCollateralBeforeCloseFill = poolBeforeCloseFill.lockedCollateral;
  const openPositionsBeforeCloseFill = poolBeforeCloseFill.openPositions;

  const closeQuote: PoolQuote = {
    nonce: successQuote.nonce + 30n,
    direction: 0,
    strike: 100n * PRICE_SCALE,
    width: 10n * PRICE_SCALE,
    premium: 500n * 1_000_000n,
    maxPayout: 5_000n * 1_000_000n,
    quoteExpiry: BigInt(closeExpiry - 10),
  };
  const closeFill = await buildPoolFill({
    buyerProgram,
    buyer,
    buyerSource: buyerToken,
    quoteAuthority: maker,
    config,
    pool: smokePool.pool,
    poolMarket: closePoolMarket,
    poolToken: smokePool.poolToken,
    market: closeMarket.market,
    settlementMint,
    quote: closeQuote,
    domainSeparator,
    domainVersion,
  });
  const closeFillSignature = await sendAndConfirmWithRetry(closeFill.transaction, [buyer], "early-close fill");

  // Pre-close balances: the baseline the buyback's token movements are
  // measured against.
  const preCloseBuyerBalance = (await getAccount(connection, buyerToken, commitment, TOKEN_PROGRAM_ID)).amount;
  const preClosePoolVaultBalance = (await getAccount(connection, smokePool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount;
  const preCloseTreasuryBalance = (await getAccount(connection, treasuryToken, commitment, TOKEN_PROGRAM_ID)).amount;

  // Roughly the premium: strictly less than max_payout, and non-zero.
  const closeBuybackAmount = closeQuote.premium;
  const closeBuyback: PoolBuyback = {
    buybackAmount: closeBuybackAmount,
    minProceeds: closeBuybackAmount,
    quoteExpiry: BigInt((await clusterUnixTime()) + 30),
  };
  const closeTransaction = await buildPoolClose({
    buyerProgram,
    buyer,
    buyerDestination: buyerToken,
    quoteAuthority: maker,
    config,
    pool: smokePool.pool,
    market: closeMarket.market,
    oracle: closeMarket.oracle,
    position: closeFill.position,
    positionVault: closeFill.positionVault,
    settlementMint,
    poolToken: smokePool.poolToken,
    treasuryDestination: treasuryToken,
    buyback: closeBuyback,
    domainSeparator,
    domainVersion,
  });
  const closeEarlySignature = await sendAndConfirmWithRetry(closeTransaction, [buyer], "early-close buyback");

  if (await accountExists(closeFill.position)) throw new Error("Early-closed pool position account did not close");
  if (await accountExists(closeFill.positionVault)) throw new Error("Early-closed pool position vault did not close");

  const closeFee = (closeQuote.premium * feeBps + 9_999n) / 10_000n;
  const postCloseBuyerBalance = (await getAccount(connection, buyerToken, commitment, TOKEN_PROGRAM_ID)).amount;
  const postClosePoolVaultBalance = (await getAccount(connection, smokePool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount;
  const postCloseTreasuryBalance = (await getAccount(connection, treasuryToken, commitment, TOKEN_PROGRAM_ID)).amount;

  const buyerDelta = postCloseBuyerBalance - preCloseBuyerBalance;
  if (buyerDelta !== closeBuybackAmount) {
    throw new Error(`Early close did not pay the buyer the buyback amount: expected ${closeBuybackAmount}, received ${buyerDelta}`);
  }
  const treasuryDelta = postCloseTreasuryBalance - preCloseTreasuryBalance;
  if (treasuryDelta !== closeFee) {
    throw new Error(`Early close did not charge the expected fee: expected ${closeFee}, received ${treasuryDelta}`);
  }
  const expectedPoolVaultDelta = closeQuote.maxPayout + closeQuote.premium - closeBuybackAmount - closeFee;
  const poolVaultDelta = postClosePoolVaultBalance - preClosePoolVaultBalance;
  if (poolVaultDelta !== expectedPoolVaultDelta) {
    throw new Error(`Early close did not return the residual to the pool: expected ${expectedPoolVaultDelta}, received ${poolVaultDelta}`);
  }
  const poolAfterCloseFill = await adminProgram.account.liquidityPool.fetch(smokePool.pool);
  if (
    !poolAfterCloseFill.lockedCollateral.eq(lockedCollateralBeforeCloseFill)
    || !poolAfterCloseFill.openPositions.eq(openPositionsBeforeCloseFill)
  ) {
    throw new Error("Pool locked collateral / open positions did not return to their pre-fill values after early close");
  }
  const closeTotalMovement = buyerDelta + treasuryDelta + poolVaultDelta;
  const closeExpectedTotalMovement = closeQuote.maxPayout + closeQuote.premium;
  if (closeTotalMovement !== closeExpectedTotalMovement) {
    throw new Error(
      `Early close did not conserve max_payout + premium: expected ${closeExpectedTotalMovement}, moved ${closeTotalMovement}`,
    );
  }
  const closeEarlyPositionClosed = !(await accountExists(closeFill.position)) && !(await accountExists(closeFill.positionVault));
  const closeEarlyConservationVerified = closeTotalMovement === closeExpectedTotalMovement;

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
  // The pool cannot drain to exactly zero any more, and that is deliberate.
  // calculate_deposit_shares / calculate_withdraw_amount carry a virtual +1
  // offset on both shares and assets (OpenZeppelin ERC-4626 style), so a full
  // withdrawal rounds down and leaves a few base units behind. That residue is
  // exactly what makes the first-depositor inflation attack unprofitable — an
  // attacker who deposits 1 unit and donates a large amount can no longer
  // recover more than they put in. Asserting == 0n here would be asserting the
  // absence of that protection.
  //
  // So bound the dust instead of demanding zero: it must be small and
  // non-increasing in the pool's size, never a material fraction of deposits.
  const poolDust = (await getAccount(connection, smokePool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount;
  const MAX_POOL_DUST = 1_000n; // base units (tUSDC has 6 decimals => <= 0.001 tUSDC)
  if (poolDust > MAX_POOL_DUST) {
    throw new Error(
      `Pool withdrawal left ${poolDust} base units behind, above the ${MAX_POOL_DUST} rounding-dust bound — ` +
        "that is real value stranded, not the virtual-offset residue.",
    );
  }
  console.log(`  pool residue after full withdrawal: ${poolDust} base units (virtual-offset dust, bound ${MAX_POOL_DUST})`);

  // --- Phase 2: the smoke lifecycle passed. Rewrite the manifest with the
  // evidence filled in. deploymentArtifacts (built in phase 1, above) is
  // reused as-is -- it has not changed, since nothing below phase 1 touches
  // the deployment artifacts themselves.
  const deployment: Deployment = {
    ...deploymentArtifacts,
    smokeStatus: "passed",
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
      // "Cleared" now means "drained to within the virtual-offset rounding
      // dust", not "exactly zero" — a full withdrawal deliberately strands a
      // few base units, which is what makes the first-depositor inflation
      // attack unprofitable. Bound must match verify-deployment.ts.
      poolWithdrawalCleared:
        (await getAccount(connection, smokePool.poolToken, commitment, TOKEN_PROGRAM_ID)).amount <= MAX_POOL_DUST,
      closeEarlyFillSignature: closeFillSignature,
      closeEarlySignature,
      closeEarlyPosition: closeFill.position.toBase58(),
      closeEarlyBuybackAmount: closeBuybackAmount.toString(),
      closeEarlyPositionClosed,
      closeEarlyConservationVerified,
    },
    generatedAt: new Date().toISOString(),
  };
  await writeDeploymentManifest(deployment, "phase 2: smoke lifecycle complete");
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
