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
// the pool for free and bleeding LPs on every cycle. Real options venues don't
// hold that spread flat: it's tight for liquid near-the-money, short-dated
// positions and widens for far out-of-the-money or long-dated ones, because
// the writer's hedging/inventory risk scales with both. `dynamicSpreadBps`
// below composes three bounded, multiplicative factors on top of this floor:
//   spreadBps = BASE * moneynessFactor * timeFactor * gapRiskMultiplier
// each factor is >= 1, so the composed spread is never below BASE and the
// result is hard-capped at BUYBACK_MAX_SPREAD_BPS. Because every factor is
// bounded below by 1, `dynamicSpreadBps(...) >= BUYBACK_BASE_SPREAD_BPS`
// always -- which is what keeps the fill-then-immediately-close round trip
// unprofitable for every input (see the sweep in
// tests/close-position.test.mjs): that invariant only ever needed the spread
// to be at least the old flat 250 bps, never exactly it.
export const BUYBACK_BASE_SPREAD_BPS = 250;

// Hard ceiling: however far out-of-the-money, long-dated, or stale the
// inputs are, the pool never discounts a buyback by more than this.
export const BUYBACK_MAX_SPREAD_BPS = 1_500;

// Moneyness: widths (strike -> cap distance) past the strike, on the losing
// side, before the moneyness multiplier saturates at its max.
export const BUYBACK_MONEYNESS_OTM_WIDTHS = 1;
// At full saturation (a full width out-of-the-money) the spread is this many
// times the base -- before the time and gap-risk factors are applied.
export const BUYBACK_MONEYNESS_MAX_MULTIPLIER = 3;

// Time to expiry: at full time remaining the spread is this many times the
// base (before moneyness/gap-risk); it relaxes linearly toward 1x (no
// widening) as minutesRemaining/originalMinutes -> 0.
export const BUYBACK_TIME_MAX_MULTIPLIER = 2;

/** @deprecated Kept for backward compatibility -- equals `BUYBACK_BASE_SPREAD_BPS`,
 * the tightest (near-the-money, short-dated, fresh-reference) floor of the
 * dynamic spread. Spread is no longer flat; see `dynamicSpreadBps`. */
export const BUYBACK_SPREAD_BPS = BUYBACK_BASE_SPREAD_BPS;

/**
 * The closing spread (in bps) the pool applies to an early-close fair value,
 * as a base floor scaled by three bounded, multiplicative factors:
 *
 * - moneyness: how far spot sits from strike relative to the option's width
 *   (strike -> cap distance). At or past the strike (spot already on the
 *   favorable side) the factor is 1 (tightest); it scales up to
 *   `BUYBACK_MONEYNESS_MAX_MULTIPLIER` as spot moves up to
 *   `BUYBACK_MONEYNESS_OTM_WIDTHS` widths past the strike on the losing
 *   side, and saturates there.
 * - time to expiry: `fraction = minutesRemaining / originalMinutes`. More
 *   time remaining means more can happen before the pool can unwind its
 *   hedge, so the factor scales from 1 (at expiry) up to
 *   `BUYBACK_TIME_MAX_MULTIPLIER` (at full time remaining).
 * - gap risk: identical widening to `quoteFor`'s entry pricing -- a stale
 *   reference is riskier to close against.
 *
 * Every factor is bounded below by 1, so the result is always
 * >= `BUYBACK_BASE_SPREAD_BPS`, and it is hard-capped at
 * `BUYBACK_MAX_SPREAD_BPS`.
 */
export function dynamicSpreadBps(params: {
  direction: Direction;
  spot: number;
  strike: number;
  cap: number;
  fraction: number;
  referenceAgeSeconds?: number;
}): number {
  const { direction, spot, strike, cap } = params;
  const fraction = Math.max(0, Math.min(1, params.fraction));
  const referenceAgeSeconds = params.referenceAgeSeconds ?? 0;

  const width = Math.abs(cap - strike);
  const signedMoneyness = direction === "up" ? (spot - strike) / width : (strike - spot) / width;
  const otmWidths = Math.max(0, Math.min(BUYBACK_MONEYNESS_OTM_WIDTHS, -signedMoneyness)) / BUYBACK_MONEYNESS_OTM_WIDTHS;
  const moneynessFactor = 1 + (BUYBACK_MONEYNESS_MAX_MULTIPLIER - 1) * otmWidths;

  const timeFactor = 1 + (BUYBACK_TIME_MAX_MULTIPLIER - 1) * fraction;

  const gapRiskHours = referenceAgeSeconds / 3_600;
  const gapRiskMultiplier = Math.min(GAP_RISK_MAX_VOL_MULTIPLIER, 1 + GAP_RISK_VOL_SCALE_PER_HOUR * Math.sqrt(gapRiskHours));

  const raw = BUYBACK_BASE_SPREAD_BPS * moneynessFactor * timeFactor * gapRiskMultiplier;
  return Math.min(BUYBACK_MAX_SPREAD_BPS, raw);
}

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

  // Time value decays to zero as minutesRemaining/originalMinutes -> 0 (sqrt
  // shape), anchored to the premium actually paid -- not re-derived from
  // volatility, which `premium` already prices in (see the doc comment above).
  const fraction = Math.max(0, Math.min(1, minutesRemaining / originalMinutes));
  const decay = Math.sqrt(fraction);
  const timeValue = Math.max(0, premium * decay);

  const fairValue = Math.min(maxPayout, intrinsic + timeValue);
  // Moneyness + time-to-expiry + gap-risk, composed multiplicatively and
  // bounded -- see `dynamicSpreadBps` above. This never re-touches the
  // fair-value math above; it only scales the discount applied to it.
  const spreadBps = dynamicSpreadBps({ direction, spot, strike, cap, fraction, referenceAgeSeconds });
  const buyback = Math.max(0, Math.min(maxPayout, fairValue * (1 - spreadBps / 10_000)));

  if (!Number.isFinite(fairValue) || !Number.isFinite(buyback) || !Number.isFinite(spreadBps)) {
    throw new RangeError("Buyback pricing produced a non-finite result");
  }
  return { fairValue, buyback, spreadBps };
}
