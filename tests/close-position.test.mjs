import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("buybackFor prices an early close strictly below premium, with the expected spread and true-binary decay shape", async () => {
  const { buybackFor, definedRiskPayout, digitalFairValue, applyMakerEdge, BINARY_WIDTH, BUYBACK_SPREAD_BPS, BUYBACK_BASE_SPREAD_BPS, BUYBACK_MAX_SPREAD_BPS } =
    await import(new URL("app/lib/options.ts", root));

  assert.equal(BUYBACK_SPREAD_BPS, 250);
  assert.equal(BUYBACK_BASE_SPREAD_BPS, 250);
  assert.ok(BUYBACK_MAX_SPREAD_BPS > BUYBACK_BASE_SPREAD_BPS);

  // `cap` is BINARY_WIDTH away from `strike`, exactly like every real quote
  // -- not an arbitrary wide test width. `premium` is derived from the SAME
  // model buybackFor re-prices with (digitalFairValue + the maker edge), the
  // way a real quoteFor-issued premium would be, so this test's inception
  // fair value is self-consistent rather than an arbitrary hand-picked number.
  const originalMinutes = 10_080; // 7D
  const volatility = 60;
  const strike = 200;
  const cap = strike + BINARY_WIDTH;
  const inceptionFair = digitalFairValue({ direction: "up", spot: 210, strike, maxPayout: 1_000, volAnnual: volatility / 100, timeYears: originalMinutes / 525_600 });
  const premium = applyMakerEdge(inceptionFair);
  const base = { direction: "up", spot: 210, strike, cap, maxPayout: 1_000, premium, originalMinutes, volatility };

  // At expiry (minutesRemaining -> 0), fair value is EXACTLY the on-chain
  // step function's terminal value -- `definedRiskPayout` at the real
  // BINARY_WIDTH, which for a settlement well past the strike is exactly
  // maxPayout (see the payout-shape test in pricing.test.mjs).
  const atExpiry = buybackFor({ ...base, minutesRemaining: 0 });
  const intrinsic = definedRiskPayout({ direction: base.direction, settlement: base.spot, strike: base.strike, cap: base.cap, maxPayout: base.maxPayout });
  assert.equal(intrinsic, 1_000, "settlement well past the strike pays the full step");
  assert.ok(Math.abs(atExpiry.fairValue - intrinsic) < 1e-6, "fair value at expiry equals intrinsic exactly");
  assert.equal(atExpiry.spreadBps, BUYBACK_SPREAD_BPS, "no gap-risk widening with a fresh reference");

  // TRUE BINARY shape, the opposite direction from the old capped-spread
  // engine: an in-the-money digital has POSITIVE theta. `fairValue` RISES
  // monotonically toward intrinsic (maxPayout) as time runs out, because
  // every minute that passes without spot dropping back below the strike
  // makes the win MORE certain -- see buybackFor's own doc comment ("THIRD
  // round-trip hazard"). This is standard digital-option behavior, not a bug.
  const far = buybackFor({ ...base, minutesRemaining: 5_000 });
  const mid = buybackFor({ ...base, minutesRemaining: 2_000 });
  const near = buybackFor({ ...base, minutesRemaining: 200 });
  assert.ok(base.premium <= 1_000, "sanity: premium must stay below maxPayout for this scenario to be meaningful");
  assert.ok(far.fairValue < mid.fairValue, "fair value rises as expiry approaches for an unmoved in-the-money strike");
  assert.ok(mid.fairValue < near.fairValue, "fair value rises as expiry approaches for an unmoved in-the-money strike");
  assert.ok(near.fairValue < atExpiry.fairValue + 1e-9, "fair value converges to intrinsic exactly at expiry");
  assert.ok(far.fairValue <= 1_000 && near.fairValue <= 1_000, "fair value never exceeds maxPayout");

  // `buyback` tracks fair value minus the spread -- it is NOT capped at the
  // premium. A ceiling there was tried and removed: an in-the-money digital's
  // fair value legitimately climbs toward maxPayout as expiry nears, and
  // capping the payout meant a buyer whose target had been crossed could only
  // exit below what they paid. What must hold is that buyback never exceeds
  // the spread-discounted fair value, and never exceeds the payout itself.
  for (const quote of [far, mid, near, atExpiry]) {
    assert.ok(
      quote.buyback <= quote.fairValue * (1 - quote.spreadBps / 10_000) + 1e-6,
      "buyback must never exceed the spread-discounted fair value",
    );
    assert.ok(quote.buyback <= 1_000 + 1e-6, "buyback must never exceed maxPayout");
  }

  // The opposite case, to pin the direction of the effect: struck OUT of the
  // money, value decays toward zero as time runs out (ordinary negative
  // theta -- a true binary's positive-theta property above is specific to
  // being on the winning side).
  const decaying = { direction: "up", spot: 200, strike: 210, cap: 210 + BINARY_WIDTH, maxPayout: 1_000, premium: 150, originalMinutes: 10_080, volatility: 60 };
  const dFar = buybackFor({ ...decaying, minutesRemaining: 5_000 });
  const dNear = buybackFor({ ...decaying, minutesRemaining: 200 });
  assert.ok(dFar.fairValue > dNear.fairValue, "an OTM position loses value as time runs out");
  assert.ok(buybackFor({ ...decaying, minutesRemaining: 0 }).fairValue === 0, "worthless at expiry when it never crossed");
  // No premium comparison here on purpose: `decaying.premium` is a
  // hand-written 150 with no pricing relationship to this synthetic
  // position, so "buyback < premium" would assert nothing about the engine.
  // The real anti-arbitrage invariant is the sweep below, which derives
  // premium and payout from quoteFor so the two are actually consistent.

  // At full time remaining, fair value must be anchored to exactly the
  // premium paid divided by (1 + maker edge) -- the pre-edge value `premium`
  // was itself derived from -- not a volatility-inflated multiple of it.
  // This is the core anti-arbitrage property the earlier double-count bugs
  // broke: time value is the MODEL's own value, never approximated as
  // `premium * decay * X` for X > 1. The exhaustive version of this sweep
  // (every tier x tenor x vol x direction x time fraction) lives below.
  const atInception = buybackFor({ ...base, minutesRemaining: base.originalMinutes });
  assert.ok(Math.abs(atInception.fairValue - inceptionFair) < 1e-6, "fair value at full time remaining equals the model's own inception value");
  assert.ok(atInception.fairValue < premium, "fair value at inception sits below the premium paid, by the maker edge");
  assert.ok(atInception.buyback < premium, "an immediate round trip always costs at least the spread");

  // Hard clamp to [0, maxPayout] even for extreme inputs.
  const deepItm = buybackFor({ ...base, spot: 1_000, minutesRemaining: 5_000 });
  assert.ok(deepItm.buyback >= 0 && deepItm.buyback <= base.maxPayout);
  assert.ok(deepItm.fairValue >= 0 && deepItm.fairValue <= base.maxPayout);
  const worthless = buybackFor({ ...base, direction: "up", spot: 50, minutesRemaining: 0 });
  assert.ok(worthless.buyback >= 0);
  assert.equal(worthless.fairValue, 0);
  assert.equal(worthless.buyback, 0);

  // A stale reference widens the spread (gap-risk term is reused, not a second knob).
  const fresh = buybackFor({ ...base, minutesRemaining: 2_000, referenceAgeSeconds: 0 });
  const stale = buybackFor({ ...base, minutesRemaining: 2_000, referenceAgeSeconds: 6 * 3_600 });
  assert.ok(stale.spreadBps > fresh.spreadBps, "a stale reference widens the closing spread");

  // Validation: throws RangeError on nonsense rather than returning NaN/Infinity.
  assert.throws(() => buybackFor({ ...base, minutesRemaining: 100, direction: "sideways" }), RangeError);
  assert.throws(() => buybackFor({ ...base, minutesRemaining: 100, spot: -1 }), RangeError);
  assert.throws(() => buybackFor({ ...base, minutesRemaining: 100, strike: 0 }), RangeError);
  assert.throws(() => buybackFor({ ...base, minutesRemaining: 100, cap: base.strike }), RangeError);
  assert.throws(() => buybackFor({ ...base, minutesRemaining: 100, maxPayout: 0 }), RangeError);
  assert.throws(() => buybackFor({ ...base, minutesRemaining: -1 }), RangeError);
  assert.throws(() => buybackFor({ ...base, minutesRemaining: 100, originalMinutes: 0 }), RangeError);
  assert.throws(() => buybackFor({ ...base, minutesRemaining: 100, referenceAgeSeconds: -1 }), RangeError);
  for (const quote of [atExpiry, far, mid, near, atInception, deepItm, fresh, stale]) {
    assert.ok(Number.isFinite(quote.fairValue));
    assert.ok(Number.isFinite(quote.buyback));
    assert.ok(Number.isFinite(quote.spreadBps));
  }
});

