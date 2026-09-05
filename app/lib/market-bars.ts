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

// Each window is sized so that (lookback / resolution) lands comfortably under
// MAX_BARS. That invariant used to be violated by every intraday resolution --
// 5m asked for 10 days (2,880 bars) and 60m for 120 days (2,880), both over the
// 2,000 cap -- so the fetch either failed the bar-count check outright or spent
// its whole timeout pulling a payload it was always going to reject. The chart
// rendered "Couldn't load real market bars" for that reason alone, independent
// of which upstream served it.
//
// 1,440 bars per resolution is the target: dense enough to read, roughly half
// the cap, and it keeps every window's payload small enough to return well
// inside UPSTREAM_TIMEOUT_MS.
const lookbackSeconds: Record<ChartResolution, number> = {
  "1": 24 * 60 * 60, //        1,440 one-minute bars
  "5": 5 * 24 * 60 * 60, //    1,440 five-minute bars
  "15": 15 * 24 * 60 * 60, //  1,440 fifteen-minute bars
  "60": 60 * 24 * 60 * 60, //  1,440 hourly bars
  D: 365 * 24 * 60 * 60, //      365 daily bars
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
