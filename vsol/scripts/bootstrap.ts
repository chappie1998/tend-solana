import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
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
  deriveMarket,
  deriveNonce,
  deriveOracle,
  derivePosition,
  derivePositionVault,
  deriveWriterToken,
  deriveWriterVault,
  marketId,
  PRICE_SCALE,
  quoteMessage,
  symbolBytes,
  toAnchorQuote,
  type Quote,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");
const deploymentPath = resolve(workspace, "deployments", `${cluster}.json`);
const walletPath = process.env.SOLANA_WALLET?.replace(/^~/, homedir()) ?? resolve(homedir(), ".config/solana/id.json");

type Deployment = {
  cluster: string;
  rpcUrl: string;
  programId: string;
  config: string;
  admin: string;
  maker: string;
  buyer: string;
  settlementMint: string;
  underlyingMint: string;
  writerVault: string;
  writerToken: string;
  uiMarket: string;
  uiOracle: string;
  uiExpiry: number;
  smoke: Record<string, string | number | boolean>;
  generatedAt: string;
};

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
  const provider = new AnchorProvider(connection, new Wallet(signer), { commitment, preflightCommitment: commitment });
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

async function ensureTokenBalance(admin: Keypair, mint: PublicKey, owner: PublicKey, minimum: bigint) {
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    mint,
    owner,
    false,
    commitment,
    { commitment },
    TOKEN_PROGRAM_ID,
  );
  const current = (await getAccount(connection, account.address, commitment, TOKEN_PROGRAM_ID)).amount;
  if (current < minimum) {
    await mintTo(connection, admin, mint, account.address, admin, minimum - current, [], { commitment }, TOKEN_PROGRAM_ID);
  }
  return account.address;
}

async function createMarket(params: {
  adminProgram: Program<Vsol>;
  admin: Keypair;
  config: PublicKey;
  settlementMint: PublicKey;
  underlyingMint: PublicKey;
  label: string;
  symbol: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
}) {
  const id = marketId(params.label);
  const market = deriveMarket(params.config, id);
  const oracle = deriveOracle(market);
  if (!(await accountExists(market))) {
    await params.adminProgram.methods
      .createMarket({
        marketId: [...id],
        underlyingMint: params.underlyingMint,
        symbol: symbolBytes(params.symbol),
        priceScale: new BN(PRICE_SCALE.toString()),
        expiry: new BN(params.expiry),
        observationWindowSeconds: params.observationWindowSeconds,
        settlementGraceSeconds: params.settlementGraceSeconds,
        maxConfidenceBps: 500,
      })
      .accountsStrict({
        admin: params.admin.publicKey,
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

async function main(): Promise<void> {
  console.log(`VSOL bootstrap on ${cluster}: ${rpcUrl}`);
  const admin = await loadKeypair(walletPath);
  const maker = await loadOrCreateKeypair(`${cluster}-maker`);
  const buyer = await loadOrCreateKeypair(`${cluster}-buyer`);
  const settlementMintKeypair = await loadOrCreateKeypair(`${cluster}-mock-usdc-mint`);
  const underlyingMintKeypair = await loadOrCreateKeypair(`${cluster}-mock-rwa-mint`);
  await ensureAdminFunds(admin);
  await ensureSignerFunds(admin, maker);
  await ensureSignerFunds(admin, buyer);

  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);

  const adminProgram = programFor(admin);
  const makerProgram = programFor(maker);
  const buyerProgram = programFor(buyer);
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
  const makerToken = await ensureTokenBalance(admin, settlementMint, maker.publicKey, 100_000n * 1_000_000n);
  const buyerToken = await ensureTokenBalance(admin, settlementMint, buyer.publicKey, 100_000n * 1_000_000n);
  const treasuryToken = await ensureTokenBalance(admin, settlementMint, admin.publicKey, 0n);

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
  const uiExpiry = now + 86_400;
  const ui = await createMarket({
    adminProgram,
    admin,
    config,
    settlementMint,
    underlyingMint,
    label: `${cluster}:VSOL-RWA:1D:${Math.floor(now / 3_600)}`,
    symbol: "VSOL-RWA",
    expiry: uiExpiry,
    observationWindowSeconds: 300,
    settlementGraceSeconds: 3_600,
  });

  const smokeExpiry = (await clusterUnixTime()) + (cluster === "localnet" ? 30 : 75);
  const runId = `${Date.now()}`;
  const successMarket = await createMarket({
    adminProgram,
    admin,
    config,
    settlementMint,
    underlyingMint,
    label: `${cluster}:success:${runId}`,
    symbol: "VSOL-TEST",
    expiry: smokeExpiry,
    observationWindowSeconds: 5,
    settlementGraceSeconds: 15,
  });
  const refundMarket = await createMarket({
    adminProgram,
    admin,
    config,
    settlementMint,
    underlyingMint,
    label: `${cluster}:refund:${runId}`,
    symbol: "VSOL-TEST",
    expiry: smokeExpiry,
    observationWindowSeconds: 5,
    settlementGraceSeconds: 15,
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

  let replayRejected = false;
  try {
    await sendAndConfirmTransaction(connection, successFill.transaction, [buyer], { commitment });
  } catch {
    replayRejected = true;
  }
  if (!replayRejected) throw new Error("A filled maker nonce was replayable");

  await waitUntil(smokeExpiry, "Waiting for settlement observation");
  // Use the market boundary itself as the observation timestamp. Client wall clocks can
  // run slightly ahead of validator Clock and must never be trusted as oracle time.
  const observedAt = smokeExpiry;
  const settlementPrice = 105n * PRICE_SCALE;
  const publishSignature = await adminProgram.methods
    .publishSettlement(new BN(settlementPrice.toString()), new BN((100_000n).toString()), new BN(observedAt))
    .accountsStrict({ oracleAuthority: admin.publicKey, config, market: successMarket.market, oracle: successMarket.oracle })
    .rpc();

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

  const deployment: Deployment = {
    cluster,
    rpcUrl,
    programId: VSOL_PROGRAM_ID.toBase58(),
    config: config.toBase58(),
    admin: admin.publicKey.toBase58(),
    maker: maker.publicKey.toBase58(),
    buyer: buyer.publicKey.toBase58(),
    settlementMint: settlementMint.toBase58(),
    underlyingMint: underlyingMint.toBase58(),
    writerVault: writerVault.toBase58(),
    writerToken: writerToken.toBase58(),
    uiMarket: ui.market.toBase58(),
    uiOracle: ui.oracle.toBase58(),
    uiExpiry,
    smoke: {
      successFillSignature,
      refundFillSignature,
      publishSignature,
      settleSignature,
      refundSignature,
      replayRejected,
      successPositionClosed: !(await accountExists(successFill.position)),
      refundPositionClosed: !(await accountExists(refundFill.position)),
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
