import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { classifyPushFailure, DEVNET_GENESIS_HASH, pushOneSymbol } from "./custom-oracle-pusher.ts";
import { liveMarkets, type Market } from "../../app/lib/markets.ts";
import { getClockUnixTimestamp } from "../../app/lib/solana-clock.ts";
import { deriveConfig, deriveCustomPriceFeed, deriveCustomSettlementObservation, VSOL_PROGRAM_ID } from "../sdk/index.ts";
import {
  anchorErrorCode,
  decideMarketPublishAction,
  decidePositionAction,
  describeSettlementError,
  fetchAllMarkets,
  fetchCollateralVaultBalances,
  fetchOpenDirectPositions,
  fetchOpenPoolPositions,
  fetchOracleStates,
  marketsWithOpenPositions,
  marketsWithOutstandingCollateral,
  redact,
  selectMarketsNeedingSettlementAttempt,
  settlePoolPositionOnChain,
  refundPoolPositionOnChain,
} from "./lib/settlement.ts";

// Unified custom-oracle worker. Each symbol has an independent serialized
// push/capture lane, while retained-price publication and payouts run in a
// separate lane. A slow provider or settlement transaction therefore cannot
// consume another symbol's 30-second capture window. `--once` is an
// operational probe; default mode repeats under a kernel-held port lease.
//
// Discovery mirrors scripts/cranker.ts's own settlement phase exactly (same
// fetchAllMarkets/fetchOracleStates/selectMarketsNeedingSettlementAttempt
// pipeline from scripts/lib/settlement.ts, same decideMarketPublishAction
// timing gate -- `final_settlement_deadline` is shared byte-for-byte between
// `publish_pyth_settlement` and `publish_custom_settlement` on-chain, so the
// same pure timing helper applies unchanged to either path). The only thing
// this script does differently from the cranker is WHICH publish
// instruction it calls.

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");

// MUST match CUSTOM_ORACLE_MAX_STALENESS_SECONDS in
// vsol/programs/vsol/src/lib.rs -- duplicated here (rather than read from
// chain) the same way scripts/lib/settlement.ts already duplicates
// SETTLEMENT_REFUND_PRIORITY_SECONDS/MARKET_CLEANUP_BUFFER_SECONDS, purely
// so this script can fail fast client-side before spending a transaction on
// a call the on-chain `require!` would reject anyway.
const PASS_INTERVAL_MS = 5_000;
const RUNNER_LEASE_PORT = Number(process.env.VSOL_CUSTOM_ORACLE_LEASE_PORT ?? 47_653);

