import assert from "node:assert/strict";
import test from "node:test";

// Best-effort, per-instance burst limiter (app/lib/in-memory-rate-limit.ts)
// applied to every mutating API route (app/api/quotes, app/api/vsol/send,
// app/api/vsol/faucet, app/api/positions POST). It is explicitly NOT the
// control that protects the server's funds -- see tests/rate-limit.test.mjs
// and the file's own doc comment -- but it still has to behave correctly:
// allow a burst up to the bucket's limit, block the next request in the same
// window, and reset once the window elapses. `checkFixedWindow` is pure and
// side-effect-free, so these tests never touch the module-scope Map that
// `enforceInMemoryRateLimit` wraps for real callers.
const root = new URL("../", import.meta.url);

async function loadLimiter() {
  return import(new URL("app/lib/in-memory-rate-limit.ts", root));
}

test("checkFixedWindow starts a fresh window on the first request for a key", async () => {
  const { checkFixedWindow } = await loadLimiter();
  const config = { limit: 3, windowMs: 60_000 };
  const result = checkFixedWindow(undefined, config, 1_000);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.nextState, { count: 1, windowStartMs: 1_000 });
});

test("checkFixedWindow allows requests up to the limit within the window, then blocks", async () => {
  const { checkFixedWindow } = await loadLimiter();
  const config = { limit: 3, windowMs: 60_000 };
  let state = checkFixedWindow(undefined, config, 0).nextState;
  state = checkFixedWindow(state, config, 100).nextState;
  const third = checkFixedWindow(state, config, 200);
  assert.equal(third.allowed, true);
  assert.equal(third.nextState.count, 3);

  const fourth = checkFixedWindow(third.nextState, config, 300);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.nextState, third.nextState, "a blocked request must not mutate the counted state");
  assert.ok(fourth.retryAfterSeconds > 0);
});

test("checkFixedWindow's retryAfterSeconds counts down to when the CURRENT window ends", async () => {
  const { checkFixedWindow } = await loadLimiter();
  const config = { limit: 1, windowMs: 60_000 };
  const first = checkFixedWindow(undefined, config, 10_000);
  const blocked = checkFixedWindow(first.nextState, config, 40_000); // 30s into the window
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 30); // 60s window - 30s elapsed
});

test("checkFixedWindow resets once the window has fully elapsed, even after being at the limit", async () => {
  const { checkFixedWindow } = await loadLimiter();
  const config = { limit: 1, windowMs: 60_000 };
  const first = checkFixedWindow(undefined, config, 0);
  const blocked = checkFixedWindow(first.nextState, config, 30_000);
  assert.equal(blocked.allowed, false);
  const afterWindow = checkFixedWindow(blocked.nextState, config, 60_000);
  assert.equal(afterWindow.allowed, true);
  assert.deepEqual(afterWindow.nextState, { count: 1, windowStartMs: 60_000 });
});

test("enforceInMemoryRateLimit isolates buckets, IPs, and wallet identities from each other", async () => {
  const { enforceInMemoryRateLimit, IN_MEMORY_RATE_LIMIT_BUCKETS } = await loadLimiter();
  const limit = IN_MEMORY_RATE_LIMIT_BUCKETS.faucet.limit;
  const requestFrom = (ip) => new Request("https://example.test/api/vsol/faucet", { headers: { "x-forwarded-for": ip } });

  // Exhaust the faucet bucket for one IP + wallet pair.
  for (let i = 0; i < limit; i += 1) {
    const verdict = enforceInMemoryRateLimit(requestFrom("203.0.113.1"), "faucet", "wallet:A");
    assert.equal(verdict.limited, false, `request ${i} should be within the burst limit`);
  }
  const exhausted = enforceInMemoryRateLimit(requestFrom("203.0.113.1"), "faucet", "wallet:A");
  assert.equal(exhausted.limited, true);
  if (exhausted.limited) assert.ok(exhausted.retryAfterSeconds > 0);

  // A different wallet from the SAME IP gets its own budget.
  const differentWallet = enforceInMemoryRateLimit(requestFrom("203.0.113.1"), "faucet", "wallet:B");
  assert.equal(differentWallet.limited, false);

  // The same wallet from a DIFFERENT IP also gets its own budget.
  const differentIp = enforceInMemoryRateLimit(requestFrom("203.0.113.2"), "faucet", "wallet:A");
  assert.equal(differentIp.limited, false);

  // A different BUCKET for the same IP + wallet is unaffected by the
  // exhausted faucet bucket.
  const differentBucket = enforceInMemoryRateLimit(requestFrom("203.0.113.1"), "quotes", "wallet:A");
  assert.equal(differentBucket.limited, false);
});

test("enforceInMemoryRateLimit takes only the first hop of x-forwarded-for, and falls back to a shared key when it is absent", async () => {
  const { enforceInMemoryRateLimit } = await loadLimiter();
  const withProxyChain = new Request("https://example.test/api/vsol/faucet", {
    headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1, 10.0.0.2" },
  });
  const withOnlyClientIp = new Request("https://example.test/api/vsol/faucet", {
    headers: { "x-forwarded-for": "198.51.100.9" },
  });
  // Both should key identically (first hop only) -- exhaust via one, confirm
  // the other sees the same budget.
  const { IN_MEMORY_RATE_LIMIT_BUCKETS } = await loadLimiter();
  const limit = IN_MEMORY_RATE_LIMIT_BUCKETS.faucet.limit;
  for (let i = 0; i < limit; i += 1) {
    enforceInMemoryRateLimit(withProxyChain, "faucet", "wallet:proxy-test");
  }
  const verdict = enforceInMemoryRateLimit(withOnlyClientIp, "faucet", "wallet:proxy-test");
  assert.equal(verdict.limited, true, "the same first-hop IP must share the same budget regardless of trailing proxy hops");

  // No header at all: does not throw, degrades to a shared "unknown" key.
  const noHeader = new Request("https://example.test/api/vsol/faucet");
  assert.doesNotThrow(() => enforceInMemoryRateLimit(noHeader, "faucet", "wallet:no-header-test"));
});

test("the module documents that this limiter is per-instance/best-effort and x-forwarded-for is never trusted for security", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("app/lib/in-memory-rate-limit.ts", root), "utf8");
  assert.match(source, /best-effort/i);
  assert.match(source, /per-instance|per instance/i);
  assert.match(source, /NEVER.*security-critical|never.*security-critical/i);
});
