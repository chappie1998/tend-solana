"use client";

// Wraps the app in the standard Solana wallet-adapter stack. See
// app/lib/wallet-bridge.tsx for the interface components actually use, and
// CLAUDE.md for why this replaced Privy: Privy's backend has Solana wallet
// auth disabled, so its modal kept failing to connect. This app never needed
// Privy's user accounts -- it already runs its own SIWS session
// (app/lib/session-client.ts, /api/auth/*) -- so external wallets only, no
// email login and no embedded wallet.

import type { ReactNode } from "react";
import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import { WalletProvider } from "@solana/wallet-adapter-react";
import { WalletBridgeProvider } from "./lib/wallet-bridge";

// Module-level, not inline: an inline `[]` literal is a new array identity
// every render, which makes WalletProvider tear down and re-initialise its
// adapters in a loop. Passing an empty (but stable) array here is enough --
// WalletProvider calls useStandardWalletAdapters() internally, which
// auto-discovers every wallet-standard wallet (Phantom, Solflare, Backpack,
// ...) without any adapter package needing to be listed by hand.
const NO_ADAPTERS: Adapter[] = [];

// A cancelled connect/sign is a routine, expected outcome (the visitor
// closed the wallet's approval popup) -- not something worth logging as a
// warning. Everything else is unexpected adapter behaviour worth a console
// trace, since there is no toast system here to surface it visually.
const USER_CANCELLED_PATTERN = /reject|declin|denied|cancel/i;

function isUserCancelledWalletError(error: WalletError): boolean {
  return USER_CANCELLED_PATTERN.test(error.name ?? "") || USER_CANCELLED_PATTERN.test(error.message ?? "");
}

function onWalletError(error: WalletError) {
  if (isUserCancelledWalletError(error)) return;
  console.warn("Solana wallet adapter error:", error);
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletProvider wallets={NO_ADAPTERS} autoConnect onError={onWalletError}>
      <WalletBridgeProvider>{children}</WalletBridgeProvider>
    </WalletProvider>
  );
}
