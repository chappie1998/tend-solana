// Pure parameter derivation for the permissionless Launch flows. Series
// created here land on the same 24/7 UTC expiry grid and use the exact
// policy constants the devnet bootstrap used, so identical series parameters
// always hash to the same deterministic market id and PDA (no duplicates).

// The explicit .ts extension keeps this module importable by the node:test
// suite (type stripping) as well as the bundler.
import { resolveExpiry, type ExpiryCode } from "./expiries.ts";

// Policy constants mirroring vsol/scripts/bootstrap.ts and the program bounds
// (MIN_MARKET_LEAD_SECONDS=15, observation<=3600, grace<=604800, conf<=2000).
export const LAUNCH_OBSERVATION_WINDOW_SECONDS = 30;
export const LAUNCH_SETTLEMENT_GRACE_SECONDS = 900;
export const LAUNCH_MAX_CONFIDENCE_BPS = 500;
export const LAUNCH_PRICE_SCALE = 1_000_000n;
export const LAUNCH_MIN_LEAD_SECONDS = 15;
// Bounds how old a tier-2 last-known Pyth price may be relative to expiry
// before settlement falls back to a refund. 24h, matching the devnet bootstrap.
export const LAUNCH_MAX_SETTLEMENT_STALENESS_SECONDS = 86_400;

// validate_pool_risk_limits in the program: 0 < position <= utilization <= 10000.
export const POOL_BPS_DENOMINATOR = 10_000;
export const DEFAULT_POOL_MAX_UTILIZATION_BPS = 8_000;
export const DEFAULT_POOL_MAX_POSITION_BPS = 2_500;

export type LaunchSeriesParams = {
  code: ExpiryCode;
  symbol: string;
  expiry: number;
  lastTradeAt: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  maxConfidenceBps: number;
  priceScale: bigint;
  maxSettlementStalenessSeconds: number;
  label: string;
  detail: string;
};

export function deriveLaunchSeriesParams(code: ExpiryCode, symbol: string, nowMs: number): LaunchSeriesParams {
  const definition = resolveExpiry(code, symbol, nowMs);
  if (!definition.available) throw new Error(definition.availabilityReason);
  const expiry = Math.floor(definition.expiryAt / 1_000);
  const lastTradeAt = expiry - definition.tradeLockSeconds;
  if (lastTradeAt <= Math.floor(nowMs / 1_000) + LAUNCH_MIN_LEAD_SECONDS) {
    throw new Error("This grid slot is too close to its trade cutoff to launch. Pick a later expiry.");
  }
  return {
    code,
    symbol: symbol.toUpperCase(),
    expiry,
    lastTradeAt,
    observationWindowSeconds: LAUNCH_OBSERVATION_WINDOW_SECONDS,
    settlementGraceSeconds: LAUNCH_SETTLEMENT_GRACE_SECONDS,
    maxConfidenceBps: LAUNCH_MAX_CONFIDENCE_BPS,
    priceScale: LAUNCH_PRICE_SCALE,
    maxSettlementStalenessSeconds: LAUNCH_MAX_SETTLEMENT_STALENESS_SECONDS,
    label: definition.label,
    detail: definition.detail,
  };
}

export function validatePoolRiskLimits(maxUtilizationBps: number, maxPositionBps: number) {
  if (!Number.isInteger(maxUtilizationBps) || !Number.isInteger(maxPositionBps)
    || maxUtilizationBps <= 0
    || maxUtilizationBps > POOL_BPS_DENOMINATOR
    || maxPositionBps <= 0
    || maxPositionBps > maxUtilizationBps) {
    throw new Error("Pool risk limits must satisfy 0 < position cap ≤ utilization cap ≤ 10000 bps.");
  }
}
