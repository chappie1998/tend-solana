// Chart bars (and realized volatility) from Twelve Data's `time_series`
// endpoint -- the stock counterpart to coinbase-market-bars.ts (crypto).
// Selected for the same reason as finnhub-market-data.ts: this deployment's
// Pyth key has no equity/tokenized-equity entitlement, and Finnhub's own
// candle endpoint 403s on the free tier, so bars for NVDA/GOOGL come from a
// second provider entirely.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: fetch `interval=1min` ONCE per
// symbol and derive every other ChartResolution ("5", "15", "60", "D") from
// that single series by local OHLC aggregation. Verified empirically
// (2026-09-15) against Twelve Data's free plan:
//
//   - the plan is 800 credits/day, 8 requests/minute;
//   - one `time_series` request costs exactly 1 credit REGARDLESS of
//     `outputsize` -- 1,440 bars cost the same as 10 -- so there is no
//     credit reason to ever request a coarser resolution directly, only a
//     correctness reason not to (a second request is a second chance to
//     rate-limit or burn budget for data this file can derive for free);
//   - stock bars only exist during regular trading hours (~390 minutes/day):
//     1,440 one-minute NVDA bars measured live spanned SIX calendar days
//     (2026-09-09 15:03 -> 2026-09-15 13:02), not one. Outside RTH the
//     series does not change at all, which is why the raw-series cache TTL
//     below is keyed off the newest bar's own age rather than a hardcoded
//     trading calendar -- staleness is read off the data, never assumed.
//
// Twelve Data's `datetime` values carry no UTC offset -- they are wall-clock
// time in `meta.exchange_timezone` (e.g. "America/New_York") -- so every bar
// is converted with exchangeTimeToEpochSeconds below rather than parsed as
// if it were UTC, which would silently shift every candle by 4-5 hours.
import {
  chartLookbackSeconds,
  chartResolutionSeconds,
  MAX_BARS,
  type ChartResolution,
  type MarketBar,
} from "./market-bars.ts";
import type { MarketDataBars, RealizedVolatility } from "./market-data-types.ts";
import type { Market } from "./markets.ts";
import { fetchJsonCapped } from "./http-fetch-capped.ts";
import { runtimeEnv } from "./runtime-env.ts";

const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_BYTES = 3_000_000;
// The largest window Twelve Data's `time_series` accepts on the plan this
// deployment verified against (1,440 was the value confirmed live; this
// deployment requests more only because outputsize is free -- see the file
// header). If a smaller plan ever rejects this, lower it -- the aggregation
// logic below is unaffected either way, it just has less raw history to fold.
const RAW_OUTPUT_SIZE = 5_000;

// --- raw 1-minute series: one fetch per symbol, shared by every resolution ---

type RawSeries = {
  symbol: string;
  exchangeTimezone: string;
  /** Ascending (oldest first), deduped by minute -- see parseTwelveDataResponse. */
  bars: MarketBar[];
};

const RAW_FRESH_BAR_MAX_AGE_SECONDS = 5 * 60;
// While the newest bar is recent (market likely open), refetch at most once
// a minute -- there is no point polling faster than the bar granularity
// itself, and this alone keeps every consumer miles under the 8 req/min cap.
const RAW_FRESH_TTL_MS = 60_000;
// Once the newest bar has stopped moving (market closed), the series will
// not change again until the next session opens, so there is nothing to gain
// from checking every minute -- this is the "TTL must be much longer when
// the market is closed" requirement, driven by the data's own staleness
// rather than a holiday calendar.
const RAW_STALE_TTL_MS = 2 * 60 * 60_000;
const RAW_FAILURE_BACKOFF_MS = 20_000;

const rawCache = new Map<string, { expiresAt: number; value: RawSeries }>();
const rawInFlight = new Map<string, Promise<RawSeries>>();
const rawFailed = new Map<string, { expiresAt: number; error: Error }>();

function twelveDataBaseUrl() {
  return runtimeEnv("TWELVE_DATA_API_URL") || "https://api.twelvedata.com";
}

