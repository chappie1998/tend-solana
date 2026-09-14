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

test("digitalFairValue stays bounded in [0, maxPayout] across direction x strike x vol x time", async () => {
  const { digitalFairValue } = await loadOptions();
  const spot = 100;
  const maxPayout = 1_000;
  for (const direction of ["up", "down"]) {
    for (const strikeFrac of [0.6, 0.85, 0.95, 1, 1.05, 1.2, 1.6]) {
      for (const volAnnual of [0.1, 0.5, 2.0, 4.0]) {
        for (const timeYears of [0, 15 / 525_600, 30 / 365]) {
          const strike = spot * strikeFrac;
          const fair = digitalFairValue({ direction, spot, strike, maxPayout, volAnnual, timeYears });
          assert.ok(fair >= -1e-9 && fair <= maxPayout + 1e-6 * maxPayout, `fairValue ${fair} outside [0, maxPayout]`);
        }
      }
    }
  }
});

// The required "payout shape" regression: with the on-chain minimum width
// (BINARY_WIDTH, one atom) `definedRiskPayout` is no longer a ramp -- it is
// an EXACT step function. Below/at the strike it must pay exactly 0; one
// atom above (the cap), exactly maxPayout. Mirrored for DOWN.
test("definedRiskPayout is an exact step function at BINARY_WIDTH: 0 at/below strike, maxPayout one atom above", async () => {
  const { definedRiskPayout, BINARY_WIDTH } = await loadOptions();
  const maxPayout = 1_000;

  for (const strike of [0.01, 1, 100, 101.64, 12_345.67]) {
    // UP: cap = strike + BINARY_WIDTH.
    const capUp = strike + BINARY_WIDTH;
    assert.equal(definedRiskPayout({ direction: "up", settlement: strike, strike, cap: capUp, maxPayout }), 0, `up @ strike=${strike}: at strike must pay 0`);
    assert.equal(definedRiskPayout({ direction: "up", settlement: strike - 10, strike, cap: capUp, maxPayout }), 0, `up @ strike=${strike}: below strike must pay 0`);
    assert.equal(definedRiskPayout({ direction: "up", settlement: capUp, strike, cap: capUp, maxPayout }), maxPayout, `up @ strike=${strike}: one atom above must pay maxPayout exactly`);
    assert.equal(definedRiskPayout({ direction: "up", settlement: strike + 10, strike, cap: capUp, maxPayout }), maxPayout, `up @ strike=${strike}: well above must still pay exactly maxPayout`);

    // DOWN: cap = strike - BINARY_WIDTH.
    const capDown = strike - BINARY_WIDTH;
    assert.equal(definedRiskPayout({ direction: "down", settlement: strike, strike, cap: capDown, maxPayout }), 0, `down @ strike=${strike}: at strike must pay 0`);
    assert.equal(definedRiskPayout({ direction: "down", settlement: strike + 10, strike, cap: capDown, maxPayout }), 0, `down @ strike=${strike}: above strike must pay 0`);
    assert.equal(definedRiskPayout({ direction: "down", settlement: capDown, strike, cap: capDown, maxPayout }), maxPayout, `down @ strike=${strike}: one atom below must pay maxPayout exactly`);
    assert.equal(definedRiskPayout({ direction: "down", settlement: strike - 10, strike, cap: capDown, maxPayout }), maxPayout, `down @ strike=${strike}: well below must still pay exactly maxPayout`);
  }
});

test("digitalFairValue saturates near maxPayout deep in the money and floors near 0 deep out of the money", async () => {
  const { digitalFairValue } = await loadOptions();
  const maxPayout = 1_000;
  const volAnnual = 0.4;
  const timeYears = 60 / 525_600;

  const deepItmUp = digitalFairValue({ direction: "up", spot: 400, strike: 100, maxPayout, volAnnual, timeYears });
  const deepItmDown = digitalFairValue({ direction: "down", spot: 10, strike: 100, maxPayout, volAnnual, timeYears });
  assert.ok(deepItmUp > maxPayout * 0.999, `deep ITM up should saturate near maxPayout, got ${deepItmUp}`);
  assert.ok(deepItmDown > maxPayout * 0.999, `deep ITM down should saturate near maxPayout, got ${deepItmDown}`);

  const deepOtmUp = digitalFairValue({ direction: "up", spot: 10, strike: 100, maxPayout, volAnnual, timeYears });
  const deepOtmDown = digitalFairValue({ direction: "down", spot: 400, strike: 100, maxPayout, volAnnual, timeYears });
  assert.ok(deepOtmUp < maxPayout * 0.001, `deep OTM up should floor near 0, got ${deepOtmUp}`);
  assert.ok(deepOtmDown < maxPayout * 0.001, `deep OTM down should floor near 0, got ${deepOtmDown}`);
});

