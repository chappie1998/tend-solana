import {
  getAccount,
  getAssociatedTokenAddressSync,
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
import {
  VSOL_CONFIG,
  VSOL_MAKER,
  VSOL_MARKET,
  VSOL_PYTH_UPGRADE_DEPLOYED,
  VSOL_PROGRAM_ID,
  VSOL_RPC_URL,
  VSOL_SETTLEMENT_MINT,
  VSOL_WRITER_TOKEN,
  VSOL_WRITER_VAULT,
} from "./vsol";
import { runtimeEnv } from "./runtime-env";

export function getVsolConnection() {
  // Resolve this after the request route has installed Cloudflare bindings.
  // A module-level Connection captures the fallback RPC before Sites runtime
  // environment variables are available.
  return new Connection(runtimeEnv("VSOL_RPC_URL") || VSOL_RPC_URL, "confirmed");
}
const TOKEN_SCALE = 1_000_000n;
const PRICE_SCALE = 1_000_000n;
const QUOTE_DOMAIN = Buffer.from("VSOLRFQ1", "ascii");
const NONCE_SEED = Buffer.from("nonce");
const POSITION_SEED = Buffer.from("position");
const POSITION_VAULT_SEED = Buffer.from("position-vault");
const FILL_QUOTE_DISCRIMINATOR = Buffer.from([12, 116, 225, 132, 142, 74, 167, 253]);

type Quote = {
  nonce: bigint;
  direction: 0 | 1;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  quoteExpiry: bigint;
};

function encodeU64(value: bigint) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function encodeI64(value: bigint) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(value);
  return buffer;
}

