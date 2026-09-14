import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Offline tests for the pure, dependency-free wallet detection in
// app/lib/solana-wallets.ts. Loaded with Node's native type stripping, the
// same way tests/quote-readiness.test.mjs loads app/lib/quote-readiness.ts.
// `detectSolanaWallets` takes an explicit `target` object here instead of a
// real `window`, so these run with no browser and no real wallet extension.

const root = new URL("../", import.meta.url);

async function loadSolanaWallets() {
  return import(new URL("app/lib/solana-wallets.ts", root));
}

/** The minimal shape that passes the connect+signTransaction duck-typing gate. */
function fakeProvider(extra = {}) {
  return { connect: async () => {}, signTransaction: async (transaction) => transaction, ...extra };
}

test("Phantom injected as both phantom.solana and window.solana (same object) dedupes to one entry", async () => {
  const { detectSolanaWallets } = await loadSolanaWallets();
  const provider = fakeProvider({ isPhantom: true });
  const wallets = detectSolanaWallets({ phantom: { solana: provider }, solana: provider });
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].id, "phantom");
  assert.equal(wallets[0].name, "Phantom");
  assert.equal(wallets[0].provider, provider);
});

test("Solflare only, injected on window.solflare", async () => {
  const { detectSolanaWallets } = await loadSolanaWallets();
  const provider = fakeProvider();
  const wallets = detectSolanaWallets({ solflare: provider });
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].id, "solflare");
  assert.equal(wallets[0].name, "Solflare");
  assert.equal(wallets[0].provider, provider);
});

test("Phantom + Solflare + Backpack all present: three entries, Phantom first, no duplicates", async () => {
  const { detectSolanaWallets } = await loadSolanaWallets();
  const phantom = fakeProvider({ isPhantom: true });
  const solflare = fakeProvider();
  const backpack = fakeProvider();
  // The legacy `solana` global also points at the Phantom object here, the
  // same as a real browser with Phantom installed -- it must not double count.
  const wallets = detectSolanaWallets({ phantom: { solana: phantom }, solflare, backpack, solana: phantom });
  assert.equal(wallets.length, 3);
  assert.deepEqual(wallets.map((wallet) => wallet.id), ["phantom", "solflare", "backpack"]);
  assert.equal(new Set(wallets.map((wallet) => wallet.provider)).size, 3);
});

test("a namespace whose value fails the duck-typing gate is skipped, not returned, and never throws", async () => {
  const { detectSolanaWallets } = await loadSolanaWallets();
  const wallets = detectSolanaWallets({
    solflare: { connect: async () => {} }, // missing signTransaction
    backpack: { signTransaction: async (transaction) => transaction }, // missing connect
    okxwallet: { solana: "not-an-object" },
    coinbaseSolana: null,
  });
  assert.deepEqual(wallets, []);
});

test("legacy window.solana is named from its boolean flags when not already deduped", async () => {
  const { detectSolanaWallets } = await loadSolanaWallets();
  const backpackLike = fakeProvider({ isBackpack: true });
  const flagged = detectSolanaWallets({ solana: backpackLike });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, "injected");
  assert.equal(flagged[0].name, "Backpack");

  const unflagged = fakeProvider();
  const plain = detectSolanaWallets({ solana: unflagged });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].name, "Injected wallet");
});

test("solanaWalletById returns the matching entry, and undefined for an unknown id", async () => {
  const { solanaWalletById } = await loadSolanaWallets();
  const provider = fakeProvider();
  const target = { solflare: provider };
  assert.equal(solanaWalletById("solflare", target)?.provider, provider);
  assert.equal(solanaWalletById("backpack", target), undefined);
});

test("an empty window object detects nothing", async () => {
  const { detectSolanaWallets } = await loadSolanaWallets();
  assert.deepEqual(detectSolanaWallets({}), []);
});

// --- Source-level wiring check (product.test.mjs style: regex over source) ---

test("TendTerminal no longer names Phantom specifically and links the wallet-agnostic install page", async () => {
  const terminal = await readFile(new URL("app/components/TendTerminal.tsx", root), "utf8");
  assert.doesNotMatch(terminal, /Get Phantom/);
  assert.doesNotMatch(terminal, /Install Phantom/);
  assert.match(terminal, /https:\/\/solana\.com\/wallets/);
});

// Regression: Phantom resolves connect() with { publicKey }, but Solflare (and
// some Backpack builds) resolve with void/true and expose the key on the
// provider. Reading only the resolved value made a working wallet fall into
// the catch and report "Wallet connection was cancelled." Verified in a
// browser with a stubbed Solflare-shaped provider: the header showed the
// Solflare address and the auto-quote was bound to it.
test("connectWallet reads the public key from the connect result OR the provider", async () => {
  const terminal = await readFile(new URL("app/components/TendTerminal.tsx", root), "utf8");
  assert.match(terminal, /connected\?\.publicKey \?\? chosen\.provider\.publicKey/);
});
