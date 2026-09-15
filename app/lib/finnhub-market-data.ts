// Spot snapshot from Finnhub's `/quote` endpoint -- the stock counterpart to
// coinbase-market-data.ts (crypto). Selected because this deployment's Pyth
// key is entitled to crypto feeds only (see app/lib/markets.ts on NVDA/
// GOOGL), so tokenized-equity and equity feeds both 403. Finnhub's free tier
// serves a real, live last-trade quote for ordinary US tickers with no such
// entitlement problem.
//
// ONLY the snapshot lives here. Finnhub's `/stock/candle` endpoint 403s on
// the free tier this deployment uses (verified live), so chart bars and
// realized volatility for stocks come from Twelve Data instead -- see
// app/lib/twelvedata-market-bars.ts. Onchain SETTLEMENT is unaffected by any
// of this: it always verifies a fresh Pyth PriceUpdateV2 regardless of which
// provider serves this off-chain reference.
import type { Market } from "./markets.ts";
import type { MarketSnapshot } from "./market-data-types.ts";
import { fetchJsonCapped } from "./http-fetch-capped.ts";
import { runtimeEnv } from "./runtime-env.ts";

type FinnhubQuote = {
  c?: number;
  h?: number;
  l?: number;
  o?: number;
  pc?: number;
  t?: number;
};

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 50_000;
// A few seconds, matching coinbase-market-data.ts's snapshot cache -- long
// enough to collapse a burst of concurrent requests, short enough that the
// UI still feels live while a stock market is polled.
const SNAPSHOT_TTL_MS = 5_000;
const FAILURE_BACKOFF_MS = 5_000;

const snapshotCache = new Map<string, { expiresAt: number; value: MarketSnapshot }>();
const snapshotInFlight = new Map<string, Promise<MarketSnapshot>>();
const snapshotFailures = new Map<string, { expiresAt: number; error: Error }>();

// Trailing slash is load-bearing: the base carries a path ("/api/v1"), and
// `quoteUrl` below resolves a RELATIVE reference ("quote", no leading
// slash) against it. `new URL("/quote", base)` -- an absolute reference --
// would discard "/api/v1" entirely and resolve to https://finnhub.io/quote,
// which 302s. Same fix pyth-market-bars.ts's hermesUrl already applies to
// PYTH_HERMES_URL for the identical reason.
function finnhubBaseUrl() {
  const base = runtimeEnv("FINNHUB_API_URL") || "https://finnhub.io/api/v1";
  return base.endsWith("/") ? base : `${base}/`;
}

function quoteUrl(symbol: string, apiKey: string): URL {
  const url = new URL("quote", finnhubBaseUrl());
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", apiKey);
  return url;
}

type ParsedQuote = { price: number; high: number; low: number; publishTime: number };

/**
 * Finnhub returns HTTP 200 with every field zeroed (`{c:0,h:0,l:0,o:0,pc:0,t:0}`)
 * for a symbol it has no quote for, rather than a 4xx -- this is the path a
 * private company like SpaceX takes, and it must fail honestly rather than
 * report a $0 price. `c <= 0` or `t <= 0` is Finnhub's own "nothing here"
 * signal, so both are treated as a hard failure, not a valid quote.
 */
export function parseFinnhubQuote(raw: unknown, symbol: string): ParsedQuote {
  if (!raw || typeof raw !== "object") throw new Error(`Finnhub returned an invalid quote for ${symbol}`);
  const quote = raw as FinnhubQuote;
  const price = Number(quote.c);
  const publishTime = Number(quote.t);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Finnhub has no quote for ${symbol}`);
  if (!Number.isFinite(publishTime) || publishTime <= 0) throw new Error(`Finnhub returned an invalid quote time for ${symbol}`);
  const high = Number(quote.h);
  const low = Number(quote.l);
  const validRange = Number.isFinite(high) && Number.isFinite(low) && high >= low && low > 0;
  return { price, high: validRange ? high : price, low: validRange ? low : price, publishTime: Math.floor(publishTime) };
}

export async function getFinnhubSnapshot(market: Market): Promise<MarketSnapshot> {
  const symbol = market.symbol;
  const now = Date.now();
  const cached = snapshotCache.get(symbol);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = snapshotFailures.get(symbol);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const existing = snapshotInFlight.get(symbol);
  if (existing) return existing;

  const request = (async () => {
    const apiKey = runtimeEnv("FINNHUB_API_KEY");
    if (!apiKey) throw new Error("FINNHUB_API_KEY is not configured; stock quotes are unavailable until it is set.");
    const raw = await fetchJsonCapped(quoteUrl(symbol, apiKey), {
      headers: { Accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      label: "Finnhub",
    });
    const parsed = parseFinnhubQuote(raw, symbol);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const ageSeconds = Math.max(0, nowSeconds - parsed.publishTime);
    const mode = ageSeconds <= 30 ? "live" : "stale";
    // Finnhub's free `/quote` carries no bid/ask, so there is no spread to
    // halve the way coinbase-market-data.ts does. Half the day's high-low
    // range is the closest available dispersion proxy -- coarser than a
    // spread and explicitly NOT a confidence interval, which the warning
    // below says outright rather than implying a precision this doesn't have.
    const confidence = (parsed.high - parsed.low) / 2;
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
      source: "Finnhub",
      warning: mode === "live"
        ? "Fresh Finnhub reference (half the day's high-low range stands in for a confidence interval, not a bid/ask spread or a Pyth-style confidence interval); onchain settlement still requires a separately verified Pyth update."
        : `Reference is ${ageMinutes} min old; Finnhub's last trade for ${symbol} is not fresh right now -- expected while the US market is closed. Gap risk is priced into the quote, not hidden.`,
    };
    snapshotCache.set(symbol, { expiresAt: Date.now() + SNAPSHOT_TTL_MS, value });
    snapshotFailures.delete(symbol);
    return value;
  })();
  snapshotInFlight.set(symbol, request);
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Finnhub snapshot request failed");
    snapshotFailures.set(symbol, { expiresAt: Date.now() + FAILURE_BACKOFF_MS, error: normalized });
    throw normalized;
  } finally {
    snapshotInFlight.delete(symbol);
  }
}
