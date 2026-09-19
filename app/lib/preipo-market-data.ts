// Spot snapshot, chart bars, and realized volatility for PRE-IPO tokenized
// equity markets (category "pre-ipo": TOPENAI, TKALSHI, TSPACEX, POPENAI,
// PANTHROPIC, PNEURALINK, PFIGUREAI -- see app/lib/markets.ts) -- priced off
// live Solana DEX trading, since none of these seven tokens trade on
// Coinbase (the crypto path) or Hyperliquid's "xyz" dex (the stocks path).
// This is the pre-IPO counterpart to coinbase-market-data.ts and
// hyperliquid-market-data.ts.
//
// Two free, keyless upstreams, doing two different jobs:
//   - DexScreener (`GET /latest/dex/tokens/{mint}`) for the SPOT price and
//     for PAIR DISCOVERY -- picking which on-chain pool is "the" price for a
//     mint (see selectPreIpoPair below).
//   - GeckoTerminal (`GET /networks/solana/pools/{pool}/ohlcv/{timeframe}`)
//     for CHART BARS, keyed off the exact pool address DexScreener's pair
//     selection already found -- so bars always describe the same pair the
//     spot price came from, never a re-discovered or different one.
// Verified live 2026-09-19: GeckoTerminal's `ohlcv_list` rows are
// `[unixSeconds, open, high, low, close, volume]`, NEWEST FIRST (confirmed
// against pool 2ZWxT3niYjyudmDMDVar9ajNE42RkwYdzZBh6TiMuKQY's hourly bars);
// parseGeckoTerminalOhlcv below re-sorts ascending, matching every other
// provider's MarketBar[] convention in this app.
//
// CRITICAL pair-selection rule (selectPreIpoPair): a pre-IPO mint can have
// dozens of listed pairs, and most of them are meme coins paired AGAINST
// this mint -- i.e. THIS token is the pair's QUOTE side, some unrelated
// shitcoin is the base, and `priceUsd` on that pair is the SHITCOIN's price,
// not this token's. Verified live 2026-09-19 against PANTHROPIC's own mint:
// a BUTTHOLE/ANTHROPIC pair carried $282.6k of listed liquidity -- MORE than
// the legitimate ANTHROPIC/SOL pair's $176.1k -- and its `priceUsd`
// (~$0.0019) is BUTTHOLE's price. Picking "the highest-liquidity pair for
// this mint" without a base-token check would have silently priced
// PANTHROPIC at $0.0019. So every pair is filtered to
// `chainId === "solana" && baseToken.address === mint && quoteToken.symbol
// in {USDC, USDT, SOL}` before ranking by `liquidity.usd`; if nothing
// qualifies, this throws naming the symbol rather than falling back to an
// unfiltered pick.
//
// Metadata-only, never read as a price: Tessera's `/token-details` and
// PreStocks' `/api/prestocks` both publish a `markPrice` -- the issuer's own
// static valuation mark, not a traded price. Measured: it diverges from the
// live DEX price by up to 74% and can sit unchanged for hours while the DEX
// price keeps moving. Settling a binary against a frozen mark is the exact
// failure this repo already documents for frozen equity feeds (see
// CLAUDE.md) -- this file exists specifically so these seven markets price
// off real, moving, traded liquidity instead, and it never fetches either
// issuer's metadata endpoint at all.
//
// ONCHAIN SETTLEMENT IS UNAFFECTED BY THIS FILE. Every pre-IPO market's
// `pythFeedId` (app/lib/markets.ts) carries its own SPL mint, not a Pyth
// feed -- these markets settle on the custom oracle
// (`CustomPriceFeed`/`publish_custom_settlement`; see CLAUDE.md), never a
// Pyth PriceUpdateV2. This file only supplies the off-chain reference a user
// sees and quotes off before they trade.
import {
  chartLookbackSeconds,
  chartResolutionSeconds,
  MAX_BARS,
  type ChartResolution,
  type MarketBar,
} from "./market-bars.ts";
import type { MarketDataBars, MarketSnapshot, RealizedVolatility } from "./market-data-types.ts";
import { preIpoMintFor, type Market } from "./markets.ts";
import { fetchJsonCapped } from "./http-fetch-capped.ts";
import { runtimeEnv } from "./runtime-env.ts";

const REQUEST_TIMEOUT_MS = 10_000;

// --- pair selection ---------------------------------------------------

export type PreIpoPair = {
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  volumeH24: number;
  /** buys + sells over the trailing hour -- used only to flag a quiet pair in the snapshot warning, never to change the price. */
  txnsH1: number;
  priceChangeH1: number;
  quoteSymbol: string;
};

