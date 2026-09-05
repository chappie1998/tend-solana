// The import attribute keeps this module importable both by the bundler and
// directly by the node:test suite (native ESM requires it for JSON modules),
// matching the convention used by app/lib/vsol.ts.
import deployment from "../../vsol/deployments/devnet.json" with { type: "json" };

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

export type Market = {
  symbol: string;
  name: string;
  tokenAddress: string;
  tone: string;
  oracleStatus: "Pyth Core";
  pythFeedId: string;
  pythSymbol: string;
  intradayEligible: boolean;
  status: MarketStatus;
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
   */
  statusNote: string;
};

export const markets: Market[] = [
  {
    symbol: "SOL",
    name: "Solana",
    tokenAddress: deployment.underlyingMint,
    tone: "#83e0ba",
    oracleStatus: "Pyth Core",
    // Settlement and display are deliberately the SAME feed. Showing one
    // price while settling on another would mean users see one number and
    // get settled on a different one.
    //
    // Crypto.SOL/USD. Pyth's own feed metadata declares its schedule
    // "America/New_York;O,O,O,O,O,O,O;" -- open all seven days, no holiday
    // closures -- which is what Tend's 24/7 UTC expiry grid requires. This
    // is a DEVNET settlement choice, made because it is the feed this
    // deployment's Pyth entitlement actually covers (see the NVDA entry
    // below). It is not a change of product direction: the RWA/equity
    // positioning is a mainnet decision and is untouched by this.
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    pythSymbol: "Crypto.SOL/USD",
    intradayEligible: true,
    status: "live",
    assetClass: "Native asset",
    blurb: "Solana's native asset, settled against the Pyth Crypto.SOL/USD feed.",
    statusNote: "",
  },
  {
    symbol: "NVDA",
    name: "NVIDIA",
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
    //   Crypto.SOL/USD    -> 200 (entitled)
    //   Crypto.NVDAX/USD  -> 403 "Not entitled: ... no grant accepts this feed"
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
    intradayEligible: true,
    status: "coming-soon",
    assetClass: "Tokenized equity",
    blurb: "Tokenized NVIDIA (xStocks), priced by the Pyth Crypto.NVDAX/USD feed.",
    statusNote: "Coming soon — not tradable: this deployment's Pyth key covers crypto feeds only, and Crypto.NVDAX/USD needs a paid entitlement tier.",
  },
];

/**
 * Every market that can actually be minted, quoted, authorized and settled.
 * This is the list every chain-facing caller must iterate: the keeper, the
 * cranker, the series resolver's symbol set, and the on-chain catalog scans.
 * `markets` (all of them, live and not) is for DISPLAY only.
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
