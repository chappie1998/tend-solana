import assert from "node:assert/strict";
import test from "node:test";

// Offline (no network) tests for app/lib/expiries.ts's `resolveExpiry`: Tend
// is a 24/7 product for EVERY market it lists, crypto and stocks alike --
// expiries are pure UTC clock arithmetic, gated on nothing but feed
// availability (`intradayEligible`) and the trade-lock cutoff, never on the
// wall clock or the weekday.
//
// Stocks used to carry a scoped regular-trading-hours (RTH) exception here
// (2026-09-16, since reverted): NVDA/GOOGL/SPACEX priced off real Finnhub/
// Twelve Data equity quotes that froze outside 09:30-16:00 America/New_York,
// so `resolveExpiry` refused any stock-category expiry landing outside that
// window. That gate (and app/lib/market-hours.ts, which implemented it) is
// gone now that stocks price off Hyperliquid's "xyz" HIP-3 dex, which
// genuinely trades around the clock -- see CLAUDE.md and
// app/lib/hyperliquid-market-data.ts for the verification evidence. This
// file now asserts the STRONGER guarantee: every configured market, not just
// crypto, is available at every instant a `now`/code pair from expiries.ts's
// own UTC grid produces, with no trading-hours language anywhere.
//
// Every `now`/code pair below was derived directly from expiries.ts's own
// UTC grid math (nextFixedSeries/nextUtcMidnightAfter), then verified against
// its America/New_York wall-clock reading, so these are pinned, deterministic
// fixtures -- not flaky "whatever today happens to be" checks. They are the
// exact instants a previous version of this suite used to prove NVDA/GOOGL
// were GATED by the clock; kept here to prove the opposite now holds.

const root = new URL("../", import.meta.url);

async function loadModule() {
  return import(new URL("app/lib/expiries.ts", root));
}

const NO_CLOCK_LANGUAGE = /trading hours|frozen|session|holiday|weekend|market (open|close)/i;

test("expiries are never gated by the clock or weekday, for every live market -- crypto and stocks alike", async () => {
  const { resolveExpiry } = await loadModule();
  const liveSymbols = ["SOL", "BTC", "ETH", "NVDA", "GOOGL", "SPACEX"];

  // Before the open (03:00 ET on a weekday) -- used to gate NVDA/GOOGL here.
  const beforeOpenNow = Date.parse("2026-07-16T05:00:01Z");
  for (const symbol of liveSymbols) {
    const definition = resolveExpiry("1H", symbol, beforeOpenNow);
    assert.equal(new Date(definition.expiryAt).toISOString(), "2026-07-16T07:00:00.000Z", `${symbol}: Thursday 03:00 ET`);
    assert.equal(definition.available, true, `${symbol} must be available at 03:00 ET`);
    assert.doesNotMatch(definition.availabilityReason, NO_CLOCK_LANGUAGE);
  }

  // A Saturday, at what would be a trading-session hour -- used to gate GOOGL here.
  const weekendNow = Date.parse("2026-07-18T17:44:59Z");
  for (const symbol of liveSymbols) {
    const definition = resolveExpiry("15M", symbol, weekendNow);
    assert.equal(new Date(definition.expiryAt).toISOString(), "2026-07-18T18:00:00.000Z", `${symbol}: Saturday 14:00 ET`);
    assert.equal(definition.available, true, `${symbol} must be available on a Saturday`);
    assert.doesNotMatch(definition.availabilityReason, NO_CLOCK_LANGUAGE);
  }

  // After the close (16:30 ET on a weekday) -- used to gate NVDA here.
  const afterCloseNow = Date.parse("2026-07-16T20:10:00Z");
  for (const symbol of liveSymbols) {
    const definition = resolveExpiry("15M", symbol, afterCloseNow);
    assert.equal(new Date(definition.expiryAt).toISOString(), "2026-07-16T20:30:00.000Z", `${symbol}: Thursday 16:30 ET`);
    assert.equal(definition.available, true, `${symbol} must be available at 16:30 ET`);
    assert.doesNotMatch(definition.availabilityReason, NO_CLOCK_LANGUAGE);
  }
});

test("expiries land on the same UTC grid for a stock market as for a crypto one -- no separate boundary math", async () => {
  const { resolveExpiry } = await loadModule();
  // Same instant, same code, different symbols: the expiry boundary itself
  // must be identical, since the grid is pure UTC arithmetic with no
  // per-category branch left in it at all.
  const now = Date.parse("2026-07-16T17:58:20Z");
  const nvda = resolveExpiry("15M", "NVDA", now);
  const sol = resolveExpiry("15M", "SOL", now);
  assert.equal(nvda.expiryAt, sol.expiryAt);
  assert.equal(nvda.available, true);
  assert.equal(sol.available, true);
});

test("DST is irrelevant to expiry availability now: the same wall-clock instant is available in both January (EST) and July (EDT)", async () => {
  const { resolveExpiry } = await loadModule();
  const july = resolveExpiry("15M", "NVDA", Date.parse("2026-07-15T13:14:20Z"));
  const january = resolveExpiry("15M", "NVDA", Date.parse("2026-01-15T14:14:20Z"));

  assert.equal(new Date(january.expiryAt).toISOString(), "2026-01-15T14:30:00.000Z");
  assert.equal(new Date(july.expiryAt).toISOString(), "2026-07-15T13:30:00.000Z");
  assert.equal(january.available, true);
  assert.equal(july.available, true);
});

test("only a missing intraday feed or a non-live status can make a code unavailable, never the clock", async () => {
  const { resolveExpiry } = await loadModule();
  const now = Date.parse("2026-07-17T14:00:00Z");
  const unsupportedSymbol = resolveExpiry("15M", "TSLA", now);
  assert.equal(unsupportedSymbol.available, false);
  assert.doesNotMatch(unsupportedSymbol.availabilityReason, NO_CLOCK_LANGUAGE);
});
