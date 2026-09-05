// Resolves the rolling VSOL series catalog straight from chain instead of a
// checked-in manifest. A keeper mints fresh 15M/1H/EOD/7D/30D grid rungs
// continuously, so a static JSON snapshot goes stale within minutes.
//
// This module is NOT pure and DOES make RPC calls -- unlike its previous
// incarnation, which only ever computed one deterministic candidate address
// per (symbol, code). Since strike moved onto a fixed listed ladder
// (STRIKE_LADDER_STEP / ladderStrike, see vsol/sdk/index.ts) rather than
// being derivable from (symbol, code, now) alone, there can be several
// strikes live at the same expiry -- the market id hashes `strike` in (see
// expected_market_id in vsol/programs/vsol/src/lib.rs), so two strikes at
// one expiry are different contracts, not duplicates of one "true" market.
// The only way to find out which strikes are actually listed is to ask
// chain: this module now does a single `getProgramAccounts` scan (via
// app/lib/vsol-market-accounts.ts's fetchAllVsolMarkets/decodeMarketAccount
// -- the exact decoding path app/lib/chain-catalog.ts's own market scan
// already used, reused here rather than written a third time) and matches
// the result against each grid slot's expiry/policy fingerprint.
//
// Three families of exports:
//
//   - Discovery (resolveVsolSeries / resolveVsolSeriesStrikes /
//     resolveVsolSeriesCatalog / resolveAvailableVsolSeries): find series
//     that are ALREADY listed on chain. resolveVsolSeries picks the
//     at-the-money strike (nearest live spot) so single-series call sites
//     keep working with zero behavior surprises; resolveVsolSeriesStrikes
//     returns every listed strike for one grid slot, ordered ascending --
//     the shape a future strike-picker UI needs. A grid slot with nothing
//     listed yet resolves `{ available: false, reason }`, same as any other
//     unavailable reason -- it never throws, and it never invents an
//     address for a market that does not exist on chain.
//
//   - Pure candidate prediction (deriveVsolSeriesCandidate): the opposite
//     job -- given a strike the CALLER has already chosen (typically
//     `ladderStrike(spot)`, see vsol/sdk/index.ts), predicts the market/
//     oracle PDAs a NEW listing at that strike would get, using the exact
//     same deterministic derivation the on-chain factory uses
//     (deriveMarketId). No RPC. This is what the three callers that are
//     about to CREATE a series -- Launch-a-series (app/lib/vsol-launch.ts),
//     the mint-on-demand quote path, and its signed-transaction inspector
//     (both app/lib/vsol-server.ts) -- use instead of discovery: there is
//     nothing to discover for a series that does not exist yet.
//
//   - Composition (resolveOrPlanVsolSeries / findVsolSeriesCandidateForMarket):
//     glue the two together for the mint-on-demand flow specifically. See
//     each function's own doc comment.
//
// The explicit .ts extensions on internal imports keep this module directly
// importable by the node:test suite (type stripping) as well as the bundler,
// matching the convention already used by app/lib/launch-params.ts.
//
// Every discovery function accepts an optional trailing `deps` object
// (`{ connection?, fetchSpot? }`) purely so tests can inject a stub
// connection and a canned spot price instead of hitting devnet RPC / Pyth
// Hermes -- see tests/helpers/vsol-market-fixture.mjs and
// tests/series-resolver.test.mjs. Every production call site omits `deps`
// and gets the real connection/Hermes-backed defaults below.

import { Connection, PublicKey } from "@solana/web3.js";
import { deriveMarket, deriveMarketId, deriveOracle, ladderStrike, PRICE_SCALE, symbolBytes } from "../../vsol/sdk/index.ts";
import { VSOL_CONFIG, VSOL_PROGRAM_ID, VSOL_RPC_URL, VSOL_SETTLEMENT_MINT } from "./vsol.ts";
import { runtimeEnv } from "./runtime-env.ts";
import { deriveLaunchSeriesParams, type LaunchSeriesParams } from "./launch-params.ts";
import { expiryCodes, type ExpiryCode } from "./expiries.ts";
import { marketBySymbol, pythFeedIdFor, strikeLadderStepFor } from "./markets.ts";
import { getPythSnapshot } from "./pyth-market-data.ts";
import { fetchAllVsolMarkets, type DiscoveredVsolMarket } from "./vsol-market-accounts.ts";

