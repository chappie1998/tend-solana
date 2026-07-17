import { markets } from "../../lib/markets";

type Resolution = "1m" | "5m" | "15m" | "1h" | "1D";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const resolutions: Record<Resolution, { multiplier: number; timespan: "minute" | "hour" | "day"; seconds: number; count: number }> = {
  "1m": { multiplier: 1, timespan: "minute", seconds: 60, count: 240 },
  "5m": { multiplier: 5, timespan: "minute", seconds: 300, count: 180 },
  "15m": { multiplier: 15, timespan: "minute", seconds: 900, count: 160 },
  "1h": { multiplier: 1, timespan: "hour", seconds: 3_600, count: 160 },
  "1D": { multiplier: 1, timespan: "day", seconds: 86_400, count: 120 },
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function deterministicNoise(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43_758.5453;
  return value - Math.floor(value);
}

function demoCandles(price: number, changePercent: number, resolution: Resolution, symbol: string) {
  const config = resolutions[resolution];
  const end = Math.floor(Date.now() / (config.seconds * 1000)) * config.seconds;
  const symbolSeed = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const candles: Candle[] = [];
  const startPrice = price / (1 + changePercent / 100);
  let close = startPrice;
  for (let index = 0; index < config.count; index += 1) {
    const progress = index / (config.count - 1);
    const trend = startPrice + (price - startPrice) * progress;
    const wave = Math.sin(index / 8) * price * 0.0018;
    const noise = (deterministicNoise(index + symbolSeed) - 0.5) * price * 0.0015;
    const open = close;
    close = index === config.count - 1 ? price : trend + wave + noise;
    const spread = open * (0.0015 + deterministicNoise(index * 3 + symbolSeed) * 0.002);
    candles.push({
      time: end - (config.count - index - 1) * config.seconds,
      open: Number(open.toFixed(4)),
      high: Number((Math.max(open, close) + spread).toFixed(4)),
      low: Number((Math.min(open, close) - spread).toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: Math.round(18_000 + deterministicNoise(index * 7 + symbolSeed) * 92_000),
    });
  }
  return candles;
}

async function massiveCandles(symbol: string, resolution: Resolution, apiKey: string) {
  const config = resolutions[resolution];
  const to = new Date();
  const historySeconds = config.seconds * config.count * (resolution === "1D" ? 2 : 5);
  const from = new Date(to.getTime() - historySeconds * 1000);
  const date = (value: Date) => value.toISOString().slice(0, 10);
  const endpoint = new URL(`https://api.massive.com/v2/aggs/ticker/${symbol}/range/${config.multiplier}/${config.timespan}/${date(from)}/${date(to)}`);
  endpoint.searchParams.set("adjusted", "true");
  endpoint.searchParams.set("sort", "asc");
  endpoint.searchParams.set("limit", "500");
  endpoint.searchParams.set("apiKey", apiKey);
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Market-data provider returned ${response.status}.`);
  const result = await response.json() as { results?: Array<{ t: number; o: number; h: number; l: number; c: number; v?: number }> };
  if (!result.results?.length) throw new Error("No market bars were returned.");
  return result.results.map((bar) => ({
    time: Math.floor(bar.t / 1000),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v ?? 0,
  }));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
  const resolution = (url.searchParams.get("resolution") ?? "5m") as Resolution;
  const market = markets.find((candidate) => candidate.symbol === symbol);
  if (!market || !(resolution in resolutions)) return json({ error: "Choose a supported symbol and chart interval." }, 422);

  const apiKey = process.env.MASSIVE_API_KEY?.trim();
  let candles: Candle[];
  let mode: "live" | "delayed" | "demo" = "demo";
  let source = "Tend simulated market data";
  let warning = "Demo candles are for interface testing only and are never used for settlement.";

  if (apiKey && market.marketDataSymbol) {
    try {
      candles = await massiveCandles(market.marketDataSymbol, resolution, apiKey);
      const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - candles[candles.length - 1].time);
      mode = ageSeconds <= Math.max(120, resolutions[resolution].seconds * 3) ? "live" : "delayed";
      source = "Massive consolidated US equities";
      warning = mode === "live" ? "Display feed only. Settlement uses the approved oracle." : "Provider data is delayed. It cannot be used for short-duration execution.";
    } catch {
      candles = demoCandles(market.price, market.change, resolution, symbol);
      warning = "The licensed market-data feed is unavailable. Showing clearly marked demo candles.";
    }
  } else {
    candles = demoCandles(market.price, market.change, resolution, symbol);
    if (!market.marketDataSymbol) warning = "This asset has no supported public reference feed. Showing indicative demo candles.";
  }

  const first = candles[0];
  const last = candles[candles.length - 1];
  const changePercent = first.open ? ((last.close - first.open) / first.open) * 100 : 0;
  const sessionVolume = mode === "demo" ? null : candles.reduce((sum, candle) => sum + candle.volume, 0);
  return json({
    symbol,
    resolution,
    candles,
    snapshot: {
      price: last.close,
      changePercent,
      sessionVolume,
      asOf: last.time * 1000,
      mode,
      source,
      warning,
    },
  });
}
