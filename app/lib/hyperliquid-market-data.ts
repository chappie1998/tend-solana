// Spot snapshot, chart bars, and realized volatility for STOCK markets
// (category "stocks": NVDA, GOOGL, SPACEX) from Hyperliquid's public HIP-3
// builder-deployed "xyz" DEX -- the stock counterpart to coinbase-market-data.ts
// / coinbase-market-bars.ts (crypto).
//
// This REPLACES finnhub-market-data.ts (spot) + twelvedata-market-bars.ts
// (bars/realized vol) entirely. Those served real exchange quotes, but a
// real equity's last-trade price freezes outside 09:30-16:00 America/New_York
// -- which is exactly what forced app/lib/expiries.ts to gate stock expiries
// to regular trading hours via app/lib/market-hours.ts in the first place.
// Hyperliquid's xyz:* markets are tokenized-equity PERPS that genuinely trade
// around the clock, so Tend's stock listings can go back to the same 24/7
// grid every crypto listing already uses, with no clock gate anywhere.
//
// Verified live (2026-09-16):
//   - `POST /info` `{"type":"metaAndAssetCtxs","dex":"xyz"}` returns
//     `[meta, ctxs]` covering all 120 xyz markets in ONE call -- meta.universe[i]
//     names the coin ("xyz:NVDA"), ctxs[i] is the index-aligned price context
//     (markPx/oraclePx/etc). This is why the universe is fetched and cached
//     ONCE, not once per symbol -- see getHyperliquidUniverse below.
//   - Two oracle-price samples 40s apart at 22:07 ET (US equity market
//     closed) showed 2 of 3 stock symbols had moved -- a real, continuously
//     updating price, not a frozen or synthetic one.
//   - xyz:NVDA's oracle price (212.09) matched Finnhub's live RTH quote
//     (212.17) to ~0.04% -- the same underlying, not a look-alike index.
//   - `POST /info` `{"type":"candleSnapshot","req":{"coin":"xyz:NVDA",
//     "interval":"5m","startTime":...,"endTime":...}}` returned bars
//     spanning a continuous 72 hours, 289 of them while the US equity market
//     was closed -- confirming bars, not just the spot tick, are 24/7 too.
//
// No API key and no credit budget: this is a free, public, unauthenticated
// endpoint, unlike Finnhub/Twelve Data's free-tier keys it replaces.
//
// ONCHAIN SETTLEMENT IS UNAFFECTED. It always verifies a fresh Pyth
// PriceUpdateV2 against the exact feed id hashed into the market
// (vsol/programs/vsol/src/pyth.rs); this file only supplies the off-chain
// reference a user sees and quotes off before they trade.
import {
  chartLookbackSeconds,
  chartResolutionSeconds,
  MAX_BARS,
  type ChartResolution,
  type MarketBar,
} from "./market-bars.ts";
import type { MarketDataBars, MarketSnapshot, RealizedVolatility } from "./market-data-types.ts";
import type { Market } from "./markets.ts";
import { fetchJsonCapped } from "./http-fetch-capped.ts";
import { runtimeEnv } from "./runtime-env.ts";

/**
 * "xyz" is a HIP-3 BUILDER-DEPLOYED dex living on top of Hyperliquid --
 * a third party's permissionless perp market deployment, not "Hyperliquid
 * core" (the BTC/ETH/... perps Hyperliquid itself operates). Every coin this
 * file asks for is namespaced under it (`xyz:NVDA`, `xyz:GOOGL`, `xyz:SPCX`);
 * a bare "NVDA" would be a Hyperliquid-core perp lookup and 404/format-error
 * against a name that dex has never listed.
 */
const HYPERLIQUID_STOCK_DEX = "xyz";

function hyperliquidInfoUrl(): URL {
  return new URL("/info", runtimeEnv("HYPERLIQUID_API_URL") || "https://api.hyperliquid.xyz");
}

