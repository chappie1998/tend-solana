import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("buybackFor prices an early close strictly below fair value with the expected spread and decay shape", async () => {
  const { buybackFor, definedRiskPayout, BUYBACK_SPREAD_BPS, BUYBACK_BASE_SPREAD_BPS, BUYBACK_MAX_SPREAD_BPS } =
    await import(new URL("app/lib/options.ts", root));

  assert.equal(BUYBACK_SPREAD_BPS, 250);
  assert.equal(BUYBACK_BASE_SPREAD_BPS, 250);
  assert.ok(BUYBACK_MAX_SPREAD_BPS > BUYBACK_BASE_SPREAD_BPS);

  const base = {
    direction: "up",
    spot: 210,
    strike: 200,
    cap: 220,
    maxPayout: 1_000,
    premium: 150,
    originalMinutes: 10_080,
  };

  // At expiry (minutesRemaining -> 0), fair value collapses to intrinsic and
  // the buyback is intrinsic minus the spread -- no time value survives.
  const atExpiry = buybackFor({ ...base, minutesRemaining: 0 });
  const intrinsic = definedRiskPayout({ direction: base.direction, settlement: base.spot, strike: base.strike, cap: base.cap, maxPayout: base.maxPayout });
  assert.ok(Math.abs(atExpiry.fairValue - intrinsic) < 1e-9, "fair value at expiry equals intrinsic");
  assert.ok(Math.abs(atExpiry.buyback - intrinsic * (1 - atExpiry.spreadBps / 10_000)) < 1e-9);
  assert.equal(atExpiry.spreadBps, BUYBACK_SPREAD_BPS, "no gap-risk widening with a fresh reference");

  // Monotonic decay: less time remaining never increases fair value.
  const far = buybackFor({ ...base, minutesRemaining: 5_000 });
  const mid = buybackFor({ ...base, minutesRemaining: 2_000 });
  const near = buybackFor({ ...base, minutesRemaining: 200 });
  assert.ok(far.fairValue >= mid.fairValue, "fair value decays as time remaining shrinks");
  assert.ok(mid.fairValue >= near.fairValue, "fair value decays as time remaining shrinks");
  assert.ok(near.fairValue >= atExpiry.fairValue, "expiry has the least fair value");
  assert.ok(far.buyback >= mid.buyback && mid.buyback >= near.buyback, "buyback decays alongside fair value");

  // The buyback is always strictly below fair value whenever fair value is positive.
  for (const quote of [far, mid, near]) {
    assert.ok(quote.fairValue > 0);
    assert.ok(quote.buyback < quote.fairValue, "buyback must sit strictly below fair value");
  }

  // At full time remaining with the strike struck away from spot (intrinsic
  // zero -- unlike `base` above, whose spot is already past its strike),
  // fair value must be anchored to exactly the premium paid, not a
  // volatility-inflated multiple of it. This is the core anti-arbitrage
  // property: time value is `premium * decay`, never `premium * decay * X` for X > 1.
  const otm = { direction: "up", spot: 200, strike: 210, cap: 230, maxPayout: 1_000, premium: 150, originalMinutes: 10_080 };
  const atInception = buybackFor({ ...otm, minutesRemaining: otm.originalMinutes });
  assert.ok(Math.abs(atInception.fairValue - otm.premium) < 1e-9, "fair value at inception equals the premium paid, not a multiple of it");
  assert.ok(atInception.buyback < otm.premium, "an immediate round trip always costs at least the spread");

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
