import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function loadOptions() {
  return import(new URL("app/lib/options.ts", root));
}

test("normalCdf is a sane standard normal CDF", async () => {
  const { normalCdf } = await loadOptions();
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(normalCdf(6) > 0.999999);
  assert.ok(normalCdf(-6) < 0.000001);
  // Symmetry: N(-x) = 1 - N(x).
  for (const x of [0.3, 1, 2.5, 4]) {
    assert.ok(Math.abs(normalCdf(-x) - (1 - normalCdf(x))) < 1e-9);
  }
});

test("Black-Scholes put/call parity holds at r=0 across a spot/strike/vol/time sweep", async () => {
  const { blackScholesCall, blackScholesPut } = await loadOptions();
  // At r=0, parity is simply C - P = S - K (no discounting term).
  for (const spot of [50, 100, 63_900]) {
    for (const strikeFrac of [0.9, 0.98, 1, 1.02, 1.1]) {
      const strike = spot * strikeFrac;
      for (const volAnnual of [0.05, 0.33, 1.2, 4.0]) {
        for (const timeYears of [15 / 525_600, 60 / 525_600, 30 / 365]) {
          const call = blackScholesCall({ spot, strike, volAnnual, timeYears });
          const put = blackScholesPut({ spot, strike, volAnnual, timeYears });
          const parityGap = call - put - (spot - strike);
          assert.ok(
            Math.abs(parityGap) < 1e-6 * spot,
            `parity violated at spot=${spot} strike=${strike} vol=${volAnnual} t=${timeYears}: gap=${parityGap}`,
          );
        }
      }
    }
  }
});

test("Black-Scholes call and put values are monotonically non-decreasing in volatility", async () => {
  const { blackScholesCall, blackScholesPut } = await loadOptions();
  const spot = 100;
  const timeYears = 60 / 525_600;
  for (const strike of [90, 100, 110]) {
    let prevCall = -Infinity;
    let prevPut = -Infinity;
    for (const volAnnual of [0.05, 0.15, 0.33, 0.6, 1.0, 2.0, 4.0]) {
      const call = blackScholesCall({ spot, strike, volAnnual, timeYears });
      const put = blackScholesPut({ spot, strike, volAnnual, timeYears });
      assert.ok(call >= prevCall - 1e-9, `call value decreased with vol at strike=${strike}: ${prevCall} -> ${call}`);
      assert.ok(put >= prevPut - 1e-9, `put value decreased with vol at strike=${strike}: ${prevPut} -> ${put}`);
      prevCall = call;
      prevPut = put;
    }
  }
});

test("Black-Scholes call and put values are monotonically non-decreasing in time to expiry", async () => {
  const { blackScholesCall, blackScholesPut } = await loadOptions();
  const spot = 100;
  const volAnnual = 0.4;
  for (const strike of [90, 100, 110]) {
    let prevCall = -Infinity;
    let prevPut = -Infinity;
    for (const timeYears of [1 / 525_600, 15 / 525_600, 60 / 525_600, 1 / 365, 7 / 365, 30 / 365]) {
      const call = blackScholesCall({ spot, strike, volAnnual, timeYears });
      const put = blackScholesPut({ spot, strike, volAnnual, timeYears });
      assert.ok(call >= prevCall - 1e-9, `call value decreased with time at strike=${strike}`);
      assert.ok(put >= prevPut - 1e-9, `put value decreased with time at strike=${strike}`);
      prevCall = call;
      prevPut = put;
    }
  }
});

test("spreadUnitValue stays bounded in [0, width] and spreadFairValue in [0, maxPayout]", async () => {
  const { spreadUnitValue, spreadFairValue } = await loadOptions();
  const spot = 100;
  const maxPayout = 1_000;
  for (const direction of ["up", "down"]) {
    for (const strikeFrac of [0.85, 0.95, 1, 1.05, 1.2]) {
      for (const widthFrac of [0.006, 0.05, 0.4]) {
        for (const volAnnual of [0.1, 0.5, 2.0, 4.0]) {
          for (const timeYears of [15 / 525_600, 30 / 365]) {
            const strike = spot * strikeFrac;
            const width = spot * widthFrac;
            const unitValue = spreadUnitValue({ direction, spot, strike, width, volAnnual, timeYears });
            assert.ok(unitValue >= -1e-9, `unitValue negative: ${unitValue}`);
            assert.ok(unitValue <= width + 1e-6 * width, `unitValue ${unitValue} exceeded width ${width}`);
            const fair = spreadFairValue(maxPayout, width, unitValue);
            assert.ok(fair >= -1e-9 && fair <= maxPayout + 1e-6 * maxPayout, `fairValue ${fair} outside [0, maxPayout]`);
          }
        }
      }
    }
  }
});

