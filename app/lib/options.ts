export type Direction = "up" | "down";

// Off-hours, Pyth's Equity.US.NVDA/USD feed stops printing fresh updates, so
// the reference price can go stale. Tend never closes for that — instead the
// gap-risk (the price could jump before the feed resumes) gets priced into
// the premium via a bounded, monotonic vol bump. Every extra hour of
// unobserved time scales the effective volatility up by sqrt(elapsed time),
// capped so it can never push the premium past the existing 0.95×amount
// ceiling.
const GAP_RISK_VOL_SCALE_PER_HOUR = 0.35;
const GAP_RISK_MAX_VOL_MULTIPLIER = 1.75;

export function quoteFor(params: {
  spot: number;
  amount: number;
  durationMinutes: number;
  direction: Direction;
  payoff: number;
  volatility: number;
  referenceAgeSeconds?: number;
}) {
  const { spot, amount, direction, durationMinutes } = params;
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(amount) || amount <= 0) {
    throw new RangeError("Spot and amount must be positive finite values");
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1) throw new RangeError("Duration must be positive");
  if (![2, 5, 10].includes(params.payoff)) throw new RangeError("Payoff must be 2×, 5×, or 10×");
  if (!Number.isFinite(params.volatility) || params.volatility < 1 || params.volatility > 400) {
    throw new RangeError("Volatility is outside maker risk bounds");
  }
  const referenceAgeSeconds = params.referenceAgeSeconds ?? 0;
  if (!Number.isFinite(referenceAgeSeconds) || referenceAgeSeconds < 0) {
    throw new RangeError("Reference age must be a non-negative finite value");
  }
  const payoff = params.payoff;
  const gapRiskHours = referenceAgeSeconds / 3_600;
  const gapRiskMultiplier = Math.min(GAP_RISK_MAX_VOL_MULTIPLIER, 1 + GAP_RISK_VOL_SCALE_PER_HOUR * Math.sqrt(gapRiskHours));
  const volatility = (params.volatility / 100) * gapRiskMultiplier;
  const timeYears = Math.max(durationMinutes, 15) / 525_600;
  const expectedMove = volatility * Math.sqrt(timeYears);
  const directionFactor = direction === "up" ? 1 : 1.06;
  const riskFactor = Math.min(1.5, Math.max(0.65, 0.8 + expectedMove * 1.2));
  const premium = Math.min(amount * 0.95, Math.max(1, (amount / payoff) * riskFactor * directionFactor));
  const maxPayout = amount;
  const leverage = maxPayout / premium;
  const moveScale = Math.min(0.4, Math.max(0.03, expectedMove * 1.25));
  const width = spot * moveScale;
  const strikeOffset = Math.min(0.12, Math.max(0.005, expectedMove * 0.15));
  const strike = spot * (direction === "up" ? 1 + strikeOffset : 1 - strikeOffset);
  const cap = direction === "up" ? strike + width : strike - width;
  const breakeven = direction === "up"
    ? strike + (premium / maxPayout) * width
    : strike - (premium / maxPayout) * width;

  return { premium, maxPayout, leverage, strike, cap, breakeven };
}

export function definedRiskPayout(params: {
  direction: Direction;
  settlement: number;
  strike: number;
  cap: number;
  maxPayout: number;
}) {
  const { direction, settlement, strike, cap, maxPayout } = params;
  if (direction === "up") {
    if (settlement <= strike) return 0;
    return maxPayout * (Math.min(settlement, cap) - strike) / (cap - strike);
  }
  if (settlement >= strike) return 0;
  return maxPayout * (strike - Math.max(settlement, cap)) / (strike - cap);
}

// The pool must always buy back below fair value. Without a spread, a trader
// could fill a quote and immediately close it for the mid price, round-tripping
// the pool for free and bleeding LPs on every cycle. 250 bps is the floor
// discount; it widens (see `buybackFor` below) when the reference price is
// stale, because closing against a stale mark is riskier for the pool than
// closing against a fresh one.
export const BUYBACK_SPREAD_BPS = 250;

