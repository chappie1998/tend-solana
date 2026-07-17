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
  return representedAsUtc - Math.floor(timestamp / 1000) * 1000;
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

function nextWeekday(year: number, month: number, day: number, includeToday: boolean) {
  let candidate = { year, month, day };
  let offset = includeToday ? 0 : 1;
  while (offset < 8) {
    candidate = addCalendarDays(year, month, day, offset);
    const dayOfWeek = weekday(candidate.year, candidate.month, candidate.day);
    if (dayOfWeek >= 1 && dayOfWeek <= 5) return candidate;
    offset += 1;
  }
  return candidate;
}

export function isReferenceMarketOpen(now = Date.now()) {
  const parts = newYorkParts(now);
  const dayOfWeek = weekday(parts.year, parts.month, parts.day);
  const minutes = parts.hour * 60 + parts.minute;
  return dayOfWeek >= 1 && dayOfWeek <= 5 && minutes >= 570 && minutes < 960;
}

export function nextReferenceMarketClose(now = Date.now()) {
  const parts = newYorkParts(now);
  const closeToday = newYorkTimeToUtc(parts.year, parts.month, parts.day, 16);
  const todayIsWeekday = weekday(parts.year, parts.month, parts.day) >= 1 && weekday(parts.year, parts.month, parts.day) <= 5;
  if (todayIsWeekday && now < closeToday) return closeToday;
  const next = nextWeekday(parts.year, parts.month, parts.day, false);
  return newYorkTimeToUtc(next.year, next.month, next.day, 16);
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

export function resolveExpiry(code: ExpiryCode, symbol: string, now = Date.now()): ExpiryDefinition {
  const intradayEligible = symbol !== "SPCX";
  const marketOpen = isReferenceMarketOpen(now);
  const close = nextReferenceMarketClose(now);
  let expiryAt = now;
  let durationMinutes = 0;
  let expiryDays = 0;
  let observationWindowSeconds = 60;
  let tradeLockSeconds = 60;
  let label: string = code;
  let shortLabel: string = code;
  let detail = "";

  if (code === "15M") {
    expiryAt = Math.ceil((now + 120_000) / 900_000) * 900_000;
    durationMinutes = Math.max(1, Math.ceil((expiryAt - now) / 60_000));
    label = "15 minutes";
    shortLabel = "15M";
    detail = formatExpiryTime(expiryAt);
  } else if (code === "1H") {
    expiryAt = Math.ceil((now + 120_000) / 3_600_000) * 3_600_000;
    durationMinutes = Math.max(1, Math.ceil((expiryAt - now) / 60_000));
    label = "1 hour";
    shortLabel = "1H";
    detail = formatExpiryTime(expiryAt);
  } else if (code === "EOD") {
    expiryAt = close;
    durationMinutes = Math.max(1, Math.ceil((expiryAt - now) / 60_000));
    label = "Market close";
    shortLabel = "Today";
    detail = formatExpiryTime(expiryAt);
  } else {
    expiryDays = code === "7D" ? 7 : 30;
    expiryAt = now + expiryDays * 86_400_000;
    durationMinutes = expiryDays * 1_440;
    observationWindowSeconds = 900;
    tradeLockSeconds = 300;
    label = code === "7D" ? "7 days" : "30 days";
    shortLabel = code;
    detail = formatExpiryDate(expiryAt);
  }

  const afterReferenceClose = INTRADAY_CODES.has(code) && expiryAt > close;
  const available = !INTRADAY_CODES.has(code) || (intradayEligible && marketOpen && !afterReferenceClose && expiryAt - now > tradeLockSeconds * 1000);
  let availabilityReason = "Available";
  if (INTRADAY_CODES.has(code) && !intradayEligible) availabilityReason = "Intraday markets are unavailable for indicative private-asset pricing.";
  else if (INTRADAY_CODES.has(code) && !marketOpen) availabilityReason = "Intraday markets open with the US reference session at 9:30 AM ET.";
  else if (afterReferenceClose) availabilityReason = "This expiry falls after the reference market closes.";

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
    detail,
  };
}

export const expiryCodes: ExpiryCode[] = ["15M", "1H", "EOD", "7D", "30D"];
