// The import attribute keeps this module importable both by the bundler and
// directly by the node:test suite (native ESM requires it for JSON modules),
// matching the convention used by app/lib/vsol.ts.
import deployment from "../../vsol/deployments/devnet.json" with { type: "json" };
// The explicit .ts extension keeps this module importable by the node:test
// suite (type stripping) and by vsol/scripts/*.ts as well as the bundler.
import { PRICE_SCALE } from "../../vsol/sdk/index.ts";

/**
 * Whether a listed market can actually be traded here.
 *
 * `"coming-soon"` is a deliberate, externally-blocked state, not unfinished
 * work: the market is named and on screen, but nothing in the protocol will
 * mint, quote, authorize or settle it. Every gate keys off THIS field --
 * never off a symbol string -- so adding or promoting a market is a one-line
 * config change rather than a hunt for scattered `symbol === "..."` tests.
 */
export type MarketStatus = "live" | "coming-soon";

/**
 * The shelf a market is listed on. Purely an organizing fact about the
 * underlying, deliberately independent of `status`: a category is not a
 * proxy for tradability and must never be used as one. Every crypto market
 * is live, and the stocks group is now a MIX -- NVDA and GOOGL live, SpaceX
 * coming-soon -- which is exactly why reading category as a tradability
 * proxy was always the wrong shortcut: `status` is the only thing any gate
 * may test. (`category` still legitimately selects a provider FAMILY --
 * see app/lib/market-data.ts -- that is a data-routing decision, not a
 * tradability one.)
 */
export type MarketCategory = "crypto" | "stocks";

