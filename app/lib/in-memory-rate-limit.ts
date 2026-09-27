// Best-effort, per-instance burst limiter for mutating API routes
// (app/api/quotes, app/api/vsol/send, app/api/vsol/faucet, and the POST
// handler of app/api/positions).
//
// This is NOT the control that protects the server's funds -- see
// app/lib/rate-limit.ts's doc comment for why an executable VSOL quote needs
// a database-backed cap instead. This module only blunts a rapid burst FROM
// ONE SERVERLESS INSTANCE before it reaches downstream work (devnet RPC
// calls, DB writes, wallet-funding transfers): Vercel can run many instances
// of the same route concurrently, each with its own copy of the Map below,
// and any redeploy/cold start clears it -- so a determined caller can always
// get more requests through than the numbers here suggest, by hitting a
// fresh instance or spreading requests across source IPs. Route handlers
// that touch money or chain state must layer their OWN authoritative check
// on top (session/signature verification, the executable-quote DB cap,
// etc.); this is a dampener, not a defense.
//
// The client IP (`x-forwarded-for`) is part of the key ONLY as a burst
// dampener, NEVER for anything security-critical: it is an ordinary,
// client-influenceable HTTP header that this app does not control the edge
// for, so it must never be trusted the way a verified session is. It is
// combined with the caller's authenticated wallet identity (when present, and
// always `resolveUserKey`'s return value -- never the unauthenticated
// request-body `walletAddress`) so a signed-in abuser can't reset their
// budget for free by reconnecting from the same IP under a different wallet,
// and so one shared IP (a NAT, a campus network) doesn't get one combined
// budget across unrelated users.

export type RateLimitBucketConfig = {
  /** Max requests allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

// One bucket per mutating route this file protects. Limits are generous
// relative to real usage -- auto-quoting alone can fire every 600ms while a
// ticket is being edited (AUTO_QUOTE_DEBOUNCE_MS in app/lib/quote-readiness.ts)
// -- but bound a single instance's exposure to a scripted burst between
// restarts.
export const IN_MEMORY_RATE_LIMIT_BUCKETS = {
  // Covers BOTH quote intents (indicative auto-quoting is the frequent case).
  quotes: { limit: 40, windowMs: 60_000 },
  // Submits a signed transaction to devnet -- one per genuine fill attempt.
  vsolSend: { limit: 20, windowMs: 60_000 },
  // Mints real devnet SOL/tokens to the caller; the tightest bucket here.
  faucet: { limit: 5, windowMs: 60_000 },
  // Persists a confirmed fill -- one per genuine fill attempt.
  positions: { limit: 20, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitBucketConfig>;

export type InMemoryRateLimitBucket = keyof typeof IN_MEMORY_RATE_LIMIT_BUCKETS;

type WindowState = { count: number; windowStartMs: number };

// Module-scope, per-instance state (see the file doc comment above) -- reset
// on every cold start/redeploy, and not shared across instances.
const windows = new Map<string, WindowState>();

/**
 * Pure fixed-window check over explicit state (resets the window once it
 * elapses, rather than a true sliding window -- simple, and adequate for a
 * dampener rather than an authoritative limiter). Side-effect-free so it's
 * directly unit-testable (see tests/in-memory-rate-limit.test.mjs) without
 * touching the module-scope Map, which `enforceInMemoryRateLimit` wraps for
 * real callers.
 */
export function checkFixedWindow(
  state: WindowState | undefined,
  config: RateLimitBucketConfig,
  now: number,
): { allowed: boolean; nextState: WindowState; retryAfterSeconds: number } {
  if (!state || now - state.windowStartMs >= config.windowMs) {
    return { allowed: true, nextState: { count: 1, windowStartMs: now }, retryAfterSeconds: 0 };
  }
  if (state.count < config.limit) {
    return { allowed: true, nextState: { count: state.count + 1, windowStartMs: state.windowStartMs }, retryAfterSeconds: 0 };
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((state.windowStartMs + config.windowMs - now) / 1000));
  return { allowed: false, nextState: state, retryAfterSeconds };
}

/**
 * Best-effort only (see the file doc comment): the first hop in
 * `x-forwarded-for`, or "unknown" when the header is absent (e.g. a direct,
 * non-proxied request in local dev). Never used for anything security-critical.
 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

export type InMemoryRateLimitVerdict = { limited: false } | { limited: true; retryAfterSeconds: number };

/**
 * Real entry point for route handlers: keys the shared, module-scope window
 * map by bucket + client IP + (when present) the caller's authenticated
 * wallet identity, and mutates it in place.
 *
 * `walletKey` must be `resolveUserKey(request)`'s return value (or null
 * before sign-in) -- never the unauthenticated request-body `walletAddress`,
 * which names the buyer a quote is FOR and proves nothing about who is
 * calling (see app/lib/rate-limit.ts's doc comment for the same distinction
 * on the DB-backed cap).
 */
export function enforceInMemoryRateLimit(
  request: Request,
  bucket: InMemoryRateLimitBucket,
  walletKey: string | null,
): InMemoryRateLimitVerdict {
  const key = `${bucket}:${clientIp(request)}:${walletKey ?? ""}`;
  const now = Date.now();
  const result = checkFixedWindow(windows.get(key), IN_MEMORY_RATE_LIMIT_BUCKETS[bucket], now);
  windows.set(key, result.nextState);
  if (!result.allowed) return { limited: true, retryAfterSeconds: result.retryAfterSeconds };
  return { limited: false };
}