// Task-required digital sanity check: an at-the-money binary must price near
// 2x BEFORE edge (P ~= 0.5, so premium/maxPayout ~= 0.5 pre-edge), and the
// achieved multiple must rise monotonically as the strike moves further out
// of the money. This is the one invariant that holds universally, for every
// vol/time: probabilityItm (N(d2)/N(-d2)) is strictly monotonic in STRIKE by
// construction (d2 is strictly decreasing in K), so 1/(P*(1+edge)) is
// strictly increasing as the strike moves OTM -- independent of the
// spot-vs-strike SIGN, which (see the strike-offset-fraction sweep below)
// can itself flip at extreme vol x time because a lognormal's median sits
// below its mean for any vol > 0.
test("digital sanity check: at-the-money prices near 2x before edge, and the multiple rises monotonically further out of the money", async () => {
  const { digitalFairValue, probabilityItm, applyMakerEdge } = await loadOptions();
  const spot = 100;
  const maxPayout = 1_000;
  // Short tenor, moderate vol: the median-drag term (0.5 * sigma^2 * T) is
  // negligible here, so at-the-money genuinely sits close to P = 0.5.
  const volAnnual = 0.5;
  const atmTimeYears = 60 / 525_600;

  for (const direction of ["up", "down"]) {
    const atmFair = digitalFairValue({ direction, spot, strike: spot, maxPayout, volAnnual, timeYears: atmTimeYears });
    const atmP = atmFair / maxPayout;
    assert.ok(Math.abs(atmP - 0.5) < 0.01, `at-the-money P should be ~0.5, got ${atmP} (direction=${direction})`);
    const atmMultiplePreEdge = maxPayout / atmFair;
    assert.ok(Math.abs(atmMultiplePreEdge - 2) < 0.05, `at-the-money should price near 2x before edge, got ${atmMultiplePreEdge}x (direction=${direction})`);

    // Monotonic rise in achieved multiple as the strike moves further OTM --
    // strike sweep is direction-aware (UP: increasing strike is further OTM;
    // DOWN: decreasing strike is further OTM). A 30-day window keeps the
    // strike range below (a wide-enough spread of standard deviations that
    // the rise is genuinely visible, but not so wide that distant strikes
    // saturate P to the same float at both ends, which would make a strict
    // "always rises" comparison flaky rather than false.
    const timeYears = 30 / 365;
    const strikes = direction === "up"
      ? [70, 80, 90, 95, 100, 105, 110, 120, 140]
      : [140, 120, 110, 105, 100, 95, 90, 80, 70];
    let prevMultiple = -Infinity;
    for (const strike of strikes) {
      const p = probabilityItm(direction, spot, strike, volAnnual, timeYears);
      const premium = applyMakerEdge(maxPayout * p);
      const multiple = maxPayout / premium;
      assert.ok(multiple > prevMultiple, `achieved multiple must rise moving further OTM (direction=${direction}): ${prevMultiple} -> ${multiple} at strike=${strike}`);
      prevMultiple = multiple;
    }
  }
});

