"use client";

// The single interface every component in this app uses to connect a
// Solana wallet and sign with it. The standard wallet-adapter stack
// (@solana/wallet-adapter-react) lives entirely behind this file: our own
// picker modal (app/components/WalletPicker.tsx) lists whatever
// wallet-standard wallets the browser has (Phantom, Solflare, Backpack,
// ...) and connects to the one the visitor chooses. External wallets only --
// no email login, no embedded wallet.
//
// The wallet-adapter-calling implementation (WalletAdapterBridge below) is
// mounted only inside <WalletProvider> -- see app/providers.tsx.
// useWalletBridge() itself only ever calls useContext, which is safe with no
// provider above it, so a missing provider can never crash the page -- it
// just reports `configured: false`.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { base64ToBytes, bytesToBase64, deserializeSolanaTransaction } from "./solana-wallet";
import { WalletPicker } from "../components/WalletPicker";

export type WalletBridge = {
  ready: boolean;
  configured: boolean;
  address: string;
  connecting: boolean;
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

// Stable across renders on purpose: useSyncExternalStore never needs to
// re-subscribe when this identity doesn't change, and this store never
// actually changes -- it exists only to tell "server/first paint" (false)
// apart from "mounted client-side" (true), the same hydration-safe pattern
// used elsewhere for anything that must not assume a wallet exists during
// SSR.
function subscribeNever() {
  return () => {};
}

/**
 * Mounted only inside <WalletProvider> -- every hook below assumes a
 * provider ancestor. app/providers.tsx is responsible for never rendering
 * this without one.
 */
function WalletAdapterBridge({ children }: { children: ReactNode }) {
  const { wallets, publicKey, connecting, select, disconnect, signTransaction, signMessage } = useWallet();

  // Haven't checked for wallets yet (SSR / before hydration) vs. checked and
  // ready -- see quoteReadiness's `providerDetected: boolean | null`, which
  // treats `!bridge.ready` as "not checked yet."
  const ready = useSyncExternalStore(subscribeNever, () => true, () => false);

  // Our own wallet picker modal, not the stock wallet-adapter-react-ui one
  // (see app/components/WalletPicker.tsx for why). `connect()` just opens
  // it; the picker itself calls `select()` on the chosen adapter, which --
  // with `autoConnect` on -- is what actually triggers the connection.
  const [pickerOpen, setPickerOpen] = useState(false);

  const connect = useCallback(async () => {
    setPickerOpen(true);
  }, []);

  const closePicker = useCallback(() => setPickerOpen(false), []);

  const disconnectWallet = useCallback(async () => {
    await disconnect();
  }, [disconnect]);

  const signTransactionBase64 = useCallback(
    async (encoded: string) => {
      if (!signTransaction) throw new Error("Connect a Solana wallet first.");
      const bytes = base64ToBytes(encoded);
      const transaction = deserializeSolanaTransaction(bytes);
      const signed = await signTransaction(transaction);
      // VersionedTransaction.serialize() takes no options and never
      // verifies. Legacy Transaction.serialize() defaults to
      // { requireAllSignatures: true, verifySignatures: true } and throws
      // ("Signature verification failed") whenever a required signature
      // (e.g. the pool's, added server-side after this comes back) is still
      // missing. app/lib/vsol-server.ts:173 disables both checks for the
      // same reason when it hands a partially-signed legacy tx to the
      // client; the wire bytes are identical either way when every
      // signature is present, and the server re-verifies with
      // `verifySignatures()` once the signed tx comes back
      // (app/lib/vsol-server.ts:1904), so nothing is weakened by skipping
      // the client-side check here.
      const serialized =
        signed instanceof VersionedTransaction
          ? signed.serialize()
          : signed.serialize({ requireAllSignatures: false, verifySignatures: false });
      return bytesToBase64(serialized);
    },
    [signTransaction],
  );

  // null only when signing is genuinely unsupported (no connected wallet, or
  // this wallet doesn't implement signMessage) -- a declined/failed
  // signature still throws, exactly like the pre-adapter signSolanaMessage
  // contract app/lib/session-client.ts relies on.
  const signMessageBase64 = useCallback(
    async (message: string) => {
      if (!signMessage) return null;
      const signature = await signMessage(new TextEncoder().encode(message));
      if (!(signature instanceof Uint8Array) || signature.length !== 64) {
        throw new Error("The wallet returned an invalid message signature.");
      }
      return bytesToBase64(signature);
    },
    [signMessage],
  );

  const address = publicKey?.toBase58() ?? "";

  const bridge = useMemo<WalletBridge>(
    () => ({
      ready,
      configured: wallets.length > 0,
      address,
      connecting: connecting || pickerOpen,
      connect,
      disconnect: disconnectWallet,
      signTransactionBase64,
      signMessageBase64,
    }),
    [ready, wallets.length, address, connecting, pickerOpen, connect, disconnectWallet, signTransactionBase64, signMessageBase64],
  );

  return (
    <WalletBridgeContext.Provider value={bridge}>
      {children}
      {pickerOpen && <WalletPicker wallets={wallets} onSelect={select} onClose={closePicker} />}
    </WalletBridgeContext.Provider>
  );
}

/** See app/providers.tsx: rendered inside <WalletProvider>. */
export function WalletBridgeProvider({ children }: { children: ReactNode }) {
  return <WalletAdapterBridge>{children}</WalletAdapterBridge>;
}

/**
 * The wallet connection + signing interface every component should use.
 * Falls back to a harmless "not configured" bridge when no
 * WalletBridgeProvider is mounted above it -- this never throws and never
 * crashes the page.
 */
export function useWalletBridge(): WalletBridge {
  return useContext(WalletBridgeContext) ?? NOT_CONFIGURED_BRIDGE;
}
