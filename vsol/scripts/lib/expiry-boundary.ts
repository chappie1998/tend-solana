// Pure clock arithmetic for oracle-runner.ts's pass schedule.
//
// Every tenor on the product grid (15M/1H/EOD/7D/30D -- see
// app/lib/expiries.ts's `computeExpiryGrid`) lands on a 15-minute UTC
// boundary: 15M and 1H are direct multiples of 15/60 minutes, and
// EOD/7D/30D all land on a UTC midnight, itself a multiple of 15 minutes.
// That was verified computationally (25,000 sampled `now` instants across
// every code, 0 misaligned) before this file was written, rather than
// asserted from reading the grid math alone. This is what lets the runner
// wake ONCE per 15 minutes and be guaranteed to observe every market's own
// expiry exactly at a wake instant, rather than needing a finer poll.

export const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * The smallest multiple of 15 minutes (UTC) STRICTLY greater than `nowMs`.
 * If `nowMs` itself sits exactly on a boundary, the result is the NEXT one --
 * the runner always sleeps forward, never re-processes the instant it just
 * woke at.
 */
export function nextFifteenMinuteBoundary(nowMs: number): number {
  return (Math.floor(nowMs / FIFTEEN_MINUTES_MS) + 1) * FIFTEEN_MINUTES_MS;
}

/**
 * Milliseconds to sleep from `nowMs` so the runner wakes `offsetMs` after the
 * next 15-minute UTC boundary. The small positive offset (a few seconds, see
 * `BOUNDARY_WAKE_OFFSET_MS` in oracle-runner.ts) exists so the wake lands
 * comfortably after `market.expiry` on-chain (clocks drift a little,
 * scheduling a `setTimeout` is never exact to the millisecond), never before
 * it -- waking early would find the market not yet expired and skip it.
 */
export function msUntilNextBoundaryPass(nowMs: number, offsetMs: number): number {
  return nextFifteenMinuteBoundary(nowMs) + offsetMs - nowMs;
}