export type Market = {
  symbol: string;
  name: string;
  category: MarketCategory;
  tokenAddress: string;
  tone: string;
  oracleStatus: "Pyth Core";
  /**
   * The Pyth feed this market settles and displays on, as a 32-byte hex id.
   *
   * EMPTY STRING means no such feed exists anywhere in Pyth's registry --
   * not "we have not filled this in yet", and not "we are not entitled to
   * it". Only SpaceX is in that state (a private company; see its entry).
   * A market with an empty feed can never be promoted to `"live"` by a
   * config edit alone, which is the whole point of distinguishing it from a
   * market whose feed exists but is merely un-entitled -- e.g. NVDA and
   * GOOGL below, both `"live"` today via a different off-chain price source
   * (Hyperliquid's "xyz" dex; see `blurb`) despite carrying a real Pyth feed
   * id this deployment's key still cannot read. This field is kept accurate
   * regardless of `status` because it is settlement-identity metadata (it is
   * hashed into the on-chain market id via `pythFeedIdFor`), not a
   * tradability switch.
   */
  pythFeedId: string;
  /** Pyth's own symbol for `pythFeedId`. Empty exactly when that is. */
  pythSymbol: string;
  /**
   * The Coinbase Exchange product this market's off-chain spot/volatility/
   * chart data reads from when MARKET_DATA_PROVIDER=coinbase (the default;
   * see app/lib/market-data.ts) -- e.g. "SOL-USD". Settlement is unaffected:
   * it always verifies Pyth, never Coinbase.
   *
   * EMPTY STRING means the same thing it does for `pythFeedId`: not "unset",
   * but "no product exists for this market on Coinbase Exchange". Every
   * STOCK market carries an empty string here, live or coming-soon alike,
   * because Coinbase lists no equities at all -- a live stock market's
   * off-chain reference comes from Hyperliquid's "xyz" HIP-3 dex instead (see
   * app/lib/market-data.ts), never from this field.
   */
  coinbaseProductId: string;
  /**
   * The exchange ticker an off-chain equity vendor knows this equity by, when
   * it differs from `symbol` -- today that vendor is Hyperliquid's "xyz" dex
   * (see app/lib/hyperliquid-market-data.ts), which namespaces every coin as
   * `xyz:${equityTicker || symbol}`. Empty string means "they are the same"
   * -- NVDA and GOOGL are their own tickers, so they leave this blank.
   *
   * These MUST be allowed to differ. `symbol` is hashed into the on-chain
   * market PDA and seeds the market's `CustomPriceFeed`, so it is permanent
   * on-chain identity: renaming SPACEX to SPCX to make the lookup "simpler"
   * would repoint every derived address and orphan the feed and any open
   * position. The vendor ticker is just how an off-chain HTTP provider spells
   * it, and vendors rename tickers. Keep the two separate.
   */
  equityTicker: string;
  intradayEligible: boolean;
  status: MarketStatus;
  /**
   * This market's strike-ladder rung size, in PRICE_SCALE atoms. Sized at
   * roughly 2-3% of the underlying's own spot -- see STRIKE_LADDER_STEP's
   * note in vsol/sdk/index.ts for why the step cannot be one global constant,
   * and each market's entry below for how its number was chosen.
   *
   * Everything that lists a strike reads it from here: the keeper and
   * bootstrap when minting a new expiry, and the app when planning a
   * mint-on-demand or hand-launched series. A divergence would put the app's
   * predicted market PDA on a different rung from the one the keeper mints,
   * and the UI would silently see nothing.
   */
  strikeLadderStep: bigint;
  /**
   * What the instrument actually IS, rendered verbatim as the badge beside
   * the ticker. It lives in config precisely so no view can invent one --
   * SOL was previously badged "Stock Token" by a hardcoded string in
   * TendTerminal.tsx, which is false and the kind of copy that costs more
   * credibility than any styling problem.
   */
  assetClass: string;
  /**
   * One true sentence naming the underlying and the price source it displays
   * on. For a crypto market this must stay accurate to `pythSymbol` above
   * (settlement and display are the same feed there). For a STOCK market it
   * must instead name Hyperliquid's "xyz" dex (see app/lib/market-data.ts) --
   * `pythSymbol` is kept on a stock entry only as settlement-identity
   * metadata (see that field's own doc comment) and must never be quoted here
   * as if it were the display source, because it is not: this deployment's
   * Pyth key has no equity/tokenized-equity entitlement, so nothing here ever
   * reads a Pyth price for a stock.
   */
  blurb: string;
  /**
   * Short, user-facing sentence explaining why a non-live market cannot
   * trade. Empty string for live markets. Shown on the disabled selector
   * chip and returned verbatim by the expiry/quote gates, so the reason a
   * user sees is the same reason the server enforces.
   *
   * SpaceX is the one remaining coming-soon market: it has no oracle at all,
   * because it is a private company that does not trade; there is no
   * settlement path for it even in principle, at any price tier. NVDA and
   * Google used to be blocked here too (a billing state: real, working 24/7
   * Pyth feeds this deployment's key was not entitled to) -- that blocker no
   * longer gates trading now that their off-chain reference comes from
   * Hyperliquid's "xyz" dex instead (see `blurb`), so both carry the same
   * empty string every other live market does.
   */
  statusNote: string;
  /**
   * Two or three words carrying the SAME distinction `statusNote` makes, for
   * the selector chip. `statusNote` stays the authoritative sentence and is
   * still what the gates return and what the chip shows on hover -- but
   * rendering three full sentences inline made the untradable markets taller
   * than the tradable ones and inverted the panel's hierarchy. Empty string
   * for live markets.
   *
   * Must preserve the kind-of-blocker distinction if a second coming-soon
   * market ever joins SpaceX below: a billing state that a purchase (or, as
   * happened for NVDA/GOOGL, a different off-chain price source) clears
   * reads differently from an instrument that has no settlement source in
   * principle, which is SpaceX's own, permanent case.
   */
  statusTag: string;
  /**
   * Optional per-market pricing overrides -- infrastructure only, not a
   * pricing-policy decision. Every market below leaves this undefined, which
   * keeps quoted prices byte-identical to before this field existed (see
   * the "per-market override defaults are inert" test in
   * tests/market-pricing-overrides.test.mjs). Only the MECHANISM lives here;
   * a real decision to price one market differently from another (its own
   * volatility seed, markup, floor, ceiling, or jump calibration) is a
   * pricing call for later, with real data behind it -- not something this
   * field invents.
   *
   * - `makerEdgeBps`: overrides the global `MAKER_EDGE_BPS`
   *   (app/lib/options.ts) for this market's quotes.
   * - `volFloor` / `volCeil`: clamp bounds on the realized-vol reading
   *   (annualized, as a percentage -- same units `getMarketRealizedVolatility`
   *   already returns) before it reaches `quoteFor`. Undefined means "no
   *   clamp", identical to current behavior.
   */
  pricingOverrides?: {
    makerEdgeBps?: number;
    volFloor?: number;
    volCeil?: number;
  };
};