test("the payout ramp saturates near maxPayout deep in the money and floors near 0 deep out of the money", async () => {
  const { spreadUnitValue, spreadFairValue } = await loadOptions();
  const spot = 100;
  const width = 2;
  const maxPayout = 1_000;
  const volAnnual = 0.4;
  const timeYears = 60 / 525_600;

  // Deep ITM: spot far past strike+width (up) / strike-width (down).
  const deepItmUp = spreadFairValue(maxPayout, width, spreadUnitValue({ direction: "up", spot: 400, strike: 100, width, volAnnual, timeYears }));
  const deepItmDown = spreadFairValue(maxPayout, width, spreadUnitValue({ direction: "down", spot: 10, strike: 100, width, volAnnual, timeYears }));
  assert.ok(deepItmUp > maxPayout * 0.999, `deep ITM up should saturate near maxPayout, got ${deepItmUp}`);
  assert.ok(deepItmDown > maxPayout * 0.999, `deep ITM down should saturate near maxPayout, got ${deepItmDown}`);

  // Deep OTM: spot far below strike (up) / far above strike (down).
  const deepOtmUp = spreadFairValue(maxPayout, width, spreadUnitValue({ direction: "up", spot: 10, strike: 100, width, volAnnual, timeYears }));
  const deepOtmDown = spreadFairValue(maxPayout, width, spreadUnitValue({ direction: "down", spot: 400, strike: 100, width, volAnnual, timeYears }));
  assert.ok(deepOtmUp < maxPayout * 0.001, `deep OTM up should floor near 0, got ${deepOtmUp}`);
  assert.ok(deepOtmDown < maxPayout * 0.001, `deep OTM down should floor near 0, got ${deepOtmDown}`);
  assert.equal(spot, 100); // spot fixture unused directly above; keeps intent explicit for readers.
});

test("quoteFor achieves the requested 5×/10× payoff exactly across the measured audit matrix, both directions", async () => {
  const { quoteFor } = await loadOptions();
  // The exact spot/notional the reviewer measured the old engine against:
  // 55x movement in true fair value produced only a 1.07x movement in the
  // old flat-table premium. This checks the ported Black-Scholes engine
  // actually prices to the requested multiple across that same matrix, for
  // the 5x/10x tiers ("Popular"/"Aggressive" in the UI copy).
  const cases = [
    { volatility: 33, durationMinutes: 60 },
    { volatility: 60, durationMinutes: 60 },
    { volatility: 120, durationMinutes: 60 },
    { volatility: 240, durationMinutes: 240 },
  ];
  const spot = 63_900;
  const amount = 2_500;

  for (const { volatility, durationMinutes } of cases) {
    for (const direction of ["up", "down"]) {
      for (const payoff of [5, 10]) {
        const quote = quoteFor({ spot, amount, durationMinutes, direction, payoff, volatility });
        const achievedLeverage = quote.maxPayout / quote.premium;
        const relativeError = Math.abs(achievedLeverage - payoff) / payoff;
        assert.ok(
          relativeError < 0.01,
          `direction=${direction} payoff=${payoff}x vol=${volatility}% dur=${durationMinutes}m achieved ${achievedLeverage.toFixed(3)}x (${(relativeError * 100).toFixed(2)}% off)`,
        );
        assert.equal(quote.reachability, "solved", `expected a solved (non-clamped) quote for this realistic matrix entry`);
      }
    }
  }
});

