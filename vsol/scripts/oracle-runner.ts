import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { getClockUnixTimestamp } from "../../app/lib/solana-clock.ts";
import { marketBySymbol } from "../../app/lib/markets.ts";
import { runMarketCleanup, type Counters as CleanupCounters } from "./cranker.ts";
import { DEVNET_GENESIS_HASH, fetchSettlementSnapshot } from "./lib/oracle-feed.ts";
import { publishHeartbeat } from "./lib/heartbeat.ts";
import { acquireRunnerLease, runSerializedLane } from "./lib/lane.ts";
import { BackoffController } from "./lib/backoff.ts";
import { FIFTEEN_MINUTES_MS, nextFifteenMinuteBoundary } from "./lib/expiry-boundary.ts";
import { selectExpiredMarketsWithOpenInterest, selectMarketsAtBoundaryWithOpenInterest } from "./lib/market-selection.ts";
import { sendPublishAndCaptureTransaction } from "./lib/publish-capture-transaction.ts";
import { runFullSettlementPass } from "./lib/settlement-sweep.ts";
import { RpcCallCounter } from "./lib/rpc-call-counter.ts";
import {
  describeSettlementError,
  fetchAllMarkets,
  fetchOpenDirectPositions,
  fetchOpenPoolPositions,
  marketsWithOpenPositions,
  redact,
  type DecodedMarketForCleanup,
} from "./lib/settlement.ts";
import { deriveConfig, deriveCustomPriceFeed, deriveCustomSettlementObservation, VSOL_PROGRAM_ID } from "../sdk/index.ts";

// ONE lifecycle engine for the custom oracle: publishes a price only when a
// settlement actually needs it, instead of the two processes this replaces:
//
//   * vsol/scripts/custom-oracle-pusher.ts (RETIRED) -- pushed every live
//     symbol's price every 60s, forever, whether or not anything was
//     expiring. On mainnet that projects to ~$340/month in transaction fees
//     for the pusher alone, for zero benefit on the (large) fraction of
//     symbol-ticks where nothing is settling.
//   * vsol/scripts/custom-settle.ts (RETIRED) -- polled every 5s with
//     `getProgramAccounts` scans looking for something to do. That 5-second
//     cadence is what exhausted this deployment's RPC provider quota.
//
// Both were also UNRELIABLE together: intraday markets (15M/1H/EOD) carry a
// 60-second observation window, and `capture_custom_settlement_observation`
// additionally requires the feed to be no more than
// `CUSTOM_OBSERVATION_MAX_CAPTURE_AGE_SECONDS` (30s) old at the moment of
// capture. A 60-second pusher tick can miss a 60-second window entirely,
// silently downgrading a settlement into a refund.
//
// This runner instead sleeps until the next 15-minute UTC boundary (every
// tenor's expiry lands on one -- verified computationally across 25,000
// sampled clock positions, see lib/expiry-boundary.ts's module doc), finds
// markets expiring at THAT exact instant with at least one open pool
// position, and for each one sends ONE transaction containing
// `update_custom_price_feed` immediately followed by
// `capture_custom_settlement_observation` (see
// lib/publish-capture-transaction.ts) -- bundling both in one transaction is
// what guarantees the fresh price lands inside the window and is captured
// well within the 30-second capture-age ceiling. A market with no open
// interest gets NOTHING published for it; that is the main source of the
// savings this runner exists for. `fill_pool_quote`/`fill_quote` never
// require a fresh feed (`CUSTOM_ORACLE_MAX_STALENESS_SECONDS` is enforced
// only inside `update_custom_price_feed` itself), so quoting/filling is
// entirely unaffected by feeds no longer being pushed continuously.
//
// Three independent lanes run concurrently (see lib/lane.ts's
// `runSerializedLane`, unchanged from the old custom-settle.ts, so a stalled
// lane can never starve another):
//   1. Boundary lane (every 15 minutes): capture+publish for due markets,
//      THEN a full publish_custom_settlement/settle/refund sweep over every
//      market and open position already fetched this pass (see
//      lib/settlement-sweep.ts) -- this is also where refunds that became due
//      get paid out, at the same low frequency.
//   2. Heartbeat lane (every 5 minutes): publishes the dedicated HEARTBEAT
//      feed (see lib/heartbeat.ts) so app/lib/custom-oracle-readiness.ts can
//      answer "is this runner alive" without needing every symbol's price to
//      be continuously fresh.
//   3. Cleanup lane (hourly): calls cranker.ts's existing, guarded
//      `runMarketCleanup` unchanged -- closing a market has a 7-day buffer
//      before it is even eligible, so there is nothing to gain from running
//      this any more often.
//
// Frugal and crash-proof by design (see lib/backoff.ts): a transient RPC/
// network failure is logged and retried with growing (capped) backoff:
// only a startup failure (missing key, program not deployed, wrong cluster)
// exits the process.

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");