/**
 * The coin name Hyperliquid's xyz dex knows this market by:
 * `xyz:${equityTicker || symbol}` -- e.g. `xyz:NVDA`, `xyz:GOOGL`, and (via
 * SPACEX's equityTicker override) `xyz:SPCX`. Same `equityTicker || symbol`
 * rule Finnhub/Twelve Data used (see that field's doc comment in
 * app/lib/markets.ts): `symbol` is permanent on-chain identity hashed into
 * the market PDA, the vendor ticker is just how an off-chain provider spells
 * the same equity, and Hyperliquid is exactly such a vendor.
 */
export function hyperliquidCoinFor(market: Pick<Market, "symbol" | "equityTicker">): string {
  return `${HYPERLIQUID_STOCK_DEX}:${market.equityTicker || market.symbol}`;
}

// --- shared "info" POST helper -------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;

async function postInfo(body: Record<string, unknown>, maxBytes: number): Promise<unknown> {
  return fetchJsonCapped(hyperliquidInfoUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes,
    label: "Hyperliquid",
  });
}

// --- universe: ONE metaAndAssetCtxs call serves every stock symbol -------

type HyperliquidAssetCtx = { markPx: number; oraclePx: number };

/**
 * Validates and reshapes a raw `metaAndAssetCtxs` response into a coin-name
 * lookup. Only the OVERALL response shape is checked eagerly here (it is a
 * two-element `[meta, ctxs]` tuple with matching-length arrays) -- per-symbol
 * field validation (numeric markPx/oraclePx) happens lazily in
 * `resolveHyperliquidAssetCtx`, on whichever symbol a caller actually asks
 * for, so a malformed entry among the other ~117 xyz markets this app never
 * reads can never block NVDA/GOOGL/SPCX.
 */
export function parseHyperliquidUniverse(raw: unknown): Map<string, unknown> {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error("Hyperliquid returned an invalid metaAndAssetCtxs response");
  }
  const [meta, ctxs] = raw as [unknown, unknown];
  if (!meta || typeof meta !== "object" || !Array.isArray((meta as { universe?: unknown }).universe)) {
    throw new Error("Hyperliquid metaAndAssetCtxs response is missing its universe");
  }
  const universe = (meta as { universe: unknown[] }).universe;
  if (!Array.isArray(ctxs) || ctxs.length !== universe.length) {
    throw new Error("Hyperliquid metaAndAssetCtxs response has mismatched universe/context lengths");
  }
  const byCoin = new Map<string, unknown>();
  universe.forEach((entry, index) => {
    if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
      byCoin.set((entry as { name: string }).name, ctxs[index]);
    }
  });
  return byCoin;
}

/** Extracts and validates one coin's price context, throwing an error that names the coin -- never a silently wrong or zero price. */
export function resolveHyperliquidAssetCtx(universe: Map<string, unknown>, coin: string): HyperliquidAssetCtx {
  if (!universe.has(coin)) throw new Error(`Hyperliquid's xyz dex has no market listed for ${coin}`);
  const raw = universe.get(coin);
  if (!raw || typeof raw !== "object") throw new Error(`Hyperliquid returned no price context for ${coin}`);
  const ctx = raw as { markPx?: unknown; oraclePx?: unknown };
  const markPx = Number(ctx.markPx);
  const oraclePx = Number(ctx.oraclePx);
  if (!Number.isFinite(markPx) || markPx <= 0) throw new Error(`Hyperliquid returned an invalid mark price for ${coin}`);
  if (!Number.isFinite(oraclePx) || oraclePx <= 0) throw new Error(`Hyperliquid returned an invalid oracle price for ${coin}`);
  return { markPx, oraclePx };
}

