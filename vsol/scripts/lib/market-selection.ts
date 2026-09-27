import type { DecodedMarketForCleanup } from "./settlement.ts";

/**
 * The runner's per-boundary work list: markets that BOTH expire at exactly
 * this 15-minute UTC boundary AND have at least one open pool position (or
 * direct-maker position -- see `marketsWithOpenPositions` in
 * lib/settlement.ts, whose result is exactly the set this function expects
 * as `marketsWithOpenPositions`). A market with no open interest gets NOTHING
 * published for it: nobody is waiting on its settlement, so spending a
 * transaction on `update_custom_price_feed` + `capture_custom_settlement_observation`
 * for it would be pure cost with no benefit -- this filter is the main
 * source of the savings this runner exists for (see oracle-runner.ts's module
 * doc). A market that expired at an EARLIER boundary (missed while the
 * runner was down, or simply never captured in its own window) is
 * deliberately NOT re-selected here: its 30-second capture window is judged
 * against `market.expiry`, not against this pass's boundary, so trying to
 * capture it now would only ever fail on-chain with `InvalidObservationTime`.
 * Such a position is handled by the refund sweep instead (see
 * oracle-runner.ts), never by this function.
 */
export function selectMarketsAtBoundaryWithOpenInterest(params: {
  markets: readonly DecodedMarketForCleanup[];
  boundaryUnixSeconds: number;
  marketsWithOpenPositions: ReadonlySet<string>;
}): DecodedMarketForCleanup[] {
  return params.markets.filter((market) =>
    market.expiry === params.boundaryUnixSeconds && params.marketsWithOpenPositions.has(market.address));
}

/**
 * The STARTUP-ONLY catch-up variant: any market that has already expired
 * (not just one landing exactly on the current boundary) and still has open
 * interest. Used once, right after the runner starts, for whatever expired
 * while it was down. Deliberately broader than
 * `selectMarketsAtBoundaryWithOpenInterest` -- a market whose capture window
 * has already elapsed will simply fail cleanly on-chain
 * (`InvalidObservationTime`/`SettlementWindowClosed`) when the runner
 * attempts it, which oracle-runner.ts already treats as a per-market skip,
 * never a crash; a market whose window is still open (the runner was down
 * for only a few minutes) gets captured exactly as if this had been its
 * regular boundary pass.
 */
export function selectExpiredMarketsWithOpenInterest(params: {
  markets: readonly DecodedMarketForCleanup[];
  now: number;
  marketsWithOpenPositions: ReadonlySet<string>;
}): DecodedMarketForCleanup[] {
  return params.markets.filter((market) => market.expiry <= params.now && params.marketsWithOpenPositions.has(market.address));
}
