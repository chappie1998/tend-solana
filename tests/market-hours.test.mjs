import assert from "node:assert/strict";
import test from "node:test";

// Offline (no network) tests for app/lib/market-hours.ts -- the RTH
// (regular trading hours) check that gates stock-category expiries in
// app/lib/expiries.ts. See CLAUDE.md's stocks-only 24/7 exception for why
// this exists at all: a US-equity price freezes outside 09:30-16:00
// America/New_York, Mon-Fri, so a binary expiry landing there settles
// against a known, frozen price rather than a real bet.

const root = new URL("../", import.meta.url);

async function loadModule() {
  return import(new URL("app/lib/market-hours.ts", root));
}

test("isWithinRegularTradingHours is true just inside the open and close boundaries, on a weekday", async () => {
  const { isWithinRegularTradingHours } = await loadModule();
  // 2026-07-16 is a Thursday. EDT (UTC-4) is in effect in July.
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-16T13:30:00Z")), true, "09:30 ET, the open, is inside the session");
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-16T18:15:00Z")), true, "14:15 ET, mid-session, is inside");
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-16T19:59:00Z")), true, "15:59 ET, just before the close, is inside");
});

test("isWithinRegularTradingHours is false at and after the close, and before the open, on a weekday", async () => {
  const { isWithinRegularTradingHours } = await loadModule();
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-16T20:00:00Z")), false, "16:00 ET, the close, is exclusive -- outside");
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-16T20:30:00Z")), false, "16:30 ET, after the close, is outside");
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-16T07:00:00Z")), false, "03:00 ET, well before the open, is outside");
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-16T13:29:00Z")), false, "09:29 ET, one minute before the open, is outside");
});

test("isWithinRegularTradingHours is false on a weekend, even during what would be trading-session hours", async () => {
  const { isWithinRegularTradingHours } = await loadModule();
  // 2026-07-18 is a Saturday; 2026-07-19 a Sunday.
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-18T18:00:00Z")), false, "Saturday 14:00 ET is outside, despite the time of day");
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-19T18:00:00Z")), false, "Sunday 14:00 ET is outside, despite the time of day");
});

test("isWithinRegularTradingHours resolves the New York offset from the date via Intl, correct across DST", async () => {
  const { isWithinRegularTradingHours } = await loadModule();
  // The SAME wall-clock instant, 09:31 ET, in January (EST, UTC-5) and July
  // (EDT, UTC-4) -- two different UTC offsets that must both read as
  // "inside the session". A hardcoded ±5 offset gets the July case wrong
  // (13:31Z would read as 08:31 ET, before the open).
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-01-15T14:31:00Z")), true, "Jan: 09:31 ET is EST (UTC-5)");
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-15T13:31:00Z")), true, "Jul: 09:31 ET is EDT (UTC-4)");
  // And the mirror check just inside the close, in both seasons.
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-01-15T20:59:00Z")), true, "Jan: 15:59 ET is EST (UTC-5)");
  assert.equal(isWithinRegularTradingHours(Date.parse("2026-07-15T19:59:00Z")), true, "Jul: 15:59 ET is EDT (UTC-4)");
});

test("REGULAR_TRADING_HOURS_DESCRIPTION names the window in plain language", async () => {
  const { REGULAR_TRADING_HOURS_DESCRIPTION } = await loadModule();
  assert.match(REGULAR_TRADING_HOURS_DESCRIPTION, /9:30/);
  assert.match(REGULAR_TRADING_HOURS_DESCRIPTION, /4:00/);
  assert.match(REGULAR_TRADING_HOURS_DESCRIPTION, /Monday-Friday/);
});
