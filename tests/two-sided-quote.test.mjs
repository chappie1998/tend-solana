import assert from "node:assert/strict";
import test from "node:test";

// Two-sided "cents on the dollar" display (Split's framing: UP + DOWN
// premiums at one strike sum to the payout width). `otherSidePremium` in
// app/lib/options.ts is the exact identity N(d2) + N(-d2) == 1, not a
// heuristic -- these tests re-derive it independently via a completely
// separate code path (a real `digitalFairValue` call at the flipped
// direction) so a copy-pasted or drifted "magic formula" would be caught.
const root = new URL("../", import.meta.url);

async function loadOptions() {
  return import(new URL("app/lib/options.ts", root));
}

test("otherSidePremium matches an independently re-derived opposite-direction digitalFairValue at the same strike", async () => {
  const { quoteFor, digitalFairValue, applyMakerEdge, otherSidePremium, MAKER_EDGE_BPS } = await loadOptions();
  const cases = [
    { spot: 100, durationMinutes: 60, direction: "up", payoff: 2, volatility: 40 },
    { spot: 63_900, durationMinutes: 43_200, direction: "down", payoff: 10, volatility: 90 },
    { spot: 2_500, durationMinutes: 15, direction: "up", payoff: 6, volatility: 65 },
    { spot: 100, durationMinutes: 1_440, direction: "down", payoff: 2, volatility: 30 },
  ];
  for (const c of cases) {
    const quote = quoteFor({ ...c, amount: 1_000 });
    const computed = otherSidePremium({ maxPayout: quote.maxPayout, probabilityItm: quote.probabilityItm });

    // Independent path: re-solve the digital's fair value at the OPPOSITE
    // direction, AT THE SAME STRIKE quoteFor solved to, via digitalFairValue
    // directly -- a different function than otherSidePremium's own
    // "maxPayout * (1 - probabilityItm)" shortcut.
    const opposite = c.direction === "up" ? "down" : "up";
    const volAnnual = quote.impliedVolatility / 100; // the gap-risk-adjusted vol quoteFor actually priced with
    const timeYears = Math.max(c.durationMinutes, 15) / 525_600;
    const independentFair = digitalFairValue({
      direction: opposite,
      spot: c.spot,
      strike: quote.strike,
      maxPayout: quote.maxPayout,
      volAnnual,
      timeYears,
    });
    // Same clamp quoteFor's own `premium` carries (Math.min(maxPayout * 0.95,
    // Math.max(1, ...))): otherSidePremium must be bounded the same way a
    // real quote is, or a low-P side (every 5x/10x tier's other side) prices
    // past maxPayout itself -- a $525 "price" to win a $500 payout, measured
    // before this test caught it. See otherSidePremium's own comment.
    const independentPremium = Math.min(
      quote.maxPayout * 0.95,
      Math.max(1, applyMakerEdge(independentFair, MAKER_EDGE_BPS)),
    );

    assert.ok(
      Math.abs(computed - independentPremium) < 1e-6 * quote.maxPayout,
      `otherSidePremium=${computed} vs independently re-derived=${independentPremium} for ${JSON.stringify(c)}`,
    );
  }
});

test("the quoted side's pre-edge fair value plus the other side's pre-edge fair value sum to exactly maxPayout", async () => {
  const { quoteFor, otherSidePremium, MAKER_EDGE_BPS } = await loadOptions();
  const quote = quoteFor({ spot: 200, amount: 1_000, durationMinutes: 1_440, direction: "up", payoff: 3, volatility: 55 });
  const quotedFair = quote.maxPayout * quote.probabilityItm;
  const otherWithEdge = otherSidePremium({ maxPayout: quote.maxPayout, probabilityItm: quote.probabilityItm });
  const otherFair = otherWithEdge / (1 + MAKER_EDGE_BPS / 10_000);
  assert.ok(
    Math.abs(quotedFair + otherFair - quote.maxPayout) < 1e-6 * quote.maxPayout,
    `${quotedFair} + ${otherFair} should sum to ${quote.maxPayout}`,
  );
});