// Ladder steps in dollars, converted once here so each market's entry reads
// as the number a human chose. See each market for the sizing argument.
const dollars = (whole: number, cents = 0): bigint =>
  BigInt(whole) * PRICE_SCALE + (BigInt(cents) * PRICE_SCALE) / 100n;

export const markets: Market[] = [
  {
    symbol: "SOL",
    name: "Solana",
    category: "crypto",
    tokenAddress: deployment.underlyingMint,
    tone: "#83e0ba",
    oracleStatus: "Pyth Core",
    // Settlement and display are deliberately the SAME feed. Showing one
    // price while settling on another would mean users see one number and
    // get settled on a different one.
    //
    // Crypto.SOL/USD. Pyth's own feed metadata declares its schedule
    // "America/New_York;O,O,O,O,O,O,O;" -- open all seven days, no holiday
    // closures -- which is what Tend's 24/7 UTC expiry grid requires.
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    pythSymbol: "Crypto.SOL/USD",
    // Verified live: GET /products/SOL-USD/ticker -> 200.
    coinbaseProductId: "SOL-USD",
    equityTicker: "",
    intradayEligible: true,
    status: "live",
    // $2.50 at SOL ~$103.36 (measured 2026-09-05) is 2.4% -- mid-band.
    strikeLadderStep: dollars(2, 50),
    assetClass: "Native asset",
    blurb: "Solana's native asset, settled against the Pyth Crypto.SOL/USD feed.",
    statusNote: "",
    statusTag: "",
  },
  {
    symbol: "BTC",
    name: "Bitcoin",
    category: "crypto",
    tokenAddress: deployment.underlyingMint,
    tone: "#f7931a",
    oracleStatus: "Pyth Core",
    // Crypto.BTC/USD -- entitled on this deployment's Pyth key (verified
    // live: 200), and 24/7 like every crypto spot feed.
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    pythSymbol: "Crypto.BTC/USD",
    // Verified live: GET /products/BTC-USD/ticker -> 200.
    coinbaseProductId: "BTC-USD",
    equityTicker: "",
    intradayEligible: true,
    status: "live",
    // $2,000 at BTC ~$80,016 (measured 2026-09-05) is 2.50% -- mid-band, and
    // a round rung ($78,000 / $80,000 / $82,000). SOL's $2.50 step here
    // would be 0.003% of spot: a new listed contract every quarter of a
    // basis point, fragmenting the pool across thousands of near-identical
    // strikes. This is the entry that makes a global step indefensible.
    strikeLadderStep: dollars(2_000),
    assetClass: "Native asset",
    blurb: "Bitcoin, settled against the Pyth Crypto.BTC/USD feed.",
    statusNote: "",
    statusTag: "",
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    category: "crypto",
    tokenAddress: deployment.underlyingMint,
    tone: "#8a92b2",
    oracleStatus: "Pyth Core",
    // Crypto.ETH/USD -- entitled on this deployment's Pyth key (verified
    // live: 200), and 24/7 like every crypto spot feed.
    pythFeedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    pythSymbol: "Crypto.ETH/USD",
    // Verified live: GET /products/ETH-USD/ticker -> 200.
    coinbaseProductId: "ETH-USD",
    equityTicker: "",
    intradayEligible: true,
    status: "live",
    // $50 at ETH ~$2,473.52 (measured 2026-09-05) is 2.02% -- the bottom of
    // the 2-3% band, chosen over a mid-band $62.50 because every rung stays
    // a round, legible strike ($2,450 / $2,500 / $2,550) instead of
    // alternating onto $2,437.50-style halves. Revisit if ETH runs past
    // ~$2,500, where $50 drops under 2%.
    strikeLadderStep: dollars(50),
    assetClass: "Native asset",
    blurb: "Ether, settled against the Pyth Crypto.ETH/USD feed.",
    statusNote: "",
    statusTag: "",
  },
  {
    symbol: "NVDA",
    name: "NVIDIA",
    category: "stocks",
    tokenAddress: deployment.underlyingMint,
    tone: "#76b900",
    oracleStatus: "Pyth Core",
    // Crypto.NVDAX/USD -- tokenized NVDA (xStocks), the 24/7 feed this
    // market settled on until 2026-08-26, when Pyth made Hermes
    // authentication mandatory and this deployment's API key turned out to
    // be entitled to crypto spot feeds only (verified against
    // hermes.pyth.network: Crypto.NVDAX/USD and Equity.US.NVDA/USD both
    // 403 "Not entitled", where Crypto.SOL/BTC/ETH/USD all still 200).
    //
    // That entitlement gap is UNCHANGED and is kept honest here -- the feed
    // id/symbol below are settlement-identity metadata only, still not a
    // price this deployment can read. What changed is the OFF-CHAIN
    // reference this market displays and quotes off: NVDA now prices through
    // Hyperliquid's "xyz" HIP-3 dex -- a tokenized-equity PERP that genuinely
    // trades 24/7 (see app/lib/hyperliquid-market-data.ts for the live
    // verification evidence), for spot, chart bars, AND realized volatility
    // alike -- see app/lib/market-data.ts's per-category routing -- none of
    // which needs any Pyth entitlement at all. That is what makes
    // `status: "live"` correct despite the Pyth blocker never having been
    // lifted, and it's also what makes trading this 24/7 HONEST rather than
    // a loophole: unlike the real Finnhub/Twelve Data quotes this used to
    // price off (which froze outside 09:30-16:00 America/New_York and forced
    // a matching RTH gate in expiries.ts), Hyperliquid's price keeps moving
    // around the clock, so there is no frozen-price window left to gate.
    pythFeedId: "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f",
    pythSymbol: "Crypto.NVDAX/USD",
    // Hyperliquid's "xyz" dex, not Coinbase -- Coinbase lists no equities at all.
    coinbaseProductId: "",
    equityTicker: "",
    intradayEligible: true,
    status: "live",
    // $5.00 at NVDA's ~$210 level is 2.4% -- mid-band, same sizing logic as
    // every crypto listing above.
    strikeLadderStep: dollars(5),
    assetClass: "US equity",
    blurb: "NVIDIA common stock, priced live off Hyperliquid's xyz:NVDA 24/7 equity feed.",
    statusNote: "",
    statusTag: "",
  },
  {
    symbol: "GOOGL",
    name: "Google",
    category: "stocks",
    tokenAddress: deployment.underlyingMint,
    tone: "#4285f4",
    oracleStatus: "Pyth Core",
    // Crypto.GOOGLX/USD -- tokenized GOOGL (xStocks), id read from Pyth's
    // own feed registry (hermes /v2/price_feeds?query=GOOGLX), not derived.
    // Exactly the same blocker as NVDA above, and the same resolution: this
    // deployment's key still returns 403 "Not entitled" for it and for
    // Equity.US.GOOGL/USD alike (a billing state, not a missing oracle --
    // which is why this entry carries a real feed id and SpaceX below
    // carries none), but that no longer matters for trading here because
    // GOOGL's off-chain reference comes from Hyperliquid's "xyz" dex instead
    // (see the NVDA entry above for the fuller explanation, which applies
    // identically, including why this is now honestly 24/7 with no RTH gate).
    // The feed id/symbol stay as settlement-identity metadata.
    pythFeedId: "b911b0329028cd0283e4259c33809d62942bd2716a58084e5f31d64c00b5424e",
    pythSymbol: "Crypto.GOOGLX/USD",
    // Hyperliquid's "xyz" dex, not Coinbase -- Coinbase lists no equities at all.
    coinbaseProductId: "",
    equityTicker: "",
    intradayEligible: true,
    status: "live",
    // ~2.4% at GOOGL's ~$210 level, same sizing logic as NVDA.
    strikeLadderStep: dollars(5),
    assetClass: "US equity",
    blurb: "Alphabet (Google) common stock, priced live off Hyperliquid's xyz:GOOGL 24/7 equity feed.",
    statusNote: "",
    statusTag: "",
  },
  {
    symbol: "SPACEX",
    name: "SpaceX",
    category: "stocks",
    tokenAddress: deployment.underlyingMint,
    tone: "#c8cdd4",
    oracleStatus: "Pyth Core",
    // SpaceX IPO'd on NASDAQ 2026-06-12 and trades as SPCX. This entry used
    // to assert -- at length -- that it was a private company with no public
    // price at any tier, which was true when written and is now simply false.
    // Verified against both live providers before flipping it: Finnhub
    // /stock/profile2 SPCX returns name "Space Exploration Technologies Corp",
    // exchange NASDAQ, ipo 2026-06-12; Twelve Data /quote SPCX agrees, and
    // Hyperliquid's "xyz" dex lists it as xyz:SPCX (see `equityTicker`
    // below), the price source this market actually reads from now. Do not
    // reinstate the old copy from memory -- check the feed.
    //
    // Pyth DOES publish SPCX, in three variants. This binds the 24/7 one
    // deliberately: Equity.US.SPCX/USD is session-bound and would be dark
    // outside RTH, the exact failure that made the equity NVDA feed useless
    // here (dark ~81% of the week). Equity.Index.SPCX/USD is Pyth's own
    // round-the-clock price for the same ticker.
    //
    // This id is NOT a price source for us -- this deployment's Pyth key has
    // no equity entitlement, and stock prices come from Hyperliquid's "xyz"
    // dex while settlement runs on the custom oracle. It is load-bearing as
    // IDENTITY: `pythFeedIdFor` feeds `series-resolver.ts`'s market-PDA
    // derivation, and an empty string there throws, so a market cannot be
    // minted, quoted or settled without one. That is why this market could
    // not simply be flipped live with the field left blank.
    pythFeedId: "2dbfb1791e75725227a90dbd23c6bdd83b80cc9d13011973c948b6aeacdf17b9",
    pythSymbol: "Equity.Index.SPCX/USD",
    // Coinbase lists no equities, SpaceX included.
    coinbaseProductId: "",
    // The one market where the vendor ticker differs from `symbol` -- see that
    // field's doc comment for why we do NOT rename the symbol to match.
    // Hyperliquid's "xyz" dex resolves this to the coin `xyz:SPCX`.
    equityTicker: "SPCX",
    intradayEligible: true,
    status: "live",
    // ~2% of a ~$143 spot, matching how every other market's rung was sized.
    strikeLadderStep: dollars(2, 50),
    assetClass: "US equity",
    blurb: "Space Exploration Technologies (SPCX) on NASDAQ, priced live off Hyperliquid's xyz:SPCX 24/7 equity feed.",
    statusNote: "",
    statusTag: "",
  },
];

