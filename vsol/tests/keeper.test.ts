import assert from "node:assert/strict";
import test from "node:test";
import { indexMarketsByExpiry, isRungAuthorizable } from "../scripts/keeper.ts";
import type { DecodedMarketForCleanup } from "../scripts/lib/settlement.ts";

// isRungAuthorizable is the pure mirror of the on-chain
// set_liquidity_pool_market check (last_trade_at >= now + MIN_MARKET_LEAD_SECONDS
// && last_trade_at < expiry) that keeper.ts uses both (1) right before
// submitting an authorization, to proactively skip a rung that has aged out
// instead of sending a transaction the program will reject, and (2) with an
// inflated lead, before ever creating a rung, so the keeper never mints a
// market that could not survive long enough to be authorized in the same
// pass. This exercises it in isolation -- no live RPC, no Connection, no
// Program instance -- per keeper.ts's own docstring on the function.

const MIN_LEAD = 15; // Mirrors MIN_MARKET_LEAD_SECONDS in vsol/programs/vsol/src/lib.rs.

test("isRungAuthorizable: true for a rung comfortably ahead of its cutoff and expiry", () => {
  const now = 1_000_000;
  assert.equal(
    isRungAuthorizable({
      now,
      lastTradeAt: now + 840, // 15M's lastTradeAt is 60s before a >=900s-out expiry.
      expiry: now + 900,
      minLeadSeconds: MIN_LEAD,
    }),
    true,
  );
});

test("isRungAuthorizable: false once the cutoff is within MIN_MARKET_LEAD_SECONDS of now", () => {
  const now = 1_000_000;
  // lastTradeAt is only 10s ahead of now -- inside the 15s minimum lead window.
  assert.equal(
    isRungAuthorizable({
      now,
      lastTradeAt: now + 10,
      expiry: now + 70,
      minLeadSeconds: MIN_LEAD,
    }),
    false,
  );
  // Exactly at the boundary (lastTradeAt == now + minLeadSeconds) is still authorizable --
  // the on-chain check is >=, not >.
  assert.equal(
    isRungAuthorizable({
      now,
      lastTradeAt: now + MIN_LEAD,
      expiry: now + 70,
      minLeadSeconds: MIN_LEAD,
    }),
    true,
  );
  // One second inside the boundary is not.
  assert.equal(
    isRungAuthorizable({
      now,
      lastTradeAt: now + MIN_LEAD - 1,
      expiry: now + 70,
      minLeadSeconds: MIN_LEAD,
    }),
    false,
  );
});

test("isRungAuthorizable: false once now has passed the rung's expiry", () => {
  const now = 1_000_000;
  assert.equal(
    isRungAuthorizable({
      now,
      lastTradeAt: now - 120, // Cutoff and expiry are both already behind us.
      expiry: now - 60,
      minLeadSeconds: MIN_LEAD,
    }),
    false,
  );
});

test("isRungAuthorizable: false when lastTradeAt has reached (not just passed) expiry", () => {
  const now = 1_000_000;
  // The on-chain check requires lastTradeAt strictly LESS than expiry.
  assert.equal(
    isRungAuthorizable({
      now,
      lastTradeAt: now + 900,
      expiry: now + 900,
      minLeadSeconds: MIN_LEAD,
    }),
    false,
  );
});

test("isRungAuthorizable: defaults minLeadSeconds to the on-chain MIN_MARKET_LEAD_SECONDS (15s)", () => {
  const now = 1_000_000;
  assert.equal(isRungAuthorizable({ now, lastTradeAt: now + 15, expiry: now + 100 }), true);
  assert.equal(isRungAuthorizable({ now, lastTradeAt: now + 14, expiry: now + 100 }), false);
});

test("isRungAuthorizable: a create-time margin can reject a rung that is still nominally authorizable under the bare lead", () => {
  // This is how keeper.ts decides whether a rung is even worth creating:
  // MIN_MARKET_LEAD_SECONDS + CREATE_AUTHORIZE_MARGIN_SECONDS as the lead,
  // so a rung with only a little headroom left is skipped before minting a
  // market that would just fail authorization moments later.
  const now = 1_000_000;
  const lastTradeAt = now + 30;
  const expiry = now + 90;

  assert.equal(isRungAuthorizable({ now, lastTradeAt, expiry, minLeadSeconds: MIN_LEAD }), true);
  assert.equal(isRungAuthorizable({ now, lastTradeAt, expiry, minLeadSeconds: MIN_LEAD + 60 }), false);
});

// indexMarketsByExpiry is the pure core of the keeper's discover-first rung
// lookup (see ensureMarketRung's doc comment): the fingerprint match it
// performs is exactly what lets a pass with every rung already minted skip
// Hermes entirely. No RPC, no Connection -- feeding it plain
// DecodedMarketForCleanup fixtures exercises the matching/collision logic in
// isolation, per this function's own doc comment in keeper.ts.

