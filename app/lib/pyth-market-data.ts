import { isReferenceMarketOpen, previousReferenceMarketCloses } from "./expiries";
import type { Market } from "./markets";

type HermesPrice = {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
};

type HermesParsedPrice = {
  id: string;
  price: HermesPrice;
  ema_price?: HermesPrice;
  metadata?: { slot?: number; proof_available_time?: number; prev_publish_time?: number };
};

type HermesResponse = { parsed?: HermesParsedPrice[] };

export type PythMarketSnapshot = {
  price: number;
  confidence: number;
  confidenceBps: number;
  exponent: number;
  publishTime: number;
  slot: number | null;
  ageSeconds: number;
  mode: "live" | "closed" | "stale";
  source: "Pyth Core Hermes";
  warning: string;
};

export type RealizedVolatility = {
  value: number;
  observations: number;
  source: "Pyth Core 20-session realized volatility";
  asOf: number;
};

const volatilityCache = new Map<string, { expiresAt: number; value: RealizedVolatility }>();

function hermesUrl(path: string) {
  const base = process.env.PYTH_HERMES_URL?.trim() || "https://hermes.pyth.network";
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

function hermesHeaders() {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = process.env.PYTH_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchHermes(url: URL) {
  const response = await fetch(url, { headers: hermesHeaders(), cache: "no-store" });
  if (!response.ok) throw new Error(`Pyth Hermes returned ${response.status}`);
  return response.json() as Promise<HermesResponse>;
}

function parsePrice(result: HermesParsedPrice, expectedFeedId: string) {
  if (result.id.toLowerCase() !== expectedFeedId.toLowerCase()) throw new Error("Pyth returned a different feed");
  const integer = Number(result.price.price);
  const confidenceInteger = Number(result.price.conf);
  const exponent = Number(result.price.expo);
  const publishTime = Number(result.price.publish_time);
  if (!Number.isSafeInteger(integer) || integer <= 0 || !Number.isSafeInteger(confidenceInteger) || confidenceInteger < 0) {
    throw new Error("Pyth returned an invalid price");
  }
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 18 || !Number.isSafeInteger(publishTime) || publishTime <= 0) {
    throw new Error("Pyth returned invalid price metadata");
  }
  const factor = 10 ** exponent;
  const price = integer * factor;
  const confidence = confidenceInteger * factor;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(confidence)) throw new Error("Pyth price cannot be represented");
  return { price, confidence, exponent, publishTime };
}

function latestUrl(feedId: string) {
  const url = hermesUrl("v2/updates/price/latest");
  url.searchParams.append("ids[]", feedId);
  url.searchParams.set("encoding", "hex");
  url.searchParams.set("parsed", "true");
  return url;
}

function historicalUrl(feedId: string, publishTime: number) {
  const url = hermesUrl(`v2/updates/price/${publishTime}`);
  url.searchParams.append("ids[]", feedId);
  url.searchParams.set("encoding", "hex");
  url.searchParams.set("parsed", "true");
  return url;
}

export async function getPythSnapshot(market: Market): Promise<PythMarketSnapshot> {
  const result = await fetchHermes(latestUrl(market.pythFeedId));
  const parsed = result.parsed?.[0];
  if (!parsed) throw new Error("Pyth returned no parsed price");
  const price = parsePrice(parsed, market.pythFeedId);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, nowSeconds - price.publishTime);
  const marketOpen = isReferenceMarketOpen();
  const mode = ageSeconds <= 30 ? "live" : marketOpen ? "stale" : "closed";
  const confidenceBps = (price.confidence / price.price) * 10_000;
  return {
    ...price,
    confidenceBps,
    slot: Number.isSafeInteger(parsed.metadata?.slot) ? Number(parsed.metadata?.slot) : null,
    ageSeconds,
    mode,
    source: "Pyth Core Hermes",
    warning: mode === "live"
      ? "Fresh Pyth reference. TradingView remains display-only."
      : mode === "closed"
        ? "The US reference session is closed; this is Pyth's last verified market price."
        : "Pyth did not publish a fresh update while the reference session is open.",
  };
}

export async function getPythRealizedVolatility(market: Market): Promise<RealizedVolatility> {
  const cached = volatilityCache.get(market.pythFeedId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const observations = await Promise.allSettled(
    previousReferenceMarketCloses(21).map(async (timestampMs) => {
      const timestamp = Math.floor(timestampMs / 1_000);
      const result = await fetchHermes(historicalUrl(market.pythFeedId, timestamp));
      const parsed = result.parsed?.[0];
      if (!parsed) throw new Error("Missing historical Pyth price");
      const price = parsePrice(parsed, market.pythFeedId);
      if (price.publishTime > timestamp + 60 || timestamp - price.publishTime > 4 * 86_400) {
        throw new Error("Historical Pyth observation is outside the requested close window");
      }
      return { value: price.price, publishTime: price.publishTime };
    }),
  );
  const unique = new Map<number, number>();
  for (const observation of observations) {
    if (observation.status === "fulfilled") unique.set(observation.value.publishTime, observation.value.value);
  }
  const prices = [...unique.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
  if (prices.length < 10) throw new Error("Pyth historical coverage is insufficient for volatility pricing");
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const annualized = Math.sqrt(variance) * Math.sqrt(252) * 100;
  if (!Number.isFinite(annualized) || annualized < 1 || annualized > 400) throw new Error("Pyth volatility result is outside risk bounds");
  const value = {
    value: annualized,
    observations: prices.length,
    source: "Pyth Core 20-session realized volatility" as const,
    asOf: Date.now(),
  };
  volatilityCache.set(market.pythFeedId, { expiresAt: Date.now() + 15 * 60_000, value });
  return value;
}