test("a fill-then-immediately-close round trip is never profitable, across every volatility and tenor", async () => {
  // Regression guard for a real bug that shipped once: buybackFor used to
  // multiply `premium` by a second volatility-derived factor (`volScale`),
  // double-counting the vol that `quoteFor` already priced into `premium`.
  // At high vol / long tenor that pushed fair value (and therefore buyback)
  // above the premium paid, so a trader could fill and instantly close for a
  // guaranteed profit, repeatable without limit, draining LPs. Concretely:
  // 70% vol/30D used to pay $211.24 back on a $208.16 premium (+$3.08), and
  // 90% vol/30D used to pay $240.10 back on a $221.93 premium (+$18.17).
  // Neither must be possible: for every volatility and tenor below, closing
  // at full time remaining (no price movement) must return strictly less
  // than the premium paid. The spread is now dynamic (moneyness x time x
  // gap-risk, see dynamicSpreadBps), not flat -- but every factor in that
  // composition is bounded below by 1, so the effective spread can only ever
  // be >= BUYBACK_BASE_SPREAD_BPS. That alone is what guarantees the round
  // trip stays unprofitable here: it never needs to be exactly the base.
  const { quoteFor, buybackFor, BUYBACK_BASE_SPREAD_BPS, BUYBACK_MAX_SPREAD_BPS } =
    await import(new URL("app/lib/options.ts", root));

  const volatilities = [20, 30, 50, 70, 90, 150];
  const tenors = [
    { label: "15M", minutes: 15 },
    { label: "1H", minutes: 60 },
    { label: "1D", minutes: 1_440 },
    { label: "7D", minutes: 10_080 },
    { label: "30D", minutes: 43_200 },
  ];
  const spot = 200;
  const amount = 1_000;
  const payoff = 5;

  const failures = [];
  for (const volatility of volatilities) {
    for (const tenor of tenors) {
      for (const direction of ["up", "down"]) {
        const quote = quoteFor({ spot, amount, durationMinutes: tenor.minutes, direction, payoff, volatility });
        const closed = buybackFor({
          direction,
          spot,
          strike: quote.strike,
          cap: quote.cap,
          maxPayout: quote.maxPayout,
          premium: quote.premium,
          minutesRemaining: tenor.minutes,
          originalMinutes: tenor.minutes,
          volatility,
        });
        const loss = quote.premium - closed.buyback;
        const minExpectedLoss = quote.premium * (BUYBACK_BASE_SPREAD_BPS / 10_000);
        const profitable = !(closed.buyback < quote.premium);
        // The spread must never dip below the base floor (that's the whole
        // anti-arbitrage guarantee) and never exceed the hard cap.
        const spreadOutOfBounds =
          closed.spreadBps < BUYBACK_BASE_SPREAD_BPS - 1e-9 || closed.spreadBps > BUYBACK_MAX_SPREAD_BPS + 1e-9;
        const lossBelowFloor = loss < minExpectedLoss - 1e-6 * Math.max(1, quote.premium);
        if (profitable || spreadOutOfBounds || lossBelowFloor) {
          failures.push({
            volatility,
            tenor: tenor.label,
            direction,
            premium: quote.premium,
            buyback: closed.buyback,
            loss,
            minExpectedLoss,
            spreadBps: closed.spreadBps,
          });
        }
      }
    }
  }

  if (failures.length) {
    throw new Error(`round trip was profitable or the loss did not match the spread for: ${JSON.stringify(failures, null, 2)}`);
  }
});

