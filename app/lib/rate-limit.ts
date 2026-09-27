// Authoritative, durable rate limiting for EXECUTABLE quotes
// (app/api/quotes/route.ts, intent === "execute"). An executable quote can
// trigger a REAL on-chain listing transaction paid for by the server
// (listVsolSeriesOnChain, ~0.006 SOL of rent) whenever the resolved strike
// isn't already listed -- so this is the cap that actually protects the
// server's SOL. It is backed by the existing `rfq_quotes` table (see
// db/schema.ts) precisely so it holds across every serverless
// instance/region, unlike app/lib/in-memory-rate-limit.ts's best-effort,
// per-instance limiter.
//
// No new column, no migration: `rfq_quotes` has no wallet column, and this
// change is scoped to avoid adding one. Instead the caller's AUTHENTICATED
// identity -- `resolveUserKey(request)`'s return value (e.g. "wallet:<base58
// pubkey>"), never the unauthenticated `walletAddress` request field, which
// merely names the buyer the quote is FOR and can be set to an arbitrary
// pubkey with no proof of ownership -- is embedded as a prefix of
// `requestId`, delimited by RFQ_REQUEST_ID_DELIMITER. Every identity shape
// this project produces (a base58 wallet key, or the email-shaped ChatGPT /
// localhost fallbacks in app/lib/session.ts) is free of that delimiter, so
// splitting on its first occurrence is unambiguous.

import { randomUUID } from "node:crypto";

/** Separates the embedded identity from the random suffix in `requestId`. Chosen because
 * neither a base58 wallet address nor this project's email-shaped fallback identities
 * (see app/lib/session.ts) can contain it. */
export const RFQ_REQUEST_ID_DELIMITER = "::";

/** Builds an `rfq_quotes.request_id` value that embeds the requester's identity for later rate-limit lookups. */
export function buildRfqRequestId(userKey: string): string {
  return `${userKey}${RFQ_REQUEST_ID_DELIMITER}${randomUUID()}`;
}

/** Recovers the identity embedded by `buildRfqRequestId`, or null for a requestId predating this scheme. */
export function userKeyFromRfqRequestId(requestId: string): string | null {
  const index = requestId.indexOf(RFQ_REQUEST_ID_DELIMITER);
  return index === -1 ? null : requestId.slice(0, index);
}

/**
 * Per-identity caps on EXECUTABLE quotes.
 *
 * Sized for a human re-pricing a ticket by hand: the auto-quote debounce is
 * 600ms (AUTO_QUOTE_DEBOUNCE_MS in app/lib/quote-readiness.ts) but auto-quotes
 * are always INDICATIVE (never rate-limited here) -- a person actually
 * clicking "Review & execute" repeatedly tops out at a handful of times a
 * minute. The hourly figure bounds the worst case a per-minute cap alone
 * cannot: a caller that waits out the per-minute window and repeats. At the
 * measured ~0.006 SOL listing rent per unlisted strike, the hourly cap bounds
 * ONE identity's worst-case drain to EXECUTABLE_QUOTES_PER_HOUR_LIMIT * 0.006
 * SOL ≈ 0.15 SOL/hour -- annoying if hit by a real trader, cheap for the
 * server to absorb even if every listing happens to be a fresh strike.
 */
export const EXECUTABLE_QUOTES_PER_MINUTE_LIMIT = 5;
export const EXECUTABLE_QUOTES_PER_HOUR_LIMIT = 25;

export type RateLimitVerdict =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number; message: string };

/**
 * Pure decision function over already-fetched timestamps: the caller queries
 * `rfq_quotes` for this identity's rows from roughly the last hour and passes
 * their `createdAt` millis here. Kept import-free of the database and
 * side-effect-free -- exactly like `checkVsolPoolDepth` in
 * app/lib/vsol-server.ts -- so it is unit-testable with no live database (see
 * tests/rate-limit.test.mjs) and the route only has to stub the DB read, not
 * this logic.
 */
export function checkExecutableQuoteRateLimit(recentCreatedAtMs: readonly number[], now: number): RateLimitVerdict {
  const oneMinuteAgo = now - 60_000;
  const inLastMinute = recentCreatedAtMs.filter((ms) => ms > oneMinuteAgo).sort((a, b) => a - b);
  if (inLastMinute.length >= EXECUTABLE_QUOTES_PER_MINUTE_LIMIT) {
    // Retry-After: when the OLDEST request inside the window ages out of it.
    const retryAfterSeconds = Math.max(1, Math.ceil((inLastMinute[0] + 60_000 - now) / 1000));
    return {
      limited: true,
      retryAfterSeconds,
      message: `Too many executable quotes requested in the last minute. Wait ${retryAfterSeconds}s and try again.`,
    };
  }

  const oneHourAgo = now - 3_600_000;
  const inLastHour = recentCreatedAtMs.filter((ms) => ms > oneHourAgo).sort((a, b) => a - b);
  if (inLastHour.length >= EXECUTABLE_QUOTES_PER_HOUR_LIMIT) {
    const retryAfterSeconds = Math.max(1, Math.ceil((inLastHour[0] + 3_600_000 - now) / 1000));
    return {
      limited: true,
      retryAfterSeconds,
      message: `Hourly executable-quote limit reached. Wait ${Math.ceil(retryAfterSeconds / 60)} minute(s) and try again.`,
    };
  }

  return { limited: false };
}
