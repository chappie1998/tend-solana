"use client";

// The single interface every component in this app uses to connect a
// Solana wallet and sign with it. Privy lives entirely behind this file: its
// modal handles both external wallets (Phantom, Solflare, Backpack, ...) and
// email login with an embedded Solana wallet, so a visitor with no wallet
// extension can still trade the devnet demo.
//
// The Privy-calling implementation (PrivyWalletBridge below) is mounted only
// inside <PrivyProvider> -- see app/providers.tsx, which renders it when
// NEXT_PUBLIC_PRIVY_APP_ID is configured and omits it (and PrivyProvider)
// entirely otherwise. useWalletBridge() itself only ever calls useContext,
// which is safe with no provider above it, so a missing app id can never
// crash the page -- it just reports `configured: false`.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import {
  useSignMessage,
  useSignTransaction,
  useWallets,
  type ConnectedStandardSolanaWallet,
} from "@privy-io/react-auth/solana";
import { base64ToBytes, bytesToBase64 } from "./solana-wallet";

export type WalletBridge = {
  /** Privy has finished initialising. */
  ready: boolean;
  /** False when NEXT_PUBLIC_PRIVY_APP_ID is missing -- wallet sign-in is unavailable, not just disconnected. */
  configured: boolean;
  /** The connected Solana wallet's base58 address, or "" when none is connected. */
  address: string;
  connecting: boolean;
  /** Opens the Privy login modal (external wallet connect or email login). */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signTransactionBase64(encoded: string): Promise<string>;
  signMessageBase64(message: string): Promise<string | null>;
};

const NOT_CONFIGURED_BRIDGE: WalletBridge = {
  ready: true,
  configured: false,
  address: "",
  connecting: false,
  connect: async () => {},
  disconnect: async () => {},
  signTransactionBase64: async () => {
    throw new Error("Wallet sign-in is not configured.");
  },
  signMessageBase64: async () => null,
};

const WalletBridgeContext = createContext<WalletBridge | null>(null);

/**
 * True only for Privy's own embedded Solana wallet. Privy's SDK identifies it
 * the same way internally (see the `isPrivyWallet` getter on its exported
 * `PrivyStandardWallet` class, in @privy-io/react-auth/solana) -- the
 * structural `SolanaStandardWallet` type doesn't declare the field, so this
 * reads it defensively rather than asserting the concrete class.
 */