/**
 * Every market that can actually be minted, quoted, authorized and settled.
 * This is the list every chain-facing caller must iterate: the keeper, the
 * bootstrap, the deployment verifier, the cranker, the series resolver's
 * symbol set, and the on-chain catalog scans. `markets` (all of them, live
 * and not) is for DISPLAY only.
 */
export const liveMarkets: Market[] = markets.filter((market) => market.status === "live");

/** Any configured market, tradable or not. Display surfaces use this. */
export function marketBySymbol(symbol: string) {
  return markets.find((market) => market.symbol === symbol.toUpperCase());
}

/**
 * The market for `symbol` only if it is actually tradable. Every path that
 * can lead to a quote, a mint, or a fill must resolve through this and NOT
 * through `marketBySymbol`, so a coming-soon symbol can never reach the
 * quote path or the series resolver.
 */
export function tradableMarketBySymbol(symbol: string) {
  const market = marketBySymbol(symbol);
  return market?.status === "live" ? market : undefined;
}

export function isTradableSymbol(symbol: string): boolean {
  return tradableMarketBySymbol(symbol) !== undefined;
}

/**
 * The Pyth feed a series for `symbol` binds to, as a 32-byte hex id.
 *
 * Every market-id derivation must go through this rather than through the
 * deployment manifest's single `pythFeedId`: that field described the one
 * market this deployment used to have, and deriving a BTC market id from
 * SOL's feed silently produces an address nothing will ever mint. Throws for
 * an unknown symbol and for a market with no feed at all (SpaceX), because
 * both mean "there is no series to derive", not "use a default".
 */
