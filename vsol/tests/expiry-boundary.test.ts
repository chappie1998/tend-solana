import assert from "node:assert/strict";
import test from "node:test";
import { FIFTEEN_MINUTES_MS, msUntilNextBoundaryPass, nextFifteenMinuteBoundary } from "../scripts/lib/expiry-boundary.ts";

test("nextFifteenMinuteBoundary rounds up to the next 15-minute UTC mark", () => {
  const t10_00_00 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const t10_07_00 = Date.UTC(2026, 0, 1, 10, 7, 0);
  const t10_14_59 = Date.UTC(2026, 0, 1, 10, 14, 59, 999);
  const t10_15_00 = Date.UTC(2026, 0, 1, 10, 15, 0);

  // Sitting exactly ON a boundary always advances to the NEXT one -- the
  // runner never re-processes the instant it just woke at.
  assert.equal(nextFifteenMinuteBoundary(t10_00_00), t10_00_00 + FIFTEEN_MINUTES_MS);
  assert.equal(nextFifteenMinuteBoundary(t10_07_00), t10_15_00);
  assert.equal(nextFifteenMinuteBoundary(t10_14_59), t10_15_00);
  assert.equal(nextFifteenMinuteBoundary(t10_15_00), t10_15_00 + FIFTEEN_MINUTES_MS);
});

test("nextFifteenMinuteBoundary crosses a UTC midnight correctly", () => {
  // 2026-01-01 23:50:00Z -> 2026-01-02 00:00:00Z, not 2026-01-01 24:00:00Z or
  // any other malformed rollover.
  const before = Date.UTC(2026, 0, 1, 23, 50, 0);
  const midnight = Date.UTC(2026, 0, 2, 0, 0, 0);
  assert.equal(nextFifteenMinuteBoundary(before), midnight);

  // One millisecond before midnight still rounds up TO midnight, never past it.
  const justBefore = midnight - 1;
  assert.equal(nextFifteenMinuteBoundary(justBefore), midnight);

  // Exactly at midnight advances a further 15 minutes, still within the new day.
  assert.equal(nextFifteenMinuteBoundary(midnight), midnight + FIFTEEN_MINUTES_MS);
});

test("nextFifteenMinuteBoundary is always a clean multiple of 15 minutes, across a dense scan", () => {
  const start = Date.UTC(2026, 0, 1, 23, 40, 0);
  for (let offsetMs = 0; offsetMs < 40 * 60_000; offsetMs += 91_000) {
    const boundary = nextFifteenMinuteBoundary(start + offsetMs);
    assert.equal(boundary % FIFTEEN_MINUTES_MS, 0, `boundary ${new Date(boundary).toISOString()} is not 15-minute aligned`);
    assert.ok(boundary > start + offsetMs, "the boundary must be strictly in the future");
  }
});

test("msUntilNextBoundaryPass adds the wake offset on top of the boundary itself", () => {
  const now = Date.UTC(2026, 0, 1, 10, 3, 0);
  const offset = 5_000;
  const wait = msUntilNextBoundaryPass(now, offset);
  assert.equal(now + wait, nextFifteenMinuteBoundary(now) + offset);
  assert.ok(wait > 0);
});
