// A synthetic coming-soon Market, temporarily pushed into the real
// app/lib/markets.ts catalog for the span of one assertion.
//
// Exists because the real catalog no longer carries a coming-soon market:
// SPACEX -- the concrete example every "a coming-soon market cannot trade"
// test used to pin against -- IPO'd and flipped to `status: "live"` (see
// app/lib/markets.ts). The gate itself -- `status` controlling tradability,
// independent of category, enforced in app/lib/expiries.ts's `resolveExpiry`
// and threaded through app/lib/series-resolver.ts -- is still real,
// load-bearing code with nothing left in the catalog to exercise it.
//
// There is no dependency-injection seam to hand a fixture Market to instead:
// every consumer (marketBySymbol, tradableMarketBySymbol, isTradableSymbol,
// resolveExpiry, the series resolver) looks a market up BY SYMBOL against
// the one module-level `markets` array, never by accepting an injected
// Market object. Mutating that array -- a plain, unfrozen JS array -- for
// the scope of one callback is therefore the only way to reach the gate from
// a test without editing app/lib/markets.ts itself.
export const SYNTHETIC_COMING_SOON_SYMBOL = "ZZCOMINGSOON";

export function syntheticComingSoonMarket(overrides = {}) {
  return {
    symbol: SYNTHETIC_COMING_SOON_SYMBOL,
    name: "Synthetic Coming Soon Co.",
    category: "stocks",
    tokenAddress: "11111111111111111111111111111111111111111",
    tone: "#000000",
    oracleStatus: "Pyth Core",
    pythFeedId: "",
    pythSymbol: "",
    coinbaseProductId: "",
    equityTicker: "",
    intradayEligible: true,
    status: "coming-soon",
    strikeLadderStep: 1_000_000n,
    assetClass: "Test fixture",
    blurb: "Test fixture only; never rendered to a real user.",
    statusNote: "Coming soon -- synthetic test fixture, not a real market.",
    statusTag: "Test only",
    ...overrides,
  };
}

/**
 * Pushes a synthetic coming-soon Market into `marketsModule.markets` (the
 * live array app/lib/markets.ts exports) for the duration of `fn`, then
 * removes it again -- even if `fn` throws. `marketsModule` must be the
 * dynamically-imported app/lib/markets.ts namespace so the mutation lands on
 * the SAME array instance every other imported module (expiries.ts,
 * series-resolver.ts, ...) reads from within this test file's module cache.
 */
export async function withSyntheticComingSoonMarket(marketsModule, fn, overrides = {}) {
  const market = syntheticComingSoonMarket(overrides);
  marketsModule.markets.push(market);
  try {
    return await fn(market);
  } finally {
    const index = marketsModule.markets.indexOf(market);
    if (index !== -1) marketsModule.markets.splice(index, 1);
  }
}