export function pythFeedIdFor(symbol: string): string {
  const market = marketBySymbol(symbol);
  if (!market) throw new Error(`No market metadata is configured for ${symbol}`);
  if (!market.pythFeedId) throw new Error(`${market.name} has no Pyth feed, so no series can bind to one.`);
  return market.pythFeedId;
}

/**
 * Applies `market.pricingOverrides.volFloor`/`volCeil` to a realized-vol
 * reading (same units as `getMarketRealizedVolatility`'s `.value`: annualized
 * percentage, e.g. 32.3 for 32.3%). A market with no overrides (every market
 * today) returns `volatility` unchanged -- this is a pass-through clamp, not
 * a pricing decision, and inert until a market's `pricingOverrides` is
 * actually set to something other than the default `undefined`.
 */
export function clampVolatilityForMarket(market: Pick<Market, "pricingOverrides">, volatility: number): number {
  const { volFloor, volCeil } = market.pricingOverrides ?? {};
  let clamped = volatility;
  if (typeof volFloor === "number") clamped = Math.max(clamped, volFloor);
  if (typeof volCeil === "number") clamped = Math.min(clamped, volCeil);
  return clamped;
}

/**
 * The ladder rung size to round a `symbol` spot price onto. Falls back to
 * nothing: an unknown symbol throws rather than silently laddering a market
 * on another asset's step (see `strikeLadderStep` on Market).
 */
