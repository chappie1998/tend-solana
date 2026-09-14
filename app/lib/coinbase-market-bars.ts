// Chart bars from Coinbase Exchange's public candles endpoint -- the
// Coinbase counterpart to pyth-market-bars.ts. No API key: this is the same
// public host the ticker (coinbase-market-data.ts) uses.
//
// Selected facts verified empirically against
// https://api.exchange.coinbase.com/products/SOL-USD/candles on 2026-09-13
// (there is no current, authoritative published spec for these limits):
//
//   - granularity accepts exactly 60, 300, 900, 3600, 21600, 86400 (seconds);
//     any other value 400s with {"message":"Unsupported granularity"}. This
//     app only ever needs 60/300/900/3600/86400 -- see chartResolutionSeconds
//     in market-bars.ts, which this file reuses directly as the granularity.
//   - a request is capped at 300 returned candles. A 300-minute window at
//     granularity=60 returns 200 with exactly 300 rows; a 301-minute window
//     404s^H^H400s: {"message":"granularity too small for the requested time
//     range. Count of aggregations requested exceeds 300"}.
//   - each row is `[ time, low, high, open, close, volume ]` -- confirmed by
//     cross-checking a live ticker's price against the newest candle's close
//     (matched exactly) and, on daily candles, that one candle's close equals
//     the NEXT (chronologically later) candle's open (OHLC continuity).
//   - rows come back newest-first (descending time).
//
// This app's chart lookbacks (chartLookbackSeconds in market-bars.ts) target
// 1,440 bars for every intraday resolution and 365 for daily -- both over the
// 300-per-request cap, so every fetch here paginates across multiple
// requests and merges them, rather than silently handing back a truncated
// window.
import {
  chartLookbackSeconds,
  chartResolutionSeconds,
  MAX_BARS,
  type ChartResolution,
  type MarketBar,
} from "./market-bars.ts";
import type { MarketDataBars } from "./market-data-types.ts";
import type { Market } from "./markets.ts";
import { fetchJsonCapped } from "./http-fetch-capped.ts";
import { runtimeEnv } from "./runtime-env.ts";

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_BYTES = 500_000;
// Verified empirically (see file header): Coinbase Exchange's public candles
// endpoint never returns more than this many rows in one request, regardless
// of granularity or the requested start/end span.
const MAX_CANDLES_PER_PAGE = 300;

const cache = new Map<string, { expiresAt: number; value: MarketDataBars }>();
const inFlight = new Map<string, Promise<MarketDataBars>>();
const failed = new Map<string, { expiresAt: number; error: Error }>();

function coinbaseBaseUrl() {
  return runtimeEnv("COINBASE_EXCHANGE_URL") || "https://api.exchange.coinbase.com";
}

function candlesUrl(productId: string, granularitySeconds: number, startSeconds: number, endSeconds: number): URL {
  const url = new URL(`/products/${encodeURIComponent(productId)}/candles`, coinbaseBaseUrl());
  url.searchParams.set("granularity", String(granularitySeconds));
  url.searchParams.set("start", new Date(startSeconds * 1_000).toISOString());
  url.searchParams.set("end", new Date(endSeconds * 1_000).toISOString());
  return url;
}

/**
 * Splits `[fromSeconds, toSeconds]` into consecutive windows of at most
 * MAX_CANDLES_PER_PAGE candles each, walking backward from `toSeconds` so the
 * most recent page is always requested first. A 1,440-bar intraday lookback
 * needs 5 pages at every resolution this app uses; the 365-bar daily lookback
 * needs 2 -- see the module doc comment.
 */
export function candleWindows(
  fromSeconds: number,
  toSeconds: number,
  granularitySeconds: number,
): Array<{ start: number; end: number }> {
  const windowSeconds = MAX_CANDLES_PER_PAGE * granularitySeconds;
  const windows: Array<{ start: number; end: number }> = [];
  let end = toSeconds;
  while (end > fromSeconds) {
    const start = Math.max(fromSeconds, end - windowSeconds);
    windows.push({ start, end });
    end = start;
  }
  return windows;
}

/**
 * Parses one raw Coinbase candle row. Row order is
 * `[ time, low, high, open, close, volume ]` -- NOT the OHLC order the
 * MarketBar shape (or a UDF response) uses. See the module doc comment for
 * how that order was confirmed.
 */
