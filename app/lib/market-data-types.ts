// Provider-neutral shapes for off-chain market data: spot reference,
// realized volatility, and chart bars. Three providers implement these --
// app/lib/coinbase-market-data.ts / coinbase-market-bars.ts (Coinbase
// Exchange's public API, no key required) and app/lib/pyth-market-data.ts /
// pyth-market-bars.ts (Pyth Core Hermes + History) for CRYPTO markets, and
// app/lib/hyperliquid-market-data.ts (spot, bars, and realized vol, all from
// one module) for STOCK markets -- and app/lib/market-data.ts resolves the
// right one per call: crypto picks Coinbase-vs-Pyth via MARKET_DATA_PROVIDER
// (defaulting to Coinbase), stocks always go to Hyperliquid's public "xyz"
// HIP-3 dex, no key required either. See that file's header for the full
// routing and the "no fallback between providers" contract.
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

export type MarketDataSource = "Coinbase Exchange" | "Pyth Core Hermes" | "Hyperliquid";

export type MarketSnapshot = {
  price: number;
  /**
   * Pyth: half the published confidence interval. Coinbase: half the live
   * bid/ask spread, a standard liquidity-based proxy. Hyperliquid: the
   * absolute difference between its own traded mark price and its external
   * oracle price -- two independently-derived numbers for the same asset,
   * which can legitimately read near zero when they agree closely (a
   * tighter measure than a high-low proxy, not a broken one). None of the
   * non-Pyth proxies is a Pyth-style confidence interval -- every snapshot's
   * `warning` field says which kind it got.
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
  | "Pyth Benchmarks 20-session realized volatility"
  | "Hyperliquid 20-session realized volatility";

export type RealizedVolatility = {
  value: number;
  observations: number;
  source: RealizedVolatilitySource;
  asOf: number;
};

/** Chart bars carry a related but distinct `source` vocabulary from MarketDataSource -- Pyth's own label for its history API is "Pyth Benchmarks", not "Pyth Core Hermes"; Hyperliquid uses one label ("Hyperliquid") for both its snapshot and its bars. */
export type MarketDataBarsSource = "Coinbase Exchange" | "Pyth Benchmarks" | "Hyperliquid";

export type MarketDataBars = {
  symbol: string;
  resolution: ChartResolution;
  source: MarketDataBarsSource;
  // Whether the most recent bar is inside the normal publish cadence for this
  // resolution. There is no "market closed" state -- Tend quotes every
  // market, crypto and stocks alike, 24/7 -- this just tells the chart
  // whether to poll fast or slow.
  freshness: "live" | "stale";
  bars: MarketBar[];
  from: number;
  to: number;
  asOf: number;
  lastBarTime: number;
};
