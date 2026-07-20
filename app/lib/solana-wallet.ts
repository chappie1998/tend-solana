"use client";

import { Transaction } from "@solana/web3.js";
import type { SolanaWalletProvider } from "./vsol";

export function injectedSolanaWallet() {
  const target = window as typeof window & {
    phantom?: { solana?: SolanaWalletProvider };
    solana?: SolanaWalletProvider;
  };
  return target.phantom?.solana ?? target.solana;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function signSerializedSolanaTransaction(encoded: string, provider = injectedSolanaWallet()) {
  if (!provider) throw new Error("Solana wallet unavailable");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const transaction = Transaction.from(bytes);
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