test("dynamicSpreadBps widens with moneyness, time, and staleness, and stays within [base, cap]", async () => {
  const { dynamicSpreadBps, BUYBACK_BASE_SPREAD_BPS, BUYBACK_MAX_SPREAD_BPS } =
    await import(new URL("app/lib/options.ts", root));

  const strike = 200;
  const cap = 220; // width = 20
  const base = { direction: "up", strike, cap, fraction: 0.5, referenceAgeSeconds: 0 };

  // Moneyness: holding time/gap fixed, moving spot further out-of-the-money
  // (further below the strike, for an "up" position) must never tighten the
  // spread, and must strictly widen it before saturation.
  const spotsFarToNear = [180, 185, 190, 195, 200, 205, 210]; // strike-width .. past strike
  const moneynessSpreads = spotsFarToNear.map((spot) => dynamicSpreadBps({ ...base, spot }));
  for (let i = 1; i < moneynessSpreads.length; i += 1) {
    assert.ok(
      moneynessSpreads[i] <= moneynessSpreads[i - 1],
      `spread must not increase as spot moves toward/through the strike: ${JSON.stringify(moneynessSpreads)}`,
    );
  }
  // Strictly wider deep out-of-the-money than at/past the strike.
  assert.ok(moneynessSpreads[0] > moneynessSpreads[moneynessSpreads.length - 1]);
  // At or past the strike (favorable side), moneyness contributes no widening.
  assert.equal(dynamicSpreadBps({ ...base, spot: strike }), dynamicSpreadBps({ ...base, spot: 300 }));

  // Time to expiry: holding spot/gap fixed, more time remaining must never
  // tighten the spread, and must strictly widen it away from expiry.
  const fractions = [0, 0.1, 0.25, 0.5, 0.75, 1];
  const timeSpreads = fractions.map((fraction) => dynamicSpreadBps({ ...base, spot: 190, fraction }));
  for (let i = 1; i < timeSpreads.length; i += 1) {
    assert.ok(
      timeSpreads[i] >= timeSpreads[i - 1],
      `spread must not decrease as time remaining grows: ${JSON.stringify(timeSpreads)}`,
    );
  }
  assert.ok(timeSpreads[timeSpreads.length - 1] > timeSpreads[0], "full time remaining is strictly wider than expiry");

  // Gap risk: a staler reference must never tighten the spread, and must
  // strictly widen it until the gap-risk multiplier itself saturates.
  const referenceAges = [0, 1 * 3_600, 2 * 3_600, 6 * 3_600, 24 * 3_600];
  const staleSpreads = referenceAges.map((referenceAgeSeconds) => dynamicSpreadBps({ ...base, spot: 190, referenceAgeSeconds }));
  for (let i = 1; i < staleSpreads.length; i += 1) {
    assert.ok(
      staleSpreads[i] >= staleSpreads[i - 1],
      `spread must not decrease as the reference gets staler: ${JSON.stringify(staleSpreads)}`,
    );
  }
  assert.ok(staleSpreads[staleSpreads.length - 1] > staleSpreads[0], "a stale reference strictly widens the spread");

  // Bounds: across a broad sweep of moneyness x time x staleness, the spread
  // never drops below the base floor and never exceeds the hard cap.
  const sweepSpots = [50, 100, 150, 180, 190, 195, 200, 205, 220, 300, 1_000];
  const sweepFractions = [0, 0.01, 0.1, 0.5, 0.9, 1];
  const sweepAges = [0, 3_600, 6 * 3_600, 48 * 3_600];
  for (const spot of sweepSpots) {
    for (const fraction of sweepFractions) {
      for (const referenceAgeSeconds of sweepAges) {
        for (const direction of ["up", "down"]) {
          const spreadBps = dynamicSpreadBps({ direction, spot, strike, cap, fraction, referenceAgeSeconds });
          assert.ok(spreadBps >= BUYBACK_BASE_SPREAD_BPS - 1e-9, `spread ${spreadBps} fell below the base floor`);
          assert.ok(spreadBps <= BUYBACK_MAX_SPREAD_BPS + 1e-9, `spread ${spreadBps} exceeded the hard cap`);
        }
      }
    }
  }

  // At/near expiry and at/past the strike, with a fresh reference, the
  // spread approaches the tight floor.
  const tightest = dynamicSpreadBps({ direction: "up", spot: strike, strike, cap, fraction: 0, referenceAgeSeconds: 0 });
  assert.equal(tightest, BUYBACK_BASE_SPREAD_BPS);
  const nearTightest = dynamicSpreadBps({ direction: "up", spot: strike + 1, strike, cap, fraction: 0.01, referenceAgeSeconds: 0 });
  assert.ok(nearTightest - BUYBACK_BASE_SPREAD_BPS < 10, "near expiry and near-the-money must sit close to the floor");
});