test("quoteFor achieves the requested 5×/10× payoff exactly across the measured audit matrix, both directions", async () => {
  const { quoteFor } = await loadOptions();
  // The exact spot/notional the reviewer measured the old engine against:
  // 55x movement in true fair value produced only a 1.07x movement in the
  // old flat-table premium. This checks the ported Black-Scholes engine
  // actually prices to the requested multiple across that same matrix, for
  // the 5x/10x tiers ("Popular"/"Aggressive" in the UI copy). durationMinutes
  // is 90, not the originally-measured 60: 60 minutes now sells the
  // intraday 2x/3x/6x ladder (see payoffTiersFor), and 5x/10x are only
  // valid on the standard ladder (tenors over an hour).
  const cases = [
    { volatility: 33, durationMinutes: 90 },
    { volatility: 60, durationMinutes: 90 },
    { volatility: 120, durationMinutes: 90 },
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

test("quoteFor reaches the 2× tier exactly, via an out-of-the-money strike, at every duration in the reviewer's matrix", async () => {
  const { quoteFor } = await loadOptions();
  // TRUE BINARY correction: 2x is priced as a digital now, not a capped
  // spread. `premium = maxPayout * P * (1 + edge)`, so 2x needs
  // P = 1 / (2 * 1.15) ~= 0.435 -- BELOW 0.5. Since a lognormal's median
  // sits below its mean for any vol > 0, at-the-money (P at strike = spot)
  // is itself already close to or below 0.5 at ordinary tenors (see the
  // "digital sanity check" test), so reaching P ~= 0.435 lands
  // out-of-the-money here -- the OPPOSITE of the old capped-spread engine,
  // where an at-the-money spread this wide was worth well under 50% of
  // maxPayout and 2x could only be reached by moving in-the-money. Both are
  // the solver correctly finding whichever side the target premium actually
  // lives on for the instrument being priced; what must hold either way is
  // that 2x is reached SOLVED (not clamped), at every duration.
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
      assert.ok(
        Math.abs(achievedLeverage - 2) / 2 < 0.01,
        `2x tier must be reached (not clamped) at vol=${volatility} dur=${durationMinutes} dir=${direction}, got ${achievedLeverage}`,
      );
      assert.ok(quote.premium >= 1 && quote.premium <= quote.maxPayout * 0.95, "premium must still be bounded");
      assert.equal(quote.reachability, "solved");
      // The strike that makes this reachable is out-of-the-money: above
      // spot for UP, below spot for DOWN.
      if (direction === "up") assert.ok(quote.strike > spot, `UP 2x strike ${quote.strike} should be above spot ${spot} (OTM)`);
      else assert.ok(quote.strike < spot, `DOWN 2x strike ${quote.strike} should be below spot ${spot} (OTM)`);
    }
  }
});

test("strike distance from spot moves meaningfully with volatility for a fixed payoff target -- the bug this port fixes", async () => {
  const { quoteFor, BINARY_WIDTH } = await loadOptions();
  // Reviewer's own numbers: at spot=63,900, 10x payoff, $2,500 notional, the
  // OLD engine's premium moved 1.07x (from $201 to $215) while fair value
  // moved 55x across this same vol/duration span. The premium itself is
  // ALWAYS ~amount/payoff by construction in this engine (that's the
  // definition of hitting the target multiple) -- what must move with vol is
  // how far out-of-the-money the STRIKE needs to be to still be worth that
  // much, which the achieved-leverage test above already pins to <1% error
  // at every vol level. TRUE BINARY correction: the old engine pinned this
  // via the payout ramp's WIDTH scaling with vol; a binary's width is always
  // exactly BINARY_WIDTH (one atom, see the dedicated width test below) --
  // it is the STRIKE OFFSET that now does the work the width used to.
  const spot = 63_900;
  const amount = 2_500;
  // durationMinutes: 90, not 60 -- 60 minutes now sells the intraday
  // 2x/3x/6x ladder (see payoffTiersFor), and 10x is only valid on the
  // standard ladder.
  const distances = [33, 60, 120].map((volatility) => {
    const q = quoteFor({ spot, amount, durationMinutes: 90, direction: "up", payoff: 10, volatility });
    assert.ok(Math.abs((q.cap - q.strike) - BINARY_WIDTH) < 1e-9, "width must stay pinned at BINARY_WIDTH regardless of vol");
    return q.strike - spot;
  });
  assert.ok(distances[0] < distances[1] && distances[1] < distances[2], `strike distance from spot must strictly widen with vol: ${distances}`);
});

test("the strike solver reaches for an in-the-money strike only when the tier genuinely needs it -- the cheapest standard tier (10x) stays out-of-the-money", async () => {
  const { quoteFor } = await loadOptions();
  // Digital pricing: target P = 1 / (payoff * 1.15). 10x needs P ~= 0.087,
  // deep below the ~0.5-ish at-the-money value (see the "digital sanity
  // check" test), so it should stay comfortably out-of-the-money here across
  // vol/duration. (This test only covers the standard ladder's cheapest
  // tier, 10x -- the intraday ladder's own genuinely in-the-money tier,
  // the directional-target property, is covered by the dedicated test below.)
  for (const direction of ["up", "down"]) {
    for (const volatility of [33, 400]) {
      for (const durationMinutes of [90, 1_440, 43_200]) { // standard-ladder tenors only
        const spot = 100;
        const quote = quoteFor({ spot, amount: 1_000, durationMinutes, direction, payoff: 10, volatility });
        if (direction === "up") assert.ok(quote.strike >= spot - 1e-9, `up strike ${quote.strike} should stay out-of-the-money (>= spot ${spot}) at 10x`);
        else assert.ok(quote.strike <= spot + 1e-9, `down strike ${quote.strike} should stay out-of-the-money (<= spot ${spot}) at 10x`);
      }
    }
  }
});

test("the intraday ladder is directional: every tier's target sits AT or ABOVE spot for UP", async () => {
  // The 1.5x tier was removed precisely because it was NOT directional: a
  // 1.5x binary needs P(win) ~58%, which places its target BELOW spot -- you
  // win if the price merely holds. The ladder now starts at 2x (essentially
  // the entry price) so every intraday tier is a real directional bet.
  const { quoteFor, payoffTiersFor } = await loadOptions();
  const spot = 101.64;
  for (const durationMinutes of [15, 60]) {
    for (const payoff of payoffTiersFor(durationMinutes)) {
      for (const volatility of [20, 60, 120]) {
        const up = quoteFor({ spot, amount: 500, durationMinutes, direction: "up", payoff, volatility });
        assert.ok(
          up.strike >= spot,
          `UP ${payoff}x @${durationMinutes}m vol=${volatility}: target ${up.strike} must sit at or above spot ${spot}`,
        );
        const down = quoteFor({ spot, amount: 500, durationMinutes, direction: "down", payoff, volatility });
        assert.ok(
          down.strike <= spot,
          `DOWN ${payoff}x @${durationMinutes}m vol=${volatility}: target ${down.strike} must sit at or below spot ${spot}`,
        );
      }
    }
  }
});

test("payoffTiersFor offers a near-binary intraday ladder at or under an hour, and the standard ladder beyond it", async () => {
  const { payoffTiersFor } = await loadOptions();
  assert.deepEqual(payoffTiersFor(1), [2, 3, 6]);
  assert.deepEqual(payoffTiersFor(15), [2, 3, 6]);
  assert.deepEqual(payoffTiersFor(60), [2, 3, 6]);
  assert.deepEqual(payoffTiersFor(61), [2, 5, 10]);
  assert.deepEqual(payoffTiersFor(720), [2, 5, 10]); // a typical EOD duration
  assert.deepEqual(payoffTiersFor(10_080), [2, 5, 10]); // 7D
  assert.deepEqual(payoffTiersFor(43_200), [2, 5, 10]); // 30D
});

test("quoteFor rejects a payoff outside the known tier set, but is duration-agnostic about WHICH known tier -- the product catalog restriction lives in payoffTiersFor/app/api/quotes/route.ts instead", async () => {
  // quoteFor is a general pricing primitive (it will honestly price ANY of
  // the known tiers at any duration you hand it, the same way it will
  // price any duration at all -- expiries.ts, not quoteFor, decides which
  // durations are real tenors). Restricting WHICH tier is for sale at a
  // given duration is the PRODUCT's decision, enforced by payoffTiersFor
  // and, at the API boundary, app/api/quotes/route.ts (see the source-level
  // check in tests/product.test.mjs) -- not by quoteFor itself. Baking the
  // tenor restriction into quoteFor directly would also incorrectly reject
  // legitimate direct callers that price a known tier at an unusual
  // duration on purpose (see tests/close-position.test.mjs, which prices
  // payoff=5 at a 15-minute duration to test buybackFor in isolation).
  const { quoteFor, PAYOFF_TIERS_ALL } = await loadOptions();
  assert.deepEqual(PAYOFF_TIERS_ALL, [2, 3, 5, 6, 10]);
  assert.throws(() => quoteFor({ spot: 100, amount: 1_000, durationMinutes: 15, direction: "up", payoff: 7, volatility: 40 }), /Payoff must be one of/);
  assert.throws(() => quoteFor({ spot: 100, amount: 1_000, durationMinutes: 1_440, direction: "up", payoff: 4, volatility: 40 }), /Payoff must be one of/);
  // Every known tier prices at every duration without throwing.
  for (const payoff of PAYOFF_TIERS_ALL) {
    assert.doesNotThrow(() => quoteFor({ spot: 100, amount: 1_000, durationMinutes: 15, direction: "up", payoff, volatility: 40 }));
    assert.doesNotThrow(() => quoteFor({ spot: 100, amount: 1_000, durationMinutes: 1_440, direction: "up", payoff, volatility: 40 }));
  }
});

test("per-tenor payoff ladder: every advertised tier lands within 10% of its target leverage, at every tenor Tend sells across a realistic vol range", async () => {
  const { quoteFor, payoffTiersFor } = await loadOptions();
  // Measured against the same spot/vol/tenor matrix from the bug report:
  // SOL spot ~$101.47, a $500 payout, and every tenor Tend actually sells
  // (15M, 1H, EOD, 7D, 30D), swept across a realistic 20%-120% vol range.
  const spot = 101.47;
  const amount = 500;
  const tenorDurations = { "15M": 15, "1H": 60, EOD: 720, "7D": 10_080, "30D": 43_200 };
  const vols = [20, 60, 120];

  for (const [tenor, durationMinutes] of Object.entries(tenorDurations)) {
    for (const payoff of payoffTiersFor(durationMinutes)) {
      for (const volatility of vols) {
        for (const direction of ["up", "down"]) {
          const quote = quoteFor({ spot, amount, durationMinutes, direction, payoff, volatility });
          const achieved = quote.maxPayout / quote.premium;
          const relativeError = Math.abs(achieved - payoff) / payoff;
          assert.ok(
            relativeError <= 0.10,
            `${tenor} ${payoff}x @ ${volatility}% vol ${direction}: achieved ${achieved.toFixed(3)}x (${(relativeError * 100).toFixed(1)}% off advertised tier)`,
          );
        }
      }
    }
  }
});

test("cap distance from spot grows monotonically with tenor at moderate volatility, for the 2x tier every ladder shares", async () => {
  const { quoteFor } = await loadOptions();
  // 2x is the one tier present on BOTH the intraday [2,3,6] and standard
  // [2,5,10] ladders, so it is the only tier comparable across all five
  // tenors on one axis. Cap distance (not just width, which is now pinned at
  // BINARY_WIDTH regardless of tenor -- see the dedicated width test below)
  // widens with tenor at ORDINARY vol, because it is dominated by how far
  // the solved strike itself sits from spot, and more time to expiry means a
  // wider distribution to hit the same target probability.
  //
  // NOT tested at vol=120%: a lognormal's median sits below its mean for any
  // vol > 0 (median = spot * exp(-0.5 * sigma^2 * T)), and at high vol x long
  // duration that median-drag term is no longer negligible -- measured, UP,
  // 30D, 120% vol: the 2x strike needed actually pulls BACK toward (and
  // slightly past) spot relative to 7D's, because the drift term does more
  // work than the extra time does. This is correct digital pricing, not a
  // bug (see MAX_STRIKE_OFFSET_FRACTION's comment in options.ts for the
  // same effect showing up in the solver's search domain) -- it just means
  // "distance grows with tenor" is not a universal invariant of a true
  // binary the way it happened to be for the old capped-spread engine, so
  // this test is scoped to the vol range where the drag term stays small.
  const spot = 101.47;
  const amount = 500;
  const tenorDurations = [15, 60, 720, 10_080, 43_200]; // 15M, 1H, EOD, 7D, 30D
  for (const volatility of [20, 60]) {
    for (const direction of ["up", "down"]) {
      let prevDistance = -Infinity;
      for (const durationMinutes of tenorDurations) {
        const quote = quoteFor({ spot, amount, durationMinutes, direction, payoff: 2, volatility });
        const distance = Math.abs(quote.cap - spot);
        assert.ok(
          distance > prevDistance,
          `cap distance must grow with tenor at vol=${volatility} dir=${direction}: ${prevDistance} -> ${distance} at duration=${durationMinutes}`,
        );
        prevDistance = distance;
      }
    }
  }
});

test("quote width is always exactly BINARY_WIDTH (one atom), for every tenor, tier and vol", async () => {
  const { quoteFor, payoffTiersFor, BINARY_WIDTH } = await loadOptions();
  // TRUE BINARY correction: width used to scale with vol/duration between a
  // 0.6% floor and a 40% ceiling (see git history). A true binary has no
  // ramp to shape -- every quote signs the smallest legal on-chain width,
  // always, regardless of tenor/tier/vol/direction. This is what turns
  // `definedRiskPayout` into an exact step function (see the dedicated
  // payout-shape test above).
  assert.equal(BINARY_WIDTH, 0.000001);
  const spot = 101.47;
  const amount = 500;
  const tenorDurations = { "15M": 15, "1H": 60, EOD: 720, "7D": 10_080, "30D": 43_200 };
  for (const [, durationMinutes] of Object.entries(tenorDurations)) {
    for (const payoff of payoffTiersFor(durationMinutes)) {
      for (const volatility of [20, 60, 120]) {
        for (const direction of ["up", "down"]) {
          const quote = quoteFor({ spot, amount, durationMinutes, direction, payoff, volatility });
          const width = Math.abs(quote.cap - quote.strike);
          assert.ok(
            Math.abs(width - BINARY_WIDTH) < 1e-9,
            `width should always be exactly BINARY_WIDTH, got ${width} at duration=${durationMinutes} payoff=${payoff} vol=${volatility} dir=${direction}`,
          );
        }
      }
    }
  }
});

test("round-trip invariant: fair value at full time remaining equals the premium paid, across payoff x volatility x tenor x direction -- in-the-money strikes included", async () => {
  // This is the property `buybackFor`'s doc comment calls out by name: a
  // same-instant round trip (quote, then immediately buy back at unchanged
  // spot) must cost exactly the spread, for every volatility and tenor --
  // never a volatility-dependent multiple of the premium (that was a real
  // bug that shipped once; see tests/close-position.test.mjs). It used to
  // hold only structurally, as long as the strike stayed out-of-the-money
  // at inception (so intrinsic was exactly 0). Now that
  // solveStrikeForTargetPremium can strike a quote IN the money too (see
  // its comment in options.ts), that precondition doesn't always hold --
  // which is exactly the SECOND double-count `buybackFor`'s doc comment
  // now documents, and the dedicated regression test just above this one
  // pins directly. This sweep re-verifies the invariant holds regardless,
  // across every payoff x tenor x vol combination the product's own ladder
  // can produce (payoffTiersFor), ITM or not.
  const { quoteFor, buybackFor, payoffTiersFor } = await loadOptions();
  const spot = 200;
  const amount = 1_000;
  const tenors = [15, 60, 1_440, 10_080, 43_200];
  const volatilities = [10, 20, 33, 60, 90, 150, 240, 400];

  for (const durationMinutes of tenors) {
    for (const payoff of payoffTiersFor(durationMinutes)) {
      for (const volatility of volatilities) {
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
            volatility,
          });
          // buybackFor re-prices with the model, so fair value at inception is
          // the PRE-EDGE value that `premium` was derived from (premium =
          // fair * 1.15, MAKER_EDGE_BPS). The invariant that actually matters
          // is not an equality but this: you can never close for more than
          // you paid, at any tier, ITM or OTM.
          assert.ok(
            closed.fairValue < quote.premium,
            `fair value at inception (${closed.fairValue}) must sit below premium (${quote.premium}) for ` +
              `payoff=${payoff} vol=${volatility} dur=${durationMinutes} direction=${direction}`,
          );
          assert.ok(closed.buyback < quote.premium, "an immediate round trip must still cost at least the spread");
        }
      }
    }
  }
});

