"use client";

// Detects Solana wallet extensions without a wallet-adapter library.
//
// Why namespace probing + duck typing instead of a library:
// 1. Zero dependencies. This app adds no @solana/wallet-adapter or
//    wallet-standard package -- every namespace below is read directly off
//    `window` (or a fake object in tests).
// 2. Fail soft. A namespace can exist without matching the shape this app
//    needs (a stale extension version, something unrelated squatting the
//    name, a locked/uninitialised provider). Duck typing means a namespace
//    that doesn't look like a wallet is skipped silently here, rather than
//    surfacing as a wallet that then throws at connect or sign time.
//
// Detection order below only matters for one thing: which entry wins when
// the legacy `window.solana` global is the SAME object as a namespaced one.
// Phantom sets both `window.phantom.solana` and `window.solana` to the same
// provider, and the namespaced probes run before the legacy one, so Phantom
// is named "Phantom" once instead of appearing twice.

import type { SolanaWalletProvider } from "./vsol";

export type DetectedWallet = {
  id: string;
  name: string;
  provider: SolanaWalletProvider;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

/** Accepts a candidate only if it's a non-null object with function `connect` and `signTransaction` -- see the file header for why. */
function isWalletLike(candidate: unknown): candidate is SolanaWalletProvider {
  if (!isRecord(candidate)) return false;
  return typeof candidate.connect === "function" && typeof candidate.signTransaction === "function";
}

/** Reads `host[key]`, tolerating a `host` that isn't an object at all. */
function readNamespace(host: UnknownRecord, key: string): unknown {
  return host[key];
}

/** Reads a nested `<namespace>.solana`, tolerating any shape (or absence) at either level. */
function readNestedSolana(host: UnknownRecord, key: string): unknown {
  const namespace = readNamespace(host, key);
  return isRecord(namespace) ? namespace.solana : undefined;
}

type Probe = { id: string; name: string; read: (host: UnknownRecord) => unknown };

const PROBES: readonly Probe[] = [
  { id: "phantom", name: "Phantom", read: (host) => readNestedSolana(host, "phantom") },
  { id: "solflare", name: "Solflare", read: (host) => readNamespace(host, "solflare") },
  { id: "backpack", name: "Backpack", read: (host) => readNamespace(host, "backpack") },
  { id: "okx", name: "OKX Wallet", read: (host) => readNestedSolana(host, "okxwallet") },
  { id: "coinbase", name: "Coinbase Wallet", read: (host) => readNamespace(host, "coinbaseSolana") },
  { id: "trust", name: "Trust Wallet", read: (host) => readNestedSolana(host, "trustwallet") },
  { id: "glow", name: "Glow", read: (host) => readNamespace(host, "glow") ?? readNamespace(host, "glowSolana") },
  { id: "brave", name: "Brave Wallet", read: (host) => readNamespace(host, "braveSolana") },
];

// Order matters: the first matching flag names the legacy `window.solana`
// provider when it isn't already deduped by identity into one of the
// namespaced entries above.
const LEGACY_FLAG_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["isPhantom", "Phantom"],
  ["isSolflare", "Solflare"],
  ["isBackpack", "Backpack"],
  ["isBraveWallet", "Brave Wallet"],
  ["isGlow", "Glow"],
  ["isTrust", "Trust Wallet"],
  ["isTrustWallet", "Trust Wallet"],
  ["isCoinbaseWallet", "Coinbase Wallet"],
  ["isOkxWallet", "OKX Wallet"],
];

function nameLegacyProvider(candidate: unknown): string {
  if (isRecord(candidate)) {
    for (const [flag, name] of LEGACY_FLAG_NAMES) {
      if (candidate[flag]) return name;
    }
  }
  return "Injected wallet";
}

/**
 * Every Solana wallet this browser has injected, deduped by provider object
 * identity, in probe order (see the file header). `target` defaults to
 * `window`; tests pass a plain object standing in for it.
 */
export function detectSolanaWallets(target: unknown = window): DetectedWallet[] {
  const host = isRecord(target) ? target : {};
  const seen: unknown[] = [];
  const results: DetectedWallet[] = [];

  for (const probe of PROBES) {
    const candidate = probe.read(host);
    if (!isWalletLike(candidate)) continue;
    if (seen.includes(candidate)) continue;
    seen.push(candidate);
    results.push({ id: probe.id, name: probe.name, provider: candidate });
  }

  const legacy = readNamespace(host, "solana");
  if (isWalletLike(legacy) && !seen.includes(legacy)) {
    results.push({ id: "injected", name: nameLegacyProvider(legacy), provider: legacy });
  }

  return results;
}

export function solanaWalletById(id: string, target: unknown = window): DetectedWallet | undefined {
  return detectSolanaWallets(target).find((wallet) => wallet.id === id);
}
