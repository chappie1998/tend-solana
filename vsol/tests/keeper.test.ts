import assert from "node:assert/strict";
import test from "node:test";
import { isRungAuthorizable } from "../scripts/keeper.ts";

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