// Short TTL, not "cache forever": the universe is fetched fresh often enough
// that `ageSeconds` below (derived from when THIS cache entry was fetched,
// not a per-asset timestamp Hyperliquid never sends) stays an honest measure
// of how live the price is, while still collapsing the near-simultaneous
// NVDA/GOOGL/SPCX requests a single quote or catalog refresh issues into the
// ONE upstream call the whole universe needs.
const UNIVERSE_TTL_MS = 10_000;
const UNIVERSE_FAILURE_BACKOFF_MS = 5_000;
// Measured live (2026-09-16): the full 120-market response is ~54KB. Ample
// headroom for the universe to grow before this ever needs raising.
const UNIVERSE_MAX_BYTES = 500_000;

type UniverseCacheEntry = { expiresAt: number; fetchedAt: number; value: Map<string, unknown> };

let universeCache: UniverseCacheEntry | null = null;
let universeInFlight: Promise<UniverseCacheEntry> | null = null;
let universeFailure: { expiresAt: number; error: Error } | null = null;

/**
 * Fetches (or reuses) the whole xyz universe as ONE `metaAndAssetCtxs` call,
 * regardless of how many symbols ask for it concurrently -- the requirement
 * this whole module exists to satisfy. Returns the fetch time alongside the
 * parsed map so callers can compute an honest `ageSeconds` without
 * Hyperliquid ever having to supply a per-asset timestamp itself.
 */
async function getHyperliquidUniverse(now: number): Promise<UniverseCacheEntry> {
  if (universeCache && universeCache.expiresAt > now) return universeCache;
  const recentFailure = universeFailure;
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  if (universeInFlight) return universeInFlight;

  const request = (async () => {
    const raw = await postInfo({ type: "metaAndAssetCtxs", dex: HYPERLIQUID_STOCK_DEX }, UNIVERSE_MAX_BYTES);
    const value = parseHyperliquidUniverse(raw);
    // Keyed off the CALLER's `now`, not a fresh `Date.now()` read here --
    // same convention coinbase-market-bars.ts's cache uses -- so a caller
    // driving `now` itself (tests; a future batched caller) gets a cache
    // whose freshness is fully determined by the `now` it passes, rather
    // than silently mixing in the real wall clock.
    const entry: UniverseCacheEntry = { expiresAt: now + UNIVERSE_TTL_MS, fetchedAt: now, value };
    universeCache = entry;
    universeFailure = null;
    return entry;
  })();
  universeInFlight = request;
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Hyperliquid universe request failed");
    universeFailure = { expiresAt: now + UNIVERSE_FAILURE_BACKOFF_MS, error: normalized };
    throw normalized;
  } finally {
    universeInFlight = null;
  }
}

// --- snapshot --------------------------------------------------------------

export async function getHyperliquidSnapshot(market: Market, now = Date.now()): Promise<MarketSnapshot> {
  const coin = hyperliquidCoinFor(market);
  const universe = await getHyperliquidUniverse(now);
  const { markPx, oraclePx } = resolveHyperliquidAssetCtx(universe.value, coin);
  // Hyperliquid's `metaAndAssetCtxs` carries no per-asset publish timestamp
  // (unlike Coinbase's ticker `time` or a Pyth PriceUpdateV2), so `publishTime`
  // is honestly the moment THIS cache entry was fetched, and `ageSeconds` is
  // how long ago that was -- never a fabricated "just now" on every read,
  // which would hide a stale universe entry behind an always-fresh clock.
  const ageSeconds = Math.max(0, Math.round((now - universe.fetchedAt) / 1_000));
  const mode: "live" | "stale" = ageSeconds <= 30 ? "live" : "stale";
  // Confidence: Hyperliquid gives both a mark price (the perp's own traded
  // price) and an oracle price (its external reference, blended from spot
  // sources). |mark - oracle| is a real, honest dispersion proxy between two
  // independently-derived prices for the same asset -- NOT a Pyth-style
  // confidence interval, and NOT the high-low proxy Finnhub's snapshot used
  // either. It is legitimately close to zero when the perp is trading tight
  // to its oracle (as it usually is), which makes it a TIGHTER measure than
  // Finnhub's half-day-range proxy, not a broken one -- a near-zero value
  // here means the two independent prices agree, not that nothing was
  // computed.
  const confidence = Math.abs(markPx - oraclePx);
  const confidenceBps = (confidence / markPx) * 10_000;
  const ageMinutes = Math.max(1, Math.round(ageSeconds / 60));
  const value: MarketSnapshot = {
    price: markPx,
    confidence,
    confidenceBps,
    exponent: 0,
    publishTime: Math.floor(universe.fetchedAt / 1_000),
    slot: null,
    ageSeconds,
    mode,
    source: "Hyperliquid",
    warning: mode === "live"
      ? "Fresh Hyperliquid xyz reference (|mark - oracle| stands in for a confidence interval and can legitimately read near zero); onchain settlement still requires a separately verified Pyth update."
      : `Reference is ${ageMinutes} min old; Hyperliquid's ${coin} universe fetch is not refreshing right now. Gap risk is priced into the quote, not hidden.`,
  };
  return value;
}