test("otherSidePremium respects a custom makerEdgeBps the same way applyMakerEdge does", async () => {
  const { quoteFor, otherSidePremium, applyMakerEdge } = await loadOptions();
  const quote = quoteFor({ spot: 100, amount: 1_000, durationMinutes: 60, direction: "up", payoff: 2, volatility: 40 });
  const otherFairValue = quote.maxPayout * (1 - quote.probabilityItm);
  const withCustomEdge = otherSidePremium({ maxPayout: quote.maxPayout, probabilityItm: quote.probabilityItm, makerEdgeBps: 500 });
  assert.equal(withCustomEdge, applyMakerEdge(otherFairValue, 500));
  assert.notEqual(withCustomEdge, otherSidePremium({ maxPayout: quote.maxPayout, probabilityItm: quote.probabilityItm }));
});

test("otherSidePremium validates its inputs and rejects nonsense", async () => {
  const { otherSidePremium } = await loadOptions();
  assert.throws(() => otherSidePremium({ maxPayout: 0, probabilityItm: 0.5 }), RangeError);
  assert.throws(() => otherSidePremium({ maxPayout: -100, probabilityItm: 0.5 }), RangeError);
  assert.throws(() => otherSidePremium({ maxPayout: 100, probabilityItm: -0.1 }), RangeError);
  assert.throws(() => otherSidePremium({ maxPayout: 100, probabilityItm: 1.1 }), RangeError);
  // Boundary probabilities are valid (deep ITM/OTM digitals). At
  // probabilityItm=1 the other side's fair value is genuinely 0, but the
  // same $1 floor quoteFor's own premium carries applies here too, so a real
  // quote for that side would never show literally $0 either.
  assert.equal(otherSidePremium({ maxPayout: 100, probabilityItm: 1 }), 1);
  assert.ok(otherSidePremium({ maxPayout: 100, probabilityItm: 0 }) > 0);
});

// Regression: none of the tests above caught this, because all four cases
// happened to land at a moderate probabilityItm. Every real 5x/10x tier
// (payoffTiersFor's own ladder) solves to a LOW win probability, which makes
// the OTHER side the near-certain one -- exactly where an uncapped
// "maxPayout * (1 - probabilityItm) * 1.15" pushes past maxPayout itself.
// Measured before the fix: a 10x tier's other side priced at $525 to win a
// $500 payout -- arithmetically impossible (a guaranteed loss even on a
// win), sitting right next to the real premium on the ticket. Swept across
// the product's actual tier ladder, every tenor it's sold at, and a
// realistic vol range, not a handful of hand-picked cases.
test("otherSidePremium never exceeds quoteFor's own 95% premium cap, across the real tier ladder", async () => {
  const { quoteFor, otherSidePremium, payoffTiersFor } = await loadOptions();
  const spot = 101.64;
  const tenors = [["15M", 15], ["1H", 60], ["EOD", 720], ["7D", 10_080], ["30D", 43_200]];
  const failures = [];
  for (const [label, durationMinutes] of tenors) {
    for (const payoff of payoffTiersFor(durationMinutes)) {
      for (const volatility of [20, 60, 120]) {
        for (const direction of ["up", "down"]) {
          const quote = quoteFor({ spot, amount: 500, durationMinutes, direction, payoff, volatility });
          const other = otherSidePremium({ maxPayout: quote.maxPayout, probabilityItm: quote.probabilityItm });
          if (other > quote.maxPayout * 0.95 + 1e-9) {
            failures.push(`${label} ${payoff}x ${direction} vol=${volatility}: other side $${other.toFixed(2)} on a $${quote.maxPayout} payout`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, [], `otherSidePremium exceeded the premium cap:\n${failures.join("\n")}`);
});

test("TendTerminal renders the two-sided estimate as indicative display only, never wired into signing", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("app/components/TendTerminal.tsx", root), "utf8");
  assert.match(source, /otherSidePremium\(\{\s*maxPayout: bestQuote\.maxPayout,\s*probabilityItm: bestQuote\.probabilityItm,/);
  assert.match(source, /for the other side/);
  assert.match(source, /Indicative/i);
  // Must not be threaded into requestQuote or the execution/signing path --
  // this is a client-side display derivation only.
  assert.doesNotMatch(source, /requestQuote[\s\S]{0,400}otherSidePremium/);
  assert.doesNotMatch(source, /confirmPreviewPosition[\s\S]{0,400}otherSidePremium/);
});
