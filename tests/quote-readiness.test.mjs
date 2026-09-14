import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Offline tests for the pure, import-free readiness helpers in
// app/lib/quote-readiness.ts (see TendTerminal's QuotePanel/TradeView).
// Loaded with Node's native type stripping, the same way
// tests/market-data.test.mjs loads app/lib/market-data.ts.

const root = new URL("../", import.meta.url);

async function loadQuoteReadiness() {
  return import(new URL("app/lib/quote-readiness.ts", root));
}

const baseReadinessInput = Object.freeze({
  providerDetected: true,
  walletAddress: "buyerWallet111",
  walletBusy: false,
  sessionWallet: "buyerWallet111",
  sessionNotice: "",
});

test("busy wins over every other readiness state", async () => {
  const { quoteReadiness } = await loadQuoteReadiness();
  // Busy while otherwise fully ready.
  assert.deepEqual(quoteReadiness({ ...baseReadinessInput, walletBusy: true }), { kind: "busy" });
  // Busy with no wallet connected at all.
  assert.deepEqual(
    quoteReadiness({ providerDetected: false, walletAddress: "", walletBusy: true, sessionWallet: null, sessionNotice: "" }),
    { kind: "busy" },
  );
  // Busy with a wallet connected but not signed in.
  assert.deepEqual(
    quoteReadiness({ ...baseReadinessInput, walletBusy: true, sessionWallet: null }),
    { kind: "busy" },
  );
});

test("no wallet connected: no-provider only when the provider check came back false", async () => {
  const { quoteReadiness } = await loadQuoteReadiness();
  assert.deepEqual(
    quoteReadiness({ providerDetected: false, walletAddress: "", walletBusy: false, sessionWallet: null, sessionNotice: "" }),
    { kind: "no-provider" },
  );
});

test("no wallet connected: providerDetected null (not checked yet) reads as connect, not no-provider", async () => {
  const { quoteReadiness } = await loadQuoteReadiness();
  assert.deepEqual(
    quoteReadiness({ providerDetected: null, walletAddress: "", walletBusy: false, sessionWallet: null, sessionNotice: "" }),
    { kind: "connect" },
  );
});

test("no wallet connected: providerDetected true reads as connect", async () => {
  const { quoteReadiness } = await loadQuoteReadiness();
  assert.deepEqual(
    quoteReadiness({ providerDetected: true, walletAddress: "", walletBusy: false, sessionWallet: null, sessionNotice: "" }),
    { kind: "connect" },
  );
});

test("wallet connected but session bound to no wallet: sign-in, reason passed through", async () => {
  const { quoteReadiness } = await loadQuoteReadiness();
  assert.deepEqual(
    quoteReadiness({ ...baseReadinessInput, sessionWallet: null, sessionNotice: "This wallet does not support message signing." }),
    { kind: "sign-in", reason: "This wallet does not support message signing." },
  );
});

test("wallet connected but session bound to a DIFFERENT wallet: sign-in", async () => {
  const { quoteReadiness } = await loadQuoteReadiness();
  assert.deepEqual(
    quoteReadiness({ ...baseReadinessInput, sessionWallet: "someOtherWallet222", sessionNotice: "" }),
    { kind: "sign-in", reason: "" },
  );
});

test("sign-in reason is passed through verbatim, including empty string", async () => {
  const { quoteReadiness } = await loadQuoteReadiness();
  const result = quoteReadiness({ ...baseReadinessInput, sessionWallet: null, sessionNotice: "" });
  assert.deepEqual(result, { kind: "sign-in", reason: "" });
});

test("wallet connected and session matches: ready", async () => {
  const { quoteReadiness } = await loadQuoteReadiness();
  assert.deepEqual(quoteReadiness(baseReadinessInput), { kind: "ready" });
});

const baseInputIssueInput = Object.freeze({
  notional: 1000,
  expiryAvailable: true,
  expiryReason: "",
  poolQuotable: true,
});

