import type { Market } from "./markets";
import { getPythMarketBars } from "./pyth-market-bars";
import { runtimeEnv } from "./runtime-env";

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
  mode: "live" | "stale";
  source: "Pyth Core Hermes";
  warning: string;
};

export type RealizedVolatility = {
  value: number;
  observations: number;
  source: "Pyth Benchmarks 20-session realized volatility";
  asOf: number;
};

const PYTH_AUTH_REQUIRED_AT = Date.UTC(2026, 6, 31);
const HERMES_TIMEOUT_MS = 8_000;
const MAX_HERMES_BYTES = 1_000_000;
const snapshotCache = new Map<string, { expiresAt: number; value: PythMarketSnapshot }>();
const snapshotInFlight = new Map<string, Promise<PythMarketSnapshot>>();
const snapshotFailures = new Map<string, { expiresAt: number; error: Error }>();
const volatilityCache = new Map<string, { expiresAt: number; value: RealizedVolatility }>();

const utcTradingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function hermesUrl(path: string) {
  const base = runtimeEnv("PYTH_HERMES_URL") || "https://hermes.pyth.network";
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

function hermesHeaders() {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = runtimeEnv("PYTH_API_KEY");
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchHermes(url: URL) {
  if (!runtimeEnv("PYTH_API_KEY") && Date.now() >= PYTH_AUTH_REQUIRED_AT) {
    throw new Error("Pyth API authentication is not configured");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: hermesHeaders(),
      cache: "no-store",
      // workerd rejects redirect: "error"; "manual" still refuses to follow, and
      // the 3xx response then fails the response.ok check below.
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Pyth Hermes returned ${response.status}`);
    const declaredBytes = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_HERMES_BYTES) {
      throw new Error("Pyth Hermes response is too large");
    }
    if (!response.body) throw new Error("Pyth Hermes response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HERMES_BYTES) {
        await reader.cancel();
        throw new Error("Pyth Hermes response is too large");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body)) as HermesResponse;
  } finally {
    clearTimeout(timeout);
  }
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

export async function getPythSnapshot(market: Market): Promise<PythMarketSnapshot> {
  const now = Date.now();
  const cached = snapshotCache.get(market.pythFeedId);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = snapshotFailures.get(market.pythFeedId);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const existing = snapshotInFlight.get(market.pythFeedId);
  if (existing) return existing;

  const request = (async () => {
    const result = await fetchHermes(latestUrl(market.pythFeedId));
    const parsed = result.parsed?.[0];
    if (!parsed) throw new Error("Pyth returned no parsed price");
    const price = parsePrice(parsed, market.pythFeedId);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const ageSeconds = Math.max(0, nowSeconds - price.publishTime);
    const mode = ageSeconds <= 30 ? "live" : "stale";
    const confidenceBps = (price.confidence / price.price) * 10_000;
    const ageMinutes = Math.max(1, Math.round(ageSeconds / 60));
    const value: PythMarketSnapshot = {
      ...price,
      confidenceBps,
      slot: Number.isSafeInteger(parsed.metadata?.slot) ? Number(parsed.metadata?.slot) : null,
      ageSeconds,
      mode,
      source: "Pyth Core Hermes",
      warning: mode === "live"
        ? "Fresh Pyth reference; settlement still uses an onchain verified update."
        : `Reference is ${ageMinutes} min old; Equity.US.NVDA/USD is not printing fresh updates right now. Gap risk is priced into the quote, not hidden.`,
    };
    snapshotCache.set(market.pythFeedId, { expiresAt: Date.now() + 5_000, value });
    snapshotFailures.delete(market.pythFeedId);
    return value;
  })();
  snapshotInFlight.set(market.pythFeedId, request);
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Pyth snapshot request failed");
    snapshotFailures.set(market.pythFeedId, { expiresAt: Date.now() + 5_000, error: normalized });
    throw normalized;
  } finally {
    snapshotInFlight.delete(market.pythFeedId);
  }
}

export async function getPythRealizedVolatility(market: Market): Promise<RealizedVolatility> {
  const cached = volatilityCache.get(market.pythFeedId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const history = await getPythMarketBars(market, "D");
  // The most recent daily bar may still be forming (its UTC day hasn't
  // finished yet); drop it so realized vol is never computed off a partial
  // candle. This has nothing to do with trading hours — it's just calendar math.
  const asOfDate = utcTradingDate.format(new Date(history.asOf));
  const completedBars = history.bars.filter((bar) => utcTradingDate.format(new Date(bar.time * 1_000)) !== asOfDate);
  const prices = completedBars.slice(-21).map((bar) => bar.close);
  if (prices.length < 10) throw new Error("Pyth historical coverage is insufficient for volatility pricing");
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  // The annualization factor MUST match the cadence of the bars above, not
  // the calendar. These are daily bars, and every market in app/lib/markets.ts
  // is currently a US equity (NVDA), whose bars exist only on the ~252 trading
  // days a year — so 252 is correct here, and NOT a "market hours" assumption
  // about when Tend itself trades (Tend is 24/7; that is a separate concern
  // from how many observations a year this feed actually produces).
  //
  // >>> Adding a CRYPTO market makes this wrong: crypto bars exist all 365
  // >>> days, so sampling 365 returns/year and annualizing by sqrt(252)
  // >>> understates realized vol by ~sqrt(365/252) = 1.20x, i.e. ~20% too
  // >>> cheap. When the first non-equity market lands, derive this per-market
  // >>> from the feed's own bar cadence instead of hardcoding it.
  const barsPerYear = 252;
  const annualized = Math.sqrt(variance) * Math.sqrt(barsPerYear) * 100;
  if (!Number.isFinite(annualized) || annualized < 1 || annualized > 400) throw new Error("Pyth volatility result is outside risk bounds");
  const value = {
    value: annualized,
    observations: prices.length,
    source: "Pyth Benchmarks 20-session realized volatility" as const,
    asOf: history.asOf,
  };
  volatilityCache.set(market.pythFeedId, { expiresAt: Date.now() + 15 * 60_000, value });
  return value;
}
