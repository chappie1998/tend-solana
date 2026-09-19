import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// Source-level wiring checks (product.test.mjs style: regex over source) for
// the standard Solana wallet-adapter-backed wallet connection + signing
// layer. These are React hooks and a client-only provider component, so --
// like quote-readiness.test.mjs and solana-wallets.test.mjs before it --
// this suite pins source facts rather than mounting a DOM.

const root = new URL("../", import.meta.url);

// Matches an actual import/require of the package, not just its name inside
// an explanatory comment (several files deliberately document *why* they
// avoid it).
const IMPORTS_WALLET_ADAPTER_REACT_UI = /(?:from\s*|require\()["']@solana\/wallet-adapter-react-ui/;

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

test("app/providers.tsx wires WalletProvider with a stable adapters array and autoConnect, not Privy", async () => {
  const providers = await readFile(new URL("app/providers.tsx", root), "utf8");

  assert.match(providers, /import\s*\{[^}]*\bWalletProvider\b[^}]*\}\s*from\s*"@solana\/wallet-adapter-react"/);
  assert.match(providers, /<WalletProvider\b/);

  // `wallets` must reference a module-level identifier, never an inline
  // array literal -- an inline `[]` is a new identity every render and
  // makes WalletProvider re-initialise its adapters in a loop.
  assert.doesNotMatch(providers, /wallets=\{\[\s*\]\}/);
  const walletsProp = providers.match(/wallets=\{(\w+)\}/);
  assert.ok(walletsProp, "the wallets prop must reference a named identifier");
  const constDeclaration = new RegExp(`^const ${walletsProp[1]}: Adapter\\[\\] = \\[\\];`, "m");
  assert.match(providers, constDeclaration, "the wallets identifier must be declared as a module-level constant");

  // autoConnect so a returning visitor reconnects without clicking.
  assert.match(providers, /<WalletProvider\b[^>]*\bautoConnect\b/s);

  // An onError handler so adapter errors (e.g. a declined connect) don't
  // become unhandled promise rejections.
  assert.match(providers, /onError=\{?\w+\}?/);

  // Privy's actual API surface is gone entirely -- a comment explaining why
  // the migration happened is fine and expected (see the file header).
  assert.doesNotMatch(providers, /NEXT_PUBLIC_PRIVY_APP_ID/);
  assert.doesNotMatch(providers, /PrivyProvider/);
  assert.doesNotMatch(providers, /@privy-io\//);
  assert.doesNotMatch(providers, /ConnectionProvider/);

  // Deliberately not the stock wallet-adapter-react-ui modal -- this app
  // draws its own picker (app/components/WalletPicker.tsx).
  assert.doesNotMatch(providers, IMPORTS_WALLET_ADAPTER_REACT_UI);
});

test("no file under app/ imports @solana/wallet-adapter-react-ui", async () => {
  const appDir = new URL("app/", root);
  const files = await collectFiles(appDir.pathname);
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  contents.forEach((source, index) => {
    assert.doesNotMatch(
      source,
      IMPORTS_WALLET_ADAPTER_REACT_UI,
      `${files[index]} must not import the stock wallet-adapter-react-ui modal`,
    );
  });
});

test("app/components/WalletPicker.tsx does not import wallet-adapter-react-ui", async () => {
  const picker = await readFile(new URL("app/components/WalletPicker.tsx", root), "utf8");
  assert.doesNotMatch(picker, IMPORTS_WALLET_ADAPTER_REACT_UI);
  // It draws wallets from useWallet() and lets a click select one.
  assert.match(picker, /adapter\.name/);
  assert.match(picker, /adapter\.icon/);
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

  // Implementations actually call the wallet-adapter hook, not a re-derived
  // injected-wallet mechanism or Privy's Solana hooks.
  assert.match(bridge, /import\s*\{[^}]*\buseWallet\b[^}]*\}\s*from\s*"@solana\/wallet-adapter-react"/);
  assert.match(bridge, /useWallet\(\)/);
  assert.match(bridge, /signTransactionBase64\s*=\s*useCallback\(/);
  assert.match(bridge, /signMessageBase64\s*=\s*useCallback\(/);
  assert.match(bridge, /deserializeSolanaTransaction\(bytes\)/);
  assert.match(bridge, /await signTransaction\(transaction\)/);
  assert.match(bridge, /await signMessage\(new TextEncoder\(\)\.encode\(message\)\)/);

  // Legacy Transaction.serialize() throws on a not-yet-fully-signed tx
  // unless verification is disabled; VersionedTransaction.serialize() takes
  // no options. Both branches must be handled explicitly.
  assert.match(bridge, /instanceof VersionedTransaction/);
  assert.match(bridge, /requireAllSignatures:\s*false,\s*verifySignatures:\s*false/);

  // Connecting opens our own picker modal rather than a third-party one.
  assert.match(bridge, /<WalletPicker\b/);
  assert.match(bridge, /select\b/);

  // Never crashes with no provider mounted: useContext falls back to a
  // harmless NOT_CONFIGURED_BRIDGE rather than throwing.
  assert.match(bridge, /useContext\(WalletBridgeContext\) \?\? NOT_CONFIGURED_BRIDGE/);
  assert.match(bridge, /configured:\s*false/);

  assert.doesNotMatch(bridge, /Privy/i);
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

  // The old inline "Choose a wallet" picker embedded in this file is gone --
  // picking a wallet happens in app/components/WalletPicker.tsx, rendered by
  // WalletBridgeProvider, not inline here.
  assert.doesNotMatch(terminal, /Choose a wallet/);
});

test("no file under app/ imports @privy-io/*", async () => {
  const appDir = new URL("app/", root);
  const files = await collectFiles(appDir.pathname);
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  contents.forEach((source, index) => {
    assert.doesNotMatch(source, /@privy-io\//, `${files[index]} must not import @privy-io/*`);
  });
});
