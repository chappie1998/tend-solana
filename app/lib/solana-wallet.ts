"use client";

import { Transaction, VersionedTransaction } from "@solana/web3.js";
import type { SolanaWalletProvider } from "./vsol";

// Wallet connection and signing now go through Privy (see
// app/lib/wallet-bridge.tsx and app/providers.tsx) instead of the hand-rolled
// injected-wallet detection this file used to own. What survives here is the
// base64/transaction plumbing that both the bridge and the pre-Privy test
// suite (tests/vsol-versioned-fill.test.mjs, tests/product.test.mjs) still
// depend on.

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

/**
 * Deserializes base64 transaction bytes as either a legacy Transaction or a
 * v0 VersionedTransaction (every Solana wallet this app supports -- Privy's
 * embedded wallet and every external wallet its modal connects -- can sign
 * both). VersionedTransaction.deserialize understands both wire formats (it
 * reads the version prefix inside the message itself), so this is a cheap,
 * side-effect-free probe: try it first, and fall back to the plain legacy
 * parser only if that probe throws.
 */
export function deserializeSolanaTransaction(bytes: Uint8Array): Transaction | VersionedTransaction {
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    if (versioned.message.version !== "legacy") return versioned;
  } catch {
    // Fall through to the legacy parser below.
  }
  return Transaction.from(bytes);
}

/**
 * Signs a base64-encoded transaction with the given wallet provider and
 * returns the signed transaction, also base64-encoded. Kept for
 * tests/vsol-versioned-fill.test.mjs's direct legacy/v0 round-trip coverage;
 * app code signs through app/lib/wallet-bridge.tsx's signTransactionBase64
 * instead, which talks to Privy directly rather than this provider shape.
 */
export async function signSerializedSolanaTransaction(encoded: string, provider: SolanaWalletProvider) {
  if (!provider) throw new Error("Solana wallet unavailable");
  const bytes = base64ToBytes(encoded);
  const transaction = deserializeSolanaTransaction(bytes);
  const signed = await provider.signTransaction(transaction);
  return bytesToBase64(signed.serialize());
}

/**
 * Signs a plain-text message with the given wallet provider and returns the
 * ed25519 signature as base64. Returns null when the wallet does not
 * implement `signMessage` so callers can degrade gracefully. Kept for
 * app/lib/session-client.ts's default `signMessage` behaviour and its test
 * coverage; app code signs through app/lib/wallet-bridge.tsx's
 * signMessageBase64 instead.
 */
export async function signSolanaMessage(message: string, provider: SolanaWalletProvider) {
  if (!provider?.signMessage) return null;
  const result = await provider.signMessage(new TextEncoder().encode(message), "utf8");
  const signature = result instanceof Uint8Array ? result : result?.signature;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error("The wallet returned an invalid message signature.");
  }
  return bytesToBase64(signature);
}