function timeSeriesUrl(symbol: string, apiKey: string): URL {
  const url = new URL("/time_series", twelveDataBaseUrl());
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", String(RAW_OUTPUT_SIZE));
  url.searchParams.set("apikey", apiKey);
  return url;
}

const EXCHANGE_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

const exchangeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function exchangeTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = exchangeFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  exchangeFormatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Converts a Twelve Data `datetime` string ("YYYY-MM-DD HH:mm:ss", wall-clock
 * time in `timeZone`, no offset) into true UTC epoch seconds.
 *
 * Standard "double conversion" trick, the same one timezone libraries use
 * without a VM-provided IANA offset table: interpret the wall clock as if it
 * were already UTC to get a first guess, ask `Intl` what that guess reads as
 * inside the target zone, and the gap between the two readings IS the zone's
 * offset at that instant -- correct across a DST transition because it is
 * derived from the real date, never a fixed offset constant.
 *
 * Exported and unit-tested directly (see tests/stock-market-data.test.mjs)
 * against both an EDT and an EST instant: getting this wrong doesn't throw,
 * it silently shifts every candle by 4-5 hours, which is exactly the failure
 * mode a fixture test needs to catch that live verification easily wouldn't.
 */
export function exchangeTimeToEpochSeconds(dateTime: string, timeZone: string): number {
  const match = EXCHANGE_DATETIME_PATTERN.exec(dateTime);
  if (!match) throw new Error(`Twelve Data datetime "${dateTime}" is not in the expected "YYYY-MM-DD HH:mm:ss" format`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = exchangeTimeZoneFormatter(timeZone).formatToParts(new Date(guessMs));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const guessReadBackAsUtcMs = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  const trueUtcMs = 2 * guessMs - guessReadBackAsUtcMs;
  return Math.floor(trueUtcMs / 1_000);
}

type TwelveDataMeta = { exchange_timezone?: unknown };
type TwelveDataValue = { datetime?: unknown; open?: unknown; high?: unknown; low?: unknown; close?: unknown };
type TwelveDataResponse = { meta?: TwelveDataMeta; values?: unknown[]; status?: unknown; message?: unknown };

/** Parses one raw `values[]` row. Twelve Data sends OHLC as strings, not numbers. */
export function parseTwelveDataBarRow(row: unknown, exchangeTimezone: string): MarketBar {
  if (!row || typeof row !== "object") throw new Error("Twelve Data bar row is malformed");
  const value = row as TwelveDataValue;
  if (typeof value.datetime !== "string") throw new Error("Twelve Data bar row is missing a datetime");
  const open = Number(value.open);
  const high = Number(value.high);
  const low = Number(value.low);
  const close = Number(value.close);
  if ([open, high, low, close].some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error("Twelve Data bar prices are invalid");
  }
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new Error("Twelve Data bar OHLC bounds are invalid");
  }
  return { time: exchangeTimeToEpochSeconds(value.datetime, exchangeTimezone), open, high, low, close };
}

/**
 * Parses a full `time_series` response into an ascending, deduped 1-minute
 * series. Twelve Data returns HTTP 200 with `status: "error"` in the body
 * for an unknown symbol (e.g. SpaceX, which trades nowhere and has no ticker
 * on this provider either) -- that must fail honestly, never be read as "no
 * bars yet" and passed through as an empty-but-valid series.
 */
export function parseTwelveDataResponse(raw: unknown, symbol: string): { bars: MarketBar[]; exchangeTimezone: string } {
  if (!raw || typeof raw !== "object") throw new Error(`Twelve Data returned an invalid response for ${symbol}`);
  const body = raw as TwelveDataResponse;
  if (body.status === "error") {
    const message = typeof body.message === "string" ? body.message : "unknown error";
    throw new Error(`Twelve Data has no data for ${symbol}: ${message}`);
  }
  const exchangeTimezone = body.meta?.exchange_timezone;
  if (typeof exchangeTimezone !== "string" || !exchangeTimezone) {
    throw new Error(`Twelve Data returned no exchange timezone for ${symbol}`);
  }
  if (!Array.isArray(body.values) || body.values.length === 0) {
    throw new Error(`Twelve Data returned no bars for ${symbol}`);
  }
  // Twelve Data returns values newest-first; fold through a Map keyed by
  // time (defensive de-dup, mirroring mergeCandlePages in
  // coinbase-market-bars.ts) then sort ascending so bars follow the same
  // ordering convention every other provider in this app already uses.
  const byTime = new Map<number, MarketBar>();
  for (const row of body.values) {
    const bar = parseTwelveDataBarRow(row, exchangeTimezone);
    byTime.set(bar.time, bar);
  }
  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { bars, exchangeTimezone };
}