// A couple of seconds of slack after the boundary itself, so the wake always
// lands strictly after `market.expiry` on-chain (clock drift, scheduling
// jitter) rather than racing it.
const BOUNDARY_WAKE_OFFSET_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const CLEANUP_INTERVAL_MS = 60 * 60_000;
const RUNNER_LEASE_PORT = Number(process.env.VSOL_CUSTOM_ORACLE_LEASE_PORT ?? 47_653);

async function loadRequiredKeypair(name: string): Promise<Keypair> {
  const path = resolve(devnetDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Missing required signer "${name}" (expected ${path}). Run "npm run devnet:bootstrap" at least once first.`);
  }
  const secret = Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

type RunnerContext = {
  authority: Keypair;
  provider: AnchorProvider;
  program: Program<Vsol>;
  config: PublicKey;
};

function contextFor(authority: Keypair): RunnerContext {
  const provider = new AnchorProvider(connection, new AnchorWallet(authority), { commitment, preflightCommitment: commitment });
  return { authority, provider, program: new Program<Vsol>(idl, provider), config: deriveConfig() };
}

async function clusterUnixTime(): Promise<number> {
  return getClockUnixTimestamp(connection);
}

async function initializeRunner(): Promise<RunnerContext> {
  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) {
    throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  }
  if (cluster === "devnet" && await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
    throw new Error("Configured RPC is not Solana devnet");
  }
  const authority = await loadRequiredKeypair("devnet-custom-oracle-authority");
  return contextFor(authority);
}

/** Fetches the standard scan (all markets + both open-position account types) once, and returns everything downstream logic needs, so callers never issue a second `getProgramAccounts` round for the same pass. */
async function scanChainState(counter: RpcCallCounter) {
  const [markets, poolPositions, directPositions] = await Promise.all([
    fetchAllMarkets(connection),
    fetchOpenPoolPositions(connection),
    fetchOpenDirectPositions(connection),
  ]);
  counter.increment("getProgramAccounts", 3);
  return { markets, poolPositions, directPositions };
}

/** Fetches a fresh snapshot and sends the single publish+capture transaction for one due market. Fully isolated: any failure (provider outage, retry exhaustion, a losing race with another runner) is logged and skipped, never thrown, so one bad market can never take down the whole pass. */
async function captureMarketAtBoundary(context: RunnerContext, market: DecodedMarketForCleanup, counter: RpcCallCounter): Promise<void> {
  const liveMarket = marketBySymbol(market.symbol);
  if (!liveMarket) {
    console.log(`skip: capture for ${market.address} (${market.symbol}) -- no market config found for this symbol`);
    return;
  }
  const snapshotResult = await fetchSettlementSnapshot({ market: liveMarket, expiry: market.expiry });
  if (!snapshotResult.ok) {
    console.log(`skip: capture for ${market.address} (${market.symbol}) -- ${snapshotResult.reason} (the position will be refundable once its settlement deadline passes)`);
    return;
  }
  try {
    const signature = await sendPublishAndCaptureTransaction(context.provider, {
      program: context.program,
      accounts: {
        oracleAuthority: context.authority.publicKey,
        config: context.config,
        market: new PublicKey(market.address),
        feed: deriveCustomPriceFeed(market.symbol),
        observation: deriveCustomSettlementObservation(market.symbol, BigInt(market.expiry)),
      },
      price: snapshotResult.price,
      confidence: snapshotResult.confidence,
      observedAt: snapshotResult.publishTime,
    });
    counter.increment("send");
    console.log(
      `captured: ${market.symbol} expiry ${market.expiry} price ${snapshotResult.price.toString()} atoms ` +
        `via ${snapshotResult.source} (signature ${signature})`,
    );
  } catch (error) {
    console.log(
      `skip: capture for ${market.address} (${market.symbol}) -- ${describeSettlementError(error, rpcUrl)} ` +
        "(the position will be refundable once its settlement deadline passes)",
    );
  }
}

/**
 * One 15-minute pass: capture+publish every due market, then run the full
 * publish/settle/refund sweep (lib/settlement-sweep.ts) over everything
 * already fetched this pass. `dueMarketsSelector` is injected so the
 * one-time startup catch-up pass can reuse this exact function with the
 * broader `selectExpiredMarketsWithOpenInterest` selector instead of the
 * steady-state exact-boundary one.
 */
async function runBoundaryPass(
  context: RunnerContext,
  dueMarketsSelector: (params: { markets: readonly DecodedMarketForCleanup[]; marketsWithOpenPositions: ReadonlySet<string> }) => DecodedMarketForCleanup[],
): Promise<void> {
  const counter = new RpcCallCounter();
  const now = await clusterUnixTime();
  counter.increment("getAccountInfo");
  const { markets, poolPositions, directPositions } = await scanChainState(counter);
  const openPositionMarkets = marketsWithOpenPositions({ poolPositions, directPositions });
  const dueMarkets = dueMarketsSelector({ markets, marketsWithOpenPositions: openPositionMarkets });

  console.log(`boundary pass @ ${new Date(now * 1_000).toISOString()}: ${markets.length} market(s) on chain, ${dueMarkets.length} due with open interest`);
  for (const market of dueMarkets) {
    await captureMarketAtBoundary(context, market, counter);
  }

  const sweep = await runFullSettlementPass({
    connection,
    program: context.program,
    cranker: context.authority,
    config: context.config,
    rpcUrl,
    markets,
    poolPositions,
    directPositions,
    now,
  });
  // fetchCollateralVaultBalances + fetchOracleStates + config.fetch, all
  // getMultipleAccountsInfo-class lookups, never getProgramAccounts.
  counter.increment("getMultipleAccountsInfo", 3);

  console.log(
    `boundary pass summary: published ${sweep.published}, settled ${sweep.settled}, refunded ${sweep.refunded}, ` +
      `skipped ${sweep.skipped} -- ${counter.summary()}`,
  );
  if (sweep.operationalFailures > 0) throw new Error(`${sweep.operationalFailures} settlement operation(s) failed this pass`);
}

async function runHeartbeatPass(context: RunnerContext): Promise<void> {
  const now = await clusterUnixTime();
  const signature = await publishHeartbeat({ program: context.program, authority: context.authority, config: context.config, observedAt: now });
  console.log(`heartbeat: published at ${now} (signature ${signature})`);
}

async function runCleanupPass(context: RunnerContext): Promise<void> {
  const counters: CleanupCounters = { published: 0, settled: 0, refunded: 0, closed: 0, skipped: 0 };
  await runMarketCleanup({ connection, program: context.program, cranker: context.authority, config: context.config, counters });
  console.log(`cleanup pass: closed ${counters.closed} market(s), skipped ${counters.skipped}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Sleeps in short chunks so a SIGINT/SIGTERM can interrupt promptly instead of blocking for up to 15 minutes. */
async function sleepInterruptible(ms: number, shouldStop: () => boolean): Promise<void> {
  const chunkMs = 2_000;
  let remaining = ms;
  while (remaining > 0 && !shouldStop()) {
    const wait = Math.min(chunkMs, remaining);
    await sleep(wait);
    remaining -= wait;
  }
}

/**
 * Drives the boundary lane's own state machine: sleeps until the next
 * 15-minute UTC boundary (+ offset), then runs the pass for it. A failed
 * pass does NOT advance to the next boundary -- the same boundary is retried
 * (with growing backoff, via `BackoffController`) until it succeeds, since
 * `runFullSettlementPass` and every per-market capture are already
 * idempotent/skip-safe on retry.
 */
function createBoundaryLane(context: RunnerContext, shouldStop: () => boolean) {
  let pendingBoundaryMs: number | null = null;
  let nextPauseMs = 1_000;
  const backoff = new BackoffController();

  const iteration = async (): Promise<void> => {
    const nowMs = Date.now();
    if (pendingBoundaryMs === null) pendingBoundaryMs = nextFifteenMinuteBoundary(nowMs);
    const wakeAtMs = pendingBoundaryMs + BOUNDARY_WAKE_OFFSET_MS;
    if (nowMs < wakeAtMs) {
      await sleepInterruptible(Math.min(wakeAtMs - nowMs, FIFTEEN_MINUTES_MS), shouldStop);
      nextPauseMs = 0;
      return;
    }
    const boundarySeconds = Math.floor(pendingBoundaryMs / 1_000);
    await runBoundaryPass(context, (params) => selectMarketsAtBoundaryWithOpenInterest({ ...params, boundaryUnixSeconds: boundarySeconds }));
    pendingBoundaryMs = null; // success: pick a fresh future boundary next time
    backoff.onSuccess();
    nextPauseMs = 1_000;
  };
  const pause = () => sleep(nextPauseMs);
  const onFailure = (error: unknown) => {
    nextPauseMs = backoff.onFailure(error);
    console.error(`boundary lane error, retrying the same boundary in ${Math.round(nextPauseMs / 1_000)}s: ${redact(String(error), rpcUrl)}`);
  };
  return () => runSerializedLane(iteration, shouldStop, pause, onFailure);
}

function createFixedIntervalLane(
  label: string,
  intervalMs: number,
  run: () => Promise<void>,
  shouldStop: () => boolean,
): () => Promise<void> {
  return () => runSerializedLane(
    run,
    shouldStop,
    () => sleepInterruptible(intervalMs, shouldStop),
    (error) => console.error(`${label} lane error, retrying in ${Math.round(intervalMs / 1_000)}s: ${redact(String(error), rpcUrl)}`),
  );
}

async function runStartupCatchUpPass(context: RunnerContext): Promise<void> {
  console.log("startup catch-up pass: checking for anything that expired while the runner was down");
  await runBoundaryPass(context, ({ markets, marketsWithOpenPositions: openPositionMarkets }) =>
    selectExpiredMarketsWithOpenInterest({ markets, now: Math.floor(Date.now() / 1_000), marketsWithOpenPositions: openPositionMarkets }));
}

async function main(): Promise<void> {
  const releaseLease = await acquireRunnerLease(RUNNER_LEASE_PORT);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const shouldStop = () => stopping;

  try {
    console.log(`VSOL oracle runner on ${cluster} through the configured RPC`);
    // Only THIS may legitimately exit the process: a missing signer key, the
    // program not being deployed, or a misconfigured RPC pointing at the
    // wrong cluster are genuine startup failures, not transient ones.
    const context = await initializeRunner();
    const once = process.argv.includes("--once");

    // One catch-up pass at startup, then heartbeat and cleanup once each, so
    // `--once` (used by smoke tooling) and a freshly (re)started long-running
    // process both leave the system in a fully caught-up state immediately.
    // Collected via allSettled rather than sequential awaits so a transient
    // failure in ONE of the three never prevents the others from running,
    // and -- critically -- never crashes the process outright: only `--once`
    // (which reports its result via exit code for smoke tooling) escalates a
    // failure into a thrown error; the steady-state long-running path just
    // logs and moves on, trusting each lane's own schedule to retry.
    const startupResults = await Promise.allSettled([
      runStartupCatchUpPass(context),
      runHeartbeatPass(context),
      runCleanupPass(context),
    ]);
    const startupFailures = startupResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    for (const failure of startupFailures) {
      console.error(`startup pass failed: ${redact(failure.reason instanceof Error ? failure.reason.message : String(failure.reason), rpcUrl)}`);
    }
    if (once) {
      if (startupFailures.length > 0) throw new Error(`${startupFailures.length} startup pass(es) failed`);
      return;
    }

    await Promise.all([
      createBoundaryLane(context, shouldStop)(),
      createFixedIntervalLane("heartbeat", HEARTBEAT_INTERVAL_MS, () => runHeartbeatPass(context), shouldStop)(),
      createFixedIntervalLane("cleanup", CLEANUP_INTERVAL_MS, () => runCleanupPass(context), shouldStop)(),
    ]);
  } finally {
    await releaseLease();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : String(error), rpcUrl));
    process.exitCode = 1;
  });
}
