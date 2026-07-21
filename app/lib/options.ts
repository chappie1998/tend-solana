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