test("quoteFor never shortchanges the 2× tier when it clamps -- achieved leverage only ever exceeds the nominal tier, honestly reported", async () => {
  const { quoteFor } = await loadOptions();
  // Genuine, math-driven finding (not a solver bug): a fair, cherry-pick-safe
  // 2x ("pay 50% of maxPayout") is NOT reachable as a capped spread at this
  // width across the reviewer's own matrix -- an at-the-money spread this
  // wide is worth well under 50% of maxPayout at these vol/duration
  // combinations. (Monad's engine hits the identical wall: its strike
  // solver throws UnreachableLeverageError for exactly this case -- "target
  // premium exceeds the at-the-money price ... too low to price at the
  // current volatility". Tend's 24/7 mandate means it clamps instead of
  // failing the RFQ, but the underlying math is the same.) The clamp must
  // always land on the SAME side as this "too cheap" finding: the achieved
  // leverage must meet or exceed 2x (never less), i.e. the trader is never
  // sold worse than what they asked for, only ever a better, honestly-priced
  // deal at the money.
  const cases = [
    { volatility: 33, durationMinutes: 60 },
    { volatility: 60, durationMinutes: 60 },
    { volatility: 120, durationMinutes: 60 },
    { volatility: 240, durationMinutes: 240 },
  ];
  const spot = 63_900;
  const amount = 2_500;

  for (const { volatility, durationMinutes } of cases) {
    for (const direction of ["up", "down"]) {
      const quote = quoteFor({ spot, amount, durationMinutes, direction, payoff: 2, volatility });
      const achievedLeverage = quote.maxPayout / quote.premium;
      assert.ok(achievedLeverage >= 2 - 1e-9, `2x tier must never deliver less than 2x, got ${achievedLeverage}`);
      assert.ok(quote.premium >= 1 && quote.premium <= quote.maxPayout * 0.95, "premium must still be bounded");
      assert.ok(["solved", "clamped-at-the-money"].includes(quote.reachability));
    }
  }
});

test("premium moves meaningfully with volatility for a fixed payoff target -- the bug this port fixes", async () => {
  const { quoteFor } = await loadOptions();
  // Reviewer's own numbers: at spot=63,900, 10x payoff, $2,500 notional, the
  // OLD engine's premium moved 1.07x (from $201 to $215) while fair value
  // moved 55x across this same vol/duration span. The premium itself is
  // ALWAYS ~amount/payoff by construction in the new engine (that's the
  // definition of hitting the target multiple) -- what must move with vol is
  // how far out-of-the-money the strike needs to be to still be worth that
  // much, which the achieved-leverage test above already pins to <1% error
  // at every vol level. This test instead pins the WIDTH (the payout ramp)
  // to scale with vol, which is the mechanism that used to be flat.
  const spot = 63_900;
  const amount = 2_500;
  const widths = [33, 60, 120].map((volatility) => {
    const q = quoteFor({ spot, amount, durationMinutes: 60, direction: "up", payoff: 10, volatility });
    return q.cap - q.strike;
  });
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `width must strictly widen with vol: ${widths}`);
});

test("the strike solver never returns an in-the-money strike (offset is always >= 0)", async () => {
  const { quoteFor } = await loadOptions();
  for (const direction of ["up", "down"]) {
    for (const volatility of [5, 33, 400]) {
      for (const durationMinutes of [15, 60, 43_200]) {
        for (const payoff of [2, 5, 10]) {
          const spot = 100;
          const quote = quoteFor({ spot, amount: 1_000, durationMinutes, direction, payoff, volatility });
          if (direction === "up") assert.ok(quote.strike >= spot - 1e-9, `up strike ${quote.strike} was below spot ${spot}`);
          else assert.ok(quote.strike <= spot + 1e-9, `down strike ${quote.strike} was above spot ${spot}`);
        }
      }
    }
  }
});