async function loadRequiredKeypair(name: string): Promise<Keypair> {
  const path = resolve(devnetDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Missing required signer "${name}" (expected ${path}). Run "npm run devnet:bootstrap" at least once first.`);
  }
  const secret = Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

function programFor(signer: Keypair): Program<Vsol> {
  const provider = new AnchorProvider(connection, new AnchorWallet(signer), { commitment, preflightCommitment: commitment });
  return new Program<Vsol>(idl, provider);
}

async function clusterUnixTime(): Promise<number> {
  return getClockUnixTimestamp(connection);
}

let discoveryCache: {
  expiresAt: number;
  value: Promise<{ markets: Awaited<ReturnType<typeof fetchAllMarkets>>; now: number }>;
} | undefined;

async function sharedMarketDiscovery() {
  const wallNow = Date.now();
  if (discoveryCache && wallNow < discoveryCache.expiresAt) return discoveryCache.value;
  const value = Promise.all([fetchAllMarkets(connection), clusterUnixTime()])
    .then(([markets, now]) => ({ markets, now }))
    .catch((error) => {
      discoveryCache = undefined;
      throw error;
    });
  discoveryCache = { expiresAt: wallNow + 2_000, value };
  return value;
}

async function runOnePass(context: RunnerContext, symbolFilter?: string, captureOnly = false): Promise<void> {
  console.log(`VSOL custom settlement (one-shot) on ${cluster} through the configured RPC`);
  const { authority: broadcaster, program, config } = context;
  // Capture lanes only need the market/oracle accounts. Avoid the position and
  // vault scans used by the relay lane so a busy portfolio cannot consume the
  // short observation window.
  const { markets, now } = await sharedMarketDiscovery();
  const [poolPositions, directPositions] = captureOnly
    ? [[], []] as const
    : await Promise.all([fetchOpenPoolPositions(connection), fetchOpenDirectPositions(connection)]);

  const openPositionMarkets = marketsWithOpenPositions({ poolPositions, directPositions });
  const outstandingCollateralMarkets = captureOnly
    ? new Set<string>()
    : marketsWithOutstandingCollateral(await fetchCollateralVaultBalances(
      connection,
      markets.map((market) => new PublicKey(market.address)),
    ));

  const captureMarkets = captureOnly
    ? markets.filter((market) =>
      (!symbolFilter || market.symbol === symbolFilter) &&
      market.expiry <= now &&
      now <= market.expiry + market.observationWindowSeconds)
    : markets;
  const oracleStates = await fetchOracleStates(
    program,
    captureMarkets.map((market) => new PublicKey(market.oracle)),
  );
  const marketsWithFinalizedOracle = new Set(
    captureMarkets.filter((market) => oracleStates.get(market.oracle)?.finalized === true).map((market) => market.address),
  );

  const candidates = (captureOnly
    ? captureMarkets.filter((market) => !marketsWithFinalizedOracle.has(market.address))
    : selectMarketsNeedingSettlementAttempt({
      markets,
      now,
      marketsWithFinalizedOracle,
      marketsWithOpenPositions: openPositionMarkets,
      marketsWithOutstandingCollateral: outstandingCollateralMarkets,
    })).filter((market) => !symbolFilter || market.symbol === symbolFilter).sort((left, right) => {
    const leftInWindow = now <= left.expiry + left.observationWindowSeconds ? 0 : 1;
    const rightInWindow = now <= right.expiry + right.observationWindowSeconds ? 0 : 1;
    return leftInWindow - rightInWindow || left.expiry - right.expiry;
  });

  if (candidates.length === 0) {
    console.log("No expired, unsettled markets found on-chain (nothing to publish)");
  } else {
    console.log(`Found ${candidates.length} expired, unsettled market(s) to attempt`);
  }

  let published = 0;
  let skipped = 0;
  let operationalFailures = 0;
  const newlyFinalized = new Set<string>();

  for (const market of candidates) {
    const oracleState = oracleStates.get(market.oracle);
    const decision = decideMarketPublishAction({
      expiry: market.expiry,
      observationWindowSeconds: market.observationWindowSeconds,
      settlementGraceSeconds: market.settlementGraceSeconds,
      maxSettlementStalenessSeconds: market.maxSettlementStalenessSeconds,
      now,
      oracleFinalized: oracleState?.finalized ?? false,
    });
    if (decision.kind === "skip") {
      console.log(`skip: ${market.address} (${market.symbol}) -- ${decision.reason}`);
      skipped += 1;
      continue;
    }

    const marketPk = new PublicKey(market.address);
    const oraclePk = new PublicKey(market.oracle);
    const feedPk = deriveCustomPriceFeed(market.symbol);
    const observationPk = deriveCustomSettlementObservation(market.symbol, BigInt(market.expiry));
    let observation = await program.account.customSettlementObservation.fetchNullable(observationPk);

    if (!observation && !captureOnly) {
      console.log(`skip: ${market.address} (${market.symbol}) -- no retained in-window observation`);
      skipped += 1;
      continue;
    }

    if (!observation) {
      const captureNow = await clusterUnixTime();
      if (captureNow > market.expiry + market.observationWindowSeconds) {
        console.log(`skip: ${market.address} (${market.symbol}) -- observation window elapsed without a retained observation`);
        skipped += 1;
        continue;
      }
      let feed: Awaited<ReturnType<typeof program.account.customPriceFeed.fetchNullable>>;
      try {
        feed = await program.account.customPriceFeed.fetchNullable(feedPk);
      } catch (error) {
        console.log(`skip: ${market.address} (${market.symbol}) -- failed to read custom price feed ${feedPk.toBase58()}: ${describeSettlementError(error, rpcUrl)}`);
        skipped += 1;
        operationalFailures += 1;
        continue;
      }
      if (!feed) {
        console.log(`skip: ${market.address} (${market.symbol}) -- custom price feed ${feedPk.toBase58()} is not initialized (run init_custom_price_feed first)`);
        skipped += 1;
        operationalFailures += 1;
        continue;
      }

    // Fail fast client-side, mirroring the on-chain require!s exactly, so a
    // doomed call never spends a transaction.
      const feedPriceScale = BigInt(feed.priceScale.toString());
      if (feedPriceScale !== market.priceScale) {
        console.log(
          `skip: ${market.address} (${market.symbol}) -- feed price_scale ${feedPriceScale} does not match market price_scale ${market.priceScale}`,
        );
        skipped += 1;
        operationalFailures += 1;
        continue;
      }
      const publishedAt = Number(feed.publishedAt.toString());
      if (publishedAt < market.expiry) {
        console.log(
          `skip: ${market.address} (${market.symbol}) -- feed's last update (${new Date(publishedAt * 1000).toISOString()}) predates this market's expiry (${new Date(market.expiry * 1000).toISOString()}); is custom-oracle-pusher.ts running?`,
        );
        skipped += 1;
        operationalFailures += 1;
        continue;
      }
      const ageSeconds = captureNow - publishedAt;
      if (ageSeconds > 30) {
        console.log(
          `skip: ${market.address} (${market.symbol}) -- feed is ${ageSeconds}s stale, over the 30s capture ceiling; is custom-oracle-pusher.ts running?`,
        );
        skipped += 1;
        operationalFailures += 1;
        continue;
      }

      if (captureNow <= market.expiry + market.observationWindowSeconds) {
        try {
          await program.methods.captureCustomSettlementObservation().accountsStrict({
            oracleAuthority: broadcaster.publicKey,
            config,
            market: marketPk,
            feed: feedPk,
            observation: observationPk,
            systemProgram: SystemProgram.programId,
          }).rpc();
          observation = await program.account.customSettlementObservation.fetch(observationPk);
          console.log(`captured: ${market.symbol} expiry ${market.expiry} at ${observation.observedAt.toString()}`);
        } catch (error) {
          console.log(`skip: capture for ${market.address} (${market.symbol}) -- ${describeSettlementError(error, rpcUrl)}`);
          operationalFailures += 1;
        }
      }
    }
    if (captureOnly) continue;
    if (!observation) {
      console.log(`skip: ${market.address} (${market.symbol}) -- no retained in-window observation`);
      skipped += 1;
      continue;
    }

    try {
      const signature = await program.methods
        .publishCustomSettlement()
        .accountsStrict({ config, market: marketPk, oracle: oraclePk, observation: observationPk })
        .rpc();
      console.log(
        `published: custom settlement for market ${market.address} (${market.symbol}) at price ${observation.price.toString()} (signature ${signature})`,
      );
      published += 1;
      newlyFinalized.add(market.address);
    } catch (error) {
      // A concurrent publish_pyth_settlement (or another run of this same
      // script) finalizing first surfaces as OracleAlreadyFinalized here --
      // a skip, not a failure.
      console.log(`skip: ${market.address} (${market.symbol}) -- ${describeSettlementError(error, rpcUrl)}`);
      skipped += 1;
      if (anchorErrorCode(error) !== "OracleAlreadyFinalized") operationalFailures += 1;
    }
  }

  if (captureOnly) {
    if (operationalFailures > 0) throw new Error(`${operationalFailures} capture operation(s) failed`);
    return;
  }

  const marketByAddress = new Map(markets.map((market) => [market.address, market]));
  const configAccount = await program.account.config.fetch(config);
  for (const position of poolPositions) {
    const market = marketByAddress.get(position.market);
    if (!market || now < market.expiry) continue;
    const finalized = oracleStates.get(market.oracle)?.finalized === true || newlyFinalized.has(market.address);
    const action = decidePositionAction({
      now,
      oracleFinalized: finalized,
      expiry: market.expiry,
      observationWindowSeconds: market.observationWindowSeconds,
      settlementGraceSeconds: market.settlementGraceSeconds,
    });
    if (action.kind === "skip") continue;
    try {
      const signature = action.kind === "settle"
        ? await settlePoolPositionOnChain({ program, cranker: broadcaster.publicKey, config, oracle: new PublicKey(market.oracle), treasuryOwner: configAccount.treasuryOwner, position })
        : await refundPoolPositionOnChain({ program, cranker: broadcaster.publicKey, config, oracle: new PublicKey(market.oracle), position });
      console.log(`${action.kind === "settle" ? "settled" : "refunded"}: position ${position.address} (signature ${signature})`);
    } catch (error) {
      console.log(`skip: ${action.kind} for position ${position.address} -- ${describeSettlementError(error, rpcUrl)}`);
      skipped += 1;
      if (anchorErrorCode(error) !== "PositionNotOpen") operationalFailures += 1;
    }
  }

  console.log(`Custom settlement summary: published ${published}, skipped ${skipped}, of ${candidates.length} candidate(s)`);
  if (operationalFailures > 0) {
    throw new Error(`${operationalFailures} settlement operation(s) failed`);
  }
}

export async function acquireRunnerLease(port = RUNNER_LEASE_PORT): Promise<() => Promise<void>> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      rejectListen(error.code === "EADDRINUSE"
        ? new Error(`Custom oracle runner is already active on localhost port ${port}`)
        : error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolveListen);
  });
  return () => new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

type RunnerContext = {
  authority: Keypair;
  program: Program<Vsol>;
  config: PublicKey;
};

async function initializeRunner(): Promise<RunnerContext> {
  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) {
    throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  }
  if (cluster === "devnet" && await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
    throw new Error("Configured RPC is not Solana devnet");
  }
  const authority = await loadRequiredKeypair("devnet-custom-oracle-authority");
  return { authority, program: programFor(authority), config: deriveConfig() };
}

async function runSymbolIteration(context: RunnerContext, market: Market): Promise<void> {
  let pushFailure: Error | undefined;
  try {
    await pushOneSymbol({ ...context, market });
  } catch (error) {
    const failure = classifyPushFailure(error, rpcUrl);
    if (failure.duplicateTimestamp) {
      console.log(`unchanged: ${market.symbol} source timestamp already published`);
    } else {
      pushFailure = new Error(`${market.symbol} push failed: ${failure.message}`);
    }
  }
  // Capture still runs after an unchanged source timestamp: a market may have
  // expired since that source observation was first pushed.
  await runOnePass(context, market.symbol, true);
  if (pushFailure) throw pushFailure;
}

export async function runSerializedLane(
  iteration: () => Promise<void>,
  shouldStop: () => boolean,
  pause: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  while (!shouldStop()) {
    try {
      await iteration();
    } catch (error) {
      onFailure(error);
    }
    if (!shouldStop()) await pause();
  }
}

function sleepPassInterval(): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, PASS_INTERVAL_MS));
}

async function main(): Promise<void> {
  const releaseLock = await acquireRunnerLease();
  const once = process.argv.includes("--once");
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const context = await initializeRunner();
    if (once) {
      const symbolResults = await Promise.allSettled(liveMarkets.map((market) => runSymbolIteration(context, market)));
      const relayResult = await Promise.allSettled([runOnePass(context)]);
      const failures = [...symbolResults, ...relayResult].filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        for (const failure of failures) {
          if (failure.status === "rejected") console.error(describeSettlementError(failure.reason, rpcUrl));
        }
        throw new Error(`${failures.length} custom-oracle lane(s) failed`);
      }
      return;
    }

    const reportFailure = (error: unknown) => {
      console.error(describeSettlementError(error, rpcUrl));
    };
    const lanes = liveMarkets.map((market) => runSerializedLane(
      () => runSymbolIteration(context, market),
      () => stopping,
      sleepPassInterval,
      reportFailure,
    ));
    lanes.push(runSerializedLane(
      () => runOnePass(context),
      () => stopping,
      sleepPassInterval,
      reportFailure,
    ));
    await Promise.all(lanes);
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : String(error), rpcUrl));
    process.exitCode = 1;
  });
}
