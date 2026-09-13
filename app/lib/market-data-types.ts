// Provider-neutral shapes for off-chain market data: spot reference,
// realized volatility, and chart bars. Two providers implement these --
// app/lib/coinbase-market-data.ts / coinbase-market-bars.ts (Coinbase
// Exchange's public API, no key required) and app/lib/pyth-market-data.ts /
// pyth-market-bars.ts (Pyth Core Hermes + History) -- and app/lib/market-data.ts
// picks exactly one per call via MARKET_DATA_PROVIDER, defaulting to Coinbase.
//
// ONCHAIN SETTLEMENT IS UNAFFECTED BY THIS FILE. It always verifies a fresh
// Pyth PriceUpdateV2 against the exact feed id hashed into the market
// (vsol/programs/vsol/src/pyth.rs) -- these types describe only the
// off-chain reference a user sees before they trade, never what a position
// settles against.
//
// `source` is a union, not a single literal, so a caller can never lie about
// which provider produced a number: whichever provider actually ran is the
// only value that can land in this field.

import type { ChartResolution, MarketBar } from "./market-bars.ts";

export type MarketDataSource = "Coinbase Exchange" | "Pyth Core Hermes";

export type MarketSnapshot = {
  price: number;
  /**
   * Pyth: half the published confidence interval. Coinbase: half the live
   * bid/ask spread, a standard liquidity-based proxy -- NOT a Pyth-style
   * confidence interval. Every snapshot's `warning` field says which.
   */
  confidence: number;
  confidenceBps: number;
  /**
   * Pyth-specific price exponent (price = integer * 10^exponent at the
   * source). Coinbase's ticker is already decimal, so its snapshots carry 0.
   * Nothing outside pyth-market-data.ts reads this field today; it is kept
   * for shape stability across providers.
   */
  exponent: number;
  publishTime: number;
  /** The Solana slot Pyth published at. Always null for Coinbase, which has no such concept. */
  slot: number | null;
  ageSeconds: number;
  mode: "live" | "stale";
  source: MarketDataSource;
  warning: string;
};

export type RealizedVolatilitySource =
  | "Coinbase Exchange 20-session realized volatility"
  | "Pyth Benchmarks 20-session realized volatility";

export type RealizedVolatility = {
  value: number;
  observations: number;
  source: RealizedVolatilitySource;
  asOf: number;
};

/** Chart bars carry the same `source` vocabulary as MarketDataSource -- Pyth's own label for its history API is "Pyth Benchmarks", not "Pyth Core Hermes". */
export type MarketDataBarsSource = "Coinbase Exchange" | "Pyth Benchmarks";

export type MarketDataBars = {
  symbol: string;
  resolution: ChartResolution;
  source: MarketDataBarsSource;
  // Whether the most recent bar is inside the normal publish cadence for this
  // resolution. There is no "market closed" state -- Tend quotes 24/7 -- this
  // just tells the chart whether to poll fast or slow.
  freshness: "live" | "stale";
  bars: MarketBar[];
  from: number;
  to: number;
  asOf: number;
  lastBarTime: number;
};