test("quoteInputIssue: amount boundaries at 99/100/5000/5001", async () => {
  const { quoteInputIssue } = await loadQuoteReadiness();
  assert.equal(
    quoteInputIssue({ ...baseInputIssueInput, notional: 99 }),
    "Enter a devnet amount between $100 and $5,000.",
  );
  assert.equal(quoteInputIssue({ ...baseInputIssueInput, notional: 100 }), null);
  assert.equal(quoteInputIssue({ ...baseInputIssueInput, notional: 5000 }), null);
  assert.equal(
    quoteInputIssue({ ...baseInputIssueInput, notional: 5001 }),
    "Enter a devnet amount between $100 and $5,000.",
  );
});

test("quoteInputIssue: unavailable expiry surfaces its own reason", async () => {
  const { quoteInputIssue } = await loadQuoteReadiness();
  assert.equal(
    quoteInputIssue({ ...baseInputIssueInput, expiryAvailable: false, expiryReason: "Cutoff passed for this expiry." }),
    "Cutoff passed for this expiry.",
  );
});

test("quoteInputIssue: non-quotable pool is flagged", async () => {
  const { quoteInputIssue } = await loadQuoteReadiness();
  assert.equal(
    quoteInputIssue({ ...baseInputIssueInput, poolQuotable: false }),
    "Executable quotes come from the Tend pool today. Other authorized pools are listed honestly, but no quote service is integrated for them yet.",
  );
});

test("quoteInputIssue: poolQuotable null (no active pool to check) passes", async () => {
  const { quoteInputIssue } = await loadQuoteReadiness();
  assert.equal(quoteInputIssue({ ...baseInputIssueInput, poolQuotable: null }), null);
});

test("quoteInputIssue: valid inputs return null", async () => {
  const { quoteInputIssue } = await loadQuoteReadiness();
  assert.equal(quoteInputIssue(baseInputIssueInput), null);
});

test("quoteInputIssue: amount check takes priority over expiry/pool issues", async () => {
  const { quoteInputIssue } = await loadQuoteReadiness();
  assert.equal(
    quoteInputIssue({ notional: 50, expiryAvailable: false, expiryReason: "Cutoff passed.", poolQuotable: false }),
    "Enter a devnet amount between $100 and $5,000.",
  );
});

test("exports the documented auto-quote constants", async () => {
  const { AUTO_QUOTE_DEBOUNCE_MS, MAX_AUTO_REFRESHES } = await loadQuoteReadiness();
  assert.equal(AUTO_QUOTE_DEBOUNCE_MS, 600);
  assert.equal(MAX_AUTO_REFRESHES, 3);
});

// --- Source-level wiring checks (product.test.mjs style: regex over source) ---

test("TendTerminal wires quote readiness, the auto-quote debounce, 401 session-expiry handling, and a wallet-agnostic install link", async () => {
  const terminal = await readFile(new URL("app/components/TendTerminal.tsx", root), "utf8");
  assert.match(terminal, /quoteReadiness/);
  assert.match(terminal, /quoteInputIssue/);
  assert.match(terminal, /AUTO_QUOTE_DEBOUNCE_MS/);
  assert.match(terminal, /MAX_AUTO_REFRESHES/);
  assert.match(terminal, /onSessionExpired/);
  assert.match(terminal, /response\.status === 401/);
  assert.match(terminal, /https:\/\/solana\.com\/wallets/);
});

// Regression: the expiry auto-refresh budget must be refilled ONLY by a manual
// request. When requestQuote reset it unconditionally, every auto-refresh
// handed itself a fresh budget, MAX_AUTO_REFRESHES was unreachable, and an
// abandoned tab re-quoted forever -- each request able to list a rung onchain.
// Caught in the browser: 7 requests in 14s with no "Quote expired" state.
test("only a manual quote request refills the expiry auto-refresh budget", async () => {
  const terminal = await readFile(new URL("app/components/TendTerminal.tsx", root), "utf8");
  assert.match(terminal, /if \(manual\) autoRefreshCountRef\.current = 0;/);
  assert.match(terminal, /runQuoteRef\.current\(\{ manual: false \}\)/);
  assert.match(terminal, /void runQuote\(\{ manual: true \}\)/);
  // The budget must never be reset anywhere else -- only in invalidateQuote
  // (a user input change), the wallet-switch effect, and the manual branch.
  const resets = terminal.match(/autoRefreshCountRef\.current = 0/g) ?? [];
  assert.equal(resets.length, 3);
});
