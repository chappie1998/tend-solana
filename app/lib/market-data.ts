// The single provider-neutral entry point for off-chain market data (spot
// reference, realized volatility, chart bars). Every caller -- API routes,
// series-resolver.ts, vsol-launch.ts, vsol-close.ts, the web smoke script --
// must import getMarketSnapshot / getMarketRealizedVolatility / getMarketBars
// from HERE, never reach into pyth-market-data.ts, coinbase-market-data.ts,
// hyperliquid-market-data.ts or preipo-market-data.ts directly, so there is
// exactly one place that decides which provider runs.
//
// Routing is per MARKET, not one global switch: each market's `category`
// (app/lib/markets.ts) decides the provider FAMILY first, and only crypto
// consults MARKET_DATA_PROVIDER after that --
//
//   - category "crypto"  -> MARKET_DATA_PROVIDER selects Coinbase (default)
//                            or Pyth, exactly as before this file learned
//                            about stocks at all.
//   - category "stocks"  -> always Hyperliquid's public "xyz" HIP-3 dex
//                            (snapshot, bars, AND realized volatility, all
//                            from one module -- see hyperliquid-market-data.ts).
//                            MARKET_DATA_PROVIDER is never consulted for a
//                            stock market: this deployment's Pyth key has no
//                            equity/tokenized-equity entitlement (see
//                            markets.ts on NVDA/GOOGL), so there is no Pyth
//                            path to fall into, and Coinbase lists no
//                            equities at all.
//   - category "pre-ipo" -> always live Solana DEX trading (DexScreener for
//                            spot + pair discovery, GeckoTerminal for bars
//                            off that same pool, and realized volatility
//                            derived from those bars -- all from one module,
//                            see preipo-market-data.ts). MARKET_DATA_PROVIDER
//                            is never consulted here either: Pyth publishes
//                            nothing for these seven tokens, and neither
//                            Coinbase nor Hyperliquid lists them at all.
//
// ONCHAIN SETTLEMENT NEVER GOES THROUGH THIS FILE. Crypto and stock markets
// always verify a fresh Pyth PriceUpdateV2 against the exact feed id hashed
// into the market (vsol/programs/vsol/src/pyth.rs); pre-IPO markets settle
// on the custom oracle instead (see markets.ts's `pythFeedId` doc comment).
// Either way, this switch only controls the off-chain number a user sees
// before they trade.
//
// Deliberately no fallback between providers, on any axis: each call
// resolves ITS market's provider once and asks only that one. If Hyperliquid
// fails for a stock market, the caller sees a Hyperliquid failure, never a
// silent retry against Coinbase wearing a Hyperliquid label -- the `source`
// field on every result is always the provider that actually produced it.
import type { ChartResolution } from "./market-bars.ts";
import type { Market } from "./markets.ts";
import type { MarketDataBars, MarketDataSource, MarketSnapshot, RealizedVolatility } from "./market-data-types.ts";
import { getCoinbaseMarketBars } from "./coinbase-market-bars.ts";
import { getCoinbaseRealizedVolatility, getCoinbaseSnapshot } from "./coinbase-market-data.ts";
import { getHyperliquidMarketBars, getHyperliquidRealizedVolatility, getHyperliquidSnapshot } from "./hyperliquid-market-data.ts";
import { getPreIpoMarketBars, getPreIpoRealizedVolatility, getPreIpoSnapshot } from "./preipo-market-data.ts";
import { getPythMarketBars } from "./pyth-market-bars.ts";
import { getPythRealizedVolatility, getPythSnapshot } from "./pyth-market-data.ts";
import { runtimeEnv } from "./runtime-env.ts";

export type MarketDataProviderName = "coinbase" | "pyth";

/**
 * Reads MARKET_DATA_PROVIDER, defaulting to "coinbase" (see the file header
 * for why). Throws on anything else, rather than silently defaulting a typo
 * to either provider. Only ever consulted for a CRYPTO market -- see the
 * file header on why a stock market never reaches this.
 */
export function marketDataProviderName(): MarketDataProviderName {
  const raw = runtimeEnv("MARKET_DATA_PROVIDER")?.toLowerCase();
  if (!raw || raw === "coinbase") return "coinbase";
  if (raw === "pyth") return "pyth";
  throw new Error(`Unknown MARKET_DATA_PROVIDER "${raw}": expected "coinbase" or "pyth".`);
}

/**
 * The `source` label the active CRYPTO provider stamps on a successful
 * MarketSnapshot -- usable even before any call has run, e.g. to label an
 * error response. There is no stock equivalent of this function: a stock
 * result's own `.source` field ("Hyperliquid") is always available directly
 * from the result or the thrown error, so no caller has needed a stock-side
 * "what would the label be" helper yet.
 */
export function marketDataSourceLabel(): MarketDataSource {
  return marketDataProviderName() === "pyth" ? "Pyth Core Hermes" : "Coinbase Exchange";
}

export async function getMarketSnapshot(market: Market): Promise<MarketSnapshot> {
  if (market.category === "pre-ipo") return getPreIpoSnapshot(market);
  if (market.category === "stocks") return getHyperliquidSnapshot(market);
  return marketDataProviderName() === "pyth" ? getPythSnapshot(market) : getCoinbaseSnapshot(market);
}

export async function getMarketRealizedVolatility(market: Market): Promise<RealizedVolatility> {
  if (market.category === "pre-ipo") return getPreIpoRealizedVolatility(market);
  if (market.category === "stocks") return getHyperliquidRealizedVolatility(market);
  return marketDataProviderName() === "pyth" ? getPythRealizedVolatility(market) : getCoinbaseRealizedVolatility(market);
}

export async function getMarketBars(market: Market, resolution: ChartResolution): Promise<MarketDataBars> {
  if (market.category === "pre-ipo") return getPreIpoMarketBars(market, resolution);
  if (market.category === "stocks") return getHyperliquidMarketBars(market, resolution);
  return marketDataProviderName() === "pyth" ? getPythMarketBars(market, resolution) : getCoinbaseMarketBars(market, resolution);
}
