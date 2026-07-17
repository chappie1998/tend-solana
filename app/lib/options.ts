export type Direction = "up" | "down";

export function quoteFor(params: {
  spot: number;
  amount: number;
  days?: number;
  durationMinutes?: number;
  direction: Direction;
  payoff?: number;
  volatility?: number;
}) {
  const { spot, amount, direction } = params;
  const durationMinutes = params.durationMinutes ?? Math.max(1, params.days ?? 7) * 1_440;
  const payoff = Math.min(10, Math.max(2, params.payoff ?? 5));
  const volatility = Math.min(2, Math.max(0.05, (params.volatility ?? 45) / 100));
  const timeFactor = Math.sqrt(Math.max(durationMinutes, 15) / 10_080);
  const directionFactor = direction === "up" ? 1 : 1.06;
  const riskFactor = 0.18 + volatility * 2 * timeFactor;
  const premium = Math.max(1, (amount / payoff) * riskFactor * directionFactor);
  const maxPayout = amount;
  const leverage = maxPayout / premium;
  const moveScale = Math.min(2, Math.max(0.08, timeFactor));
  const width = spot * (direction === "up" ? 0.12 : 0.1) * moveScale;
  const strikeOffset = 0.025 * moveScale;
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
