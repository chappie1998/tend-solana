"use client";

import { Transaction, VersionedTransaction } from "@solana/web3.js";
import type { SolanaWalletProvider } from "./vsol";
// Explicit extension: this file is loaded directly by Node's native
// TypeScript loader in tests/vsol-versioned-fill.test.mjs, and plain Node ESM
// resolution (unlike Next.js's bundler) requires it for relative specifiers.
import { detectSolanaWallets } from "./solana-wallets.ts";

const ACTIVE_WALLET_STORAGE_KEY = "tend.wallet.id";

/**
 * Remembers which detected wallet the user picked, so every later signature
 * (a fresh page load, a different tab) resolves back to the same wallet
 * instead of whichever one happens to load first. `localStorage` throws in
 * some privacy modes, so every access here is defensive -- losing the
 * remembered id just means the next connect falls back to auto-detection.
 */
export function setActiveSolanaWalletId(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_WALLET_STORAGE_KEY);
    else window.localStorage.setItem(ACTIVE_WALLET_STORAGE_KEY, id);
  } catch {
    // Ignored -- see comment above.
  }
}

export function activeSolanaWalletId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_WALLET_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The provider every signature call defaults to. Prefers the wallet the user
 * actively chose (see setActiveSolanaWalletId); when that one is no longer
 * present, falls back to the single detected wallet if there's exactly one,
 * so a returning user with just one wallet extension never has to re-pick
 * it. With zero or multiple wallets and no active choice, there's no safe
 * default -- callers must have the user pick one first.
 */
export function injectedSolanaWallet(): SolanaWalletProvider | undefined {
  const detected = detectSolanaWallets();
  const activeId = activeSolanaWalletId();
  if (activeId) {
    const active = detected.find((wallet) => wallet.id === activeId);
    if (active) return active.provider;
  }
  return detected.length === 1 ? detected[0].provider : undefined;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Deserializes base64 transaction bytes as either a legacy Transaction or a
 * v0 VersionedTransaction (Phantom -- and every other injected wallet this
 * app supports -- can sign both). VersionedTransaction.deserialize
 * understands both wire formats (it reads the version prefix inside the
 * message itself), so this is a cheap, side-effect-free probe: try it first,
 * and fall back to the plain legacy parser only if that probe throws.
 */
function deserializeSolanaTransaction(bytes: Uint8Array): Transaction | VersionedTransaction {
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    if (versioned.message.version !== "legacy") return versioned;
  } catch {
    // Fall through to the legacy parser below.
  }
  return Transaction.from(bytes);
}

export async function signSerializedSolanaTransaction(encoded: string, provider = injectedSolanaWallet()) {
  if (!provider) throw new Error("Solana wallet unavailable");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const transaction = deserializeSolanaTransaction(bytes);
  const signed = await provider.signTransaction(transaction);
  return bytesToBase64(signed.serialize());
}

/**
 * Signs a plain-text message with the injected wallet and returns the
 * ed25519 signature as base64. Returns null when the wallet does not
 * implement `signMessage` so callers can degrade gracefully.
 */
export async function signSolanaMessage(message: string, provider = injectedSolanaWallet()) {
  if (!provider?.signMessage) return null;
  const result = await provider.signMessage(new TextEncoder().encode(message), "utf8");
  const signature = result instanceof Uint8Array ? result : result?.signature;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error("The wallet returned an invalid message signature.");
  }
  return bytesToBase64(signature);
}