function isEmbeddedWallet(wallet: ConnectedStandardSolanaWallet): boolean {
  return (wallet.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet === true;
}

/** Whether this wallet's wallet-standard feature set includes signMessage at all. */
function supportsSignMessage(wallet: ConnectedStandardSolanaWallet): boolean {
  return Boolean((wallet.standardWallet.features as Record<string, unknown>)["solana:signMessage"]);
}

/**
 * Picks which connected wallet's address to expose: keep `preferred` if it's
 * still among `wallets`, otherwise prefer an external wallet over the
 * embedded one, otherwise whichever is first.
 */
function pickAddress(wallets: ConnectedStandardSolanaWallet[], preferred: string): string {
  const stillConnected = wallets.find((wallet) => wallet.address === preferred);
  if (stillConnected) return stillConnected.address;
  const external = wallets.find((wallet) => !isEmbeddedWallet(wallet));
  return (external ?? wallets[0])?.address ?? "";
}

/**
 * Mounted only inside <PrivyProvider> -- every hook below assumes a provider
 * ancestor. app/providers.tsx is responsible for never rendering this
 * without one.
 */
function PrivyWalletBridge({ children }: { children: ReactNode }) {
  // `isModalOpen` is Privy's own view of whether its login modal is showing.
  // `connecting` is derived from it rather than tracked locally on purpose:
  // closing the modal without logging in fires no completion callback, so a
  // locally-held flag (or a promise awaiting one) would stay stuck forever
  // and leave the whole ticket showing "Waiting for wallet…". Reading
  // Privy's flag makes the state self-heal the moment the modal closes.
  const { ready, logout, isModalOpen } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const { login } = useLogin();

  // Prefer an external wallet (Phantom, Solflare, ...) over Privy's embedded
  // one when both are connected, but once an address is chosen, keep using it
  // across renders even if `wallets` reorders -- only a disconnect (the
  // chosen address no longer appearing in `wallets`) re-runs the preference.
  // Adjusted during render (not in an effect) when `wallets` changes identity
  // -- the same "state derived from a changed input" pattern TendTerminal's
  // TradeView already uses for its own wallet-switch reset (see
  // `quotedWallet` there): a plain conditional setState call during render,
  // which React explicitly supports for this exact case.
  const [previousWallets, setPreviousWallets] = useState(wallets);
  const [address, setAddress] = useState(() => pickAddress(wallets, ""));
  if (previousWallets !== wallets) {
    setPreviousWallets(wallets);
    setAddress((current) => pickAddress(wallets, current));
  }

  const activeWallet = useMemo(
    () => wallets.find((wallet) => wallet.address === address),
    [wallets, address],
  );

  // Opens the modal and resolves immediately: Privy owns the rest of the
  // flow, and the app reacts to its outcome through `address` (a fresh
  // connection) and `connecting` (the modal being open), never by awaiting
  // this. Errors inside the flow are surfaced by Privy's own modal UI.
  const connect = useCallback(async () => {
    login();
  }, [login]);

  const disconnect = useCallback(async () => {
    await logout();
  }, [logout]);

  const signTransactionBase64 = useCallback(
    async (encoded: string) => {
      if (!activeWallet) throw new Error("Connect a Solana wallet first.");
      const bytes = base64ToBytes(encoded);
      const { signedTransaction } = await signTransaction({ transaction: bytes, wallet: activeWallet });
      return bytesToBase64(signedTransaction);
    },
    [activeWallet, signTransaction],
  );

  // Mirrors the pre-Privy signSolanaMessage contract: null only when signing
  // is genuinely unsupported (no connected wallet, or this wallet's standard
  // feature set has no signMessage) -- a declined/failed signature still
  // throws, exactly like app/lib/solana-wallet.ts's signSolanaMessage did.
  const signMessageBase64 = useCallback(
    async (message: string) => {
      if (!activeWallet || !supportsSignMessage(activeWallet)) return null;
      const { signature } = await signMessage({ message: new TextEncoder().encode(message), wallet: activeWallet });
      if (!(signature instanceof Uint8Array) || signature.length !== 64) {
        throw new Error("The wallet returned an invalid message signature.");
      }
      return bytesToBase64(signature);
    },
    [activeWallet, signMessage],
  );

  const bridge = useMemo<WalletBridge>(
    () => ({
      ready,
      configured: true,
      address,
      connecting: isModalOpen,
      connect,
      disconnect,
      signTransactionBase64,
      signMessageBase64,
    }),
    [ready, address, isModalOpen, connect, disconnect, signTransactionBase64, signMessageBase64],
  );

  return <WalletBridgeContext.Provider value={bridge}>{children}</WalletBridgeContext.Provider>;
}

/** See app/providers.tsx: rendered inside <PrivyProvider> only when NEXT_PUBLIC_PRIVY_APP_ID is configured. */
export function WalletBridgeProvider({ children }: { children: ReactNode }) {
  return <PrivyWalletBridge>{children}</PrivyWalletBridge>;
}

/**
 * The wallet connection + signing interface every component should use.
 * Falls back to a harmless "not configured" bridge when no
 * WalletBridgeProvider is mounted above it (i.e. NEXT_PUBLIC_PRIVY_APP_ID is
 * unset) -- this never throws and never crashes the page.
 */
export function useWalletBridge(): WalletBridge {
  return useContext(WalletBridgeContext) ?? NOT_CONFIGURED_BRIDGE;
}