export function strikeLadderStepFor(symbol: string): bigint {
  const market = marketBySymbol(symbol);
  if (!market) throw new Error(`No market metadata is configured for ${symbol}`);
  return market.strikeLadderStep;
}

/**
 * The catalog as it goes over the wire.
 *
 * `strikeLadderStep` is a bigint, and `Response.json()` throws
 * "Do not know how to serialize a BigInt" on one -- which is exactly what
 * happened the moment the field was added: /api/markets returned 500 for
 * every request while the whole app still typechecked and built cleanly. So
 * the wire shape is stated explicitly here rather than being "whatever
 * `Market` happens to hold today", and the step is carried as a decimal
 * string of PRICE_SCALE atoms (the same convention the deployment manifest
 * uses for `strike`).
 */
export type MarketWireEntry = Omit<Market, "strikeLadderStep"> & { strikeLadderStep: string };

export function toMarketWireEntry(market: Market): MarketWireEntry {
  return { ...market, strikeLadderStep: market.strikeLadderStep.toString() };
}

/** Every configured market, JSON-safe. What /api/markets publishes. */
export const marketsForWire: MarketWireEntry[] = markets.map(toMarketWireEntry);

export type MarketGroup = {
  category: MarketCategory;
  /** The heading the selector renders for this group. */
  label: string;
  markets: Market[];
};

/**
 * The display order of the categories, and the only place that order is
 * decided. Stocks lead: they are what this deployment is demonstrating.
 *
 * This used to read "Crypto leads because it is the shelf that actually
 * trades" -- true when stocks were all coming-soon, and false since NVDA,
 * GOOGL and SPACEX went live. Order is presentation only; nothing derives
 * tradability from it (that is `status`, always).
 */
const CATEGORY_LABELS: ReadonlyArray<{ category: MarketCategory; label: string }> = [
  { category: "stocks", label: "Stocks" },
  { category: "crypto", label: "Crypto" },
];

/**
 * Every market grouped by category, in a fixed display order, with empty
 * groups dropped. Views must render FROM THIS rather than filtering
 * `markets` themselves -- one grouping rule, so a market added to the config
 * appears under the right heading with no view edit at all.
 */
export const marketsByCategory: MarketGroup[] = CATEGORY_LABELS
  .map(({ category, label }) => ({ category, label, markets: markets.filter((market) => market.category === category) }))
  .filter((group) => group.markets.length > 0);
