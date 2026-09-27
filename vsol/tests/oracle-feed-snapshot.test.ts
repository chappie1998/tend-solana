import assert from "node:assert/strict";
import test from "node:test";
import { fetchSettlementSnapshot } from "../scripts/lib/oracle-feed.ts";
import { marketBySymbol } from "../../app/lib/markets.ts";
import type { MarketSnapshot } from "../../app/lib/market-data-types.ts";

const solMarket = marketBySymbol("SOL");
if (!solMarket) throw new Error("app/lib/markets.ts no longer configures a SOL market -- this fixture needs updating");

function fakeSnapshot(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    price: 100,
    confidence: 0.05,
    confidenceBps: 5,
    exponent: 0,
    publishTime: 1_000,
    slot: null,
    ageSeconds: 1,
    mode: "live",
    source: "Coinbase Exchange",
    warning: "",
    ...overrides,
  };
}

function instantSleep(calls: number[]) {
  return async (ms: number) => { calls.push(ms); };
}

test("a snapshot published AT OR AFTER expiry is accepted on the first attempt, no retry needed", async () => {
  const expiry = 1_000;
  let calls = 0;
  const result = await fetchSettlementSnapshot({
    market: solMarket,
    expiry,
    fetchSnapshot: async () => { calls += 1; return fakeSnapshot({ publishTime: expiry, price: 101.5 }); },
    sleep: instantSleep([]),
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: true, price: 101_500_000n, confidence: 50_000n, publishTime: expiry, source: "Coinbase Exchange" });
});

test("a snapshot published BEFORE expiry is retried until one at/after expiry arrives", async () => {
  const expiry = 1_000;
  const publishTimes = [990, 995, 999, 1_000];
  let index = 0;
  const sleepCalls: number[] = [];
  const result = await fetchSettlementSnapshot({
    market: solMarket,
    expiry,
    maxAttempts: 5,
    retryDelayMs: 2_000,
    fetchSnapshot: async () => fakeSnapshot({ publishTime: publishTimes[index++], price: 100 }),
    sleep: instantSleep(sleepCalls),
  });
  assert.equal(index, 4);
  assert.equal(sleepCalls.length, 3);
  assert.ok(sleepCalls.every((ms) => ms === 2_000));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.publishTime, expiry);
});

test("exhausting every attempt still before expiry fails cleanly, naming the reason", async () => {
  const expiry = 1_000;
  const result = await fetchSettlementSnapshot({
    market: solMarket,
    expiry,
    maxAttempts: 3,
    retryDelayMs: 0,
    fetchSnapshot: async () => fakeSnapshot({ publishTime: 500 }),
    sleep: instantSleep([]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /still before expiry/);
    assert.match(result.reason, /3 attempt/);
  }
});

test("a stale (non-live) snapshot is retried, not accepted, even if its publish time is fine", async () => {
  const expiry = 1_000;
  let calls = 0;
  const result = await fetchSettlementSnapshot({
    market: solMarket,
    expiry,
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchSnapshot: async () => {
      calls += 1;
      return calls === 1 ? fakeSnapshot({ publishTime: 1_000, mode: "stale" }) : fakeSnapshot({ publishTime: 1_000, mode: "live" });
    },
    sleep: instantSleep([]),
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test("a fetch failure is retried rather than thrown", async () => {
  const expiry = 1_000;
  let calls = 0;
  const result = await fetchSettlementSnapshot({
    market: solMarket,
    expiry,
    maxAttempts: 3,
    retryDelayMs: 0,
    fetchSnapshot: async () => {
      calls += 1;
      if (calls < 2) throw new Error("fetch failed");
      return fakeSnapshot({ publishTime: expiry });
    },
    sleep: instantSleep([]),
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test("a non-positive price is rejected and retried, never returned as ok", async () => {
  const expiry = 1_000;
  const result = await fetchSettlementSnapshot({
    market: solMarket,
    expiry,
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchSnapshot: async () => fakeSnapshot({ publishTime: expiry, price: 0 }),
    sleep: instantSleep([]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /non-positive/);
});