/**
 * Prices an early close (buyer sells an open pool position back to the pool
 * before expiry). Fair value is intrinsic (the same `definedRiskPayout` used
 * at settlement) plus a time-value term anchored to the premium actually
 * paid, decaying to zero as the position approaches expiry. The pool's
 * actual buyback is fair value minus a spread, so filling and immediately
 * closing a position can never be free for the trader.
 *
 * IMPORTANT: time value must NOT re-derive a volatility multiplier here.
 * `quoteFor` already prices volatility into `premium` via its own
 * `riskFactor` (`min(1.5, max(0.65, 0.8 + expectedMove * 1.2))`). An earlier
 * version of this function multiplied `premium` by an equivalent `volScale`
 * a second time, so at inception (decay = 1, intrinsic = 0) fair value came
 * out to `premium * riskFactor` -- which exceeds `premium` whenever
 * `riskFactor > 1` (high vol and/or long tenor) -- making buyback exceed the
 * premium paid and letting a trader fill-then-close for free, repeatedly,
 * draining the pool. Anchoring time value to `premium * decay` alone means
 * fair value at inception is exactly `premium`, so a same-instant round
 * trip always costs the spread, for every volatility and tenor. Genuine
 * price moves still flow through `intrinsic`, which is real P/L, not
 * arbitrage. See the round-trip-never-profitable sweep in
 * tests/close-position.test.mjs.
 */
export function buybackFor(params: {
  direction: Direction;
  spot: number;
  strike: number;
  cap: number;
  maxPayout: number;
  premium: number;
  minutesRemaining: number;
  originalMinutes: number;
  referenceAgeSeconds?: number;
}) {
  const { direction, spot, strike, cap, maxPayout, premium, minutesRemaining, originalMinutes } = params;
  if (direction !== "up" && direction !== "down") throw new RangeError("Direction must be up or down");
  if (!Number.isFinite(spot) || spot <= 0) throw new RangeError("Spot must be a positive finite value");
  if (!Number.isFinite(strike) || strike <= 0) throw new RangeError("Strike must be a positive finite value");
  if (!Number.isFinite(cap) || cap === strike) throw new RangeError("Cap must be a finite value distinct from strike");
  if (!Number.isFinite(maxPayout) || maxPayout <= 0) throw new RangeError("Max payout must be a positive finite value");
  if (!Number.isFinite(premium) || premium < 0) throw new RangeError("Premium must be a non-negative finite value");
  if (!Number.isFinite(minutesRemaining) || minutesRemaining < 0) {
    throw new RangeError("Minutes remaining must be a non-negative finite value");
  }
  if (!Number.isFinite(originalMinutes) || originalMinutes <= 0) {
    throw new RangeError("Original duration must be a positive finite value");
  }
  const referenceAgeSeconds = params.referenceAgeSeconds ?? 0;
  if (!Number.isFinite(referenceAgeSeconds) || referenceAgeSeconds < 0) {
    throw new RangeError("Reference age must be a non-negative finite value");
  }

  const intrinsic = definedRiskPayout({ direction, settlement: spot, strike, cap, maxPayout });

  // Same gap-risk widening `quoteFor` applies at entry: a stale reference
  // means more could happen before the feed resumes, so the closing spread
  // widens with it (this is the only place gap risk feeds into pricing here).
  const gapRiskHours = referenceAgeSeconds / 3_600;
  const gapRiskMultiplier = Math.min(GAP_RISK_MAX_VOL_MULTIPLIER, 1 + GAP_RISK_VOL_SCALE_PER_HOUR * Math.sqrt(gapRiskHours));

  // Time value decays to zero as minutesRemaining/originalMinutes -> 0 (sqrt
  // shape), anchored to the premium actually paid -- not re-derived from
  // volatility, which `premium` already prices in (see the doc comment above).
  const fraction = Math.max(0, Math.min(1, minutesRemaining / originalMinutes));
  const decay = Math.sqrt(fraction);
  const timeValue = Math.max(0, premium * decay);

  const fairValue = Math.min(maxPayout, intrinsic + timeValue);
  const spreadBps = BUYBACK_SPREAD_BPS * gapRiskMultiplier;
  const buyback = Math.max(0, Math.min(maxPayout, fairValue * (1 - spreadBps / 10_000)));

  if (!Number.isFinite(fairValue) || !Number.isFinite(buyback) || !Number.isFinite(spreadBps)) {
    throw new RangeError("Buyback pricing produced a non-finite result");
  }
  return { fairValue, buyback, spreadBps };
}