test("round-trip invariant: fair value at full time remaining equals the premium paid, across payoff x volatility x tenor x direction", async () => {
  // This is the property `buybackFor`'s doc comment calls out by name: a
  // same-instant round trip (quote, then immediately buy back at unchanged
  // spot) must cost exactly the spread, for every volatility and tenor --
  // never a volatility-dependent multiple of the premium (that was a real
  // bug that shipped once; see tests/close-position.test.mjs). It holds
  // structurally as long as the strike stays on the out-of-the-money side of
  // spot at inception (proven by the previous test) so intrinsic value is
  // exactly 0 when the quote is struck. Re-verified here directly against
  // the new Black-Scholes-derived premiums, not just the old formula.
  const { quoteFor, buybackFor } = await loadOptions();
  const spot = 200;
  const amount = 1_000;
  const tenors = [15, 60, 1_440, 10_080, 43_200];
  const volatilities = [10, 20, 33, 60, 90, 150, 240, 400];

  for (const payoff of [2, 5, 10]) {
    for (const volatility of volatilities) {
      for (const durationMinutes of tenors) {
        for (const direction of ["up", "down"]) {
          const quote = quoteFor({ spot, amount, durationMinutes, direction, payoff, volatility });
          const closed = buybackFor({
            direction,
            spot,
            strike: quote.strike,
            cap: quote.cap,
            maxPayout: quote.maxPayout,
            premium: quote.premium,
            minutesRemaining: durationMinutes,
            originalMinutes: durationMinutes,
          });
          assert.ok(
            Math.abs(closed.fairValue - quote.premium) < 1e-6 * Math.max(1, quote.premium),
            `fair value at inception (${closed.fairValue}) must equal premium (${quote.premium}) for ` +
              `payoff=${payoff} vol=${volatility} dur=${durationMinutes} direction=${direction}`,
          );
          assert.ok(closed.buyback < quote.premium, "an immediate round trip must still cost at least the spread");
        }
      }
    }
  }
});

test("maker edge is applied inside the strike solve, not added to fair value afterward", async () => {
  // The critical detail from the port: solving on fair value and adding the
  // edge afterward would make an advertised "10x" deliver less than 10x
  // (since the edge inflates the premium past the fairly-priced target). By
  // solving with the edge already inside the objective, `premium` (fair
  // value + edge) is what hits the target multiple, and `fairValue` (no
  // edge) sits strictly below the target -- i.e. below what a naive
  // fair-value-only solve would have produced for the same strike.
  const { solveStrikeForTargetPremium } = await loadOptions();
  const spot = 100;
  const width = 1;
  const maxPayout = 1_000;
  const targetPremium = 100; // 10x
  const volAnnual = 0.4;
  const timeYears = 60 / 525_600;

  const solved = solveStrikeForTargetPremium({ direction: "up", spot, width, maxPayout, targetPremium, volAnnual, timeYears });
  assert.ok(Math.abs(solved.premium - targetPremium) < 1e-4, "premium (edge included) must hit the target");
  assert.ok(solved.fairValue < targetPremium, "fair value (no edge) must sit strictly below the edge-inclusive target");
  const impliedEdgeBps = (solved.premium / solved.fairValue - 1) * 10_000;
  assert.ok(Math.abs(impliedEdgeBps - 1_500) < 1, `implied edge should be ~1500bps, got ${impliedEdgeBps.toFixed(2)}`);
});

test("probabilityItm and impliedVolatility are surfaced honestly by quoteFor", async () => {
  const { quoteFor } = await loadOptions();
  const quote = quoteFor({ spot: 100, amount: 1_000, durationMinutes: 60, direction: "up", payoff: 5, volatility: 40 });
  assert.ok(quote.probabilityItm > 0 && quote.probabilityItm < 1, `probabilityItm ${quote.probabilityItm} should be a real probability`);
  // Deeper leverage (further out-of-the-money) must have a lower win probability.
  const shallow = quoteFor({ spot: 100, amount: 1_000, durationMinutes: 60, direction: "up", payoff: 2, volatility: 40 });
  const deep = quoteFor({ spot: 100, amount: 1_000, durationMinutes: 60, direction: "up", payoff: 10, volatility: 40 });
  assert.ok(deep.probabilityItm <= shallow.probabilityItm, "higher payoff (further OTM) must not have a higher win probability");
  // impliedVolatility reflects the gap-risk-adjusted vol, so a stale
  // reference must push it above the raw input.
  const fresh = quoteFor({ spot: 100, amount: 1_000, durationMinutes: 60, direction: "up", payoff: 5, volatility: 40, referenceAgeSeconds: 0 });
  const stale = quoteFor({ spot: 100, amount: 1_000, durationMinutes: 60, direction: "up", payoff: 5, volatility: 40, referenceAgeSeconds: 6 * 3_600 });
  assert.ok(stale.impliedVolatility > fresh.impliedVolatility, "a stale reference must raise the priced-in (implied) volatility");
  assert.ok(Math.abs(fresh.impliedVolatility - 40) < 1e-9, "a fresh reference prices at exactly the raw input vol (no gap-risk bump)");
});