const POLICY = {
  pythFeedId: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  symbol: "NVDA",
  observationWindowSeconds: 30,
  settlementGraceSeconds: 900,
  maxConfidenceBps: 500,
  priceScale: 1_000_000n,
  maxSettlementStalenessSeconds: 86_400,
};

function marketFixture(overrides: Partial<DecodedMarketForCleanup> = {}): DecodedMarketForCleanup {
  return {
    address: overrides.address ?? "market-address",
    oracle: overrides.oracle ?? "oracle-address",
    creator: overrides.creator ?? "creator-address",
    expiry: overrides.expiry ?? 1_000_000,
    observationWindowSeconds: overrides.observationWindowSeconds ?? POLICY.observationWindowSeconds,
    settlementGraceSeconds: overrides.settlementGraceSeconds ?? POLICY.settlementGraceSeconds,
    marketId: overrides.marketId ?? "market-id",
    symbol: overrides.symbol ?? POLICY.symbol,
    pythFeedId: overrides.pythFeedId ?? POLICY.pythFeedId,
    maxConfidenceBps: overrides.maxConfidenceBps ?? POLICY.maxConfidenceBps,
    priceScale: overrides.priceScale ?? POLICY.priceScale,
    maxSettlementStalenessSeconds: overrides.maxSettlementStalenessSeconds ?? POLICY.maxSettlementStalenessSeconds,
    enabled: overrides.enabled ?? true,
    strike: overrides.strike ?? 100_000_000n,
  };
}

test("indexMarketsByExpiry keys a policy-matching market by its expiry", () => {
  const market = marketFixture({ address: "m1", expiry: 1_000_000 });
  const index = indexMarketsByExpiry([market], POLICY);
  assert.equal(index.size, 1);
  assert.equal(index.get(1_000_000)?.address, "m1");
});

test("indexMarketsByExpiry excludes a market on a different feed", () => {
  const market = marketFixture({ pythFeedId: "ff".repeat(32) });
  const index = indexMarketsByExpiry([market], POLICY);
  assert.equal(index.size, 0);
});

test("indexMarketsByExpiry excludes a market with a different symbol", () => {
  const market = marketFixture({ symbol: "AAPL" });
  const index = indexMarketsByExpiry([market], POLICY);
  assert.equal(index.size, 0);
});

test("indexMarketsByExpiry excludes a market whose policy constants have drifted (observation window, grace, confidence, price scale, staleness)", () => {
  assert.equal(indexMarketsByExpiry([marketFixture({ observationWindowSeconds: 60 })], POLICY).size, 0);
  assert.equal(indexMarketsByExpiry([marketFixture({ settlementGraceSeconds: 60 })], POLICY).size, 0);
  assert.equal(indexMarketsByExpiry([marketFixture({ maxConfidenceBps: 100 })], POLICY).size, 0);
  assert.equal(indexMarketsByExpiry([marketFixture({ priceScale: 1_000n })], POLICY).size, 0);
  assert.equal(indexMarketsByExpiry([marketFixture({ maxSettlementStalenessSeconds: 1 })], POLICY).size, 0);
});

test("indexMarketsByExpiry excludes a disabled market -- a guardian-disabled rung is never reused", () => {
  const market = marketFixture({ enabled: false });
  const index = indexMarketsByExpiry([market], POLICY);
  assert.equal(index.size, 0);
});

test("indexMarketsByExpiry matches pythFeedId case-insensitively", () => {
  const market = marketFixture({ pythFeedId: POLICY.pythFeedId.toUpperCase() });
  const index = indexMarketsByExpiry([market], POLICY);
  assert.equal(index.size, 1);
});

test("indexMarketsByExpiry keeps the first market of a ladder-rung race at the same expiry and drops the second", () => {
  const first = marketFixture({ address: "m-first", expiry: 2_000_000, strike: 100_000_000n });
  const second = marketFixture({ address: "m-second", expiry: 2_000_000, strike: 105_000_000n });
  const index = indexMarketsByExpiry([first, second], POLICY);
  assert.equal(index.size, 1);
  assert.equal(index.get(2_000_000)?.address, "m-first");
});

test("indexMarketsByExpiry indexes multiple distinct expiries independently", () => {
  const fifteenMinute = marketFixture({ address: "m-15m", expiry: 1_000_900 });
  const oneHour = marketFixture({ address: "m-1h", expiry: 1_003_600 });
  const index = indexMarketsByExpiry([fifteenMinute, oneHour], POLICY);
  assert.equal(index.size, 2);
  assert.equal(index.get(1_000_900)?.address, "m-15m");
  assert.equal(index.get(1_003_600)?.address, "m-1h");
});