/**
 * Folds ascending 1-minute bars into ascending `bucketSeconds` candles --
 * open of the first minute in a bucket, close of the last, high/low the
 * extremes across the bucket. Never mutates an input or already-built bar;
 * each bucket update produces a fresh MarketBar.
 */
export function aggregateBars(bars: MarketBar[], bucketSeconds: number): MarketBar[] {
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error("aggregateBars requires a positive bucket size");
  }
  const buckets = new Map<number, MarketBar>();
  for (const bar of bars) {
    const bucketStart = bar.time - (bar.time % bucketSeconds);
    const existing = buckets.get(bucketStart);
    const merged: MarketBar = existing
      ? {
          time: bucketStart,
          open: existing.open,
          high: Math.max(existing.high, bar.high),
          low: Math.min(existing.low, bar.low),
          close: bar.close,
        }
      : { time: bucketStart, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
    buckets.set(bucketStart, merged);
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function fetchRawSeries(symbol: string, now: number): Promise<RawSeries> {
  const cached = rawCache.get(symbol);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = rawFailed.get(symbol);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const active = rawInFlight.get(symbol);
  if (active) return active;

  const request = (async () => {
    const apiKey = runtimeEnv("TWELVE_DATA_API_KEY");
    if (!apiKey) throw new Error("TWELVE_DATA_API_KEY is not configured; stock chart bars are unavailable until it is set.");
    const raw = await fetchJsonCapped(timeSeriesUrl(symbol, apiKey), {
      headers: { Accept: "application/json" },
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      maxBytes: MAX_UPSTREAM_BYTES,
      label: "Twelve Data",
    });
    const parsed = parseTwelveDataResponse(raw, symbol);
    const value: RawSeries = { symbol, exchangeTimezone: parsed.exchangeTimezone, bars: parsed.bars };
    const lastBarTime = value.bars[value.bars.length - 1].time;
    const isFresh = now / 1_000 - lastBarTime <= RAW_FRESH_BAR_MAX_AGE_SECONDS;
    rawCache.set(symbol, { expiresAt: now + (isFresh ? RAW_FRESH_TTL_MS : RAW_STALE_TTL_MS), value });
    rawFailed.delete(symbol);
    return value;
  })();
  rawInFlight.set(symbol, request);
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Twelve Data request failed");
    rawFailed.set(symbol, { expiresAt: now + RAW_FAILURE_BACKOFF_MS, error: normalized });
    throw normalized;
  } finally {
    rawInFlight.delete(symbol);
  }
}

// --- per-resolution bars: cached/deduped the same way coinbase-market-bars.ts is ---

const cache = new Map<string, { expiresAt: number; value: MarketDataBars }>();
const inFlight = new Map<string, Promise<MarketDataBars>>();
const failed = new Map<string, { expiresAt: number; error: Error }>();

/**
 * The ticker an off-chain equity provider knows this market by. Falls back to
 * `symbol` when they agree (NVDA, GOOGL). They are separate fields on purpose:
 * `symbol` is permanent on-chain identity (hashed into the market PDA and the
 * CustomPriceFeed seed), while this is just a vendor's spelling -- SPACEX
 * trades as SPCX. See the `equityTicker` doc comment in app/lib/markets.ts.
 */
function tickerFor(market: Market): string {
  return market.equityTicker || market.symbol;
}

export async function getTwelveDataMarketBars(
  market: Market,
  resolution: ChartResolution,
  now = Date.now(),
): Promise<MarketDataBars> {
  const symbol = tickerFor(market);
  const cacheKey = `${symbol}:${resolution}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = failed.get(cacheKey);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const active = inFlight.get(cacheKey);
  if (active) return active;

  const request = (async () => {
    const raw = await fetchRawSeries(symbol, now);
    const bucketSeconds = chartResolutionSeconds(resolution);
    // "1" IS the raw series -- aggregating it into 60-second buckets would be
    // a no-op, so skip the extra pass rather than merely tolerate it.
    const bars = resolution === "1" ? raw.bars : aggregateBars(raw.bars, bucketSeconds);
    if (bars.length === 0) throw new Error(`Twelve Data has no ${symbol} bars for this range`);
    // Same ceiling every provider respects (market-bars.ts); only reachable
    // here if RAW_OUTPUT_SIZE ever grows past MAX_BARS for the "1" case.
    const trimmed = bars.length > MAX_BARS ? bars.slice(bars.length - MAX_BARS) : bars;
    const to = Math.floor(now / 1_000);
    const from = to - chartLookbackSeconds(resolution);
    const lastBarTime = trimmed[trimmed.length - 1].time;
    const barLagLimit = Math.max(180, bucketSeconds * 2);
    // Same freshness convention as Coinbase/Pyth (market-bars.ts): a daily
    // bar is always "live", an intraday bar is "live" only within twice its
    // own bucket width of `now`. Outside RTH the newest bar simply IS old --
    // this reads staleness off the data, the same signal the raw-series
    // cache above uses, never a market-hours assumption.
    const freshness: "live" | "stale" = resolution === "D" || to - lastBarTime <= barLagLimit ? "live" : "stale";
    const value: MarketDataBars = {
      symbol,
      resolution,
      source: "Twelve Data",
      freshness,
      bars: trimmed,
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
    const normalized = error instanceof Error ? error : new Error("Twelve Data chart request failed");
    failed.set(cacheKey, { expiresAt: now + 15_000, error: normalized });
    throw normalized;
  } finally {
    inFlight.delete(cacheKey);
  }
}

// --- realized volatility, derived from the same daily aggregation ---

const volatilityCache = new Map<string, { expiresAt: number; value: RealizedVolatility }>();

const utcTradingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export async function getTwelveDataRealizedVolatility(market: Market): Promise<RealizedVolatility> {
  const symbol = tickerFor(market);
  const cached = volatilityCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const history = await getTwelveDataMarketBars(market, "D");
  // Drop the most recent daily bar if its UTC day hasn't finished yet, same
  // method as coinbase-market-data.ts and pyth-market-data.ts: a regular
  // NYSE/NASDAQ session (13:30-20:00 or 13:30-21:00 UTC depending on DST)
  // never crosses a UTC calendar-day boundary, so bucketing by UTC day here
  // agrees with the exchange's own trading date without needing a separate
  // timezone-aware "is today's session still open" check.
  const asOfDate = utcTradingDate.format(new Date(history.asOf));
  const completedBars = history.bars.filter((bar) => utcTradingDate.format(new Date(bar.time * 1_000)) !== asOfDate);
  const prices = completedBars.slice(-21).map((bar) => bar.close);
  if (prices.length < 10) {
    throw new Error(`Twelve Data historical coverage for ${symbol} is insufficient for volatility pricing`);
  }
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  // 252, not 365: unlike every crypto feed this app also prices (which
  // trade 24/7, see pyth-market-data.ts's own comment on this exact trap),
  // a stock's daily bars only exist on the ~252 US trading days per year.
  // Sampling 252 returns/year and annualizing by sqrt(365) would OVERSTATE
  // realized vol by sqrt(365/252) = ~1.20x -- the mirror image of the crypto
  // trap, and just as capable of mispricing every option quoted off it.
  const barsPerYear = 252;
  const annualized = Math.sqrt(variance) * Math.sqrt(barsPerYear) * 100;
  if (!Number.isFinite(annualized) || annualized < 1 || annualized > 400) {
    throw new Error(`Twelve Data volatility result for ${symbol} is outside risk bounds`);
  }
  const value: RealizedVolatility = {
    value: annualized,
    observations: prices.length,
    source: "Twelve Data 20-session realized volatility",
    asOf: history.asOf,
  };
  volatilityCache.set(symbol, { expiresAt: Date.now() + 15 * 60_000, value });
  return value;
}