export function parseCoinbaseCandleRow(row: unknown): MarketBar {
  if (!Array.isArray(row) || row.length < 5) throw new Error("Coinbase candle row is malformed");
  const [time, low, high, open, close] = row as unknown[];
  if ([time, low, high, open, close].some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("Coinbase candle values must be numbers");
  }
  if (!Number.isSafeInteger(time as number) || (time as number) <= 0) {
    throw new Error("Coinbase candle timestamp is invalid");
  }
  const bar = { time: time as number, open: open as number, high: high as number, low: low as number, close: close as number };
  if (![bar.open, bar.high, bar.low, bar.close].every((value) => value > 0)) {
    throw new Error("Coinbase candle prices are invalid");
  }
  if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) {
    throw new Error("Coinbase candle OHLC bounds are invalid");
  }
  return bar;
}

async function fetchCandlePage(
  productId: string,
  granularitySeconds: number,
  startSeconds: number,
  endSeconds: number,
): Promise<unknown[]> {
  const raw = await fetchJsonCapped(candlesUrl(productId, granularitySeconds, startSeconds, endSeconds), {
    headers: { Accept: "application/json" },
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    maxBytes: MAX_UPSTREAM_BYTES,
    label: "Coinbase Exchange",
  });
  if (!Array.isArray(raw)) throw new Error("Coinbase candles response is invalid");
  return raw;
}

/**
 * Merges Coinbase's paginated candle rows into ascending, deduped MarketBars:
 * pages can share a boundary candle, so bars are keyed by time in a Map
 * (last write wins, and the exchange's own data agrees at shared boundaries)
 * rather than concatenated, which would double-count or misorder them.
 */
export function mergeCandlePages(pages: unknown[][]): MarketBar[] {
  const merged = new Map<number, MarketBar>();
  for (const rows of pages) {
    for (const row of rows) {
      const bar = parseCoinbaseCandleRow(row);
      merged.set(bar.time, bar);
    }
  }
  return [...merged.values()].sort((a, b) => a.time - b.time);
}

export async function getCoinbaseMarketBars(
  market: Market,
  resolution: ChartResolution,
  now = Date.now(),
): Promise<MarketDataBars> {
  if (!market.coinbaseProductId) throw new Error(`${market.name} has no Coinbase product configured`);
  const productId = market.coinbaseProductId;
  const cacheKey = `${productId}:${resolution}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = failed.get(cacheKey);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const active = inFlight.get(cacheKey);
  if (active) return active;

  const request = (async () => {
    const to = Math.floor(now / 1_000);
    const granularitySeconds = chartResolutionSeconds(resolution);
    const from = to - chartLookbackSeconds(resolution);
    const windows = candleWindows(from, to, granularitySeconds);
    const pages = await Promise.all(
      windows.map((window) => fetchCandlePage(productId, granularitySeconds, window.start, window.end)),
    );
    let bars = mergeCandlePages(pages);
    if (bars.length === 0) throw new Error("Coinbase returned no candle data for this range");
    // Respect the same shared ceiling the Pyth path enforces (market-bars.ts).
    // Pagination here is sized to land well under it, so this only trims in
    // an unexpected upstream case rather than in the normal path.
    if (bars.length > MAX_BARS) bars = bars.slice(bars.length - MAX_BARS);
    const lastBarTime = bars[bars.length - 1].time;
    const barLagLimit = Math.max(180, granularitySeconds * 2);
    const freshness: "live" | "stale" = resolution === "D" || to - lastBarTime <= barLagLimit ? "live" : "stale";
    const value: MarketDataBars = {
      symbol: market.symbol,
      resolution,
      source: "Coinbase Exchange",
      freshness,
      bars,
      from,
      to,
      asOf: now,
      lastBarTime,
    };
    cache.set(cacheKey, { expiresAt: now + (freshness === "live" ? 15_000 : 5 * 60_000), value });
    failed.delete(cacheKey);
    return value;
  })();
  inFlight.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Coinbase chart request failed");
    failed.set(cacheKey, { expiresAt: now + 15_000, error: normalized });
    throw normalized;
  } finally {
    inFlight.delete(cacheKey);
  }
}
