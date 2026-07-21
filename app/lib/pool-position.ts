// PoolPosition account decoding. Kept free of JSON/module side effects so the
// node:test suite can decode fixture buffers with the exact production code.
// Layout mirrors `PoolPosition` in vsol/target/types/vsol.ts:
//   8  discriminator
//   8  bump (u8), 9 vault_bump (u8), 10 status (u8), 11 direction (u8)
//   12 pool, 44 market, 76 nonce_record, 108 buyer, 140 quote_authority,
//   172 settlement_mint (pubkeys)
//   204 nonce (u64), 212 strike (u64), 220 width (u64), 228 premium (u64),
//   236 max_payout (u64), 244 fee_bps (u16), 246 opened_at (i64),
//   254 quote_expiry (i64) => 262 bytes total.

import { PublicKey } from "@solana/web3.js";

export const POOL_POSITION_ACCOUNT_SIZE = 262;
export const POOL_POSITION_BUYER_OFFSET = 108;
// sha256("account:PoolPosition")[0..8]; asserted against the published IDL in tests/web3-auth.test.mjs.
export const POOL_POSITION_DISCRIMINATOR = Object.freeze([246, 13, 238, 156, 119, 129, 253, 135]);
// The program's PositionStatus enum has a single variant: Open = 1. Settled or
// refunded positions close their accounts, so they never appear on-chain.
export const POOL_POSITION_STATUS_OPEN = 1;

export type DecodedPoolPosition = {
  status: number;
  direction: "up" | "down";
  pool: PublicKey;
  market: PublicKey;
  nonceRecord: PublicKey;
  buyer: PublicKey;
  quoteAuthority: PublicKey;
  settlementMint: PublicKey;
  nonce: bigint;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  feeBps: number;
  openedAt: number;
  quoteExpiry: number;
};

function publicKeyAt(data: Buffer, offset: number) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

export function decodePoolPositionAccount(data: Buffer): DecodedPoolPosition {
  if (data.length !== POOL_POSITION_ACCOUNT_SIZE) {
    throw new Error("The pool position account size is invalid");
  }
  if (!data.subarray(0, 8).equals(Buffer.from(POOL_POSITION_DISCRIMINATOR))) {
    throw new Error("The pool position account discriminator is invalid");
  }
  const direction = data[11];
  if (direction !== 0 && direction !== 1) throw new Error("The pool position direction is invalid");
  return {
    status: data[10],
    direction: direction === 0 ? "up" : "down",
    pool: publicKeyAt(data, 12),
    market: publicKeyAt(data, 44),
    nonceRecord: publicKeyAt(data, 76),
    buyer: publicKeyAt(data, POOL_POSITION_BUYER_OFFSET),
    quoteAuthority: publicKeyAt(data, 140),
    settlementMint: publicKeyAt(data, 172),
    nonce: data.readBigUInt64LE(204),
    strike: data.readBigUInt64LE(212),
    width: data.readBigUInt64LE(220),
    premium: data.readBigUInt64LE(228),
    maxPayout: data.readBigUInt64LE(236),
    feeBps: data.readUInt16LE(244),
    openedAt: Number(data.readBigInt64LE(246)),
    quoteExpiry: Number(data.readBigInt64LE(254)),
  };
}

/** Decimal precision for a market's price scale (e.g. 1_000_000n -> 6). Every
 * published market uses a power-of-ten scale; anything else renders
 * conservatively at 6 decimals rather than inventing a conversion. */
export function priceScaleDecimals(priceScale: bigint) {
  const text = priceScale.toString();
  return /^10*$/.test(text) ? text.length - 1 : 6;
}

/** Formats a 6-decimal atom amount as a display decimal string (no float math). */
export function formatAtomsDecimal(value: bigint, decimals = 6, maximumFractionDigits = 2) {
  if (value < 0n || decimals < 0) throw new RangeError("Invalid atom amount");
  const raw = value.toString().padStart(decimals + 1, "0");
  const integer = raw.slice(0, raw.length - decimals);
  const fraction = raw.slice(raw.length - decimals).slice(0, maximumFractionDigits).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}
