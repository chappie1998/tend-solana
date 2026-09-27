import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Client-side half of the indicative/executable split (app/api/quotes/route.ts
// owns the server half -- see tests/quote-intent.test.mjs). TendTerminal.tsx
// has no test harness (no jsdom/@testing-library in this repo -- see how
// tests/product.test.mjs and tests/two-sided-quote.test.mjs already cover it,
// via source assertions), so these follow the same convention: regex/string-
// offset checks over the real component source.
const root = new URL("../", import.meta.url);

async function terminalSource() {
  return readFile(new URL("app/components/TendTerminal.tsx", root), "utf8");
}

// Doc comments legitimately MENTION the other function/intent by name (e.g.
// requestExecutableQuote's own doc comment explains why runQuote can't be
// reused for it) -- so these boundaries are drawn at the doc comment that
// PRECEDES each declaration, not the `async function` keyword itself, or a
// preceding comment would leak into the "wrong" slice.
const REQUEST_EXECUTABLE_QUOTE_DOC_COMMENT_START = '/**\n   * "Review & execute" always fetches a FRESH executable quote';

// Matches only the actual fetch BODY literal (the JSON key/value pair sent to
// the server), never a comment that merely mentions `intent: "execute"` in
// prose (both functions' doc comments legitimately do, explaining the split)
// -- anchored on the exact shared prefix of the two functions' request bodies.
const INDICATIVE_FETCH_BODY = 'walletAddress, intent: "indicative" }),';
const EXECUTE_FETCH_BODY = 'walletAddress, intent: "execute" }),';

test("the auto-quote / manual-refresh path (runQuote) always requests intent: indicative, never execute", async () => {
  const source = await terminalSource();
  const runQuoteBody = source.slice(source.indexOf("async function runQuote("), source.indexOf(REQUEST_EXECUTABLE_QUOTE_DOC_COMMENT_START));
  assert.notEqual(runQuoteBody, "");
  assert.ok(runQuoteBody.includes(INDICATIVE_FETCH_BODY));
  assert.ok(!runQuoteBody.includes(EXECUTE_FETCH_BODY));
});

test("\"Review & execute\" (requestExecutableQuote) always requests intent: execute, and is the ONLY function that does", async () => {
  const source = await terminalSource();
  const requestExecutableQuoteBody = source.slice(source.indexOf("async function requestExecutableQuote("), source.indexOf("function requestQuote(event"));
  assert.notEqual(requestExecutableQuoteBody, "");
  assert.ok(requestExecutableQuoteBody.includes(EXECUTE_FETCH_BODY));
  // Exactly one call site in the whole file actually SENDS intent: "execute"
  // as a fetch body -- if a second one appears, either this function was
  // duplicated or another path started requesting executable quotes without
  // review. (Doc comments mentioning the phrase in prose don't match this
  // exact fetch-body literal, so they don't inflate the count.)
  const executeIntentOccurrences = source.split(EXECUTE_FETCH_BODY).length - 1;
  assert.equal(executeIntentOccurrences, 1);
});

test("onExecute wires the QuotePanel's button to requestExecutableQuote, not directly to opening the review modal", async () => {
  const source = await terminalSource();
  assert.match(source, /onExecute=\{\(\) => void requestExecutableQuote\(\)\}/);
  // The old direct-open wiring must be gone -- opening the modal on unreviewed data was the bug.
  assert.doesNotMatch(source, /onExecute=\{\(\) => setComplete\(true\)\}/);
});

test("the review modal only ever opens (setComplete(true)) after an executable quote has actually loaded, inside requestExecutableQuote", async () => {
  const source = await terminalSource();
  const requestExecutableQuoteBody = source.slice(source.indexOf("async function requestExecutableQuote("), source.indexOf("function requestQuote(event"));
  assert.notEqual(requestExecutableQuoteBody, "");
  assert.match(requestExecutableQuoteBody, /setComplete\(true\)/);
  // And it must appear only after the executable/vsol guard, not before it.
  const guardIndex = requestExecutableQuoteBody.indexOf("!result.quotes[0].executable");
  const completeIndex = requestExecutableQuoteBody.indexOf("setComplete(true)");
  assert.ok(guardIndex > -1 && guardIndex < completeIndex);
});

test("confirmPreviewPosition (the wallet-signing path) refuses to sign a quote that is not executable", async () => {
  const source = await terminalSource();
  const confirmBody = source.slice(source.indexOf("async function confirmPreviewPosition("), source.indexOf('return (\n    <main className="trade-layout">'));
  assert.notEqual(confirmBody, "");
  assert.match(confirmBody, /if \(!bestQuote\.executable\)/);
  // The refusal must come before the transaction is ever signed.
  const refusalIndex = confirmBody.indexOf("!bestQuote.executable");
  const signIndex = confirmBody.indexOf("bridge.signTransactionBase64");
  assert.ok(refusalIndex > -1 && signIndex > -1 && refusalIndex < signIndex);
});

test("MakerQuote carries an explicit executable flag that the signing path and the panel copy both read", async () => {
  const source = await terminalSource();
  const makerQuoteType = source.slice(source.indexOf("type MakerQuote = {"), source.indexOf("type SeriesState = {"));
  assert.match(makerQuoteType, /executable:\s*boolean;/);
});

test("QuotePanel labels an indicative success state honestly (never claims 'Signed'/'Executable' for a non-executable quote)", async () => {
  const source = await terminalSource();
  const quotePanelBody = source.slice(source.indexOf("function QuotePanel("), source.indexOf("function VsolStatus("));
  assert.match(quotePanelBody, /const executable = quotes\[0\]\?\.executable \?\? false;/);
  assert.match(quotePanelBody, /executable \? "Signed devnet quote" : "Indicative price"/);
  assert.match(quotePanelBody, /executable \? `Executable for \$\{secondsLeft\}s` : `Refreshes in \$\{secondsLeft\}s`/);
});

test("the fee shown to the trader comes from the live protocolFeeBps once a quote has loaded, falling back to PROTOCOL_WIN_FEE_BPS only before that", async () => {
  const source = await terminalSource();
  assert.match(source, /const \[protocolFeeBps, setProtocolFeeBps\] = useState<number \| null>\(null\);/);
  assert.match(source, /const feeBpsForDisplay = protocolFeeBps \?\? PROTOCOL_WIN_FEE_BPS;/);
  // PROTOCOL_WIN_FEE_BPS itself must appear ONLY in that fallback expression
  // (plus its import and doc-comment mentions) -- not duplicated into any of
  // the three display rows the fee actually shows up in.
  assert.doesNotMatch(source, /\{PROTOCOL_WIN_FEE_BPS \/ 100\}/);
  assert.match(source, /You net after the \{feeBpsForDisplay \/ 100\}% fee/);
  assert.match(source, /after the \{feeBpsForDisplay \/ 100\}% protocol fee/);
  assert.match(source, /A winning position pays a \{feeBpsForDisplay \/ 100\}% protocol fee/);
  // netWinning is called with the explicit rate everywhere it's used for display.
  assert.match(source, /netWinning\(bestQuote\.maxPayout, feeBpsForDisplay\)/);
  assert.match(source, /netWinning\(maxPayout, feeBpsForDisplay\)/);
});

test("protocolFeeBps is captured from both the indicative and executable responses", async () => {
  const source = await terminalSource();
  const setterCalls = source.match(/if \(typeof result\.protocolFeeBps === "number"\) setProtocolFeeBps\(result\.protocolFeeBps\);/g) ?? [];
  assert.equal(setterCalls.length, 2, "both runQuote and requestExecutableQuote must capture protocolFeeBps");
});
