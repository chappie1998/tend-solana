// The single provider-neutral entry point for off-chain market data (spot
// reference, realized volatility, chart bars). Every caller -- API routes,
// series-resolver.ts, vsol-launch.ts, vsol-close.ts, the web smoke script --
// must import getMarketSnapshot / getMarketRealizedVolatility / getMarketBars
// from HERE, never reach into pyth-market-data.ts or coinbase-market-data.ts
// directly, so there is exactly one place that decides which provider runs.
//
// ONCHAIN SETTLEMENT NEVER GOES THROUGH THIS FILE. It always verifies a fresh
// Pyth PriceUpdateV2 against the exact feed id hashed into the market
// (vsol/programs/vsol/src/pyth.rs). This switch only controls the off-chain
// number a user sees before they trade.
//
// Deliberately no fallback between providers: each call resolves the
// provider once and asks only that one. If Coinbase fails, the caller sees a
// Coinbase failure, not a silent retry against Pyth wearing a Coinbase label
// -- the `source` field on every result is always the provider that actually
// produced it.
import type { ChartResolution } from "./market-bars.ts";
import type { Market } from "./markets.ts";
import type { MarketDataBars, MarketDataSource, MarketSnapshot, RealizedVolatility } from "./market-data-types.ts";
import { getCoinbaseMarketBars } from "./coinbase-market-bars.ts";
import { getCoinbaseRealizedVolatility, getCoinbaseSnapshot } from "./coinbase-market-data.ts";
import { getPythMarketBars } from "./pyth-market-bars.ts";
import { getPythRealizedVolatility, getPythSnapshot } from "./pyth-market-data.ts";
import { runtimeEnv } from "./runtime-env.ts";

export type MarketDataProviderName = "coinbase" | "pyth";

/**
 * Reads MARKET_DATA_PROVIDER, defaulting to "coinbase" (see the file header
 * for why). Throws on anything else, rather than silently defaulting a typo
 * to either provider.
 */
export function marketDataProviderName(): MarketDataProviderName {
  const raw = runtimeEnv("MARKET_DATA_PROVIDER")?.toLowerCase();
  if (!raw || raw === "coinbase") return "coinbase";
  if (raw === "pyth") return "pyth";
  throw new Error(`Unknown MARKET_DATA_PROVIDER "${raw}": expected "coinbase" or "pyth".`);
}

/** The `source` label the active provider stamps on a successful MarketSnapshot -- usable even before any call has run, e.g. to label an error response. */
export function marketDataSourceLabel(): MarketDataSource {
  return marketDataProviderName() === "pyth" ? "Pyth Core Hermes" : "Coinbase Exchange";
}

export async function getMarketSnapshot(market: Market): Promise<MarketSnapshot> {
  return marketDataProviderName() === "pyth" ? getPythSnapshot(market) : getCoinbaseSnapshot(market);
}

export async function getMarketRealizedVolatility(market: Market): Promise<RealizedVolatility> {
  return marketDataProviderName() === "pyth" ? getPythRealizedVolatility(market) : getCoinbaseRealizedVolatility(market);
}

export async function getMarketBars(market: Market, resolution: ChartResolution): Promise<MarketDataBars> {
  return marketDataProviderName() === "pyth" ? getPythMarketBars(market, resolution) : getCoinbaseMarketBars(market, resolution);
}
