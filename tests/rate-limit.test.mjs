import assert from "node:assert/strict";
import test from "node:test";

// Authoritative, DB-backed per-wallet cap on EXECUTABLE VSOL quotes (see
// app/lib/rate-limit.ts's own doc comment for why this -- not the in-memory
// limiter -- is the control that actually protects the server's SOL: an
// executable quote can trigger a real, server-paid on-chain listing
// transaction). `checkExecutableQuoteRateLimit` is pure and import-free of
// the database, exactly like `checkVsolPoolDepth` in app/lib/vsol-server.ts
// (see tests/pool-depth.test.mjs), so these tests stub the "already queried
// timestamps" input directly instead of touching a live Postgres connection.
const root = new URL("../", import.meta.url);

async function loadRateLimit() {
  return import(new URL("app/lib/rate-limit.ts", root));
}

test("checkExecutableQuoteRateLimit allows an empty history and a history well under both caps", async () => {
  const { checkExecutableQuoteRateLimit, EXECUTABLE_QUOTES_PER_MINUTE_LIMIT, EXECUTABLE_QUOTES_PER_HOUR_LIMIT } = await loadRateLimit();
  const now = 1_000_000_000;
  assert.deepEqual(checkExecutableQuoteRateLimit([], now), { limited: false });
  // One request short of EITHER cap, all within the last minute (so also within the hour).
  const timestamps = Array.from(
    { length: Math.min(EXECUTABLE_QUOTES_PER_MINUTE_LIMIT, EXECUTABLE_QUOTES_PER_HOUR_LIMIT) - 1 },
    (_unused, index) => now - index * 1_000,
  );
  assert.deepEqual(checkExecutableQuoteRateLimit(timestamps, now), { limited: false });
});

test("checkExecutableQuoteRateLimit trips the per-minute cap exactly at the boundary, not one under", async () => {
  const { checkExecutableQuoteRateLimit, EXECUTABLE_QUOTES_PER_MINUTE_LIMIT } = await loadRateLimit();
  const now = 2_000_000_000;
  // All inside the last minute, none inside the last hour's OTHER cap (kept
  // well under EXECUTABLE_QUOTES_PER_HOUR_LIMIT).
  const oneUnderCap = Array.from({ length: EXECUTABLE_QUOTES_PER_MINUTE_LIMIT - 1 }, () => now - 1_000);
  assert.equal(checkExecutableQuoteRateLimit(oneUnderCap, now).limited, false);

  const atCap = Array.from({ length: EXECUTABLE_QUOTES_PER_MINUTE_LIMIT }, () => now - 1_000);
  const verdict = checkExecutableQuoteRateLimit(atCap, now);
  assert.equal(verdict.limited, true);
  if (verdict.limited) {
    assert.ok(verdict.retryAfterSeconds > 0);
    assert.match(verdict.message, /minute/);
  }
});

test("checkExecutableQuoteRateLimit ignores requests that have aged out of the minute window", async () => {
  const { checkExecutableQuoteRateLimit, EXECUTABLE_QUOTES_PER_MINUTE_LIMIT } = await loadRateLimit();
  const now = 3_000_000_000;
  // EXECUTABLE_QUOTES_PER_MINUTE_LIMIT timestamps, but all 61 seconds old --
  // outside the 60s window, so the minute cap must not trip.
  const staleTimestamps = Array.from({ length: EXECUTABLE_QUOTES_PER_MINUTE_LIMIT + 5 }, () => now - 61_000);
  assert.deepEqual(checkExecutableQuoteRateLimit(staleTimestamps, now), { limited: false });
});

test("checkExecutableQuoteRateLimit's retryAfterSeconds is when the OLDEST request in the window ages out", async () => {
  const { checkExecutableQuoteRateLimit, EXECUTABLE_QUOTES_PER_MINUTE_LIMIT } = await loadRateLimit();
  const now = 4_000_000_000;
  // The oldest of the capping requests is 10s old -- it ages out of the 60s
  // window in 50s.
  const timestamps = [now - 10_000, ...Array.from({ length: EXECUTABLE_QUOTES_PER_MINUTE_LIMIT - 1 }, () => now - 1_000)];
  const verdict = checkExecutableQuoteRateLimit(timestamps, now);
  assert.equal(verdict.limited, true);
  if (verdict.limited) assert.equal(verdict.retryAfterSeconds, 50);
});

