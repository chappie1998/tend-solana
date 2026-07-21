// Tend is a 24/7 protocol: there is no market calendar here. Rolling market
// expiries are pure UTC clock boundaries, mirroring app/lib/expiries.ts.
//
// This module is the single source of truth for the rolling 15M/1H/EOD/7D/30D
// grid. Both scripts/bootstrap.ts (one-shot setup) and scripts/keeper.ts
// (recurring, idempotent maintenance) import it so the two can never drift
// on how expiries are computed.

export type SeriesCode = "15M" | "1H" | "EOD" | "7D" | "30D";

export const DAY_SECONDS = 86_400;

export type ScheduledSeries = {
  code: SeriesCode;
  expiry: number;
  lastTradeAt: number;
};

/**
 * A fixed onchain series cannot give every entrant exactly the same
 * duration. Select the first cadence boundary at least one full tenor in
 * the future, matching app/lib/expiries.ts's nextFixedSeries.
 */
export function nextFixedBoundary(nowSeconds: number, cadenceSeconds: number): number {
  return Math.ceil((nowSeconds + cadenceSeconds) / cadenceSeconds) * cadenceSeconds;
}

/** The next UTC midnight strictly after `target` — the daily settlement boundary. */
export function nextUtcMidnightAfter(target: number): number {
  const boundary = Math.ceil(target / DAY_SECONDS) * DAY_SECONDS;
  return boundary > target ? boundary : boundary + DAY_SECONDS;
}

/**
 * Advances `candidate` by whole `stepSeconds` increments of its own cadence
 * until it is strictly greater than `floor`. This is how the grid guarantees
 * 15M < 1H < EOD < 7D < 30D for every possible `now`: each code's natural
 * boundary is computed independently, and only collapses onto (or behind) a
 * neighbor's boundary get nudged forward, on the same clean cadence the code
 * already uses. Market ids stay a pure parameter hash — mirrors
 * app/lib/expiries.ts's advanceUntilAfter exactly.
 */
export function advanceUntilAfter(candidate: number, floor: number, stepSeconds: number): number {
  let value = candidate;
  while (value <= floor) value += stepSeconds;
  return value;
}

/**
 * Computes the current five-rung rolling grid for `now` (a Unix timestamp,
 * ideally the cluster's on-chain clock). Every call is pure and
 * deterministic: the same `now` always yields the same five expiries, and
 * the collision guard above keeps them strictly increasing.
 */
export function rollingMarketSchedule(now: number): ScheduledSeries[] {
  const fifteen = nextFixedBoundary(now, 15 * 60);
  const oneHour = advanceUntilAfter(nextFixedBoundary(now, 60 * 60), fifteen, 60 * 60);
  const eod = advanceUntilAfter(nextUtcMidnightAfter(now), oneHour, DAY_SECONDS);
  const seven = advanceUntilAfter(nextUtcMidnightAfter(now + 7 * DAY_SECONDS), eod, DAY_SECONDS);
  const thirty = advanceUntilAfter(nextUtcMidnightAfter(now + 30 * DAY_SECONDS), seven, DAY_SECONDS);
  return [
    { code: "15M", expiry: fifteen, lastTradeAt: fifteen - 60 },
    { code: "1H", expiry: oneHour, lastTradeAt: oneHour - 300 },
    { code: "EOD", expiry: eod, lastTradeAt: eod - 300 },
    { code: "7D", expiry: seven, lastTradeAt: seven - 300 },
    { code: "30D", expiry: thirty, lastTradeAt: thirty - 300 },
  ];
}
