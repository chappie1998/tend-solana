import assert from "node:assert/strict";
import test from "node:test";
import { selectExpiredMarketsWithOpenInterest, selectMarketsAtBoundaryWithOpenInterest } from "../scripts/lib/market-selection.ts";
import type { DecodedMarketForCleanup } from "../scripts/lib/settlement.ts";

function fixtureMarket(overrides: Partial<DecodedMarketForCleanup> & { address: string; expiry: number }): DecodedMarketForCleanup {
  return {
    oracle: `oracle-${overrides.address}`,
    creator: "creator",
    observationWindowSeconds: 60,
    settlementGraceSeconds: 900,
    marketId: "00".repeat(32),
    symbol: "SOL",
    pythFeedId: "11".repeat(32),
    maxConfidenceBps: 500,
    priceScale: 1_000_000n,
    maxSettlementStalenessSeconds: 86_400,
    enabled: true,
    strike: 100_000_000n,
    ...overrides,
  };
}

test("selectMarketsAtBoundaryWithOpenInterest keeps only markets expiring at EXACTLY this boundary AND carrying open interest", () => {
  const boundary = 1_000_000;
  const markets = [
    fixtureMarket({ address: "at-boundary-with-interest", expiry: boundary }),
    fixtureMarket({ address: "at-boundary-no-interest", expiry: boundary }),
    fixtureMarket({ address: "different-boundary-with-interest", expiry: boundary + 900 }),
    fixtureMarket({ address: "earlier-boundary-with-interest", expiry: boundary - 900 }),
  ];
  const openInterest = new Set(["at-boundary-with-interest", "different-boundary-with-interest", "earlier-boundary-with-interest"]);

  const selected = selectMarketsAtBoundaryWithOpenInterest({ markets, boundaryUnixSeconds: boundary, marketsWithOpenPositions: openInterest });

  assert.deepEqual(selected.map((market) => market.address), ["at-boundary-with-interest"]);
});

test("selectMarketsAtBoundaryWithOpenInterest returns nothing when no market has open interest, even if several expire at the boundary", () => {
  const boundary = 2_000_000;
  const markets = [
    fixtureMarket({ address: "a", expiry: boundary }),
    fixtureMarket({ address: "b", expiry: boundary }),
  ];
  const selected = selectMarketsAtBoundaryWithOpenInterest({ markets, boundaryUnixSeconds: boundary, marketsWithOpenPositions: new Set() });
  assert.deepEqual(selected, []);
});

test("selectExpiredMarketsWithOpenInterest (startup catch-up) picks up ANY already-expired market with open interest, not just an exact boundary match", () => {
  const now = 5_000_000;
  const markets = [
    fixtureMarket({ address: "expired-long-ago", expiry: now - 10_000 }),
    fixtureMarket({ address: "expired-just-now", expiry: now }),
    fixtureMarket({ address: "not-yet-expired", expiry: now + 900 }),
    fixtureMarket({ address: "expired-no-interest", expiry: now - 100 }),
  ];
  const openInterest = new Set(["expired-long-ago", "expired-just-now", "not-yet-expired"]);

  const selected = selectExpiredMarketsWithOpenInterest({ markets, now, marketsWithOpenPositions: openInterest });

  assert.deepEqual(selected.map((market) => market.address).sort(), ["expired-just-now", "expired-long-ago"]);
});
