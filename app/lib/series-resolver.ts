// Resolves the rolling VSOL series catalog straight from chain instead of a
// checked-in manifest. A keeper mints fresh 15M/1H/EOD/7D/30D grid rungs
// continuously, so a static JSON snapshot goes stale within minutes; instead,
// for a given symbol + expiry code, this module recomputes the exact series
// parameters the keeper/bootstrap scripts use (see app/lib/launch-params.ts)
// and derives the deterministic market id the on-chain factory itself uses
// (vsol/sdk's `deriveMarketId`), so the app always points at the market that
// SHOULD exist for the current UTC grid boundary — never a stale address.
//
// This module is intentionally chain-agnostic and pure (no RPC calls): it
// only computes candidate addresses. Verifying that a candidate actually
// exists on-chain, is owned by the program, and binds exactly to these same
// parameters is app/lib/vsol-server.ts's job (getVsolSeriesState) — that
// verification is unchanged by this module's existence.
//
// The explicit .ts extensions on internal imports keep this module directly
// importable by the node:test suite (type stripping) as well as the bundler,
// matching the convention already used by app/lib/launch-params.ts.

import { PublicKey } from "@solana/web3.js";
import { deriveMarket, deriveMarketId, deriveOracle, symbolBytes } from "../../vsol/sdk/index.ts";
import { VSOL_CONFIG, VSOL_PROGRAM_ID, VSOL_PYTH_FEED_ID, VSOL_SETTLEMENT_MINT } from "./vsol.ts";
import { deriveLaunchSeriesParams } from "./launch-params.ts";
import { expiryCodes, type ExpiryCode } from "./expiries.ts";

export type ResolvedVsolSeries = {
  symbol: string;
  code: ExpiryCode;
  marketKey: PublicKey;
  oracleKey: PublicKey;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  lastTradeAt: number;
  maxSettlementStalenessSeconds: number;
};

export type VsolSeriesResolution =
  | { symbol: string; code: ExpiryCode; available: true; series: ResolvedVsolSeries }
  | { symbol: string; code: ExpiryCode; available: false; reason: string };

/**
 * Resolves `symbol` + `code` to the deterministic market/oracle PDAs the
 * on-chain factory would assign a series with these exact parameters at
 * `nowMs`. Never throws: a code that the grid currently rules out (e.g. no
 * verified intraday feed, or too close to its trade cutoff) resolves to
 * `{ available: false, reason }` instead.
 */
export async function resolveVsolSeries(symbol: string, code: ExpiryCode, nowMs: number = Date.now()): Promise<VsolSeriesResolution> {
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
    const marketId = await deriveMarketId({
      pythFeedId: Buffer.from(VSOL_PYTH_FEED_ID, "hex"),
      settlementMint: VSOL_SETTLEMENT_MINT,
      expiry: BigInt(params.expiry),
      observationWindowSeconds: params.observationWindowSeconds,
      settlementGraceSeconds: params.settlementGraceSeconds,
      priceScale: params.priceScale,
      maxConfidenceBps: params.maxConfidenceBps,
      symbol: symbolBytes(params.symbol),
      maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
    });
    const marketKey = deriveMarket(VSOL_CONFIG, marketId, VSOL_PROGRAM_ID);
    const oracleKey = deriveOracle(marketKey, VSOL_PROGRAM_ID);
    return {
      symbol: params.symbol,
      code: params.code,
      available: true,
      series: {
        symbol: params.symbol,
        code: params.code,
        marketKey,
        oracleKey,
        expiry: params.expiry,
        observationWindowSeconds: params.observationWindowSeconds,
        settlementGraceSeconds: params.settlementGraceSeconds,
        lastTradeAt: params.lastTradeAt,
        maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
      },
    };
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
 * Resolves the full rolling grid (every expiry code) for each symbol in
 * `symbols`, at `nowMs`. Includes resolution-level unavailable entries (with
 * a reason) rather than dropping them — callers decide how to surface those.
 */
export async function resolveVsolSeriesCatalog(symbols: string[], nowMs: number = Date.now()): Promise<VsolSeriesResolution[]> {
  return Promise.all(symbols.flatMap((symbol) => expiryCodes.map((code) => resolveVsolSeries(symbol, code, nowMs))));
}

/** Convenience: only the resolutions that currently derive a candidate series. */
export async function resolveAvailableVsolSeries(symbols: string[], nowMs: number = Date.now()): Promise<ResolvedVsolSeries[]> {
  const resolutions = await resolveVsolSeriesCatalog(symbols, nowMs);
  const available: ResolvedVsolSeries[] = [];
  for (const resolution of resolutions) {
    if (resolution.available) available.push(resolution.series);
  }
  return available;
}