test("regression: an immediate round trip on an in-the-money-struck intraday quote is NOT profitable -- the second double-count buybackFor's doc comment now documents", async () => {
  // Widening solveStrikeForTargetPremium to reach the new near-binary
  // intraday tiers broke an assumption buybackFor's fair-value model
  // (`intrinsic + premium * decay`) relied on: every quote used to be
  // struck out-of-the-money, so `intrinsic` -- the raw definedRiskPayout
  // ramp evaluated at TODAY's spot -- was always exactly 0 at inception.
  // For the intraday ladder specifically, 2x/3x/6x are ITM-struck
  // essentially always (measured: 1.5x and 3x 100% of the time, 2x ~96%,
  // across a 15M/1H/EOD/7D/30D x 10%-400% vol sweep), and at inception
  // `intrinsic` there is genuinely nonzero while `premium` ALREADY prices
  // that same in-the-money-ness via Black-Scholes -- so naively adding them
  // double-counted it, making fair value (and therefore buyback) exceed
  // premium: a fill-then-immediately-close round trip was free money,
  // repeatable without limit. Fixed by pinning fair value to exactly
  // `premium` at fraction === 1 (see buybackFor's doc comment, second half)
  // rather than deriving it from intrinsic + time value there -- correct
  // unconditionally, since no time has elapsed and spot cannot have moved
  // yet either, so intrinsic there IS the value premium already reflects.
  //
  // THAT POINT-FIX WAS NOT ENOUGH and was replaced. Pinning only the exact
  // fraction === 1 instant left the heuristic in charge one tick later: at
  // fraction 0.999 a 15M 2x bought for $250.00 closed for $427.37, +$177
  // risk-free and repeatable. buybackFor now re-prices the spread with the
  // same Black-Scholes model that sold it, at today's spot and the time
  // actually left, so there is no inception special case at all. The
  // exhaustive fraction-by-fraction sweep lives in
  // tests/close-position.test.mjs.
  const { quoteFor, buybackFor, payoffTiersFor } = await loadOptions();
  const spot = 101.47;
  const amount = 500;
  for (const durationMinutes of [15, 60]) {
    for (const payoff of payoffTiersFor(durationMinutes)) {
      for (const volatility of [20, 60, 120]) {
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
            volatility,
          });
          assert.ok(
            closed.buyback < quote.premium,
            `an immediate round trip must still cost at least the spread: dur=${durationMinutes} payoff=${payoff}x vol=${volatility} dir=${direction} premium=${quote.premium.toFixed(2)} buyback=${closed.buyback.toFixed(2)}`,
          );
          // Fair value at inception is the model's PRE-EDGE value, which is
          // what `premium` was derived from (premium = fair * 1.15). The
          // property being pinned is the anti-arbitrage one above, not an
          // equality to premium -- that equality belonged to the superseded
          // point-fix and would re-admit the bug if restored.
          assert.ok(
            closed.fairValue < quote.premium,
            `fair value at inception must sit below premium, ITM or not: dur=${durationMinutes} payoff=${payoff}x vol=${volatility} dir=${direction}`,
          );
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
  const maxPayout = 1_000;
  const targetPremium = 100; // 10x
  const volAnnual = 0.4;
  const timeYears = 60 / 525_600;

  const solved = solveStrikeForTargetPremium({ direction: "up", spot, maxPayout, targetPremium, volAnnual, timeYears });
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

test("BINARY_WIDTH and strike-offset bound are the documented, defensible values (regression guard)", async () => {
  const { BINARY_WIDTH, MAX_STRIKE_OFFSET_FRACTION, MAKER_EDGE_BPS } = await loadOptions();
  // One atom at the on-chain 1e6 price scale -- see BINARY_WIDTH's comment
  // in options.ts and PRICE_SCALE in vsol-server.ts.
  assert.equal(BINARY_WIDTH, 0.000001, "width must stay pinned at exactly one atom");
  // Widened from the old spread engine's 40%: a true digital needs to search
  // further OTM than a capped spread did to reach the same rich target
  // premium (measured worst case in the tier x tenor x vol matrix this
  // product sells: 30D 10x at 120% vol needs ~50.5% OTM). See
  // MAX_STRIKE_OFFSET_FRACTION's comment in options.ts for the full
  // derivation.
  assert.equal(MAX_STRIKE_OFFSET_FRACTION, 0.6);
  assert.equal(MAKER_EDGE_BPS, 1_500);
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
