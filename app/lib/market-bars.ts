export const chartResolutions = ["1", "5", "15", "60", "D"] as const;

export type ChartResolution = (typeof chartResolutions)[number];

export type MarketBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

const MAX_BARS = 2_000;

const resolutionSeconds: Record<ChartResolution, number> = {
  "1": 60,
  "5": 5 * 60,
  "15": 15 * 60,
  "60": 60 * 60,
  D: 24 * 60 * 60,
};

const lookbackSeconds: Record<ChartResolution, number> = {
  "1": 3 * 24 * 60 * 60,
  "5": 10 * 24 * 60 * 60,
  "15": 30 * 24 * 60 * 60,
  "60": 120 * 24 * 60 * 60,
  D: 365 * 24 * 60 * 60,
};

export function isChartResolution(value: string): value is ChartResolution {
  return chartResolutions.includes(value as ChartResolution);
}

export function chartResolutionSeconds(resolution: ChartResolution) {
  return resolutionSeconds[resolution];
}

export function chartLookbackSeconds(resolution: ChartResolution) {
  return lookbackSeconds[resolution];
}

function numericArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`Pyth chart field ${field} is missing`);
  return value;
}

export function parsePythUdfBars(input: unknown): MarketBar[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Pyth chart response is invalid");
  }
  const result = input as Record<string, unknown>;
  if (result.s === "no_data") throw new Error("Pyth returned no chart data for this range");
  if (result.s !== "ok") throw new Error("Pyth chart response did not succeed");

  const times = numericArray(result.t, "t");
  const opens = numericArray(result.o, "o");
  const highs = numericArray(result.h, "h");
  const lows = numericArray(result.l, "l");
  const closes = numericArray(result.c, "c");
  const length = times.length;
  if (length === 0 || length > MAX_BARS) throw new Error("Pyth chart returned an invalid number of bars");
  if ([opens, highs, lows, closes].some((values) => values.length !== length)) {
    throw new Error("Pyth chart arrays have mismatched lengths");
  }

  const bars: MarketBar[] = [];
  for (let index = 0; index < length; index += 1) {
    const time = times[index];
    const open = opens[index];
    const high = highs[index];
    const low = lows[index];
    const close = closes[index];
    if ([time, open, high, low, close].some((value) => typeof value !== "number")) {
      throw new Error("Pyth chart values must be numbers");
    }
    if (!Number.isSafeInteger(time) || time <= 0 || (index > 0 && time <= bars[index - 1].time)) {
      throw new Error("Pyth chart timestamps are invalid");
    }
    if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error("Pyth chart prices are invalid");
    }
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw new Error("Pyth chart OHLC bounds are invalid");
    }
    bars.push({ time, open, high, low, close });
  }
  return bars;
}
