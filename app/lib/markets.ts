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
 * proxy for tradability and must never be used as one. It happens that every
 * crypto market is live today and every stock market is not, and reading
 * that coincidence as a rule is exactly the bug this comment exists to
 * prevent -- `status` is the only thing any gate may test.
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
   * market whose feed exists and is merely un-entitled.
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
   * coming-soon market carries an empty string here regardless of the reason
   * its Pyth feed is blocked, because none of them (tokenized equities,
   * SpaceX) trade on Coinbase's spot market at all.
   */
  coinbaseProductId: string;
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
   * One true sentence naming the underlying and the feed it settles on.
   * Shown under the ticker; must stay accurate to `pythSymbol` above.
   */
  blurb: string;
  /**
   * Short, user-facing sentence explaining why a non-live market cannot
   * trade. Empty string for live markets. Shown on the disabled selector
   * chip and returned verbatim by the expiry/quote gates, so the reason a
   * user sees is the same reason the server enforces.
   *
   * The three coming-soon markets below are blocked for TWO different
   * reasons and the copy must not blur them: NVDA and Google have real,
   * working 24/7 feeds this deployment's Pyth key is not entitled to -- a
   * billing state, one purchase away from live. SpaceX has no oracle at all,
   * because it is a private company that does not trade; there is no
   * settlement path for it even in principle, at any price tier.
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
   * Must preserve the kind-of-blocker distinction: a billing state that a
   * purchase clears reads differently from an instrument that has no
   * settlement source in principle.
   */
  statusTag: string;
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
    // market settled on until 2026-08-26.
    //
    // NOT TRADABLE HERE, and the reason is external, not incomplete work:
    // Pyth made Hermes authentication mandatory on 2026-08-26, and this
    // deployment's API key is entitled to crypto spot feeds ONLY. Verified
    // against hermes.pyth.network with the live key:
    //
    //   Crypto.SOL/USD     -> 200 (entitled)
    //   Crypto.BTC/USD     -> 200 (entitled)
    //   Crypto.ETH/USD     -> 200 (entitled)
    //   Crypto.NVDAX/USD   -> 403 "Not entitled: ... no grant accepts this feed"
    //   Equity.US.NVDA/USD -> 403 "Not entitled"
    //
    // Equity and tokenized-equity feeds sit behind a paid Pyth tier this
    // devnet deployment does not buy. With no price, NVDA cannot settle, so
    // it must not be mintable or quotable -- a user must never be able to
    // buy something that cannot settle. The feed id and symbol are kept
    // accurate so that promoting this to `status: "live"` is the only edit
    // required once the entitlement exists.
    pythFeedId: "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f",
    pythSymbol: "Crypto.NVDAX/USD",
    // Tokenized NVDA does not trade on Coinbase's spot market either.
    coinbaseProductId: "",
    intradayEligible: true,
    status: "coming-soon",
    // Unused while this market is coming-soon (nothing lists a strike for
    // it), but sized now so promoting it is a one-line `status` edit: $5.00
    // at NVDA's ~$210 level is 2.4%.
    strikeLadderStep: dollars(5),
    assetClass: "Tokenized equity",
    blurb: "Tokenized NVIDIA (xStocks), priced by the Pyth Crypto.NVDAX/USD feed.",
    statusNote: "Coming soon — the feed exists and runs 24/7, but this deployment's Pyth key is entitled to crypto feeds only; Crypto.NVDAX/USD needs a paid tier.",
    statusTag: "Feed not entitled",
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
    // Exactly the same blocker as NVDA above: the feed is real, published
    // and 24/7, and this deployment's key returns 403 "Not entitled" for it
    // and for Equity.US.GOOGL/USD alike. A billing state, not a missing
    // oracle -- which is why this entry carries a real feed id and SpaceX
    // below carries none.
    pythFeedId: "b911b0329028cd0283e4259c33809d62942bd2716a58084e5f31d64c00b5424e",
    pythSymbol: "Crypto.GOOGLX/USD",
    // Tokenized GOOGL does not trade on Coinbase's spot market either.
    coinbaseProductId: "",
    intradayEligible: true,
    status: "coming-soon",
    // Unused while coming-soon; ~2.4% at GOOGL's ~$210 level, same as NVDA.
    strikeLadderStep: dollars(5),
    assetClass: "Tokenized equity",
    blurb: "Tokenized Alphabet (xStocks), priced by the Pyth Crypto.GOOGLX/USD feed.",
    statusNote: "Coming soon — the feed exists and runs 24/7, but this deployment's Pyth key is entitled to crypto feeds only; Crypto.GOOGLX/USD needs a paid tier.",
    statusTag: "Feed not entitled",
  },
  {
    symbol: "SPACEX",
    name: "SpaceX",
    category: "stocks",
    tokenAddress: deployment.underlyingMint,
    tone: "#c8cdd4",
    oracleStatus: "Pyth Core",
    // NO FEED. This is a different kind of blocked from NVDA and Google, and
    // the difference is not a detail: SpaceX is a private company, its stock
    // does not trade on a public venue, and Pyth publishes nothing for it --
    // a registry-wide query (hermes /v2/price_feeds?query=SpaceX, and
    // ?query=SPACEX) returns zero feeds, not a feed we lack a grant for.
    //
    // So there is no settlement price for a SpaceX contract to reference, at
    // any Pyth tier, and no amount of paying for entitlements produces one.
    // Listing it requires a price source that does not exist today. The
    // empty strings below are the honest encoding of that, and they are load
    // bearing: nothing can promote this market to "live" by flipping
    // `status` alone, because there would still be no feed to settle on.
    pythFeedId: "",
    pythSymbol: "",
    // No public market anywhere for SpaceX equity, Coinbase included.
    coinbaseProductId: "",
    intradayEligible: false,
    status: "coming-soon",
    // No feed means no spot, so no ladder can be sized. The value is inert
    // (nothing lists a strike for a coming-soon market) and deliberately set
    // to the default rather than to a number implying a real price level.
    strikeLadderStep: dollars(2, 50),
    assetClass: "Private company",
    blurb: "SpaceX equity. No public market and no oracle — listed here as a target, not a tradable series.",
    statusNote: "Coming soon — SpaceX is a private company: no public price and no Pyth feed exists for it at all, so there is no settlement source to trade against yet.",
    statusTag: "No feed exists",
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
 * decided. Crypto leads because it is the shelf that actually trades.
 */
const CATEGORY_LABELS: ReadonlyArray<{ category: MarketCategory; label: string }> = [
  { category: "crypto", label: "Crypto" },
  { category: "stocks", label: "Stocks" },
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
