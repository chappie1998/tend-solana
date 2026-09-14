"use client";

// Client side of Sign-In-With-Solana: nonce → signMessage → verify. The
// server sets an HTTP-only session cookie on success; this module never
// touches the cookie directly.

import { buildSiwsMessage } from "./siws";

export type WalletSessionResult =
  | { status: "active"; wallet: string }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

export async function fetchSessionWallet(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) return null;
    const result = await response.json() as { wallet?: string | null };
    return typeof result.wallet === "string" ? result.wallet : null;
  } catch {
    return null;
  }
}

// The default when no signer is supplied: no wallet is available to sign, so
// this degrades exactly the way the pre-Privy signSolanaMessage did when it
// had no usable provider -- return null (unsupported), never throw. In
// practice every real call site (TendTerminal) always passes the wallet
// bridge's signMessageBase64 explicitly; this default only keeps the
// single-argument call shape working.
async function noWalletSignMessage(): Promise<string | null> {
  return null;
}

export async function establishWalletSession(
  walletAddress: string,
  signMessage: (message: string) => Promise<string | null> = noWalletSignMessage,
): Promise<WalletSessionResult> {
  const existing = await fetchSessionWallet();
  if (existing === walletAddress) return { status: "active", wallet: walletAddress };

  let nonceResult: { nonce?: string; issuedAt?: number; expiresAt?: number; domain?: string; error?: string };
  try {
    const response = await fetch("/api/auth/nonce", { method: "POST" });
    nonceResult = await response.json() as typeof nonceResult;
    if (!response.ok || !nonceResult.nonce || !nonceResult.issuedAt || !nonceResult.expiresAt) {
      return { status: "failed", reason: nonceResult.error ?? "The sign-in service is unavailable." };
    }
  } catch {
    return { status: "failed", reason: "The sign-in service is unreachable." };
  }

  const message = buildSiwsMessage({
    domain: window.location.host,
    walletAddress,
    nonce: nonceResult.nonce,
    issuedAtMs: nonceResult.issuedAt,
    expiresAtMs: nonceResult.expiresAt,
  });

  let signature: string | null;
  try {
    signature = await signMessage(message);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "The wallet did not sign the message." };
  }
  if (signature === null) {
    return {
      status: "unsupported",
      reason: "This wallet does not support message signing, so chain-derived portfolio and launch features stay unavailable. Trading and liquidity still work.",
    };
  }

  try {
    const response = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress, nonce: nonceResult.nonce, signature }),
    });
    const result = await response.json() as { wallet?: string; error?: string };
    if (!response.ok || result.wallet !== walletAddress) {
      return { status: "failed", reason: result.error ?? "Wallet sign-in verification failed." };
    }
    return { status: "active", wallet: walletAddress };
  } catch {
    return { status: "failed", reason: "Wallet sign-in verification is unreachable." };
  }
}

export async function endWalletSession() {
  try {
    await fetch("/api/auth/signout", { method: "POST" });
  } catch {
    // Cookie expiry still bounds the session.
  }
}