const QUALIFYING_QUOTE_SYMBOLS = new Set(["USDC", "USDT", "SOL"]);

type DexScreenerPairRaw = {
  chainId?: unknown;
  baseToken?: { address?: unknown };
  quoteToken?: { symbol?: unknown };
  liquidity?: { usd?: unknown };
  priceUsd?: unknown;
  pairAddress?: unknown;
  volume?: { h24?: unknown };
  txns?: { h1?: { buys?: unknown; sells?: unknown } };
  priceChange?: { h1?: unknown };
};

function asNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Selects the single pair DexScreener's `/tokens/{mint}` response should be
 * trusted for, and validates it. See the module header's "CRITICAL
 * pair-selection rule" for why the base-token/quote-symbol filter exists.
 * Throws, naming `symbol`, for: no pairs at all for this mint, no pair that
 * qualifies (this token as base, quoted in USDC/USDT/SOL), or a qualifying
 * pair whose price is not a usable positive number.
 */
export function selectPreIpoPair(raw: unknown, mint: string, symbol: string): PreIpoPair {
  if (!raw || typeof raw !== "object") throw new Error(`DexScreener returned an invalid response for ${symbol}`);
  const pairsField = (raw as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairsField) || pairsField.length === 0) {
    throw new Error(`DexScreener has no listed pairs for ${symbol} (mint ${mint})`);
  }

  const qualifying = pairsField.filter((entry): entry is DexScreenerPairRaw => {
    if (!entry || typeof entry !== "object") return false;
    const pair = entry as DexScreenerPairRaw;
    if (pair.chainId !== "solana") return false;
    const base = pair.baseToken;
    if (!base || typeof base !== "object" || (base as { address?: unknown }).address !== mint) return false;
    const quote = pair.quoteToken;
    const quoteSymbol = quote && typeof quote === "object" ? (quote as { symbol?: unknown }).symbol : undefined;
    return typeof quoteSymbol === "string" && QUALIFYING_QUOTE_SYMBOLS.has(quoteSymbol.toUpperCase());
  });
  if (qualifying.length === 0) {
    throw new Error(`DexScreener has no qualifying USDC/USDT/SOL pair for ${symbol} where it is the base token`);
  }

  let best: DexScreenerPairRaw | null = null;
  let bestLiquidity = -Infinity;
  for (const pair of qualifying) {
    const liquidityUsd = Number(pair.liquidity?.usd);
    if (Number.isFinite(liquidityUsd) && liquidityUsd > bestLiquidity) {
      bestLiquidity = liquidityUsd;
      best = pair;
    }
  }
  if (!best) throw new Error(`DexScreener pairs for ${symbol} carry no valid liquidity figures`);

  const priceUsd = Number(best.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error(`DexScreener returned an invalid price for ${symbol}`);
  const pairAddress = best.pairAddress;
  if (typeof pairAddress !== "string" || !pairAddress) throw new Error(`DexScreener pair for ${symbol} has no pair address`);
  const quoteSymbolRaw = best.quoteToken?.symbol;

  return {
    pairAddress,
    priceUsd,
    liquidityUsd: bestLiquidity,
    volumeH24: asNumberOr(best.volume?.h24, 0),
    txnsH1: asNumberOr(best.txns?.h1?.buys, 0) + asNumberOr(best.txns?.h1?.sells, 0),
    priceChangeH1: asNumberOr(best.priceChange?.h1, 0),
    quoteSymbol: typeof quoteSymbolRaw === "string" ? quoteSymbolRaw.toUpperCase() : "",
  };
}

// --- pair cache: one DexScreener call per mint serves every caller -------

function dexscreenerTokenUrl(mint: string): URL {
  return new URL(
    `/latest/dex/tokens/${encodeURIComponent(mint)}`,
    runtimeEnv("DEXSCREENER_API_URL") || "https://api.dexscreener.com",
  );
}

// 20s, per the product spec this file implements: long enough that a burst
// of concurrent snapshot/bars/volatility calls for the same market collapses
// onto one upstream request, short enough that a thinly-traded pool's price
// cannot go stale for long without a fresh check.
const PAIR_TTL_MS = 20_000;
const PAIR_FAILURE_BACKOFF_MS = 5_000;
// Measured live 2026-09-19: a popular mint (PreStocks' OPENAI) returned 30
// pairs in well under 100KB. Ample headroom.
const MAX_DEXSCREENER_BYTES = 2_000_000;

