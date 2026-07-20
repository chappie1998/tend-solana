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

const NEW_YORK = "America/New_York";
const INTRADAY_CODES = new Set<ExpiryCode>(["15M", "1H", "EOD"]);
const MINUTE = 60_000;
const DAY = 86_400_000;

function newYorkParts(timestamp: number) {
  const values: Record<string, string> = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function timeZoneOffset(timestamp: number) {
  const parts = newYorkParts(timestamp);
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return representedAsUtc - Math.floor(timestamp / 1_000) * 1_000;
}

function newYorkTimeToUtc(year: number, month: number, day: number, hour: number, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return guess - timeZoneOffset(guess);
}

function addCalendarDays(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekday(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

type CalendarDate = { year: number; month: number; day: number };

function dateKey(date: CalendarDate) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

// NYSE's published core-session calendar. Keeping the dates explicit makes
// unknown years fail closed instead of treating every Monday-Friday as open.
// Source of truth: https://www.nyse.com/trade/hours-calendars
const REFERENCE_CALENDAR_YEARS = new Set([2026, 2027, 2028]);
const REFERENCE_MARKET_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);
const REFERENCE_MARKET_EARLY_CLOSES = new Set([
  "2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24",
]);

function isWeekday(date: CalendarDate) {
  const dayOfWeek = weekday(date.year, date.month, date.day);
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

function referenceCloseMinutes(date: CalendarDate) {
  if (!REFERENCE_CALENDAR_YEARS.has(date.year) || !isWeekday(date) || REFERENCE_MARKET_HOLIDAYS.has(dateKey(date))) return null;
  return REFERENCE_MARKET_EARLY_CLOSES.has(dateKey(date)) ? 13 * 60 : 16 * 60;
}

function nextTradingDay(year: number, month: number, day: number, includeToday: boolean) {
  for (let offset = includeToday ? 0 : 1; offset < 370; offset += 1) {
    const candidate = addCalendarDays(year, month, day, offset);
    if (referenceCloseMinutes(candidate) !== null) return candidate;
  }
  throw new Error("The reference-market calendar is not published for this date.");
}

function closeForDate(date: CalendarDate) {
  const closeMinutes = referenceCloseMinutes(date);
  if (closeMinutes === null) return null;
  return newYorkTimeToUtc(date.year, date.month, date.day, Math.floor(closeMinutes / 60), closeMinutes % 60);
}

export function isReferenceMarketOpen(now = Date.now()) {
  const parts = newYorkParts(now);
  const minutes = parts.hour * 60 + parts.minute;
  const closeMinutes = referenceCloseMinutes(parts);
  return closeMinutes !== null && minutes >= 570 && minutes < closeMinutes;
}

export function nextReferenceMarketOpen(now = Date.now()) {
  const parts = newYorkParts(now);
  const openToday = newYorkTimeToUtc(parts.year, parts.month, parts.day, 9, 30);
  if (referenceCloseMinutes(parts) !== null && now < openToday) return openToday;
  const next = nextTradingDay(parts.year, parts.month, parts.day, false);
  return newYorkTimeToUtc(next.year, next.month, next.day, 9, 30);
}

export function nextReferenceMarketClose(now = Date.now()) {
  const parts = newYorkParts(now);
  const closeToday = closeForDate(parts);
  if (closeToday !== null && now < closeToday) return closeToday;
  const next = nextTradingDay(parts.year, parts.month, parts.day, false);
  return closeForDate(next)!;
}

/** First regular-session close at or after a target timestamp. */
export function referenceMarketCloseOnOrAfter(target: number) {
  const parts = newYorkParts(target);
  const closeToday = closeForDate(parts);
  if (closeToday !== null && target <= closeToday) return closeToday;
  const next = nextTradingDay(parts.year, parts.month, parts.day, false);
  return closeForDate(next)!;
}

export function previousReferenceMarketCloses(count: number, now = Date.now()) {
  if (!Number.isInteger(count) || count < 1 || count > 60) {
    throw new Error("Reference close count must be between 1 and 60");
  }
  const parts = newYorkParts(now);
  const todayClose = closeForDate(parts);
  let calendarOffset = todayClose !== null && now >= todayClose + 5 * MINUTE ? 0 : 1;
  const closes: number[] = [];
  while (closes.length < count && calendarOffset < 370) {
    const candidate = addCalendarDays(parts.year, parts.month, parts.day, -calendarOffset);
    const close = closeForDate(candidate);
    if (close !== null) closes.push(close);
    calendarOffset += 1;
  }
  if (closes.length !== count) throw new Error("The reference-market calendar does not cover the requested close history.");
  return closes.reverse();
}

function formatExpiryTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function formatExpiryDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function formatNextSession(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function nextFixedSeries(now: number, cadenceMinutes: number) {
  // A fixed onchain series cannot give every entrant exactly the same duration.
  // Select the first cadence boundary at least one full tenor in the future and
  // label it as a series, not as an exact time-to-expiry promise.
  const cadence = cadenceMinutes * MINUTE;
  return Math.ceil((now + cadence) / cadence) * cadence;
}

export function resolveExpiry(code: ExpiryCode, symbol: string, now = Date.now()): ExpiryDefinition {
  const intradayEligible = symbol === "NVDA";
  const marketOpen = isReferenceMarketOpen(now);
  const close = nextReferenceMarketClose(now);
  let expiryAt = now;
  let expiryDays = 0;
  let observationWindowSeconds = 60;
  let tradeLockSeconds = 60;
  let label: string = code;
  let shortLabel: string = code;

  if (code === "15M") {
    expiryAt = nextFixedSeries(now, 15);
    label = "Next 15-minute series";
  } else if (code === "1H") {
    expiryAt = nextFixedSeries(now, 60);
    label = "Next hourly series";
  } else if (code === "EOD") {
    expiryAt = close;
    label = "Reference close";
    shortLabel = marketOpen ? "Today" : "Next close";
  } else {
    expiryDays = code === "7D" ? 7 : 30;
    expiryAt = referenceMarketCloseOnOrAfter(now + expiryDays * DAY);
    observationWindowSeconds = 900;
    tradeLockSeconds = 300;
    label = code === "7D" ? "Next 7-day close" : "Next 30-day close";
  }

  const durationMinutes = Math.max(1, Math.ceil((expiryAt - now) / MINUTE));
  const afterReferenceClose = INTRADAY_CODES.has(code) && expiryAt > close;
  const available = !INTRADAY_CODES.has(code)
    || (intradayEligible && marketOpen && !afterReferenceClose && expiryAt - now > tradeLockSeconds * 1_000);
  let availabilityReason = "A matching deployed onchain series is required.";
  if (INTRADAY_CODES.has(code) && !intradayEligible) {
    availabilityReason = "This symbol has no verified intraday Pyth feed.";
  } else if (INTRADAY_CODES.has(code) && !marketOpen) {
    availabilityReason = `US reference session closed. Next session: ${formatNextSession(nextReferenceMarketOpen(now))}.`;
  } else if (afterReferenceClose) {
    availabilityReason = "This series would settle after the reference market closes.";
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
    detail: code === "15M" || code === "1H" || code === "EOD" ? formatExpiryTime(expiryAt) : formatExpiryDate(expiryAt),
  };
}

export const expiryCodes: ExpiryCode[] = ["15M", "1H", "EOD", "7D", "30D"];
