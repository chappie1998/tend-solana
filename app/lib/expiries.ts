// Tend is a 24/7 protocol: expiries are pure clock arithmetic in UTC. There is
// no market calendar, no session, and no holiday — the only real constraint is
// whether a fresh Pyth print exists for a symbol (see `intradayEligible`),
// which is a feed-availability fact, not an hours-of-operation rule.
//
// Both feed-availability facts come from the market config in ./markets.ts,
// never from a symbol comparison in here. A hardcoded `symbol === "NVDA"`
// used to stand in for `intradayEligible`, which silently made every
// intraday code unavailable for any other symbol the moment a second market
// was listed — the catalog would look broken with nothing to point at.

// The explicit .ts extension keeps this module importable by the node:test
// suite (type stripping) as well as the bundler, matching ./launch-params.ts.
import { marketBySymbol } from "./markets.ts";

export type ExpiryCode = "15M" | "1H" | "EOD" | "7D" | "30D";

export type ExpiryDefinition = {
  code: ExpiryCode;
  label: string;
  shortLabel: string;
  group: "intraday" | "standard";
  expiryAt: number;
  durationMinutes: number;
  expiryDays: number;
  observationWindowSeconds: number;
  tradeLockSeconds: number;
  available: boolean;
  availabilityReason: string;
  detail: string;
};

const INTRADAY_CODES = new Set<ExpiryCode>(["15M", "1H", "EOD"]);
const MINUTE = 60_000;
const DAY = 86_400_000;

function formatExpiryTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function formatExpiryDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function formatExpiryDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function isSameUtcDay(a: number, b: number) {
  return Math.floor(a / DAY) === Math.floor(b / DAY);
}

/**
 * Intraday codes (15M/1H/EOD) share a time-only detail string by default, but
 * on a 24/7 UTC grid their boundaries can land on different calendar days
 * (e.g. 1H at the next midnight, EOD at the one after) while still rendering
 * the same time-of-day. Disambiguate by including a short date whenever the
 * expiry isn't on the current UTC calendar day. Both `resolveExpiry` below and
 * the onchain-series-exact detail in TendTerminal must call this so the two
 * surfaces can never disagree.
 */
export function formatExpiryDetail(code: ExpiryCode, expiryAt: number, now: number): string {
  if (!INTRADAY_CODES.has(code)) return formatExpiryDate(expiryAt);
  return isSameUtcDay(expiryAt, now) ? formatExpiryTime(expiryAt) : formatExpiryDateTime(expiryAt);
}

function nextFixedSeries(now: number, cadenceMinutes: number) {
  // A fixed onchain series cannot give every entrant exactly the same duration.
  // Select the first cadence boundary at least one full tenor in the future and
  // label it as a series, not as an exact time-to-expiry promise.
  const cadence = cadenceMinutes * MINUTE;
  return Math.ceil((now + cadence) / cadence) * cadence;
}

/** The next UTC midnight strictly after `target` — the daily settlement boundary. */
function nextUtcMidnightAfter(target: number) {
  const boundary = Math.ceil(target / DAY) * DAY;
  return boundary > target ? boundary : boundary + DAY;
}

/**
 * Advances `candidate` by whole `stepMs` increments of its own cadence until
 * it is strictly greater than `floor`. This is how the grid guarantees
 * 15M < 1H < EOD < 7D < 30D for every possible `now`: each code's natural
 * boundary is computed independently, and only collapses onto (or behind) a
 * neighbor's boundary get nudged forward, on the same clean cadence the code
 * already uses. The identical-parameters-collapse-to-one-market property of
 * the factory is untouched — this only changes which boundary a code targets,
 * never how market ids are derived.
 */
function advanceUntilAfter(candidate: number, floor: number, stepMs: number): number {
  let value = candidate;
  while (value <= floor) value += stepMs;
  return value;
}

type ExpiryGrid = Record<ExpiryCode, number>;

function computeExpiryGrid(now: number): ExpiryGrid {
  const fifteen = nextFixedSeries(now, 15);
  const oneHour = advanceUntilAfter(nextFixedSeries(now, 60), fifteen, 60 * MINUTE);
  const eod = advanceUntilAfter(nextUtcMidnightAfter(now), oneHour, DAY);
  const seven = advanceUntilAfter(nextUtcMidnightAfter(now + 7 * DAY), eod, DAY);
  const thirty = advanceUntilAfter(nextUtcMidnightAfter(now + 30 * DAY), seven, DAY);
  return { "15M": fifteen, "1H": oneHour, EOD: eod, "7D": seven, "30D": thirty };
}

export function resolveExpiry(code: ExpiryCode, symbol: string, now = Date.now()): ExpiryDefinition {
  // Driven entirely by the market config: an unknown symbol is neither
  // tradable nor intraday-eligible, and a configured-but-not-live market
  // (see `MarketStatus` in ./markets.ts) is unavailable at EVERY code, which
  // is the single chokepoint that keeps a coming-soon symbol out of the
  // launch, series-resolution and quote paths -- deriveLaunchSeriesParams
  // throws on an unavailable definition, and everything downstream of it
  // funnels through that.
  const market = marketBySymbol(symbol);
  const tradable = market?.status === "live";
  const intradayEligible = tradable && market.intradayEligible;
  const grid = computeExpiryGrid(now);
  const expiryAt = grid[code];
  let expiryDays = 0;
  let observationWindowSeconds = 60;
  let tradeLockSeconds = 60;
  let label: string = code;
  let shortLabel: string = code;

  if (code === "15M") {
    label = "Next 15-minute series";
  } else if (code === "1H") {
    label = "Next hourly series";
  } else if (code === "EOD") {
    label = "Next daily settlement";
    shortLabel = "Daily";
  } else {
    expiryDays = code === "7D" ? 7 : 30;
    observationWindowSeconds = 900;
    tradeLockSeconds = 300;
    label = code === "7D" ? "Next 7-day settlement" : "Next 30-day settlement";
  }

  const durationMinutes = Math.max(1, Math.ceil((expiryAt - now) / MINUTE));
  const available = tradable
    && (!INTRADAY_CODES.has(code) || intradayEligible)
    && expiryAt - now > tradeLockSeconds * 1_000;
  let availabilityReason = "A matching deployed onchain series is required.";
  if (!tradable) {
    // The market's own configured explanation, so the sentence a user reads
    // on a disabled chip is the same one the server enforces.
    availabilityReason = market?.statusNote || "This symbol is not a configured Tend market.";
  } else if (INTRADAY_CODES.has(code) && !intradayEligible) {
    availabilityReason = "This symbol has no verified intraday Pyth feed.";
  } else if (!available) {
    availabilityReason = "This series is too close to its trade cutoff. A new series must roll first.";
  }

  return {
    code,
    label,
    shortLabel,
    group: INTRADAY_CODES.has(code) ? "intraday" : "standard",
    expiryAt,
    durationMinutes,
    expiryDays,
    observationWindowSeconds,
    tradeLockSeconds,
    available,
    availabilityReason,
    detail: formatExpiryDetail(code, expiryAt, now),
  };
}

export const expiryCodes: ExpiryCode[] = ["15M", "1H", "EOD", "7D", "30D"];
