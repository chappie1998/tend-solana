import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// app/api/quotes/route.ts splits into two intents (see its own doc comment):
// `indicative` (the safe default -- pricing only, no chain mutation, no
// persistence) and `execute` (today's original behaviour: lists an unlisted
// strike onchain, asks the pool authority to sign, persists an rfq_quotes
// row). There is no live database or RPC available offline, so -- exactly
// like tests/product.test.mjs, tests/pool-depth.test.mjs, and
// tests/market-pricing-overrides.test.mjs already do for this same file --
// these are source-level assertions over the route's actual code, checking
// BOTH that the right calls exist and that they are only reachable from the
// right branch (via string-offset ordering).
const root = new URL("../", import.meta.url);

async function routeSource() {
  return readFile(new URL("app/api/quotes/route.ts", root), "utf8");
}

test("intent defaults to the safe, non-mutating 'indicative' path -- only the literal string 'execute' reaches the costly one", async () => {
  const source = await routeSource();
  assert.match(source, /const intent: QuoteIntent = input\.intent === "execute" \? "execute" : "indicative";/);
});

test("indicative responses are returned BEFORE buildVsolQuoteTransaction, listVsolSeriesOnChain, or any rfq_quotes write can run", async () => {
  const source = await routeSource();
  const indicativeReturnIndex = source.indexOf('if (intent === "indicative") {');
  const buildTransactionIndex = source.indexOf("buildVsolQuoteTransaction({");
  const dbInsertIndex = source.indexOf("db.insert(rfqQuotes)");
  assert.ok(indicativeReturnIndex > -1, "the indicative branch must exist");
  assert.ok(buildTransactionIndex > -1, "buildVsolQuoteTransaction must still be called somewhere (the execute path)");
  assert.ok(dbInsertIndex > -1, "the rfq_quotes insert must still exist (the execute path)");
  assert.ok(
    indicativeReturnIndex < buildTransactionIndex,
    "the indicative branch's return must appear before buildVsolQuoteTransaction in source order, so it always executes first and returns before that call is ever reached",
  );
  assert.ok(
    indicativeReturnIndex < dbInsertIndex,
    "the indicative branch's return must appear before the rfq_quotes insert, so an indicative request can never persist a row",
  );
});

test("the indicative quote object is explicitly marked non-executable, and never carries a vsol transaction", async () => {
  const source = await routeSource();
  const indicativeBranch = source.slice(source.indexOf('if (intent === "indicative") {'), source.indexOf("buildVsolQuoteTransaction({"));
  assert.match(indicativeBranch, /executable:\s*false/);
  assert.doesNotMatch(indicativeBranch, /vsol:/);
});

