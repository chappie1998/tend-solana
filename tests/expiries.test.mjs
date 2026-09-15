import assert from "node:assert/strict";
import test from "node:test";

// Offline (no network) tests for the stocks-only regular-trading-hours (RTH)
// exception in app/lib/expiries.ts's `resolveExpiry`: a US-equity spot price
// freezes outside 09:30-16:00 America/New_York, Mon-Fri (see
// app/lib/market-hours.ts and CLAUDE.md's stocks-only 24/7 exception), so a
// stock-category expiry landing outside that window must resolve
// unavailable with a named reason. Crypto must be completely unaffected --
// still 24/7, gated on nothing but feed availability and the trade cutoff.
//
// Every `now`/code pair below was derived directly from expiries.ts's own
// UTC grid math (nextFixedSeries/nextUtcMidnightAfter), then verified
// against its America/New_York wall-clock reading, so these are pinned,
// deterministic fixtures -- not flaky "whatever today happens to be" checks.

const root = new URL("../", import.meta.url);

async function loadModule() {
  return import(new URL("app/lib/expiries.ts", root));
}

test("a stock expiry landing inside regular trading hours is available", async () => {
  const { resolveExpiry } = await loadModule();
  // now = 2026-07-16T17:58:20Z; the next 15M boundary is 2026-07-16T18:15:00Z,
  // which is Thursday 14:15 ET -- squarely inside the session.
  const now = Date.parse("2026-07-16T17:58:20Z");
  const definition = resolveExpiry("15M", "NVDA", now);
  assert.equal(new Date(definition.expiryAt).toISOString(), "2026-07-16T18:15:00.000Z");
  assert.equal(definition.available, true);
});

test("a stock expiry landing at 03:00 ET (before the open, on a weekday) is not available", async () => {
  const { resolveExpiry } = await loadModule();
  // now = 2026-07-16T05:00:01Z; the next 1H boundary is 2026-07-16T07:00:00Z,
  // which is Thursday 03:00 ET.
  const now = Date.parse("2026-07-16T05:00:01Z");
  const definition = resolveExpiry("1H", "NVDA", now);
  assert.equal(new Date(definition.expiryAt).toISOString(), "2026-07-16T07:00:00.000Z");
  assert.equal(definition.available, false);
  assert.match(definition.availabilityReason, /NVIDIA's price is frozen outside regular trading hours/);
  assert.match(definition.availabilityReason, /9:30am-4:00pm ET, Monday-Friday/);
  assert.doesNotMatch(definition.availabilityReason, /coming soon/i, "NVDA is live -- this must be the clock reason, not the old coming-soon one");
});

test("a stock expiry landing on a Saturday is not available, even at what would be a trading-session hour", async () => {
  const { resolveExpiry } = await loadModule();
  // now = 2026-07-18T17:44:59Z; the next 15M boundary is 2026-07-18T18:00:00Z,
  // which is Saturday 14:00 ET.
  const now = Date.parse("2026-07-18T17:44:59Z");
  const definition = resolveExpiry("15M", "GOOGL", now);
  assert.equal(new Date(definition.expiryAt).toISOString(), "2026-07-18T18:00:00.000Z");
  assert.equal(definition.available, false);
  assert.match(definition.availabilityReason, /Google's price is frozen outside regular trading hours/);
});

test("a stock expiry landing at 16:30 ET (after the close, on a weekday) is not available", async () => {
  const { resolveExpiry } = await loadModule();
  // now = 2026-07-16T20:10:00Z; the next 15M boundary is 2026-07-16T20:30:00Z,
  // which is Thursday 16:30 ET.
  const now = Date.parse("2026-07-16T20:10:00Z");
  const definition = resolveExpiry("15M", "NVDA", now);
  assert.equal(new Date(definition.expiryAt).toISOString(), "2026-07-16T20:30:00.000Z");
  assert.equal(definition.available, false);
  assert.match(definition.availabilityReason, /frozen outside regular trading hours/);
});

test("DST correctness: the same 09:30 ET wall-clock boundary resolves available in both January (EST) and July (EDT)", async () => {
  const { resolveExpiry } = await loadModule();
  // A hardcoded UTC-5 offset would get the July case wrong (it is really
  // UTC-4 under EDT), landing one hour before the open instead of exactly
  // on it.
  const januaryNow = Date.parse("2026-01-15T14:14:20Z");
  const july = resolveExpiry("15M", "NVDA", Date.parse("2026-07-15T13:14:20Z"));
  const january = resolveExpiry("15M", "NVDA", januaryNow);

  assert.equal(new Date(january.expiryAt).toISOString(), "2026-01-15T14:30:00.000Z", "09:30 ET under EST (UTC-5)");
  assert.equal(new Date(july.expiryAt).toISOString(), "2026-07-15T13:30:00.000Z", "09:30 ET under EDT (UTC-4)");
  assert.equal(january.available, true);
  assert.equal(july.available, true);
});

test("crypto expiries are never gated by the clock: 03:00 ET and a weekend both stay available", async () => {
  const { resolveExpiry } = await loadModule();

  // The exact instants used above to prove NVDA/GOOGL are gated -- reused
  // here for SOL to prove the same clock never touches a crypto market.
  const beforeOpen = resolveExpiry("1H", "SOL", Date.parse("2026-07-16T05:00:01Z"));
  assert.equal(new Date(beforeOpen.expiryAt).toISOString(), "2026-07-16T07:00:00.000Z", "Thursday 03:00 ET");
  assert.equal(beforeOpen.available, true);
  assert.doesNotMatch(beforeOpen.availabilityReason, /trading hours|frozen|session|holiday|weekend/i);

  const weekend = resolveExpiry("15M", "SOL", Date.parse("2026-07-18T17:44:59Z"));
  assert.equal(new Date(weekend.expiryAt).toISOString(), "2026-07-18T18:00:00.000Z", "Saturday 14:00 ET");
  assert.equal(weekend.available, true);
  assert.doesNotMatch(weekend.availabilityReason, /trading hours|frozen|session|holiday|weekend/i);

  const afterClose = resolveExpiry("15M", "SOL", Date.parse("2026-07-16T20:10:00Z"));
  assert.equal(new Date(afterClose.expiryAt).toISOString(), "2026-07-16T20:30:00.000Z", "Thursday 16:30 ET");
  assert.equal(afterClose.available, true);
});