// --- chart bars --------------------------------------------------------------

const INTERVAL_BY_RESOLUTION: Record<ChartResolution, string> = {
  "1": "1m",
  "5": "5m",
  "15": "15m",
  "60": "1h",
  D: "1d",
};

type HyperliquidCandleRow = { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown };

/**
 * Parses one `candleSnapshot` row. Hyperliquid's `t` is the candle's OPEN
 * time in MILLISECONDS; every `MarketBar.time` in this app is epoch SECONDS
 * (see market-bars.ts) -- this is the one required ms -> s conversion this
 * provider needs that Coinbase/Pyth (native seconds) never did and Twelve
 * Data (a wall-clock string) needed for a different reason entirely.
 */
export function parseHyperliquidCandleRow(row: unknown, coin: string): MarketBar {
  if (!row || typeof row !== "object") throw new Error(`Hyperliquid candle row for ${coin} is malformed`);
  const value = row as HyperliquidCandleRow;
  const timeMs = Number(value.t);
  const open = Number(value.o);
  const high = Number(value.h);
  const low = Number(value.l);
  const close = Number(value.c);
  if (!Number.isFinite(timeMs) || timeMs <= 0) throw new Error(`Hyperliquid candle timestamp for ${coin} is invalid`);
  if ([open, high, low, close].some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error(`Hyperliquid candle prices for ${coin} are invalid`);
  }
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new Error(`Hyperliquid candle OHLC bounds for ${coin} are invalid`);
  }
  return { time: Math.floor(timeMs / 1_000), open, high, low, close };
}

/**
 * Parses a full `candleSnapshot` array. Verified live (2026-09-16):
 * Hyperliquid already returns rows ascending (oldest first) and, unlike
 * Coinbase's 300-candle-per-request cap, a single request covers this app's
 * entire lookback window at every resolution (1,441 one-minute bars for a
 * 24h window measured live) -- so, unlike coinbase-market-bars.ts, no
 * pagination/merge step is needed here. Still sorted defensively rather than
 * trusting an external API's ordering to never change, matching every other
 * provider's posture in this app.
 */
export function parseHyperliquidCandles(raw: unknown, coin: string): MarketBar[] {
  if (!Array.isArray(raw)) throw new Error(`Hyperliquid returned an invalid candle response for ${coin}`);
  const bars = raw.map((row) => parseHyperliquidCandleRow(row, coin));
  return bars.sort((a, b) => a.time - b.time);
}

const MAX_CANDLE_BYTES = 1_000_000;

const barsCache = new Map<string, { expiresAt: number; value: MarketDataBars }>();
const barsInFlight = new Map<string, Promise<MarketDataBars>>();
const barsFailed = new Map<string, { expiresAt: number; error: Error }>();