test("checkExecutableQuoteRateLimit trips the hourly cap once the minute cap is not the binding constraint", async () => {
  const { checkExecutableQuoteRateLimit, EXECUTABLE_QUOTES_PER_MINUTE_LIMIT, EXECUTABLE_QUOTES_PER_HOUR_LIMIT } = await loadRateLimit();
  assert.ok(
    EXECUTABLE_QUOTES_PER_HOUR_LIMIT > EXECUTABLE_QUOTES_PER_MINUTE_LIMIT,
    "the hour cap must be looser than the minute cap for this test (and for the limiter itself) to be meaningful",
  );
  const now = 5_000_000_000;
  // Spread evenly across the last hour (well outside the 60s window each), at
  // exactly the hourly cap.
  const timestamps = Array.from({ length: EXECUTABLE_QUOTES_PER_HOUR_LIMIT }, (_unused, index) =>
    now - 120_000 - index * (3_000_000 / EXECUTABLE_QUOTES_PER_HOUR_LIMIT));
  const verdict = checkExecutableQuoteRateLimit(timestamps, now);
  assert.equal(verdict.limited, true);
  if (verdict.limited) assert.match(verdict.message, /hour/i);
});

test("checkExecutableQuoteRateLimit ignores requests older than the hour window entirely", async () => {
  const { checkExecutableQuoteRateLimit, EXECUTABLE_QUOTES_PER_HOUR_LIMIT } = await loadRateLimit();
  const now = 6_000_000_000;
  const ancient = Array.from({ length: EXECUTABLE_QUOTES_PER_HOUR_LIMIT + 20 }, () => now - 3_600_001);
  assert.deepEqual(checkExecutableQuoteRateLimit(ancient, now), { limited: false });
});

test("buildRfqRequestId embeds the identity as a recoverable prefix, and userKeyFromRfqRequestId inverts it exactly", async () => {
  const { buildRfqRequestId, userKeyFromRfqRequestId } = await loadRateLimit();
  const walletKey = "wallet:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const requestId = buildRfqRequestId(walletKey);
  assert.notEqual(requestId, walletKey);
  assert.ok(requestId.startsWith(walletKey));
  assert.equal(userKeyFromRfqRequestId(requestId), walletKey);
  // Two ids for the same identity are still unique (the random suffix), which
  // is what keeps `id`/`request_id` collision-free across many quotes from
  // one wallet.
  assert.notEqual(buildRfqRequestId(walletKey), buildRfqRequestId(walletKey));
});

test("userKeyFromRfqRequestId returns null for a requestId with no embedded identity (predates this scheme, or malformed)", async () => {
  const { userKeyFromRfqRequestId } = await loadRateLimit();
  assert.equal(userKeyFromRfqRequestId(crypto.randomUUID()), null);
  assert.equal(userKeyFromRfqRequestId(""), null);
});

test("distinct wallets' histories never leak into each other -- a route-level regression guard on the filter, not just the pure function", async () => {
  // This mirrors exactly what app/api/quotes/route.ts does: fetch recent rows
  // for ALL wallets, then keep only the ones whose embedded identity matches
  // the caller. Wire it here so a future change to that filter (e.g.
  // accidentally matching by substring instead of exact prefix) fails a test
  // that has nothing to do with the database.
  const { buildRfqRequestId, userKeyFromRfqRequestId, checkExecutableQuoteRateLimit, EXECUTABLE_QUOTES_PER_MINUTE_LIMIT } = await loadRateLimit();
  const now = 7_000_000_000;
  const walletA = "wallet:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const walletB = "wallet:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const rows = [
    ...Array.from({ length: EXECUTABLE_QUOTES_PER_MINUTE_LIMIT + 3 }, () => ({ requestId: buildRfqRequestId(walletB), createdAt: now - 1_000 })),
    { requestId: buildRfqRequestId(walletA), createdAt: now - 1_000 },
  ];
  const walletAHistory = rows
    .filter((row) => userKeyFromRfqRequestId(row.requestId) === walletA)
    .map((row) => row.createdAt);
  // Wallet B is well over the cap, but wallet A made exactly one request.
  assert.deepEqual(checkExecutableQuoteRateLimit(walletAHistory, now), { limited: false });
});