type PairCacheEntry = { expiresAt: number; fetchedAt: number; value: PreIpoPair };

const pairCache = new Map<string, PairCacheEntry>();
const pairInFlight = new Map<string, Promise<PairCacheEntry>>();
const pairFailure = new Map<string, { expiresAt: number; error: Error }>();

/**
 * Fetches (or reuses) the selected pair for `mint`, cached per mint so
 * concurrent snapshot/bars/volatility calls for the same market share one
 * upstream request -- the same collapsing behavior
 * hyperliquid-market-data.ts's universe cache provides, just keyed per-mint
 * here instead of one shared key, since DexScreener's endpoint is
 * per-token rather than a whole-market snapshot.
 */
async function getPreIpoPair(mint: string, symbol: string, now: number): Promise<PairCacheEntry> {
  const cached = pairCache.get(mint);
  if (cached && cached.expiresAt > now) return cached;
  const recentFailure = pairFailure.get(mint);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const active = pairInFlight.get(mint);
  if (active) return active;

  const request = (async () => {
    const raw = await fetchJsonCapped(dexscreenerTokenUrl(mint), {
      headers: { Accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_DEXSCREENER_BYTES,
      label: "DexScreener",
    });
    const value = selectPreIpoPair(raw, mint, symbol);
    const entry: PairCacheEntry = { expiresAt: now + PAIR_TTL_MS, fetchedAt: now, value };
    pairCache.set(mint, entry);
    pairFailure.delete(mint);
    return entry;
  })();
  pairInFlight.set(mint, request);
  try {
    return await request;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("DexScreener pair request failed");
    pairFailure.set(mint, { expiresAt: now + PAIR_FAILURE_BACKOFF_MS, error: normalized });
    throw normalized;
  } finally {
    pairInFlight.delete(mint);
  }
}

// --- confidence: a liquidity-implied price-impact estimate ---------------

// A representative single-quote fill size in this app (stakes here run from
// small change up to a few hundred dollars) -- see estimatePreIpoConfidence.
const REFERENCE_TRADE_USD = 1_000;

/**
 * "Confidence", DEX style. Neither a Pyth-style confidence interval nor a
 * bid/ask spread exists for an AMM pool -- what DexScreener actually gives
 * (see PreIpoPair) is `liquidity.usd`, the pool's own total value locked on
 * both sides. This turns that into an honest, directly meaningful number:
 * the estimated price impact a REFERENCE_TRADE_USD fill would have against
 * that liquidity, using the standard coarse shallow-pool approximation
 * (impact fraction ~= trade size / pool liquidity).
 *
 * This is deliberately the SAME concern CLAUDE.md's settlement-width note
 * already raises about these markets: thin liquidity is exactly what makes
 * a price cheap to move, so a liquidity-derived number is the one honest
 * "confidence" to report here, not an invented figure. `volumeH24`/`txnsH1`
 * were considered too, but they measure how ACTIVELY a price updates, not
 * how far a single trade could move it -- that is left to the snapshot's
 * `warning` string instead (a pair with zero trades in the last hour is
 * flagged there), rather than folded into this number.
 */
function estimatePreIpoConfidence(priceUsd: number, liquidityUsd: number): { confidence: number; confidenceBps: number } {
  const impactFraction = liquidityUsd > 0 ? REFERENCE_TRADE_USD / liquidityUsd : 1;
  return { confidence: priceUsd * impactFraction, confidenceBps: impactFraction * 10_000 };
}

// --- snapshot --------------------------------------------------------------

export async function getPreIpoSnapshot(market: Market, now = Date.now()): Promise<MarketSnapshot> {
  const mint = preIpoMintFor(market);
  const entry = await getPreIpoPair(mint, market.symbol, now);
  const pair = entry.value;
  // DexScreener's token endpoint carries no per-call publish timestamp
  // (unlike Coinbase's ticker `time`), so -- same convention
  // hyperliquid-market-data.ts uses for its universe cache -- `publishTime`
  // is honestly the moment THIS cache entry was fetched, and `ageSeconds` is
  // how long ago that was.
  const ageSeconds = Math.max(0, Math.round((now - entry.fetchedAt) / 1_000));
  const mode: "live" | "stale" = ageSeconds <= 30 ? "live" : "stale";
  const { confidence, confidenceBps } = estimatePreIpoConfidence(pair.priceUsd, pair.liquidityUsd);
  const ageMinutes = Math.max(1, Math.round(ageSeconds / 60));
  const liquidityLabel = `$${Math.round(pair.liquidityUsd).toLocaleString()}`;
  const noRecentTrades = pair.txnsH1 === 0;
  const value: MarketSnapshot = {
    price: pair.priceUsd,
    confidence,
    confidenceBps,
    exponent: 0,
    publishTime: Math.floor(entry.fetchedAt / 1_000),
    slot: null,
    ageSeconds,
    mode,
    source: "DEX (Solana)",
    warning: mode === "live"
      ? `Fresh Solana DEX reference (${pair.quoteSymbol}-quoted pool, confidence estimates a $${REFERENCE_TRADE_USD} fill's price impact against ${liquidityLabel} of listed liquidity)${noRecentTrades ? " -- this pool recorded no trades in the last hour" : ""}; the centrally signed custom oracle retains the first validated fetch inside the expiry window.`
      : `Reference is ${ageMinutes} min old; the ${market.symbol} DEX lookup is not refreshing right now. Gap risk is priced into the quote, not hidden.`,
  };
  return value;
}

// --- chart bars: GeckoTerminal OHLCV off the SAME pool ---------------------

const TIMEFRAME_BY_RESOLUTION: Record<ChartResolution, { timeframe: "minute" | "hour" | "day"; aggregate: number }> = {
  "1": { timeframe: "minute", aggregate: 1 },
  "5": { timeframe: "minute", aggregate: 5 },
  "15": { timeframe: "minute", aggregate: 15 },
  "60": { timeframe: "hour", aggregate: 1 },
  D: { timeframe: "day", aggregate: 1 },
};

// GeckoTerminal's public OHLCV endpoint is not documented with a hard
// row-count ceiling; this app's own per-resolution bar targets
// (chartLookbackSeconds/chartResolutionSeconds -- 1,440 intraday, 365 daily)
// are used as the requested `limit`, capped here defensively. Verified live
// 2026-09-19: requesting limit=1000 daily bars for a ~3-month-old pool
// returned only the 87 rows that actually exist rather than erroring -- an
// over-large limit is safe, it just returns less than asked for.
const GECKOTERMINAL_LIMIT_CAP = 1_000;

function limitFor(resolution: ChartResolution): number {
  const desired = Math.round(chartLookbackSeconds(resolution) / chartResolutionSeconds(resolution));
  return Math.min(GECKOTERMINAL_LIMIT_CAP, desired);
}

function geckoTerminalOhlcvUrl(poolAddress: string, resolution: ChartResolution): URL {
  const { timeframe, aggregate } = TIMEFRAME_BY_RESOLUTION[resolution];
  const url = new URL(
    `/api/v2/networks/solana/pools/${encodeURIComponent(poolAddress)}/ohlcv/${timeframe}`,
    runtimeEnv("GECKOTERMINAL_API_URL") || "https://api.geckoterminal.com",
  );
  url.searchParams.set("aggregate", String(aggregate));
  url.searchParams.set("limit", String(limitFor(resolution)));
  return url;
}

type GeckoTerminalOhlcvResponse = { data?: { attributes?: { ohlcv_list?: unknown } } };

function parseGeckoTerminalRow(row: unknown, poolAddress: string): MarketBar {
  if (!Array.isArray(row) || row.length < 5) throw new Error(`GeckoTerminal OHLCV row for pool ${poolAddress} is malformed`);
  const [time, open, high, low, close] = row as unknown[];
  if ([time, open, high, low, close].some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`GeckoTerminal OHLCV values for pool ${poolAddress} must be numbers`);
  }
  if (!Number.isSafeInteger(time as number) || (time as number) <= 0) {
    throw new Error(`GeckoTerminal OHLCV timestamp for pool ${poolAddress} is invalid`);
  }
  const bar = { time: time as number, open: open as number, high: high as number, low: low as number, close: close as number };
  if (![bar.open, bar.high, bar.low, bar.close].every((value) => value > 0)) {
    throw new Error(`GeckoTerminal OHLCV prices for pool ${poolAddress} are invalid`);
  }
  if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) {
    throw new Error(`GeckoTerminal OHLCV bounds for pool ${poolAddress} are invalid`);
  }
  return bar;
}