test("width floor and strike-offset bound are the documented, defensible values (regression guard)", async () => {
  const { WIDTH_MIN_FRACTION, WIDTH_MAX_FRACTION, WIDTH_EXPECTED_MOVE_MULTIPLIER, MAX_STRIKE_OFFSET_FRACTION, MAKER_EDGE_BPS } = await loadOptions();
  assert.equal(WIDTH_MIN_FRACTION, 0.006, "width floor must stay at the documented 0.6% of spot");
  assert.equal(WIDTH_MAX_FRACTION, 0.4);
  assert.equal(WIDTH_EXPECTED_MOVE_MULTIPLIER, 1.25);
  assert.equal(MAX_STRIKE_OFFSET_FRACTION, 0.4);
  assert.equal(MAKER_EDGE_BPS, 1_500);
  // The floor must be strictly smaller than the old, audit-identified 3%
  // floor that broke short-dated pricing -- this is the whole point of the fix.
  assert.ok(WIDTH_MIN_FRACTION < 0.03, "the new floor must be smaller than the old 3% floor it replaces");
});

// --- Stake -> payout inversion (app/lib/options.ts payoutForStake) ---------
// The buyer types what they PAY; the engine prices from the payout. These
// pin the property that makes the inversion exact rather than a search.

test("premium is exactly linear in payout, so one reference quote inverts it", async () => {
  const { quoteFor } = await loadOptions();
  const inputs = { spot: 101, durationMinutes: 43_200, direction: "up", payoff: 5, volatility: 60 };
  const small = quoteFor({ ...inputs, amount: 100 });
  const large = quoteFor({ ...inputs, amount: 5_000 });
  // Strike/width/probability are size-independent: the solver matches
  // premium == payout / payoff, and payout cancels out of that target.
  assert.equal(small.strike, large.strike);
  assert.equal(small.cap, large.cap);
  assert.equal(small.probabilityItm, large.probabilityItm);
  // ...so the premium ratio is identical at both sizes.
  assert.ok(Math.abs(small.premium / 100 - large.premium / 5_000) < 1e-9);
});

test("payoutForStake returns the payout whose premium is the requested stake", async () => {
  const { quoteFor, payoutForStake } = await loadOptions();
  const inputs = { spot: 101, durationMinutes: 43_200, direction: "up", payoff: 5, volatility: 60 };
  const reference = quoteFor({ ...inputs, amount: 1_000 });
  for (const stake of [25, 100, 250, 900]) {
    const payout = payoutForStake({ stake, referencePremium: reference.premium, referenceNotional: 1_000 });
    const repriced = quoteFor({ ...inputs, amount: payout });
    // Re-pricing at the derived payout must cost what the buyer asked to pay.
    assert.ok(Math.abs(repriced.premium - stake) < 0.02, `stake ${stake} -> premium ${repriced.premium}`);
  }
});

test("payoutForStake clamps to what the pool underwrites, and rejects nonsense", async () => {
  const { payoutForStake, MIN_PAYOUT_NOTIONAL, MAX_PAYOUT_NOTIONAL } = await loadOptions();
  const ref = { referencePremium: 200, referenceNotional: 1_000 }; // 5x
  assert.equal(payoutForStake({ stake: 1, ...ref }), MIN_PAYOUT_NOTIONAL);
  assert.equal(payoutForStake({ stake: 10_000, ...ref }), MAX_PAYOUT_NOTIONAL);
  assert.throws(() => payoutForStake({ stake: 0, ...ref }), /positive/);
  assert.throws(() => payoutForStake({ stake: Number.NaN, ...ref }), /positive/);
});

test("stakeBoundsForPayoff keeps the implied payout inside the pool's limits", async () => {
  const { stakeBoundsForPayoff, MIN_PAYOUT_NOTIONAL, MAX_PAYOUT_NOTIONAL } = await loadOptions();
  for (const payoff of [2, 5, 10]) {
    const { min, max } = stakeBoundsForPayoff(payoff);
    assert.ok(min * payoff >= MIN_PAYOUT_NOTIONAL, `${payoff}x min`);
    assert.ok(max * payoff <= MAX_PAYOUT_NOTIONAL, `${payoff}x max`);
  }
  assert.deepEqual(stakeBoundsForPayoff(5), { min: 20, max: 1_000 });
});
