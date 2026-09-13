import {
  chartLookbackSeconds,
  chartResolutionSeconds,
  parsePythUdfBars,
  type ChartResolution,
  type MarketBar,
} from "./market-bars.ts";
import type { Market } from "./markets.ts";
import { runtimeEnv } from "./runtime-env.ts";

export type PythMarketBars = {
  symbol: string;
  resolution: ChartResolution;
  source: "Pyth Benchmarks";
  // Whether the most recent bar is inside the normal publish cadence for this
  // resolution. There is no "market closed" state — Tend quotes 24/7 — this
  // just tells the chart whether to poll fast or slow.
  freshness: "live" | "stale";
  bars: MarketBar[];
  from: number;
  to: number;
  asOf: number;
  lastBarTime: number;
};

// Measured: Pyth's history API returns a 1,440-bar window in ~2.1-2.8s. 8s left
// barely 3x headroom, and a single slow response aborted the request outright
// -- the user saw "Couldn't load real market bars" for what was really one slow
// upstream call. 15s keeps a comfortable margin while staying far inside the
// serverless execution ceiling.
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_BYTES = 2_000_000;
const PYTH_AUTH_REQUIRED_AT = Date.UTC(2026, 6, 31);
const cache = new Map<string, { expiresAt: number; value: PythMarketBars }>();
const inFlight = new Map<string, Promise<PythMarketBars>>();
const failed = new Map<string, { expiresAt: number; error: Error }>();

/**
 * Pyth Pro's History API — the documented replacement for the Benchmarks
 * TradingView shim, which Pyth RETIRED in the 2026-08-26 Core upgrade. The old
 * `/v1/shims/tradingview/history` endpoint now returns 404, not 401, so an API
 * key alone does not revive it; that retirement is why the chart rendered
 * "Couldn't load real market bars" on every load. Pro implements the same UDF
 * contract (`symbol`/`resolution`/`from`/`to` in, `{ s, t, o, h, l, c }` out),
 * so only the base URL changed — the parser below is untouched.
 *
 * Overridable by env so a self-hosted or third-party instance can be pointed
 * at without a code change.
 */
const PYTH_HISTORY_URL =
  runtimeEnv("PYTH_HISTORY_URL")?.trim() || "https://pyth.dourolabs.app/v1/fixed_rate@200ms/history";

function benchmarksHistoryUrl(market: Market, resolution: ChartResolution, nowSeconds: number) {
  const url = new URL(PYTH_HISTORY_URL);
  url.searchParams.set("symbol", market.pythSymbol);
  url.searchParams.set("resolution", resolution);
  url.searchParams.set("from", String(nowSeconds - chartLookbackSeconds(resolution)));
  url.searchParams.set("to", String(nowSeconds));
  return url;
}

async function fetchPythHistory(url: URL) {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = runtimeEnv("PYTH_API_KEY");
  if (!apiKey && Date.now() >= PYTH_AUTH_REQUIRED_AT) {
    throw new Error("Pyth API authentication is not configured");
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      // workerd rejects redirect: "error"; "manual" still refuses to follow, and
      // the 3xx response then fails the response.ok check below.
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Pyth history API returned ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPSTREAM_BYTES) {
      throw new Error("Pyth chart response is too large");
    }
    if (!response.body) throw new Error("Pyth chart response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BYTES) {
        await reader.cancel();
        throw new Error("Pyth chart response is too large");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPythMarketBars(
  market: Market,
  resolution: ChartResolution,
  now = Date.now(),
): Promise<PythMarketBars> {
  const cacheKey = `${market.pythSymbol}:${resolution}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = failed.get(cacheKey);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const active = inFlight.get(cacheKey);
  if (active) return active;

  const request = (async () => {
    const to = Math.floor(now / 1_000);
    const from = to - chartLookbackSeconds(resolution);
    const bars = parsePythUdfBars(await fetchPythHistory(benchmarksHistoryUrl(market, resolution, to)));
    const resolutionSeconds = chartResolutionSeconds(resolution);
    const firstBarTime = bars[0].time;
    const lastBarTime = bars[bars.length - 1].time;
    if (firstBarTime < from - resolutionSeconds || lastBarTime > to + resolutionSeconds) {
      throw new Error("Pyth chart timestamps are outside the requested range");
    }
    const barLagLimit = Math.max(180, resolutionSeconds * 2);
    const freshness: "live" | "stale" = resolution === "D" || to - lastBarTime <= barLagLimit ? "live" : "stale";
    const value: PythMarketBars = {
      symbol: market.symbol,
      resolution,
      source: "Pyth Benchmarks",
      freshness,
      bars,
      from,
      to,
      asOf: now,
      lastBarTime,
    };
    cache.set(cacheKey, {
      expiresAt: now + (freshness === "live" ? 15_000 : 5 * 60_000),
      value,
    });
    failed.delete(cacheKey);
    return value;
  })();
  inFlight.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Pyth chart request failed");
    failed.set(cacheKey, { expiresAt: now + 15_000, error: normalized });
    throw normalized;
  } finally {
    inFlight.delete(cacheKey);
  }
}