/**
 * Parses a `GET /pools/{pool}/ohlcv/{timeframe}` response into ascending
 * MarketBars. GeckoTerminal's rows are `[unixSeconds, o, h, l, c, volume]`,
 * already in epoch SECONDS (no ms conversion, unlike Hyperliquid) -- but
 * NEWEST FIRST (verified live 2026-09-19), the one reorder this provider
 * needs to match every other provider's ascending convention in this app.
 */
export function parseGeckoTerminalOhlcv(raw: unknown, poolAddress: string): MarketBar[] {
  if (!raw || typeof raw !== "object") throw new Error(`GeckoTerminal returned an invalid OHLCV response for pool ${poolAddress}`);
  const list = (raw as GeckoTerminalOhlcvResponse).data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error(`GeckoTerminal returned no ohlcv_list for pool ${poolAddress}`);
  const bars = list.map((row) => parseGeckoTerminalRow(row, poolAddress));
  return bars.sort((a, b) => a.time - b.time);
}

const MAX_OHLCV_BYTES = 2_000_000;

const barsCache = new Map<string, { expiresAt: number; value: MarketDataBars }>();
const barsInFlight = new Map<string, Promise<MarketDataBars>>();
const barsFailed = new Map<string, { expiresAt: number; error: Error }>();

export async function getPreIpoMarketBars(
  market: Market,
  resolution: ChartResolution,
  now = Date.now(),
): Promise<MarketDataBars> {
  const mint = preIpoMintFor(market);
  // Reuses the pair cache (rather than re-discovering the pool) so bars are
  // always for the exact same pool the spot price came from -- see the
  // module header.
  const pairEntry = await getPreIpoPair(mint, market.symbol, now);
  const poolAddress = pairEntry.value.pairAddress;
  const cacheKey = `${poolAddress}:${resolution}`;
  const cached = barsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  const recentFailure = barsFailed.get(cacheKey);
  if (recentFailure && recentFailure.expiresAt > now) throw recentFailure.error;
  const active = barsInFlight.get(cacheKey);
  if (active) return active;

  const request = (async () => {
    const raw = await fetchJsonCapped(geckoTerminalOhlcvUrl(poolAddress, resolution), {
      headers: { Accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_OHLCV_BYTES,
      label: "GeckoTerminal",
    });
    let bars = parseGeckoTerminalOhlcv(raw, poolAddress);
    if (bars.length === 0) throw new Error(`GeckoTerminal returned no chart data for ${market.symbol}`);
    // Same shared ceiling every provider in this app respects (market-bars.ts).
    if (bars.length > MAX_BARS) bars = bars.slice(bars.length - MAX_BARS);
    const to = Math.floor(now / 1_000);
    const from = to - chartLookbackSeconds(resolution);
    const lastBarTime = bars[bars.length - 1].time;
    const granularitySeconds = chartResolutionSeconds(resolution);
    const barLagLimit = Math.max(180, granularitySeconds * 2);
    const freshness: "live" | "stale" = resolution === "D" || to - lastBarTime <= barLagLimit ? "live" : "stale";
    const value: MarketDataBars = {
      symbol: market.symbol,
      resolution,
      source: "DEX (Solana)",
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
    const normalized = error instanceof Error ? error : new Error("GeckoTerminal chart request failed");
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

export async function getPreIpoRealizedVolatility(market: Market, now = Date.now()): Promise<RealizedVolatility> {
  const mint = preIpoMintFor(market);
  const cached = volatilityCache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const history = await getPreIpoMarketBars(market, "D", now);
  // Same method as every other provider here: drop the most recent daily bar
  // if its UTC day has not finished yet, so volatility is never computed off
  // a partial candle. 365, not 252: these DEX pools trade 24/7, same as
  // crypto and Hyperliquid's xyz stocks, so daily bars exist on all 365
  // calendar days rather than the ~252 US-equity trading sessions.
  const asOfDate = utcTradingDate.format(new Date(history.asOf));
  const completedBars = history.bars.filter((bar) => utcTradingDate.format(new Date(bar.time * 1_000)) !== asOfDate);
  const prices = completedBars.slice(-21).map((bar) => bar.close);
  if (prices.length < 10) {
    throw new Error(`DEX historical coverage for ${market.symbol} is insufficient for volatility pricing`);
  }
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const barsPerYear = 365;
  const annualized = Math.sqrt(variance) * Math.sqrt(barsPerYear) * 100;
  if (!Number.isFinite(annualized) || annualized < 1 || annualized > 400) {
    throw new Error(`DEX volatility result for ${market.symbol} is outside risk bounds`);
  }
  const value: RealizedVolatility = {
    value: annualized,
    observations: prices.length,
    source: "DEX (Solana) 20-session realized volatility",
    asOf: history.asOf,
  };
  volatilityCache.set(mint, { expiresAt: Date.now() + 15 * 60_000, value });
  return value;
}