test("the execute branch still builds and persists exactly as before, and marks its quote executable: true", async () => {
  const source = await routeSource();
  const executeBranch = source.slice(source.indexOf("// From here on: EXECUTE ONLY."));
  assert.match(executeBranch, /buildVsolQuoteTransaction\(/);
  assert.match(executeBranch, /db\.insert\(rfqQuotes\)/);
  assert.match(executeBranch, /executable:\s*true/);
  assert.match(executeBranch, /vsol:\s*\{/);
});

test("the DB-backed per-wallet rate limit is checked ONLY for intent === execute, and before every chain read on that path", async () => {
  const source = await routeSource();
  const rateLimitCheckIndex = source.indexOf("checkExecutableQuoteRateLimit(recentCreatedAtMsForWallet, requestedAt)");
  const oracleReadinessIndex = source.indexOf("getVsolExecutionReadiness(");
  const seriesResolutionIndex = source.indexOf("resolveOrPlanVsolSeries(");
  const poolDepthIndex = source.indexOf("checkVsolPoolDepth(");
  const buildTransactionIndex = source.indexOf("buildVsolQuoteTransaction({");
  assert.ok(rateLimitCheckIndex > -1);
  assert.ok(rateLimitCheckIndex < oracleReadinessIndex, "rate limit must be checked before the oracle-readiness RPC read");
  assert.ok(rateLimitCheckIndex < seriesResolutionIndex, "rate limit must be checked before series resolution");
  assert.ok(rateLimitCheckIndex < poolDepthIndex, "rate limit must be checked before the pool-depth read");
  assert.ok(rateLimitCheckIndex < buildTransactionIndex, "rate limit must be checked before the listing/signing call");
  // And it must be gated behind the execute-only branch, not reachable for indicative.
  const rateLimitGateIndex = source.indexOf('if (intent === "execute") {\n    // Authoritative, DB-backed per-wallet cap');
  assert.ok(rateLimitGateIndex > -1 && rateLimitGateIndex < rateLimitCheckIndex);
});

test("a rate-limited executable request returns 429 with a Retry-After header", async () => {
  const source = await routeSource();
  assert.match(source, /VSOL_EXECUTABLE_QUOTE_RATE_LIMITED/);
  assert.match(source, /"Retry-After":\s*String\(rateLimit\.retryAfterSeconds\)/);
  assert.match(source, /\},\s*429,/);
});

test("the per-wallet rate limit keys off resolveUserKey's authenticated identity, never the unauthenticated walletAddress request field", async () => {
  const source = await routeSource();
  assert.match(source, /const userKey = await resolveUserKey\(request\);/);
  assert.match(source, /buildRfqRequestId\(userKey\)/);
  assert.match(source, /userKeyFromRfqRequestId\(row\.requestId\) === userKey/);
});

test("the in-memory burst limiter runs for BOTH intents, before the request body is even parsed", async () => {
  const source = await routeSource();
  const inMemoryLimitIndex = source.indexOf('enforceInMemoryRateLimit(request, "quotes", userKey)');
  const intentParseIndex = source.indexOf('input.intent === "execute"');
  const jsonParseIndex = source.indexOf("await request.json()");
  assert.ok(inMemoryLimitIndex > -1);
  assert.ok(inMemoryLimitIndex < jsonParseIndex, "the in-memory limiter should run before the body is parsed");
  assert.ok(inMemoryLimitIndex < intentParseIndex);
});

test("protocolFeeBps is read live from the onchain Config account and returned in BOTH intents' responses", async () => {
  const source = await routeSource();
  assert.match(source, /const protocolFeeBps = poolCore\.config\.feeBps;/);
  // Both branches spread `responseEnvelope`, which carries protocolFeeBps --
  // assert it directly on the envelope object literal so this can't silently
  // stop being included if the envelope shape changes.
  const envelopeLiteral = source.slice(source.indexOf("const responseEnvelope = {"), source.indexOf("if (intent === \"indicative\")"));
  assert.match(envelopeLiteral, /protocolFeeBps,/);
  assert.match(source, /return json\(\{\s*\.\.\.responseEnvelope,\s*intent,\s*requestId: crypto\.randomUUID\(\),/);
  assert.match(source, /return json\(\{\s*\.\.\.responseEnvelope,\s*intent,\s*requestId,\s*quotes,/);
});

test("the pool-depth pre-check still runs for both intents (a single read-only account fetch, not the listing transaction)", async () => {
  const source = await routeSource();
  const poolDepthIndex = source.indexOf("checkVsolPoolDepth(");
  const indicativeBranchIndex = source.indexOf('if (intent === "indicative") {');
  assert.ok(poolDepthIndex > -1 && poolDepthIndex < indicativeBranchIndex, "the pool-depth check must run before the intent branch, so both intents pass through it");
});

test("the custom-settlement-deployment gate is scoped to intent === execute only, since it only meaningfully guards opening a real position", async () => {
  const source = await routeSource();
  assert.match(source, /if \(intent === "execute" && !VSOL_CUSTOM_SETTLEMENT_DEPLOYED\)/);
});