export type ResolvedVsolSeries = {
  symbol: string;
  code: ExpiryCode;
  marketKey: PublicKey;
  oracleKey: PublicKey;
  // The listed ladder rung this series actually binds to (or, for a
  // not-yet-minted candidate from deriveVsolSeriesCandidate/
  // resolveOrPlanVsolSeries, the rung a new listing WOULD bind to). Always a
  // real, chosen value now -- never the old fabricated placeholder.
  strike: bigint;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  lastTradeAt: number;
  maxSettlementStalenessSeconds: number;
};

export type VsolSeriesResolution =
  | { symbol: string; code: ExpiryCode; available: true; series: ResolvedVsolSeries; strikeSelectionNote: string }
  | { symbol: string; code: ExpiryCode; available: false; reason: string };

export type VsolSeriesListResolution =
  | { symbol: string; code: ExpiryCode; available: true; series: ResolvedVsolSeries[] }
  | { symbol: string; code: ExpiryCode; available: false; reason: string };

// Distinguishes "the grid slot itself is invalid" (no intraday feed, too
// close to cutoff, ...) from "the grid slot is fine but nobody has listed a
// strike for it yet" -- resolveOrPlanVsolSeries and
// findVsolSeriesCandidateForMarket key off this exact string to decide
// whether predicting a brand-new at-the-money listing makes sense.
export const SERIES_NOT_YET_LISTED_REASON = "No series has been listed for this expiry yet.";

export type VsolDiscoveryDeps = {
  connection?: Connection;
  // Returns live spot for `symbol` in whole-dollar units (the same
  // convention as PythMarketSnapshot.price). Injectable purely for tests;
  // every production call site omits this and gets the real Hermes-backed
  // getPythSnapshot below.
  fetchSpot?: (symbol: string) => Promise<number>;
};

function defaultConnection(): Connection {
  // A tiny, local equivalent of app/lib/vsol-server.ts's getVsolConnection --
  // reproduced here (not imported) because vsol-server.ts imports FROM this
  // module (for resolveVsolSeries et al), so the reverse import would be
  // circular.
  return new Connection(runtimeEnv("VSOL_RPC_URL") || VSOL_RPC_URL, "confirmed");
}

