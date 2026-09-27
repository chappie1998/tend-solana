// Frugal, crash-proof retry policy for oracle-runner.ts. Every lane pass is
// wrapped so a transient error (a dropped connection, an RPC provider's rate
// limit, a quota exhaustion) is logged and retried with GROWING delay, rather
// than either crashing the process (a pusher died last week on an unhandled
// `fetch failed` / `ETIMEDOUT`) or hammering the same failing endpoint every
// few seconds (the old 5-second settlement poller's own failure mode, which
// is what exhausted the RPC provider's monthly quota in the first place).

export const DEFAULT_BACKOFF_BASE_MS = 5_000;
// "capped at a few minutes" per the operating brief.
export const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;

/** True for an RPC/HTTP rate-limit or quota rejection: HTTP 429, the JSON-RPC `-32429 "max usage reached"` code some providers use, or a generic "rate limit" message. */
export function isRateLimitedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message) || /-32429/.test(message) || /max usage reached/i.test(message) || /rate.?limit/i.test(message);
}

/** True for a transient network fault (a dropped connection, a timeout) rather than an application-level rejection. */
export function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed/i.test(message) || /\bETIMEDOUT\b/.test(message) || /\bECONNRESET\b/.test(message)
    || /\bENOTFOUND\b/.test(message) || /socket hang up/i.test(message);
}

/**
 * Exponential backoff that only grows for rate-limit/quota and transient
 * network errors -- an ordinary application-level skip (a market not yet
 * expired, an oracle already finalized by someone else) is not this
 * controller's concern at all; those are handled as ordinary skips inside a
 * pass, never thrown up to the lane's `onFailure`, so they never reach this
 * class. Any OTHER thrown error resets the delay to the base rather than
 * compounding across unrelated failures, so one genuine bug does not slowly
 * ratchet the runner into a multi-minute stall on every subsequent pass.
 */
export class BackoffController {
  private currentMs: number;

  constructor(private readonly baseMs: number = DEFAULT_BACKOFF_BASE_MS, private readonly maxMs: number = DEFAULT_BACKOFF_MAX_MS) {
    this.currentMs = baseMs;
  }

  /** Call once per failed pass. Returns the delay (ms) to wait before the next attempt. */
  onFailure(error: unknown): number {
    if (isRateLimitedError(error) || isTransientNetworkError(error)) {
      const delay = this.currentMs;
      this.currentMs = Math.min(this.currentMs * 2, this.maxMs);
      return delay;
    }
    this.currentMs = this.baseMs;
    return this.baseMs;
  }

  /** Call once per successful pass, so a resolved outage does not leave the NEXT unrelated failure starting from a stale, still-elevated delay. */
  onSuccess(): void {
    this.currentMs = this.baseMs;
  }
}