test("the close-position flow reuses the audited session-wallet-only, message-hash-bound, strictly-inspected pattern", async () => {
  const [prepareRoute, sendRoute, closeLib, schema, migration, vsolLib, vsolServer, portfolio] = await Promise.all([
    readFile(new URL("app/api/vsol/close/prepare/route.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/close/send/route.ts", root), "utf8"),
    readFile(new URL("app/lib/vsol-close.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("drizzle/0007_shocking_titania.sql", root), "utf8"),
    readFile(new URL("app/lib/vsol.ts", root), "utf8"),
    readFile(new URL("app/lib/vsol-server.ts", root), "utf8"),
    readFile(new URL("app/components/PortfolioView.tsx", root), "utf8"),
  ]);

  // Auth: strict session-wallet only, no ChatGPT/localhost fallback -- this
  // moves the buyer's money, so it must not use the weaker `resolveUserKey`.
  assert.match(prepareRoute, /readSessionWallet/);
  assert.doesNotMatch(prepareRoute, /resolveUserKey/, "close/prepare requires the wallet session, not weaker fallbacks");
  assert.match(sendRoute, /readSessionWallet/);
  assert.doesNotMatch(sendRoute, /resolveUserKey/, "close/send requires the wallet session, not weaker fallbacks");
  assert.match(prepareRoute, /sameOrigin/);
  assert.match(sendRoute, /sameOrigin/);

  // Message-hash binding: the prepared intent's exact serialized message is
  // what gets simulated and sent, matching the launch/liquidity pattern.
  assert.match(prepareRoute, /transactionMessageHash|messageHash/);
  assert.match(sendRoute, /transactionMessageHash/);
  assert.match(sendRoute, /messageHash !== intent\.transactionMessageHash/);
  assert.match(sendRoute, /sigVerify: true/);
  assert.match(sendRoute, /verifySignatures/);

  // Strict instruction inspection: exact Ed25519 + program instruction pair,
  // discriminator, and account list, mirroring `inspectVsolFillTransaction`.
  assert.match(closeLib, /isVsolCloseTransaction/);
  assert.match(closeLib, /inspectVsolCloseTransaction/);
  assert.match(closeLib, /Ed25519Program\.programId/);
  assert.match(closeLib, /close_pool_position/);
  assert.match(closeLib, /CLOSE_POOL_POSITION_ACCOUNT_COUNT/);
  assert.match(sendRoute, /inspectVsolCloseTransaction/);
  assert.match(sendRoute, /The signed close instruction does not match the prepared intent/);

  // Buyback pricing must sit below fair value with the spread disclosed, and
  // the position must belong to the caller before anything is built.
  assert.match(closeLib, /buybackFor/);
  assert.match(closeLib, /This position does not belong to the signed-in wallet/);
  assert.match(closeLib, /VSOL_CLOSE_POSITION_DEPLOYED/);
  // volatility is no longer fed into buybackFor's pricing (it's already
  // priced into `premium` at inception) -- guard against reintroducing the
  // double-count bug via a realized-volatility fetch in the close flow.
  assert.doesNotMatch(closeLib, /getPythRealizedVolatility/, "the close flow must not re-derive volatility for pricing");

  // Fail-closed until the devnet program is redeployed with
  // close_pool_position: the manifest flag defaults to false/undefined.
  assert.match(vsolLib, /VSOL_CLOSE_POSITION_DEPLOYED/);
  assert.match(vsolLib, /closePoolPositionDeployed/);

  // Post-state reconciliation: the position must be gone and the buyer's
  // balance must have increased by exactly the quoted buyback amount.
  assert.match(sendRoute, /verifyPostState/);
  assert.match(sendRoute, /delta !== BigInt\(intent\.buybackAmountAtoms\)/);

  // Schema + migration stay in lockstep, mirroring `launch_actions`.
  assert.match(schema, /close_actions/);
  assert.match(migration, /CREATE TABLE `close_actions`/);
  assert.match(migration, /transaction_message_hash/);

  // UI discloses the spread and P\/L rather than hiding it, and counts down
  // to quote expiry before the user signs.
  assert.match(portfolio, /spread/i);
  assert.match(portfolio, /below fair value/i);
  // Signing goes through the Privy-backed wallet bridge (see
  // app/lib/wallet-bridge.tsx), not the legacy injected-wallet helper.
  assert.match(portfolio, /bridge\.signTransactionBase64/);
  assert.match(portfolio, /close\/prepare/);
  assert.match(portfolio, /close\/send/);

  // `decodeConfigAccount`/`decodeOracleAccount` are shared, published decoders
  // (not re-derived ad hoc) so the close flow reads onchain state the same
  // way the rest of the server does.
  assert.match(vsolServer, /export function decodeConfigAccount/);
  assert.match(vsolServer, /export function decodeOracleAccount/);
});


// Regression for the SECOND round-trip bug, found when the intraday ladder
// started solving in-the-money strikes. `buybackFor` used to value an open
// position as `intrinsic + premium * sqrt(timeLeft)`. For an ITM-struck quote
// `intrinsic` is already inside `premium`, so that sum double-counted it.
// Pinning only the fraction === 1 instant did NOT fix it: one second later the
// heuristic returned, and a 15M 2x bought for $250.00 closed for $427.37 --
// +$177 risk-free, repeatable, draining the pool. The fix re-prices the spread
// with the same Black-Scholes model that sold it, so this sweep must hold for
// EVERY tier (including the ITM ones), at every fraction of time remaining --
// not just at full time remaining, which is where the old test only looked.
// The invariant is about an IMMEDIATE round trip: no time elapsed, no price
// move. It is deliberately NOT "closing at unchanged spot loses at every time
// remaining" -- that stricter version is FALSE for a binary and, when it was
// asserted here, forced a blanket ceiling (buyback <= premium) that made a
// winning position impossible to close for profit: a buyer whose target had
// already been crossed, holding a position genuinely worth $150, could only
// exit at $97.50 on a $100 premium. An in-the-money digital has positive
// theta -- its value rises toward the payout as expiry nears -- and realising
// that gain after carrying real risk through real time is P/L, not arbitrage.
test("no IMMEDIATE fill-then-close round trip is profitable, for any tier, tenor, vol or direction", async () => {
  const { quoteFor, buybackFor, payoffTiersFor } = await import(new URL("app/lib/options.ts", root));

  const spot = 101.47;
  const amount = 500;
  const tenors = [["15M", 15], ["1H", 60], ["EOD", 720], ["7D", 10_080], ["30D", 43_200]];
  const failures = [];

  for (const volatility of [20, 60, 120]) {
    for (const [label, minutes] of tenors) {
      for (const payoff of payoffTiersFor(minutes)) {
        for (const direction of ["up", "down"]) {
          const quote = quoteFor({ spot, amount, durationMinutes: minutes, direction, payoff, volatility });
          // Spot UNCHANGED and effectively no time elapsed: any profit in
          // this window is pure pricing arbitrage, not P/L. (0.999 of a 15M
          // contract is ~0.9 seconds.)
          for (const fraction of [1, 0.9999, 0.999]) {
            const { buyback } = buybackFor({
              direction,
              spot,
              strike: quote.strike,
              cap: quote.cap,
              maxPayout: quote.maxPayout,
              premium: quote.premium,
              minutesRemaining: minutes * fraction,
              originalMinutes: minutes,
              volatility,
            });
            if (buyback >= quote.premium) {
              failures.push(
                `${label} ${payoff}x ${direction} vol=${volatility} f=${fraction}: paid ${quote.premium.toFixed(2)}, closed ${buyback.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
  }

  assert.deepEqual(failures, [], `profitable round trips found:\n${failures.join("\n")}`);
});


// The other half of the same invariant, pinned so the anti-arbitrage guard can
// never again be "fixed" by capping payouts at the premium: a position whose
// target has been crossed MUST be closeable for more than it cost. Without
// this, taking profit early is impossible and the close feature is a trap.
test("a winning binary can be closed for a real profit, and a losing one pays nothing", async () => {
  const { quoteFor, buybackFor, payoffTiersFor } = await import(new URL("app/lib/options.ts", root));

  const spot = 101.64;
  const volatility = 60;
  const minutes = 15;

  for (const payoff of payoffTiersFor(minutes)) {
    for (const direction of ["up", "down"]) {
      const quote = quoteFor({ spot, amount: 500, durationMinutes: minutes, direction, payoff, volatility });
      // Move spot decisively through the target, then close near expiry.
      const through = direction === "up" ? quote.strike * 1.01 : quote.strike * 0.99;
      const won = buybackFor({
        direction, spot: through, strike: quote.strike, cap: quote.cap, maxPayout: quote.maxPayout,
        premium: quote.premium, minutesRemaining: minutes * 0.1, originalMinutes: minutes, volatility,
      });
      assert.ok(
        won.buyback > quote.premium,
        `${payoff}x ${direction}: a crossed target must close above the $${quote.premium.toFixed(2)} premium, got $${won.buyback.toFixed(2)}`,
      );
      assert.ok(won.buyback < quote.maxPayout, "but never above the payout itself");

      // The mirror case: decisively on the wrong side, near expiry, pays ~nothing.
      const missed = direction === "up" ? quote.strike * 0.99 : quote.strike * 1.01;
      const lost = buybackFor({
        direction, spot: missed, strike: quote.strike, cap: quote.cap, maxPayout: quote.maxPayout,
        premium: quote.premium, minutesRemaining: minutes * 0.1, originalMinutes: minutes, volatility,
      });
      assert.ok(lost.buyback < quote.premium * 0.05, `${payoff}x ${direction}: a missed target must be near worthless`);
    }
  }
});