export async function getHyperliquidMarketBars(
  market: Market,
  resolution: ChartResolution,
  now = Date.now(),
): Promise<MarketDataBars> {
  const coin = hyperliquidCoinFor(market);
  const cacheKey = `${coin}:${resolution}`;
  const cached = barsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = barsFailed.get(cacheKey);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const active = barsInFlight.get(cacheKey);
  if (active) return active;

  const request = (async () => {
    const granularitySeconds = chartResolutionSeconds(resolution);
    const to = Math.floor(now / 1_000);
    const from = to - chartLookbackSeconds(resolution);
    const raw = await postInfo(
      {
        type: "candleSnapshot",
        req: { coin, interval: INTERVAL_BY_RESOLUTION[resolution], startTime: from * 1_000, endTime: now },
      },
      MAX_CANDLE_BYTES,
    );
    let bars = parseHyperliquidCandles(raw, coin);
    if (bars.length === 0) throw new Error(`Hyperliquid returned no candle data for ${coin}`);
    // Same shared ceiling every provider in this app respects (market-bars.ts).
    if (bars.length > MAX_BARS) bars = bars.slice(bars.length - MAX_BARS);
    const lastBarTime = bars[bars.length - 1].time;
    const barLagLimit = Math.max(180, granularitySeconds * 2);
    const freshness: "live" | "stale" = resolution === "D" || to - lastBarTime <= barLagLimit ? "live" : "stale";
    const value: MarketDataBars = {
      symbol: market.symbol,
      resolution,
      source: "Hyperliquid",
      freshness,
      bars,
      from,
      to,
      asOf: now,
      lastBarTime,
    };
    barsCache.set(cacheKey, { expiresAt: now + (freshness === "live" ? 15_000 : 5 * 60_000), value });
    barsFailed.delete(cacheKey);
    return value;
  })();
  barsInFlight.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Hyperliquid chart request failed");
    barsFailed.set(cacheKey, { expiresAt: now + 15_000, error: normalized });
    throw normalized;
  } finally {
    barsInFlight.delete(cacheKey);
  }
}

// --- realized volatility, derived from daily bars -------------------------

const volatilityCache = new Map<string, { expiresAt: number; value: RealizedVolatility }>();

const utcTradingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export async function getHyperliquidRealizedVolatility(market: Market): Promise<RealizedVolatility> {
  const coin = hyperliquidCoinFor(market);
  const cached = volatilityCache.get(coin);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const history = await getHyperliquidMarketBars(market, "D");
  // Same method as coinbase-market-data.ts: drop the most recent daily bar if
  // its UTC day has not finished yet, so volatility is never computed off a
  // partial candle. 365, not 252 (which twelvedata-market-bars.ts's own
  // realized-vol used): xyz:NVDA/GOOGL/SPCX trade 24/7 on Hyperliquid now,
  // the same as every crypto listing here, so daily bars exist on all 365
  // calendar days rather than the ~252 US-equity trading sessions Twelve
  // Data's feed was limited to.
  const asOfDate = utcTradingDate.format(new Date(history.asOf));
  const completedBars = history.bars.filter((bar) => utcTradingDate.format(new Date(bar.time * 1_000)) !== asOfDate);
  const prices = completedBars.slice(-21).map((bar) => bar.close);
  if (prices.length < 10) {
    throw new Error(`Hyperliquid historical coverage for ${coin} is insufficient for volatility pricing`);
  }
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const barsPerYear = 365;
  const annualized = Math.sqrt(variance) * Math.sqrt(barsPerYear) * 100;
  if (!Number.isFinite(annualized) || annualized < 1 || annualized > 400) {
    throw new Error(`Hyperliquid volatility result for ${coin} is outside risk bounds`);
  }
  const value: RealizedVolatility = {
    value: annualized,
    observations: prices.length,
    source: "Hyperliquid 20-session realized volatility",
    asOf: history.asOf,
  };
  volatilityCache.set(coin, { expiresAt: Date.now() + 15 * 60_000, value });
  return value;
}
