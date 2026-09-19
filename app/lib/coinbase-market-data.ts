// Spot snapshot and realized volatility from Coinbase Exchange's public
// ticker/candles API -- the Coinbase counterpart to pyth-market-data.ts.
//
// Selected as the default off-chain market-data provider (see
// app/lib/market-data.ts) because this deployment's Pyth API key lost its
// crypto-spot entitlement: every Hermes call now 403s. Coinbase requires no
// key at all for the endpoints used here. Onchain SETTLEMENT is unaffected --
// it always verifies a fresh Pyth PriceUpdateV2 regardless of which provider
// serves this off-chain reference.
import type { Market } from "./markets.ts";
import type { MarketSnapshot, RealizedVolatility } from "./market-data-types.ts";
import { getCoinbaseMarketBars } from "./coinbase-market-bars.ts";
import { fetchJsonCapped } from "./http-fetch-capped.ts";
import { runtimeEnv } from "./runtime-env.ts";

type CoinbaseTicker = {
  ask?: string;
  bid?: string;
  price?: string;
  time?: string;
};

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 200_000;

const snapshotCache = new Map<string, { expiresAt: number; value: MarketSnapshot }>();
const snapshotInFlight = new Map<string, Promise<MarketSnapshot>>();
const snapshotFailures = new Map<string, { expiresAt: number; error: Error }>();
const volatilityCache = new Map<string, { expiresAt: number; value: RealizedVolatility }>();

const utcTradingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function coinbaseBaseUrl() {
  return runtimeEnv("COINBASE_EXCHANGE_URL") || "https://api.exchange.coinbase.com";
}

function tickerUrl(productId: string): URL {
  return new URL(`/products/${encodeURIComponent(productId)}/ticker`, coinbaseBaseUrl());
}

type ParsedTicker = { price: number; bid: number; ask: number; publishTime: number };

export function parseCoinbaseTicker(raw: unknown, productId: string): ParsedTicker {
  if (!raw || typeof raw !== "object") throw new Error(`Coinbase returned an invalid ticker for ${productId}`);
  const ticker = raw as CoinbaseTicker;
  const price = Number(ticker.price);
  const bid = Number(ticker.bid);
  const ask = Number(ticker.ask);
  const publishTimeMs = typeof ticker.time === "string" ? Date.parse(ticker.time) : NaN;
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Coinbase returned an invalid price for ${productId}`);
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0 || ask < bid) {
    throw new Error(`Coinbase returned an invalid bid/ask for ${productId}`);
  }
  if (!Number.isFinite(publishTimeMs)) throw new Error(`Coinbase returned an invalid ticker time for ${productId}`);
  return { price, bid, ask, publishTime: Math.floor(publishTimeMs / 1_000) };
}

export async function getCoinbaseSnapshot(market: Market): Promise<MarketSnapshot> {
  if (!market.coinbaseProductId) throw new Error(`${market.name} has no Coinbase product configured`);
  const productId = market.coinbaseProductId;
  const now = Date.now();
  const cached = snapshotCache.get(productId);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = snapshotFailures.get(productId);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const existing = snapshotInFlight.get(productId);
  if (existing) return existing;

  const request = (async () => {
    const raw = await fetchJsonCapped(tickerUrl(productId), {
      headers: { Accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      label: "Coinbase Exchange",
    });
    const parsed = parseCoinbaseTicker(raw, productId);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const ageSeconds = Math.max(0, nowSeconds - parsed.publishTime);
    const mode = ageSeconds <= 30 ? "live" : "stale";
    // Coinbase's public ticker carries no confidence interval the way a Pyth
    // price update does. Half the live bid/ask spread is the standard
    // liquidity-based proxy for quote uncertainty -- it is NOT a Pyth-style
    // confidence interval, and the warning below says so explicitly.
    const confidence = (parsed.ask - parsed.bid) / 2;
    const confidenceBps = (confidence / parsed.price) * 10_000;
    const ageMinutes = Math.max(1, Math.round(ageSeconds / 60));
    const value: MarketSnapshot = {
      price: parsed.price,
      confidence,
      confidenceBps,
      exponent: 0,
      publishTime: parsed.publishTime,
      slot: null,
      ageSeconds,
      mode,
      source: "Coinbase Exchange",
      warning: mode === "live"
        ? "Fresh Coinbase reference (half the live bid/ask spread stands in for confidence); the centrally signed custom oracle retains the first validated observation inside the expiry window."
        : `Reference is ${ageMinutes} min old; Coinbase's ${productId} ticker is not printing fresh updates right now. Gap risk is priced into the quote, not hidden.`,
    };
    snapshotCache.set(productId, { expiresAt: Date.now() + 5_000, value });
    snapshotFailures.delete(productId);
    return value;
  })();
  snapshotInFlight.set(productId, request);
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Coinbase snapshot request failed");
    snapshotFailures.set(productId, { expiresAt: Date.now() + 5_000, error: normalized });
    throw normalized;
  } finally {
    snapshotInFlight.delete(productId);
  }
}

export async function getCoinbaseRealizedVolatility(market: Market): Promise<RealizedVolatility> {
  if (!market.coinbaseProductId) throw new Error(`${market.name} has no Coinbase product configured`);
  const cacheKey = market.coinbaseProductId;
  const cached = volatilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const history = await getCoinbaseMarketBars(market, "D");
  // Same method as the Pyth path (app/lib/pyth-market-data.ts): drop the most
  // recent daily bar if its UTC day has not finished yet, so volatility is
  // never computed off a partial candle. Calendar math, not a market-hours
  // gate -- Tend quotes every market here 24/7.
  const asOfDate = utcTradingDate.format(new Date(history.asOf));
  const completedBars = history.bars.filter((bar) => utcTradingDate.format(new Date(bar.time * 1_000)) !== asOfDate);
  const prices = completedBars.slice(-21).map((bar) => bar.close);
  if (prices.length < 10) throw new Error("Coinbase historical coverage is insufficient for volatility pricing");
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  // 365, not 252: every live market here is a 24/7 crypto spot pair, so daily
  // bars exist on all 365 calendar days rather than the ~252 sessions a
  // US-equity feed produces. See pyth-market-data.ts's getPythRealizedVolatility
  // for the fuller trap this guards against -- it applies identically here.
  const barsPerYear = 365;
  const annualized = Math.sqrt(variance) * Math.sqrt(barsPerYear) * 100;
  if (!Number.isFinite(annualized) || annualized < 1 || annualized > 400) {
    throw new Error("Coinbase volatility result is outside risk bounds");
  }
  const value: RealizedVolatility = {
    value: annualized,
    observations: prices.length,
    source: "Coinbase Exchange 20-session realized volatility",
    asOf: history.asOf,
  };
  volatilityCache.set(cacheKey, { expiresAt: Date.now() + 15 * 60_000, value });
  return value;
}
