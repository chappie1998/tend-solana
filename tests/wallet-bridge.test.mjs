import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// Source-level wiring checks (product.test.mjs style: regex over source) for
// the Privy-backed wallet connection + signing layer. These are React hooks
// and a client-only provider component, so -- like quote-readiness.test.mjs
// and solana-wallets.test.mjs before it -- this suite pins source facts
// rather than mounting a DOM.

const root = new URL("../", import.meta.url);

test("app/providers.tsx reads the app id from env, never hardcodes it, and never leaks a secret", async () => {
  const providers = await readFile(new URL("app/providers.tsx", root), "utf8");

  assert.match(providers, /process\.env\.NEXT_PUBLIC_PRIVY_APP_ID/);
  assert.match(providers, /PrivyProvider/);
  assert.match(providers, /appId=\{PRIVY_APP_ID\}/);
  // No literal Privy app id (cl... or a bare quoted id) hardcoded as the appId.
  assert.doesNotMatch(providers, /appId="[^{]/);
  assert.doesNotMatch(providers, /privy_app_secret/i);

  assert.match(providers, /walletChainType:\s*"solana-only"/);
  assert.match(providers, /toSolanaWalletConnectors/);
  assert.match(providers, /loginMethods:\s*\[[^\]]*"wallet"[^\]]*"email"/);

  // Never crashes when unconfigured: renders children directly.
  assert.match(providers, /if \(!PRIVY_APP_ID\) return <>\{children\}<\/>;/);
});

test("app/lib/wallet-bridge.tsx exports useWalletBridge and implements the full WalletBridge interface", async () => {
  const bridge = await readFile(new URL("app/lib/wallet-bridge.tsx", root), "utf8");

  assert.match(bridge, /export function useWalletBridge/);
  assert.match(bridge, /export function WalletBridgeProvider/);
  assert.match(bridge, /export type WalletBridge/);

  // The interface shape the rest of the app relies on.
  assert.match(bridge, /ready:\s*boolean/);
  assert.match(bridge, /configured:\s*boolean/);
  assert.match(bridge, /address:\s*string/);
  assert.match(bridge, /connecting:\s*boolean/);
  assert.match(bridge, /connect\(\):\s*Promise<void>/);
  assert.match(bridge, /disconnect\(\):\s*Promise<void>/);
  assert.match(bridge, /signTransactionBase64\(encoded: string\): Promise<string>/);
  assert.match(bridge, /signMessageBase64\(message: string\): Promise<string \| null>/);

  // Implementations actually call Privy's Solana hooks, not a re-derived
  // injected-wallet mechanism.
  assert.match(bridge, /useWallets\(\)/);
  assert.match(bridge, /useSignMessage\(\)/);
  assert.match(bridge, /useSignTransaction\(\)/);
  assert.match(bridge, /signTransactionBase64\s*=\s*useCallback\(/);
  assert.match(bridge, /signMessageBase64\s*=\s*useCallback\(/);
  assert.match(bridge, /signTransaction\(\{ transaction: bytes, wallet: activeWallet \}\)/);
  assert.match(bridge, /signMessage\(\{ message: new TextEncoder\(\)\.encode\(message\), wallet: activeWallet \}\)/);

  // Never crashes with no provider mounted (missing app id): useContext falls
  // back to a harmless NOT_CONFIGURED_BRIDGE rather than throwing.
  assert.match(bridge, /useContext\(WalletBridgeContext\) \?\? NOT_CONFIGURED_BRIDGE/);
  assert.match(bridge, /configured:\s*false/);

  assert.doesNotMatch(bridge, /privy_app_secret/i);
});

test("EarnView, LaunchView, and PortfolioView sign through the wallet bridge, not the legacy injected-wallet helper", async () => {
  const [earn, launch, portfolio] = await Promise.all([
    readFile(new URL("app/components/EarnView.tsx", root), "utf8"),
    readFile(new URL("app/components/LaunchView.tsx", root), "utf8"),
    readFile(new URL("app/components/PortfolioView.tsx", root), "utf8"),
  ]);

  for (const [name, source] of [["EarnView", earn], ["LaunchView", launch], ["PortfolioView", portfolio]]) {
    assert.match(source, /useWalletBridge/, `${name} must use the wallet bridge`);
    assert.doesNotMatch(
      source,
      /signSerializedSolanaTransaction/,
      `${name} must not call the legacy injected-wallet signer directly`,
    );
  }

  assert.match(earn, /bridge\.signTransactionBase64/);
  assert.match(portfolio, /bridge\.signTransactionBase64/);
  // LaunchView threads signing through its shared runLaunchFlow helper rather
  // than calling the bridge inline at each of its three call sites.
  assert.match(launch, /signTransactionBase64/);
});

test("TendTerminal wires the bridge for connect, address, and transaction signing", async () => {
  const terminal = await readFile(new URL("app/components/TendTerminal.tsx", root), "utf8");

  assert.match(terminal, /useWalletBridge/);
  assert.match(terminal, /bridge\.address/);
  assert.match(terminal, /bridge\.connect\(\)/);
  assert.match(terminal, /bridge\.signTransactionBase64/);
  assert.match(terminal, /bridge\.signMessageBase64/);
  assert.doesNotMatch(terminal, /signSerializedSolanaTransaction/);
  assert.doesNotMatch(terminal, /detectSolanaWallets/);

  // The custom "Choose a wallet" picker is gone -- Privy's own modal replaces it.
  assert.doesNotMatch(terminal, /Choose a wallet/);
});

test("no file under app/ contains the Privy app secret placeholder string", async () => {
  async function collectFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(full);
      if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) return [full];
      return [];
    }));
    return files.flat();
  }

  const appDir = new URL("app/", root);
  const files = await collectFiles(appDir.pathname);
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  contents.forEach((source, index) => {
    assert.doesNotMatch(source, /privy_app_secret/i, `${files[index]} must not contain the Privy app secret`);
  });
});
