"use client";

// Wraps the app in Privy's wallet connection + signing layer. See
// app/lib/wallet-bridge.tsx for the interface components actually use, and
// CLAUDE.md / the Privy recipe docs for why: one modal that handles both
// external Solana wallets and email login with an embedded wallet, so a
// visitor with no wallet extension can still trade the devnet demo.

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { WalletBridgeProvider } from "./lib/wallet-bridge";

// Public by design (NEXT_PUBLIC_*): identifies the app to Privy, it is not a
// secret. The APP SECRET never belongs in client code and is not read here.
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export function Providers({ children }: { children: ReactNode }) {
  // No app id configured: render children as-is rather than crashing the
  // page. useWalletBridge() (app/lib/wallet-bridge.tsx) then reports
  // `configured: false` and the UI explains that wallet sign-in isn't set up.
  if (!PRIVY_APP_ID) return <>{children}</>;

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          walletChainType: "solana-only",
          // Required, not cosmetic: appearance.walletList defaults to
          // ['detected_wallets', 'metamask', 'coinbase_wallet', 'rainbow',
          // 'wallet_connect'] -- an Ethereum list -- and walletChainType alone
          // does not replace it, so the modal offered EVM-only wallets on a
          // Solana-only app. 'detected_solana_wallets' covers whatever the
          // visitor actually has installed; the named entries below stay
          // visible (with install/deep links) when they don't.
          walletList: ["detected_solana_wallets", "phantom", "solflare", "backpack", "jupiter"],
          showWalletLoginFirst: true,
          theme: "dark",
        },
        loginMethods: ["wallet", "email"],
        externalWallets: {
          solana: { connectors: toSolanaWalletConnectors() },
        },
        // Note: the installed @privy-io/react-auth types nest this under
        // embeddedWallets.solana.createOnLogin, not embeddedWallets.createOnLogin
        // directly -- confirmed in node_modules/@privy-io/react-auth/dist/dts/types-D8YDZp5m.d.ts.
        embeddedWallets: {
          solana: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      <WalletBridgeProvider>{children}</WalletBridgeProvider>
    </PrivyProvider>
  );
}
