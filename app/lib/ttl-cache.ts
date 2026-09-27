// A single-entry TTL cache with in-flight de-duplication -- the same pattern
// app/lib/preipo-market-data.ts's `pairCache`/`barsCache` already use keyed
// per mint/pool, generalized here to ONE cached value rather than one per
// key. app/api/vsol/status/route.ts is hit by every visitor on a page that
// polls it, and its handler does a Promise.all of several RPC/DB reads; this
// is what lets many concurrent requests share a single in-flight computation
// and a single cached result for a short window, rather than each one
// re-running the full RPC/DB round trip.
//
// A rejected `compute()` is never cached -- the next caller (whether a
// concurrently-waiting one or a later one) gets a fresh attempt, exactly the
// same "don't cache a failure as if it were a success" contract every other
// cache in this codebase already follows.

export type SingleEntryTtlCache<T> = {
  /** Returns the cached value if still fresh, joins an in-flight computation if one is running, or starts a new one. */
  get(): Promise<T>;
  /** Drops any cached value and in-flight promise, forcing the next `get()` to recompute. */
  invalidate(): void;
};

export function createSingleEntryTtlCache<T>(params: {
  ttlMs: number;
  compute: () => Promise<T>;
  /** Injectable for tests; defaults to the real wall clock. */
  clock?: () => number;
}): SingleEntryTtlCache<T> {
  const clock = params.clock ?? Date.now;
  let cached: { expiresAt: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;

  async function get(): Promise<T> {
    const now = clock();
    if (cached && cached.expiresAt > now) return cached.value;
    if (inFlight) return inFlight;

    const request = params.compute().then(
      (value) => {
        cached = { expiresAt: clock() + params.ttlMs, value };
        inFlight = null;
        return value;
      },
      (error: unknown) => {
        inFlight = null;
        throw error;
      },
    );
    inFlight = request;
    return request;
  }

  function invalidate(): void {
    cached = null;
    inFlight = null;
  }

  return { get, invalidate };
}
