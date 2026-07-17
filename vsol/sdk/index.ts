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
export const QUOTE_DOMAIN = Buffer.from("VSOLRFQ1", "ascii");
export const PRICE_SCALE = 1_000_000n;

export type Quote = {
  nonce: bigint;
  direction: 0 | 1;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
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

export function calculatePayout(quote: Pick<Quote, "direction" | "strike" | "width" | "maxPayout">, price: bigint): bigint {
  if (quote.width <= 0n || quote.maxPayout <= 0n) throw new RangeError("invalid payout parameters");
  const rawDelta = quote.direction === 0 ? price - quote.strike : quote.strike - price;
  const delta = rawDelta <= 0n ? 0n : rawDelta >= quote.width ? quote.width : rawDelta;
  return (quote.maxPayout * delta) / quote.width;
}
