import assert from "node:assert/strict";
import test from "node:test";

// Per-market pricing overrides (app/lib/markets.ts's `pricingOverrides`,
// app/lib/options.ts's `quoteFor({ makerEdgeBps })`): infrastructure only.
// These tests pin two things: (1) every market's DEFAULT behavior is
// byte-identical to before this field existed -- no market has actually
// opted into a different value yet -- and (2) the override MECHANISM itself
// really changes what gets priced when a caller does set one, proving the
// wiring works rather than being dead code.
const root = new URL("../", import.meta.url);

async function loadMarkets() {
  return import(new URL("app/lib/markets.ts", root));
}
async function loadOptions() {
  return import(new URL("app/lib/options.ts", root));
}

test("no configured market has opted into a pricing override yet, and the clamp is a no-op for all of them", async () => {
  const { markets, clampVolatilityForMarket } = await loadMarkets();
  assert.ok(markets.length > 0);
  for (const market of markets) {
    assert.equal(market.pricingOverrides, undefined, `${market.symbol} must default to no override`);
    for (const vol of [1, 32.5, 120, 400]) {
      assert.equal(clampVolatilityForMarket(market, vol), vol, `${market.symbol} must not alter volatility ${vol}`);
    }
  }
});

test("quoteFor with no makerEdgeBps prices byte-identically to passing the global default explicitly", async () => {
  const { quoteFor, MAKER_EDGE_BPS } = await loadOptions();
  const base = { spot: 200, amount: 1_000, durationMinutes: 43_200, direction: "up", payoff: 5, volatility: 45 };
  const implicit = quoteFor(base);
  const explicitDefault = quoteFor({ ...base, makerEdgeBps: MAKER_EDGE_BPS });
  assert.equal(implicit.premium, explicitDefault.premium);
  assert.equal(implicit.strike, explicitDefault.strike);
  assert.equal(implicit.probabilityItm, explicitDefault.probabilityItm);
  assert.equal(implicit.reachability, explicitDefault.reachability);
});

test("clampVolatilityForMarket is a genuine pass-through clamp until a market sets real bounds", async () => {
  const { clampVolatilityForMarket } = await loadMarkets();
  const noOverrides = {};
  assert.equal(clampVolatilityForMarket(noOverrides, 250), 250);
  const floorOnly = { pricingOverrides: { volFloor: 20 } };
  assert.equal(clampVolatilityForMarket(floorOnly, 5), 20);
  assert.equal(clampVolatilityForMarket(floorOnly, 50), 50);
  const ceilOnly = { pricingOverrides: { volCeil: 80 } };
  assert.equal(clampVolatilityForMarket(ceilOnly, 200), 80);
  assert.equal(clampVolatilityForMarket(ceilOnly, 50), 50);
  const both = { pricingOverrides: { volFloor: 20, volCeil: 80 } };
  assert.equal(clampVolatilityForMarket(both, 5), 20);
  assert.equal(clampVolatilityForMarket(both, 500), 80);
  assert.equal(clampVolatilityForMarket(both, 50), 50);
});

test("a per-market volatility floor actually changes the priced strike and implied volatility", async () => {
  const { quoteFor } = await loadOptions();
  const { clampVolatilityForMarket } = await loadMarkets();
  const overriddenMarket = { pricingOverrides: { volFloor: 80 } };
  const rawVol = 10; // a very quiet realized-vol reading
  const clampedVol = clampVolatilityForMarket(overriddenMarket, rawVol);
  assert.equal(clampedVol, 80);

  const base = { spot: 200, amount: 1_000, durationMinutes: 43_200, direction: "up", payoff: 5 };
  const unclamped = quoteFor({ ...base, volatility: rawVol });
  const clamped = quoteFor({ ...base, volatility: clampedVol });
  assert.notEqual(unclamped.strike, clamped.strike);
  assert.notEqual(unclamped.impliedVolatility, clamped.impliedVolatility);
  assert.ok(clamped.impliedVolatility > unclamped.impliedVolatility);
});

test("a per-market makerEdgeBps override actually engages inside the strike solve, not a dead parameter", async () => {
  const { quoteFor } = await loadOptions();
  const base = { spot: 200, amount: 1_000, durationMinutes: 43_200, direction: "up", payoff: 5, volatility: 45 };
  const globalEdge = quoteFor(base);
  const richerEdge = quoteFor({ ...base, makerEdgeBps: 3_000 }); // 30%, double the 15% default
  assert.equal(globalEdge.reachability, "solved");
  assert.equal(richerEdge.reachability, "solved");
  // A richer edge means, for the SAME targetPremium (= maxPayout / payoff,
  // edge-independent), the pre-edge fair value the strike must hit is LOWER
  // -- so the solver reaches for a strike further out-of-the-money, and the
  // win probability at that strike is lower. This is the honest signal that
  // the edge was applied INSIDE the solve (see applyMakerEdge's own doc
  // comment on why it must be), not tacked on afterward.
  assert.ok(richerEdge.probabilityItm < globalEdge.probabilityItm);
  assert.notEqual(richerEdge.strike, globalEdge.strike);
});

test("app/api/quotes/route.ts threads clampVolatilityForMarket and the per-market makerEdgeBps override into quoteFor instead of the raw provider reading", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("app/api/quotes/route.ts", root), "utf8");
  assert.match(source, /clampVolatilityForMarket\(market, volatility\.value\)/);
  assert.match(source, /market\.pricingOverrides\?\.makerEdgeBps/);
});
