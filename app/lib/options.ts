export type Direction = "up" | "down";

export function quoteFor(params: {
  spot: number;
  amount: number;
  days: number;
  direction: Direction;
  payoff?: number;
  volatility?: number;
}) {
  const { spot, amount, days, direction } = params;
  const payoff = Math.min(10, Math.max(2, params.payoff ?? 5));
  const volatility = Math.min(2, Math.max(0.05, (params.volatility ?? 45) / 100));
  const timeFactor = Math.sqrt(Math.max(days, 1) / 7);
  const directionFactor = direction === "up" ? 1 : 1.06;
  const riskFactor = 0.76 + volatility * 0.62 * timeFactor;
  const premium = Math.max(1, (amount / payoff) * riskFactor * directionFactor);
  const maxPayout = amount;
  const leverage = maxPayout / premium;
  const width = spot * (direction === "up" ? 0.12 : 0.1);
  const strike = spot * (direction === "up" ? 1.025 : 0.975);
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