function encodeU16(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function deriveNonce(config: PublicKey, maker: PublicKey, nonce: bigint) {
  return PublicKey.findProgramAddressSync([NONCE_SEED, config.toBuffer(), maker.toBuffer(), encodeU64(nonce)], VSOL_PROGRAM_ID)[0];
}

function derivePosition(nonce: PublicKey) {
  return PublicKey.findProgramAddressSync([POSITION_SEED, nonce.toBuffer()], VSOL_PROGRAM_ID)[0];
}

function derivePositionVault(position: PublicKey) {
  return PublicKey.findProgramAddressSync([POSITION_VAULT_SEED, position.toBuffer()], VSOL_PROGRAM_ID)[0];
}

function quoteMessage(params: { buyer: PublicKey; maker: PublicKey; quote: Quote }) {
  return Buffer.concat([
    QUOTE_DOMAIN,
    Buffer.from(deployment.domainSeparator),
    encodeU16(deployment.domainVersion),
    VSOL_PROGRAM_ID.toBuffer(),
    VSOL_CONFIG.toBuffer(),
    VSOL_MARKET.toBuffer(),
    params.buyer.toBuffer(),
    params.maker.toBuffer(),
    encodeU64(params.quote.nonce),
    Buffer.from([params.quote.direction]),
    encodeU64(params.quote.strike),
    encodeU64(params.quote.width),
    encodeU64(params.quote.premium),
    encodeU64(params.quote.maxPayout),
    encodeI64(params.quote.quoteExpiry),
  ]);
}

function fillQuoteInstruction(params: {
  buyer: PublicKey;
  maker: PublicKey;
  buyerSource: PublicKey;
  nonceRecord: PublicKey;
  position: PublicKey;
  positionVault: PublicKey;
  quote: Quote;
}) {
  const data = Buffer.concat([
    FILL_QUOTE_DISCRIMINATOR,
    encodeU64(params.quote.nonce),
    Buffer.from([params.quote.direction]),
    encodeU64(params.quote.strike),
    encodeU64(params.quote.width),
    encodeU64(params.quote.premium),
    encodeU64(params.quote.maxPayout),
    encodeI64(params.quote.quoteExpiry),
  ]);
  return new TransactionInstruction({
    programId: VSOL_PROGRAM_ID,
    keys: [
      { pubkey: params.buyer, isSigner: true, isWritable: true },
      { pubkey: params.maker, isSigner: false, isWritable: false },
      { pubkey: VSOL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: VSOL_MARKET, isSigner: false, isWritable: false },
      { pubkey: VSOL_SETTLEMENT_MINT, isSigner: false, isWritable: false },
      { pubkey: VSOL_WRITER_VAULT, isSigner: false, isWritable: false },
      { pubkey: VSOL_WRITER_TOKEN, isSigner: false, isWritable: true },
      { pubkey: params.buyerSource, isSigner: false, isWritable: true },
      { pubkey: params.nonceRecord, isSigner: false, isWritable: true },
      { pubkey: params.position, isSigner: false, isWritable: true },
      { pubkey: params.positionVault, isSigner: false, isWritable: true },
      { pubkey: VSOL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
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

export function vsolMaker() {
  const maker = loadSecret("VSOL_MAKER_SECRET_KEY");
  if (!maker.publicKey.equals(VSOL_MAKER)) throw new Error("VSOL maker key does not match the deployed writer vault");
  return maker;
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

function randomNonce() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).readBigUInt64LE();
}

export async function buildVsolQuoteTransaction(params: {
  buyer: PublicKey;
  direction: "up" | "down";
  strike: number;
  cap: number;
  premium: number;
  maxPayout: number;
}) {
  if (!VSOL_PYTH_UPGRADE_DEPLOYED) {
    throw new Error("The Pyth-bound VSOL deployment has not passed devnet verification");
  }
  const connection = getVsolConnection();
  const maker = vsolMaker();
  const [configAccount, marketAccount, writerAccount] = await Promise.all([
    connection.getAccountInfo(VSOL_CONFIG, "confirmed"),
    connection.getAccountInfo(VSOL_MARKET, "confirmed"),
    getAccount(connection, VSOL_WRITER_TOKEN, "confirmed", TOKEN_PROGRAM_ID),
  ]);
  if (!configAccount || !marketAccount) throw new Error("VSOL devnet configuration is unavailable");

  const buyerSource = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, params.buyer);
  if (!(await connection.getAccountInfo(buyerSource, "confirmed"))) {
    const error = new Error("Claim devnet test USDC before requesting an executable quote");
    error.name = "VsolTestFundsRequired";
    throw error;
  }

  const now = await clusterTime(connection);
  const marketExpiry = BigInt(deployment.uiExpiry);
  const quoteExpiry = BigInt(Math.min(now + 30, Number(marketExpiry - 1n)));
  if (quoteExpiry <= BigInt(now + 5)) throw new Error("The current devnet market is too close to expiry");

  const maxPayout = BigInt(Math.round(params.maxPayout * Number(TOKEN_SCALE)));
  if (writerAccount.amount < maxPayout) throw new Error("The VSOL writer vault has insufficient devnet liquidity");
  const width = BigInt(Math.max(1, Math.round(Math.abs(params.cap - params.strike) * Number(PRICE_SCALE))));
  const quote: Quote = {
    nonce: randomNonce(),
    direction: params.direction === "up" ? 0 : 1,
    strike: BigInt(Math.round(params.strike * Number(PRICE_SCALE))),
    width,
    premium: BigInt(Math.max(1, Math.ceil(params.premium * Number(TOKEN_SCALE)))),
    maxPayout,
    quoteExpiry,
  };
  const nonceRecord = deriveNonce(VSOL_CONFIG, maker.publicKey, quote.nonce);
  const position = derivePosition(nonceRecord);
  const positionVault = derivePositionVault(position);
  const message = quoteMessage({ buyer: params.buyer, maker: maker.publicKey, quote });
  const makerSignature = nacl.sign.detached(message, maker.secretKey);
  const signatureInstruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: maker.publicKey.toBytes(),
    message,
    signature: makerSignature,
  });
  const fillInstruction = fillQuoteInstruction({
    buyer: params.buyer,
    maker: maker.publicKey,
    buyerSource,
    nonceRecord,
    position,
    positionVault,
    quote,
  });
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
    marketAddress: VSOL_MARKET.toBase58(),
  };
}

export async function verifyVsolFill(signature: string, buyer: PublicKey, position: PublicKey) {
  const connection = getVsolConnection();
  let result = null;
  for (let attempt = 0; attempt < 6 && !result; attempt += 1) {
    result = await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!result) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!result || result.meta?.err) return false;
  const keys = result.transaction.message.accountKeys;
  const buyerSigned = keys.some((key) => key.pubkey.equals(buyer) && key.signer);
  const invokesProgram = keys.some((key) => key.pubkey.equals(VSOL_PROGRAM_ID));
  const createsPosition = keys.some((key) => key.pubkey.equals(position));
  const fillLogged = result.meta?.logMessages?.some((line) => line.includes("Instruction: FillQuote")) ?? false;
  const positionAccount = await connection.getAccountInfo(position, "confirmed");
  const positionOwnedByVsol = positionAccount?.owner.equals(VSOL_PROGRAM_ID) ?? false;
  return buyerSigned && invokesProgram && createsPosition && fillLogged && positionOwnedByVsol;
}

export function isVsolFillTransaction(transaction: Transaction) {
  if (transaction.instructions.length !== 2) return false;
  const [signatureInstruction, fillInstruction] = transaction.instructions;
  return signatureInstruction.programId.equals(Ed25519Program.programId)
    && fillInstruction.programId.equals(VSOL_PROGRAM_ID)
    && Buffer.from(fillInstruction.data).subarray(0, FILL_QUOTE_DISCRIMINATOR.length).equals(FILL_QUOTE_DISCRIMINATOR);
}

export function inspectVsolFillTransaction(transaction: Transaction) {
  if (!isVsolFillTransaction(transaction)) return null;
  const fillInstruction = transaction.instructions[1];
  if (fillInstruction.keys.length < 10) return null;
  const buyer = fillInstruction.keys[0];
  const market = fillInstruction.keys[3];
  const position = fillInstruction.keys[9];
  if (!buyer.isSigner || !buyer.isWritable || !market.pubkey.equals(VSOL_MARKET) || !position.isWritable) return null;
  return { buyer: buyer.pubkey, market: market.pubkey, position: position.pubkey };
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
