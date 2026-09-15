// Whether a US-equity spot price is actually moving right now. Unlike every
// crypto feed this app prices, a stock's last trade FREEZES outside the
// regular trading session: app/lib/twelvedata-market-bars.ts's file header
// documents the empirical proof (1,440 one-minute NVDA bars, fetched live,
// spanned SIX calendar days because only ~390 RTH minutes exist per day).
//
// This module exists for exactly one caller, app/lib/expiries.ts: a
// defined-risk binary that expires while its underlying is frozen is not a
// bet, it is a known outcome -- an in-the-money strike is a guaranteed,
// permissionlessly-claimable payout from the pool (settlement publication has
// no signer check), and an out-of-the-money strike is a guaranteed loss for
// whoever bought it. Gating which expiries are OFFERED to a stock-category
// market is the fix; nothing here touches quoting or settlement math.
//
// CRYPTO MARKETS MUST NEVER CALL THIS. Tend is a 24/7 product for crypto by
// hard rule -- see CLAUDE.md's "24/7 product" entry and its stocks-only
// exception. expiries.ts enforces that by gating strictly on
// `market.category === "stocks"` before it ever reaches this file.
//
// Deliberately no US market-holiday calendar: this checks weekday + wall-clock
// time only, nothing more. A holiday slipping through settles against a
// frozen price exactly like any other closed session -- an accepted, and
// disclosed, limitation of this devnet demo (see CLAUDE.md), not a bug this
// module is trying to fix. Building and maintaining a real holiday calendar
// is real work with its own edge cases (early closes, observed-vs-actual
// dates); it is out of scope until this becomes more than a demo.

const REGULAR_TRADING_HOURS_TIME_ZONE = "America/New_York";
const REGULAR_TRADING_HOURS_OPEN_MINUTES = 9 * 60 + 30; // 09:30
const REGULAR_TRADING_HOURS_CLOSE_MINUTES = 16 * 60; // 16:00

/** The sentence fragment every "outside trading hours" reason quotes, so the UI and this module can never drift on what the window actually is. */
export const REGULAR_TRADING_HOURS_DESCRIPTION = "9:30am-4:00pm ET, Monday-Friday";

const WEEKDAY_TOKENS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

// Reads weekday + wall-clock time directly in America/New_York via Intl,
// rather than applying a hardcoded UTC offset -- the same DST-correctness
// requirement app/lib/twelvedata-market-bars.ts's exchangeTimeToEpochSeconds
// solves for the opposite conversion (exchange wall clock -> true UTC). Going
// this direction (a real UTC instant -> exchange wall clock) needs no
// "double conversion" trick: Intl.DateTimeFormat resolves the IANA zone's
// offset for the specific date on its own, DST included.
const regularTradingHoursFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: REGULAR_TRADING_HOURS_TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * True when `timestampMs` (a real UTC instant, e.g. an `ExpiryDefinition.expiryAt`)
 * falls inside a US-equity regular trading session: 09:30-16:00
 * America/New_York, Monday-Friday. See the file header for why this exists
 * and what it deliberately does not attempt (a holiday calendar).
 */
export function isWithinRegularTradingHours(timestampMs: number): boolean {
  const parts = regularTradingHoursFormatter.formatToParts(new Date(timestampMs));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  if (!WEEKDAY_TOKENS.has(read("weekday"))) return false;
  const minutesSinceMidnight = Number(read("hour")) * 60 + Number(read("minute"));
  return minutesSinceMidnight >= REGULAR_TRADING_HOURS_OPEN_MINUTES && minutesSinceMidnight < REGULAR_TRADING_HOURS_CLOSE_MINUTES;
}
