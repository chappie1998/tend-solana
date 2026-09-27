import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("createSingleEntryTtlCache de-duplicates concurrent calls into ONE underlying compute()", async () => {
  const { createSingleEntryTtlCache } = await import(new URL("app/lib/ttl-cache.ts", root));
  let computeCalls = 0;
  let resolveCompute;
  const gate = new Promise((resolve) => { resolveCompute = resolve; });
  const cache = createSingleEntryTtlCache({
    ttlMs: 20_000,
    compute: async () => { computeCalls += 1; return gate; },
  });

  const [a, b, c] = [cache.get(), cache.get(), cache.get()];
  assert.equal(computeCalls, 1, "three concurrent callers must share ONE in-flight computation");
  resolveCompute("shared-value");
  assert.deepEqual(await Promise.all([a, b, c]), ["shared-value", "shared-value", "shared-value"]);

  // A call after resolution reuses the now-cached value -- still one call total.
  assert.equal(await cache.get(), "shared-value");
  assert.equal(computeCalls, 1);
});

test("createSingleEntryTtlCache recomputes once the TTL has elapsed", async () => {
  const { createSingleEntryTtlCache } = await import(new URL("app/lib/ttl-cache.ts", root));
  let now = 0;
  let computeCalls = 0;
  const cache = createSingleEntryTtlCache({
    ttlMs: 20_000,
    compute: async () => { computeCalls += 1; return `value-${computeCalls}`; },
    clock: () => now,
  });

  assert.equal(await cache.get(), "value-1");
  now += 19_999;
  assert.equal(await cache.get(), "value-1", "still within the TTL window");
  assert.equal(computeCalls, 1);

  now += 2; // now 20_001ms after the first fetch, past the 20s TTL
  assert.equal(await cache.get(), "value-2");
  assert.equal(computeCalls, 2);
});

test("a rejected compute() is never cached, so the next call retries instead of repeating the failure forever", async () => {
  const { createSingleEntryTtlCache } = await import(new URL("app/lib/ttl-cache.ts", root));
  let computeCalls = 0;
  const cache = createSingleEntryTtlCache({
    ttlMs: 20_000,
    compute: async () => {
      computeCalls += 1;
      if (computeCalls === 1) throw new Error("RPC unavailable");
      return "recovered";
    },
  });

  await assert.rejects(() => cache.get(), /RPC unavailable/);
  assert.equal(await cache.get(), "recovered");
  assert.equal(computeCalls, 2);
});

test("concurrent callers during a failing computation all see the same rejection, not a stuck in-flight promise", async () => {
  const { createSingleEntryTtlCache } = await import(new URL("app/lib/ttl-cache.ts", root));
  let rejectCompute;
  const gate = new Promise((_, reject) => { rejectCompute = reject; });
  const cache = createSingleEntryTtlCache({ ttlMs: 20_000, compute: async () => gate });

  const [a, b] = [cache.get(), cache.get()];
  rejectCompute(new Error("boom"));
  await assert.rejects(() => a, /boom/);
  await assert.rejects(() => b, /boom/);

  // Recovers cleanly afterward.
  const recovered = createSingleEntryTtlCache({ ttlMs: 20_000, compute: async () => "ok" });
  assert.equal(await recovered.get(), "ok");
});

test("invalidate() forces the next get() to recompute even within the TTL window", async () => {
  const { createSingleEntryTtlCache } = await import(new URL("app/lib/ttl-cache.ts", root));
  let computeCalls = 0;
  const cache = createSingleEntryTtlCache({
    ttlMs: 20_000,
    compute: async () => { computeCalls += 1; return `value-${computeCalls}`; },
  });
  assert.equal(await cache.get(), "value-1");
  cache.invalidate();
  assert.equal(await cache.get(), "value-2");
  assert.equal(computeCalls, 2);
});