async function defaultFetchSpot(symbol: string): Promise<number> {
  const market = marketBySymbol(symbol);
  if (!market) throw new Error(`No market metadata is configured for ${symbol}`);
  const snapshot = await getPythSnapshot(market);
  return snapshot.price;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function matchesSlot(entry: DiscoveredVsolMarket, params: LaunchSeriesParams): boolean {
  const market = entry.market;
  // The feed comes from THIS symbol's market config, not from the
  // deployment manifest's single `pythFeedId`. That manifest field described
  // the one market this deployment used to have; matching every symbol
  // against it would make a BTC or ETH rung -- correctly minted, live on
  // chain -- fail to match its own grid slot and vanish from the app.
  return market.config.equals(VSOL_CONFIG)
    && market.settlementMint.equals(VSOL_SETTLEMENT_MINT)
    && market.pythFeedId.toLowerCase() === pythFeedIdFor(params.symbol).toLowerCase()
    && market.symbol.toUpperCase() === params.symbol
    && market.priceScale === params.priceScale
    && market.maxConfidenceBps === params.maxConfidenceBps
    && market.observationWindowSeconds === params.observationWindowSeconds
    && market.settlementGraceSeconds === params.settlementGraceSeconds
    && market.maxSettlementStalenessSeconds === params.maxSettlementStalenessSeconds
    && market.expiry === params.expiry;
}

function toResolvedSeries(entry: DiscoveredVsolMarket, params: LaunchSeriesParams): ResolvedVsolSeries {
  return {
    symbol: params.symbol,
    code: params.code,
    marketKey: entry.address,
    // Read back directly from the account rather than re-derived: it is the
    // account's own recorded truth, and re-deriving would just recompute the
    // same PDA from fields this function already trusts.
    oracleKey: entry.market.oracle,
    strike: entry.market.strike,
    expiry: params.expiry,
    observationWindowSeconds: params.observationWindowSeconds,
    settlementGraceSeconds: params.settlementGraceSeconds,
    lastTradeAt: params.lastTradeAt,
    maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
  };
}

function formatDollars(atoms: bigint): string {
  return (Number(atoms) / Number(PRICE_SCALE)).toFixed(2);
}

/**
 * Picks the at-the-money candidate from `candidates` (all already confirmed
 * to belong to the same grid slot): the one whose strike is nearest live
 * spot. Falls back to the (lower) median listed strike -- a deterministic,
 * spot-independent choice -- when spot cannot be fetched, rather than
 * failing the whole resolution; either way the returned note says which
 * rule was used, so a caller inspecting the resolution knows this was a
 * judgment call, not a guarantee.
 */
async function pickAtTheMoney(
  symbol: string,
  candidates: ResolvedVsolSeries[],
  fetchSpot: (symbol: string) => Promise<number>,
): Promise<{ series: ResolvedVsolSeries; note: string }> {
  const sorted = [...candidates].sort((a, b) => (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));
  if (sorted.length === 1) {
    return { series: sorted[0], note: `Only one strike ($${formatDollars(sorted[0].strike)}) is currently listed at this expiry.` };
  }
  try {
    const spot = await fetchSpot(symbol);
    if (!Number.isFinite(spot) || spot <= 0) throw new Error("Pyth returned an invalid spot price");
    const spotAtoms = BigInt(Math.round(spot * Number(PRICE_SCALE)));
    let best = sorted[0];
    let bestDiff = absDiff(best.strike, spotAtoms);
    for (const candidate of sorted.slice(1)) {
      const diff = absDiff(candidate.strike, spotAtoms);
      if (diff < bestDiff) {
        best = candidate;
        bestDiff = diff;
      }
    }
    return { series: best, note: `At-the-money: nearest of ${sorted.length} listed strikes to live spot ($${spot.toFixed(2)}).` };
  } catch {
    const medianIndex = Math.floor((sorted.length - 1) / 2);
    return {
      series: sorted[medianIndex],
      note: `Live spot price is unavailable; used the median of ${sorted.length} listed strikes ($${formatDollars(sorted[medianIndex].strike)}) as a deterministic fallback.`,
    };
  }
}

async function resolveSlot(
  symbol: string,
  code: ExpiryCode,
  nowMs: number,
  discovered: DiscoveredVsolMarket[],
  fetchSpot: (symbol: string) => Promise<number>,
): Promise<VsolSeriesResolution> {
  const normalizedSymbol = symbol.toUpperCase();
  try {
    // Reuses the exact UTC-boundary grid math (resolveExpiry) and the exact
    // policy constants (observation window, settlement grace, confidence,
    // price scale, max settlement staleness) the launch/bootstrap flows use —
    // see app/lib/launch-params.ts. This is the parity guarantee: as long as
    // both this resolver and the launch flow call deriveLaunchSeriesParams,
    // they cannot independently drift on what a given (symbol, code, now)
    // triple means.
    const params = deriveLaunchSeriesParams(code, normalizedSymbol, nowMs);
    const candidates = discovered.filter((entry) => matchesSlot(entry, params)).map((entry) => toResolvedSeries(entry, params));
    if (candidates.length === 0) {
      return { symbol: params.symbol, code: params.code, available: false, reason: SERIES_NOT_YET_LISTED_REASON };
    }
    const { series, note } = await pickAtTheMoney(normalizedSymbol, candidates, fetchSpot);
    return { symbol: params.symbol, code: params.code, available: true, series, strikeSelectionNote: note };
  } catch (error) {
    return {
      symbol: normalizedSymbol,
      code,
      available: false,
      reason: error instanceof Error ? error.message : "This series is not currently available.",
    };
  }
}

async function resolveSlotStrikes(
  symbol: string,
  code: ExpiryCode,
  nowMs: number,
  discovered: DiscoveredVsolMarket[],
): Promise<VsolSeriesListResolution> {
  const normalizedSymbol = symbol.toUpperCase();
  try {
    const params = deriveLaunchSeriesParams(code, normalizedSymbol, nowMs);
    const candidates = discovered.filter((entry) => matchesSlot(entry, params)).map((entry) => toResolvedSeries(entry, params))
      .sort((a, b) => (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));
    if (candidates.length === 0) {
      return { symbol: params.symbol, code: params.code, available: false, reason: SERIES_NOT_YET_LISTED_REASON };
    }
    return { symbol: params.symbol, code: params.code, available: true, series: candidates };
  } catch (error) {
    return {
      symbol: normalizedSymbol,
      code,
      available: false,
      reason: error instanceof Error ? error.message : "This series is not currently available.",
    };
  }
}

/**
 * Resolves `symbol` + `code` to the at-the-money listed series (the strike
 * nearest live spot) for the current grid slot at `nowMs`. Never throws: a
 * code the grid currently rules out (e.g. no verified intraday feed, or too
 * close to its trade cutoff), or one nobody has listed a strike for yet,
 * resolves to `{ available: false, reason }` instead. Does a single
 * `getProgramAccounts` scan per call -- see resolveVsolSeriesCatalog for the
 * many-slot version that shares one scan across every (symbol, code) pair.
 */
export async function resolveVsolSeries(symbol: string, code: ExpiryCode, nowMs: number = Date.now(), deps: VsolDiscoveryDeps = {}): Promise<VsolSeriesResolution> {
  const connection = deps.connection ?? defaultConnection();
  const fetchSpot = deps.fetchSpot ?? defaultFetchSpot;
  const discovered = await fetchAllVsolMarkets(connection, VSOL_PROGRAM_ID);
  return resolveSlot(symbol, code, nowMs, discovered, fetchSpot);
}

/**
 * Resolves every listed strike for `symbol` + `code` at `nowMs`, ordered
 * ascending by strike -- the full, honest shape of the ladder at this grid
 * slot. This is what a future strike-picker UI needs (out of scope for this
 * change: this function only exposes the data). Never throws; unavailable
 * exactly like resolveVsolSeries.
 */
export async function resolveVsolSeriesStrikes(symbol: string, code: ExpiryCode, nowMs: number = Date.now(), deps: VsolDiscoveryDeps = {}): Promise<VsolSeriesListResolution> {
  const connection = deps.connection ?? defaultConnection();
  const discovered = await fetchAllVsolMarkets(connection, VSOL_PROGRAM_ID);
  return resolveSlotStrikes(symbol, code, nowMs, discovered);
}

/**
 * Resolves the full rolling grid (every expiry code) for each symbol in
 * `symbols`, at `nowMs`, picking the at-the-money strike per slot. Includes
 * resolution-level unavailable entries (with a reason) rather than dropping
 * them — callers decide how to surface those. Fetches markets from chain
 * exactly ONCE for the whole batch (not once per slot), regardless of how
 * many symbols/codes are requested.
 */
export async function resolveVsolSeriesCatalog(symbols: string[], nowMs: number = Date.now(), deps: VsolDiscoveryDeps = {}): Promise<VsolSeriesResolution[]> {
  const connection = deps.connection ?? defaultConnection();
  const fetchSpot = deps.fetchSpot ?? defaultFetchSpot;
  const discovered = await fetchAllVsolMarkets(connection, VSOL_PROGRAM_ID);
  return Promise.all(symbols.flatMap((symbol) => expiryCodes.map((code) => resolveSlot(symbol, code, nowMs, discovered, fetchSpot))));
}

/**
 * Convenience: every currently listed series across `symbols`' rolling grid —
 * ALL listed strikes at every slot, not just the at-the-money pick. This
 * (deliberately) differs from resolveVsolSeriesCatalog's one-per-slot ATM
 * selection: every existing caller of this function (app/lib/chain-catalog.ts,
 * app/lib/chain-positions.ts, and vsol-server.ts's inspectVsolFillTransaction)
 * needs to match an arbitrary on-chain pubkey against ANY currently-listed
 * grid market, not just the ATM one — a fill or a position can target a
 * non-ATM strike once more than one rung is listed at an expiry, and an
 * ATM-only set would silently mislabel or reject those. One chain scan for
 * the whole batch, same as resolveVsolSeriesCatalog.
 */
export async function resolveAvailableVsolSeries(symbols: string[], nowMs: number = Date.now(), deps: VsolDiscoveryDeps = {}): Promise<ResolvedVsolSeries[]> {
  const connection = deps.connection ?? defaultConnection();
  const discovered = await fetchAllVsolMarkets(connection, VSOL_PROGRAM_ID);
  const results: ResolvedVsolSeries[] = [];
  for (const symbol of symbols) {
    const normalizedSymbol = symbol.toUpperCase();
    for (const code of expiryCodes) {
      let params: LaunchSeriesParams;
      try {
        params = deriveLaunchSeriesParams(code, normalizedSymbol, nowMs);
      } catch {
        continue; // This grid slot is invalid for this symbol; nothing to list.
      }
      for (const entry of discovered) {
        if (matchesSlot(entry, params)) results.push(toResolvedSeries(entry, params));
      }
    }
  }
  return results;
}

/**
 * Pure, no RPC: predicts the market/oracle PDAs a NEW listing at `strike`
 * would get for this (symbol, code) grid slot, using the exact same
 * deterministic derivation the on-chain factory uses (deriveMarketId). Used
 * only by the three callers that are about to CREATE a series -- Launch-a-
 * series (app/lib/vsol-launch.ts), the mint-on-demand quote path, and its
 * signed-transaction inspector (both app/lib/vsol-server.ts) -- which choose
 * `strike` themselves (typically `ladderStrike(spot)`, see
 * vsol/sdk/index.ts) rather than discovering one that already exists. Throws
 * exactly when the grid slot itself is invalid (same cases
 * deriveLaunchSeriesParams throws for) -- never confuse this function's
 * output with resolveVsolSeries's: this is a PREDICTION for a market that
 * may not exist on chain yet, not a verified, already-listed series.
 */
export async function deriveVsolSeriesCandidate(symbol: string, code: ExpiryCode, nowMs: number, strike: bigint): Promise<ResolvedVsolSeries> {
  const normalizedSymbol = symbol.toUpperCase();
  const params = deriveLaunchSeriesParams(code, normalizedSymbol, nowMs);
  const marketId = await deriveMarketId({
    // Per-symbol, for the same reason matchesSlot is: predicting a BTC
    // listing's PDA from SOL's feed yields an address nothing will ever mint.
    pythFeedId: Buffer.from(pythFeedIdFor(normalizedSymbol), "hex"),
    settlementMint: VSOL_SETTLEMENT_MINT,
    expiry: BigInt(params.expiry),
    observationWindowSeconds: params.observationWindowSeconds,
    settlementGraceSeconds: params.settlementGraceSeconds,
    priceScale: params.priceScale,
    maxConfidenceBps: params.maxConfidenceBps,
    symbol: symbolBytes(params.symbol),
    maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
    strike,
  });
  const marketKey = deriveMarket(VSOL_CONFIG, marketId, VSOL_PROGRAM_ID);
  const oracleKey = deriveOracle(marketKey, VSOL_PROGRAM_ID);
  return {
    symbol: params.symbol,
    code: params.code,
    marketKey,
    oracleKey,
    strike,
    expiry: params.expiry,
    observationWindowSeconds: params.observationWindowSeconds,
    settlementGraceSeconds: params.settlementGraceSeconds,
    lastTradeAt: params.lastTradeAt,
    maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
  };
}

/**
 * Like resolveVsolSeries, but when the grid slot is valid and simply has no
 * strike listed yet, predicts where a BRAND NEW listing at the live
 * at-the-money ladder rung (ladderStrike(spot), see vsol/sdk/index.ts) would
 * land, instead of reporting unavailable. This is what lets
 * buildVsolQuoteTransaction's mint-on-demand path (app/lib/vsol-server.ts)
 * work for a symbol/expiry nobody has listed yet: the buyer becomes that
 * listing's creator, paying its rent as part of their own fill. A grid slot
 * that is invalid for another reason (no intraday feed, too close to
 * cutoff, spot itself unavailable, ...) still resolves unavailable exactly
 * as resolveVsolSeries does -- this never invents a series for a slot the
 * grid itself rules out, and it never overrides an ALREADY-listed strike
 * with a freshly-planned one.
 */
export async function resolveOrPlanVsolSeries(symbol: string, code: ExpiryCode, nowMs: number = Date.now(), deps: VsolDiscoveryDeps = {}): Promise<VsolSeriesResolution> {
  const resolution = await resolveVsolSeries(symbol, code, nowMs, deps);
  if (resolution.available || resolution.reason !== SERIES_NOT_YET_LISTED_REASON) return resolution;
  const fetchSpot = deps.fetchSpot ?? defaultFetchSpot;
  try {
    const spot = await fetchSpot(symbol);
    if (!Number.isFinite(spot) || spot <= 0) throw new Error("Pyth returned an invalid spot price");
    const spotAtoms = BigInt(Math.round(spot * Number(PRICE_SCALE)));
    // This symbol's own ladder step -- see `strikeLadderStep` in
    // app/lib/markets.ts. Rounding BTC onto SOL's $2.50 step would plan a
    // listing on a rung the keeper will never mint.
    const strike = ladderStrike(spotAtoms, strikeLadderStepFor(symbol));
    const series = await deriveVsolSeriesCandidate(symbol, code, nowMs, strike);
    return {
      symbol: series.symbol,
      code: series.code,
      available: true,
      series,
      strikeSelectionNote: `No series is listed yet; planned a new listing at the live at-the-money ladder rung ($${formatDollars(strike)}).`,
    };
  } catch {
    // Spot unavailable (or the grid slot rejected the candidate for some
    // other reason) -- report the original discovery-side reason honestly
    // rather than inventing a series with no real strike behind it.
    return resolution;
  }
}

/**
 * Used only by inspectVsolFillTransaction's mint-and-fill verification
 * (app/lib/vsol-server.ts): a signed transaction that mints its own market
 * has no discovered series to match against yet -- the market does not
 * exist on chain until this exact transaction lands -- so this tries every
 * (symbol, code) grid slot's would-be at-the-money candidate (the same
 * ladderStrike(spot) rule resolveOrPlanVsolSeries applies for a live quote)
 * and returns whichever one's predicted market PDA equals `market`. Never
 * throws: a symbol/code whose spot lookup fails, or whose grid slot is
 * invalid, is simply skipped rather than aborting the whole search.
 */
export async function findVsolSeriesCandidateForMarket(
  symbols: string[],
  market: PublicKey,
  nowMs: number = Date.now(),
  deps: VsolDiscoveryDeps = {},
): Promise<ResolvedVsolSeries | null> {
  const fetchSpot = deps.fetchSpot ?? defaultFetchSpot;
  for (const symbol of symbols) {
    let spotAtoms: bigint;
    try {
      const spot = await fetchSpot(symbol);
      if (!Number.isFinite(spot) || spot <= 0) throw new Error("Pyth returned an invalid spot price");
      spotAtoms = BigInt(Math.round(spot * Number(PRICE_SCALE)));
    } catch {
      continue;
    }
    const strike = ladderStrike(spotAtoms, strikeLadderStepFor(symbol));
    for (const code of expiryCodes) {
      try {
        const candidate = await deriveVsolSeriesCandidate(symbol, code, nowMs, strike);
        if (candidate.marketKey.equals(market)) return candidate;
      } catch {
        // Invalid grid slot for this symbol/code combination; skip.
      }
    }
  }
  return null;
}
