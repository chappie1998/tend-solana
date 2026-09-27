import type { Program } from "@anchor-lang/core";
import type { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { Vsol } from "../../target/types/vsol.ts";
// Reuses the app's provider-neutral market-data entry point rather than
// writing a second HTTP client here (or hardcoding one provider). Every live
// market on this deployment routes through the SAME per-category dispatch
// the app and the quote path use (see app/lib/market-data.ts's own header):
// crypto reads Coinbase (or Pyth, via MARKET_DATA_PROVIDER), stocks always
// read Hyperliquid's "xyz" dex. Nothing here may ever call a single provider
// directly -- see app/lib/market-data.ts's own header for why.
import { getMarketSnapshot } from "../../../app/lib/market-data.ts";
import type { Market } from "../../../app/lib/markets.ts";
import { deriveCustomPriceFeed, PRICE_SCALE } from "../../sdk/index.ts";

// Shared library for the off-chain half of the custom-oracle backup/demo
// settlement path (`CustomPriceFeed` in vsol/programs/vsol/src/lib.rs).
//
// This used to be vsol/scripts/custom-oracle-pusher.ts's OWN module: a
// standalone process that pushed every live symbol's price on a 60-second
// forever-loop, whether or not anything was expiring. That pusher is retired
// (see oracle-runner.ts's module doc for the full rationale -- $340/mo in
// mainnet tx fees, RPC quota exhaustion from a 5-second settlement poller
// running alongside it, AND unreliable: a 60s cadence can miss an intraday
// market's 60-second observation window entirely). `pushOneSymbol` and its
// snapshot validation survive here as a plain library function:
// `oracle-runner.ts` calls it (via `fetchSettlementSnapshot` below) only when
// a market is actually about to need a price, never on a fixed clock.
export const MAX_SOURCE_AGE_SECONDS = 30;
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Rounds a human spot price/confidence to the nearest `PRICE_SCALE` atom -- the same rounding convention `toPoolAtoms` uses in app/lib/vsol-server.ts. */
export function toPriceScaleAtoms(humanAmount: number): bigint {
  return BigInt(Math.round(humanAmount * Number(PRICE_SCALE)));
}

export async function pushOneSymbol(params: {
  program: Program<Vsol>;
  authority: Keypair;
  config: PublicKey;
  market: Market;
}): Promise<void> {
  const { program, authority, config, market } = params;
  const feed = deriveCustomPriceFeed(market.symbol);
  const snapshot = await getMarketSnapshot(market);
  if (snapshot.mode !== "live" || snapshot.ageSeconds > MAX_SOURCE_AGE_SECONDS) {
    throw new Error(`${snapshot.source} snapshot is ${snapshot.mode} (${snapshot.ageSeconds}s old)`);
  }
  if (!Number.isSafeInteger(snapshot.publishTime) || snapshot.publishTime <= 0) {
    throw new Error(`${snapshot.source} returned an invalid observation timestamp`);
  }
  const price = toPriceScaleAtoms(snapshot.price);
  // `confidence` is always a non-negative, human-scale dispersion proxy
  // regardless of which provider produced the snapshot -- half the live
  // bid/ask spread for Coinbase, |mark - oracle| for Hyperliquid
  // (see MarketSnapshot's doc comment in app/lib/market-data-types.ts) --
  // never a Pyth-style confidence interval, but always a real, roundable
  // number. The `Math.max(0, ...)` stays defensive rather than provider-
  // specific: neither provider's parser can hand back a negative value
  // today, but nothing here should trust that invariant blindly either.
  const confidence = toPriceScaleAtoms(Math.max(0, snapshot.confidence));
  if (price <= 0n) {
    throw new Error(`${snapshot.source} returned a non-positive price for ${market.symbol} (${snapshot.price})`);
  }

  const signature = await program.methods
    .updateCustomPriceFeed(
      new BN(price.toString()),
      new BN(confidence.toString()),
      new BN(snapshot.publishTime),
    )
    .accountsStrict({
      oracleAuthority: authority.publicKey,
      config,
      feed,
    })
    .rpc();

  console.log(
    `pushed: ${market.symbol} price $${snapshot.price} (${price.toString()} atoms), confidence ${confidence.toString()} atoms (signature ${signature})`,
  );
}

export function classifyPushFailure(error: unknown, secret: string): { duplicateTimestamp: boolean; message: string } {
  const code = error && typeof error === "object" && "error" in error
    ? (error as { error?: { errorCode?: { code?: string } } }).error?.errorCode?.code
    : undefined;
  const message = (error instanceof Error ? error.message : String(error)).split(secret).join("[redacted]");
  return { duplicateTimestamp: code === "CustomFeedTimestampNotIncreasing", message };
}

// --- Expiry-aware snapshot fetch (oracle-runner.ts's capture trigger) -------
//
// `pushOneSymbol` above answers "push whatever the provider has right now".
// The runner needs something slightly stronger at the moment a market
// expires: a snapshot whose `publishTime` is AT OR AFTER that market's own
// `expiry`, since `capture_custom_settlement_observation` rejects an
// observation whose `published_at` predates `market.expiry`
// (`InvalidObservationTime` -- see the require! in
// vsol/programs/vsol/src/lib.rs). A provider's last tick can trail real time
// by a few seconds (Coinbase's `publishTime` is the last trade's own
// timestamp, not the HTTP fetch time), so immediately after expiry that tick
// can still be a hair earlier than `expiry`. This retries a SHORT, bounded
// number of times rather than failing the market outright -- by construction
// every retry only pushes `publishTime` closer to "now", which is always
// eventually >= `expiry` once `now >= expiry` (the only state the runner ever
// calls this from).
export type SettlementSnapshotResult =
  | { ok: true; price: bigint; confidence: bigint; publishTime: number; source: string }
  | { ok: false; reason: string };

export const SETTLEMENT_SNAPSHOT_MAX_ATTEMPTS = 5;
export const SETTLEMENT_SNAPSHOT_RETRY_DELAY_MS = 2_000;

/**
 * Fetches a settlement-worthy snapshot for `market`, retrying while the
 * source's own `publishTime` still predates `expiry`. Pure apart from its two
 * injected effects (`fetchSnapshot`/`sleep`), so it is directly unit-testable
 * with a fake provider and an instant fake sleep -- no real network or timer
 * needed (see tests/oracle-feed-snapshot.test.ts).
 */
export async function fetchSettlementSnapshot(params: {
  market: Market;
  expiry: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchSnapshot?: (market: Market) => Promise<Awaited<ReturnType<typeof getMarketSnapshot>>>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SettlementSnapshotResult> {
  const maxAttempts = params.maxAttempts ?? SETTLEMENT_SNAPSHOT_MAX_ATTEMPTS;
  const retryDelayMs = params.retryDelayMs ?? SETTLEMENT_SNAPSHOT_RETRY_DELAY_MS;
  const fetchSnapshot = params.fetchSnapshot ?? getMarketSnapshot;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));

  let lastReason = "no attempt was made";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>;
    try {
      snapshot = await fetchSnapshot(params.market);
    } catch (error) {
      lastReason = `${params.market.symbol} snapshot fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
      continue;
    }
    if (snapshot.mode !== "live" || snapshot.ageSeconds > MAX_SOURCE_AGE_SECONDS) {
      lastReason = `${snapshot.source} snapshot is ${snapshot.mode} (${snapshot.ageSeconds}s old)`;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
      continue;
    }
    if (!Number.isSafeInteger(snapshot.publishTime) || snapshot.publishTime <= 0) {
      lastReason = `${snapshot.source} returned an invalid observation timestamp`;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
      continue;
    }
    if (snapshot.publishTime < params.expiry) {
      lastReason = `${snapshot.source} publish time ${snapshot.publishTime} is still before expiry ${params.expiry}`;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
      continue;
    }
    const price = toPriceScaleAtoms(snapshot.price);
    if (price <= 0n) {
      lastReason = `${snapshot.source} returned a non-positive price for ${params.market.symbol} (${snapshot.price})`;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
      continue;
    }
    const confidence = toPriceScaleAtoms(Math.max(0, snapshot.confidence));
    return { ok: true, price, confidence, publishTime: snapshot.publishTime, source: snapshot.source };
  }
  return { ok: false, reason: `${lastReason} (${maxAttempts} attempt(s))` };
}
