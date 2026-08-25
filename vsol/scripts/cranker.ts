import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { HermesClient } from "@pythnetwork/hermes-client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { deriveConfig, VSOL_PROGRAM_ID } from "../sdk/index.ts";
import {
  closeSettledMarketOnChain,
  decideMarketPublishAction,
  decidePositionAction,
  describeSettlementError,
  fetchAllMarkets,
  fetchCollateralVaultBalances,
  fetchOpenDirectPositions,
  fetchOpenPoolPositions,
  fetchOracleStates,
  fetchPythUpdateForSettlement,
  filterExpiredOpenPositions,
  groupPositionsByMarket,
  marketsWithOpenPositions,
  marketsWithOutstandingCollateral,
  publishSettlementForMarket,
  redact,
  refundPoolPositionOnChain,
  selectMarketCloseCandidates,
  selectMarketsNeedingSettlementAttempt,
  settlePoolPositionOnChain,
  type MarketWindow,
} from "./lib/settlement.ts";

// The settlement cranker is the permissionless liveness layer for expired
// VSOL pool positions: the payoff is fixed entirely by strike + oracle
// price, so the "cranker" signer has no special authority on-chain (settle
// and refund accept any funded signer) and cannot choose outcomes or divert
// funds. Running this on a short interval is a convenience that lets buyers
// get paid without lifting a finger; if it stops running, any buyer can
// still call settle/refund themselves against the same permissionless
// instructions. It is safe to run concurrently with itself and with a
// buyer's own settlement transaction -- every write here is idempotent or
// treated as a skip (see lib/settlement.ts).
//
// After settlement/refund, the same pass runs a market-cleanup phase that
// calls `close_settled_market` for markets that are safe to reclaim rent
// from. Unlike settlement, this is NOT permissionless from the chain's
// perspective (the program requires the caller be `market.creator` or
// `config.admin`) -- it works here because the cranker's persisted key is the
// market creator on this deployment. Cleanup is bounded per run (see
// MAX_MARKETS_CLOSED_PER_RUN) and can be disabled via `--no-cleanup` or
// VSOL_CRANKER_CLEANUP=false, but is ON by default. See
// lib/settlement.ts's selectMarketCloseCandidates for the full safety
// predicate that keeps this from ever stranding an open position.
//
// Two account types reference a market via `has_one = market` and must both
// be considered "still referencing this market": pool-backed `PoolPosition`
// (settled/refunded by this cranker's settlement phase above) and
// direct-maker `Position` (opened by `fill_quote`, settled by `settle` or
// `refund_unsettled`). This cranker does NOT settle or refund the direct-maker
// path today -- only the pooled path above does. The settlement phase's
// publish-attempt enumeration DOES scan both account types, though (via
// `marketsWithOpenPositions`), because a direct-maker position still needs
// its market's oracle finalized before the buyer can call `settle` or
// `refund_unsettled` themselves -- publishing is permissionless-liveness for
// that path exactly as it is for the pooled path, even though this script
// does not carry the direct-maker position itself to completion. Market
// cleanup separately scans BOTH account types and blocks closing any market
// referenced by either, so an unsettled direct-maker position can never be
// stranded by cleanup either. Resolving direct-maker positions (via
// `settle`/`refund_unsettled`) end-to-end is a real gap but a distinct one
// from both of the above, which this file does guarantee.

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");
const hermes = new HermesClient(process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network", {
  accessToken: process.env.PYTH_API_KEY?.trim() || undefined,
  timeout: 20_000,
  httpRetries: 3,
});

async function loadRequiredKeypair(name: string): Promise<Keypair> {
  const path = resolve(devnetDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing required signer "${name}" (expected ${path}). Run "npm run devnet:bootstrap" at least once before the cranker.`,
    );
  }
  const secret = Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

function programFor(signer: Keypair): Program<Vsol> {
  const provider = new AnchorProvider(connection, new AnchorWallet(signer), { commitment, preflightCommitment: commitment });
  return new Program<Vsol>(idl, provider);
}

async function clusterUnixTime(): Promise<number> {
  const slot = await connection.getSlot(commitment);
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error(`No block time is available for slot ${slot}`);
  return blockTime;
}

type Counters = { published: number; settled: number; refunded: number; closed: number; skipped: number };

function logSummary(counters: Counters): void {
  console.log(
    `Cranker summary: published ${counters.published} settlements, settled ${counters.settled} positions, ` +
      `refunded ${counters.refunded}, closed ${counters.closed} markets, skipped ${counters.skipped}`,
  );
}

// Bounds the market-cleanup phase: even with a large backlog of closeable
// markets, a single run closes at most this many, so the pass stays bounded
// in time and in the number of transactions it fires.
const MAX_MARKETS_CLOSED_PER_RUN = 25;

/** `--no-cleanup` on the command line, or VSOL_CRANKER_CLEANUP=false in the environment, disables the market-cleanup phase. Cleanup is ON by default. */
function isCleanupEnabled(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes("--no-cleanup")) return false;
  if ((env.VSOL_CRANKER_CLEANUP ?? "").trim().toLowerCase() === "false") return false;
  return true;
}

/**
 * Closes every market that selectMarketCloseCandidates proves safe. Must run
 * strictly after the settle/refund phase in the same pass has finished (its
 * caller in main() guarantees this ordering) and re-scans BOTH position
 * account types itself -- via the same fetchOpenPoolPositions the settlement
 * phase uses, plus fetchOpenDirectPositions for the direct-maker path this
 * cranker does not settle -- rather than reusing anything fetched earlier in
 * main(), specifically so a PoolPosition just settled or refunded this pass
 * has already dropped out of the union set before any close decision is
 * made. A market referenced by either account type is excluded from
 * candidates; see selectMarketCloseCandidates's doc for the full predicate.
 *
 * Also fetches every candidate-window market's complete-set collateral vault
 * balance (FINDING 1's off-chain mirror -- see
 * `marketsWithOutstandingCollateral`/`fetchCollateralVaultBalances`) so this
 * pass never wastes a transaction retrying `close_settled_market` against a
 * market the on-chain `MarketHasOutstandingCollateral` check would simply
 * revert.
 */
async function runMarketCleanup(params: {
  connection: Connection;
  program: Program<Vsol>;
  cranker: Keypair;
  config: PublicKey;
  counters: Counters;
}): Promise<void> {
  const [freshPoolPositions, freshDirectPositions, markets, now] = await Promise.all([
    fetchOpenPoolPositions(params.connection),
    fetchOpenDirectPositions(params.connection),
    fetchAllMarkets(params.connection),
    clusterUnixTime(),
  ]);
  const openPositionMarkets = marketsWithOpenPositions({
    poolPositions: freshPoolPositions,
    directPositions: freshDirectPositions,
  });
  const vaultBalances = await fetchCollateralVaultBalances(
    params.connection,
    markets.map((market) => new PublicKey(market.address)),
  );
  const outstandingCollateralMarkets = marketsWithOutstandingCollateral(vaultBalances);

  const candidates = selectMarketCloseCandidates({
    markets,
    now,
    marketsWithOpenPositions: openPositionMarkets,
    marketsWithOutstandingCollateral: outstandingCollateralMarkets,
    maxPerRun: MAX_MARKETS_CLOSED_PER_RUN,
  });

  for (const market of candidates) {
    try {
      const signature = await closeSettledMarketOnChain({
        program: params.program,
        authority: params.cranker.publicKey,
        config: params.config,
        market: new PublicKey(market.address),
        oracle: new PublicKey(market.oracle),
        rentRecipient: new PublicKey(market.creator),
      });
      console.log(`closed: market ${market.address} (signature ${signature})`);
      params.counters.closed += 1;
    } catch (error) {
      // Already closed by a concurrent cleaner ("account not found"), or this
      // cranker key is not this market's creator/admin on this deployment
      // (Unauthorized) -- both are skips, never a reason to fail the run.
      console.log(`skip: close for market ${market.address} -- ${describeSettlementError(error, rpcUrl)}`);
      params.counters.skipped += 1;
    }
  }
}

/**
 * The settlement/refund phase.
 *
 * FIX for a confirmed live bug: this used to build its ENTIRE work list from
 * `fetchOpenPoolPositions` -- `[...new Set(positions.map(p => p.market))]` --
 * so a market reachable from no position of either kind (a v2
 * conditional-token market, whose only state is two SPL mints and a
 * complete-set collateral vault) was never enumerated, its oracle never
 * finalized, and `redeem_winning` reverted with `OracleNotFinalized` forever.
 * The base enumeration is now `fetchAllMarkets` (the same helper
 * `runMarketCleanup` already uses), and the publish-attempt set is widened
 * via `selectMarketsNeedingSettlementAttempt` to include any market with a
 * non-zero complete-set vault, even with zero positions -- see that
 * function's doc comment in lib/settlement.ts for the full rationale.
 *
 * The position-driven settle/refund behavior below is UNCHANGED: every
 * market with an expired open `PoolPosition` still gets its positions
 * settled or refunded exactly as before, via its own scan
 * (`grouped`/`expiredPositions`) independent of the publish-attempt set --
 * deliberately so, since a market whose oracle was already finalized (by a
 * prior pass, a concurrent cranker, or the buyer's own settlement call) is
 * EXCLUDED from the publish-attempt set (nothing left to publish) yet may
 * still have a position waiting on `settle_pool_position`/
 * `refund_pool_position`. The two sets are unioned below so both cases are
 * covered without regressing either.
 */
async function runSettlementPhase(params: {
  connection: Connection;
  program: Program<Vsol>;
  cranker: Keypair;
  config: PublicKey;
  counters: Counters;
}): Promise<void> {
  const { connection, program, cranker, config, counters } = params;

  const [poolPositions, directPositions, markets, now] = await Promise.all([
    fetchOpenPoolPositions(connection),
    fetchOpenDirectPositions(connection),
    fetchAllMarkets(connection),
    clusterUnixTime(),
  ]);
  if (poolPositions.length === 0) {
    console.log("No open pool positions found on-chain");
  }

  const marketByAddress = new Map(markets.map((market) => [market.address, market]));
  const openPositionMarkets = marketsWithOpenPositions({
    poolPositions,
    directPositions,
  });

  const vaultBalances = await fetchCollateralVaultBalances(
    connection,
    markets.map((market) => new PublicKey(market.address)),
  );
  const outstandingCollateralMarkets = marketsWithOutstandingCollateral(vaultBalances);

  // Fetched for every market on the deployment (not just ones already known
  // to be "at stake"), mirroring runMarketCleanup's own philosophy of
  // fetching broadly and filtering in pure code -- this is what lets
  // selectMarketsNeedingSettlementAttempt exclude already-finalized markets
  // from the publish-attempt set below.
  const oracleStates = await fetchOracleStates(
    program,
    markets.map((market) => new PublicKey(market.oracle)),
  );
  const marketsWithFinalizedOracle = new Set(
    markets.filter((market) => oracleStates.get(market.oracle)?.finalized === true).map((market) => market.address),
  );

  const publishCandidates = selectMarketsNeedingSettlementAttempt({
    markets,
    now,
    marketsWithFinalizedOracle,
    marketsWithOpenPositions: openPositionMarkets,
    marketsWithOutstandingCollateral: outstandingCollateralMarkets,
  });

  const positionsWithKnownMarket = poolPositions.filter((position) => marketByAddress.has(position.market));
  for (const position of poolPositions) {
    if (!marketByAddress.has(position.market)) {
      console.log(`skip: position ${position.address} references market ${position.market} which is not readable on-chain`);
      counters.skipped += 1;
    }
  }

  const marketExpiries = new Map<string, number>();
  markets.forEach((market) => marketExpiries.set(market.address, market.expiry));

  const expiredPositions = filterExpiredOpenPositions(positionsWithKnownMarket, marketExpiries, now);
  const notYetExpiredCount = positionsWithKnownMarket.length - expiredPositions.length;
  if (notYetExpiredCount > 0) {
    console.log(`skip: ${notYetExpiredCount} open position(s) have not reached their market's expiry yet`);
    counters.skipped += notYetExpiredCount;
  }

  const grouped = groupPositionsByMarket(expiredPositions);

  // The union drives the loop: every market that either needs a publish
  // attempt (positions and/or outstanding collateral, oracle not yet
  // finalized) or has expired positions awaiting settle/refund regardless of
  // publish-attempt eligibility (see the function doc comment above).
  const marketAddressesToProcess = new Set<string>([
    ...publishCandidates.map((market) => market.address),
    ...grouped.keys(),
  ]);

  if (marketAddressesToProcess.size === 0) {
    console.log("No settlement work found on-chain (no expired positions and no markets with outstanding collateral)");
    return;
  }

  const configAccount = await program.account.config.fetch(config);

  for (const marketAddress of marketAddressesToProcess) {
    const market = marketByAddress.get(marketAddress);
    if (!market) continue; // unreachable: every address here came from `markets` or a position already proven to reference a known market above

    const oracleAddress = new PublicKey(market.oracle);
    const oracleState = oracleStates.get(market.oracle);
    const marketPositions = grouped.get(marketAddress) ?? [];
    if (!oracleState) {
      console.log(`skip: market ${marketAddress} oracle ${market.oracle} is not readable on-chain; deferring settlement`);
      counters.skipped += Math.max(1, marketPositions.length);
      continue;
    }
    let finalized = oracleState.finalized;

    const window: MarketWindow = {
      expiry: market.expiry,
      observationWindowSeconds: market.observationWindowSeconds,
      settlementGraceSeconds: market.settlementGraceSeconds,
    };
    const publishWindow = { ...window, maxSettlementStalenessSeconds: market.maxSettlementStalenessSeconds };

    const publishDecision = decideMarketPublishAction({
      now,
      oracleFinalized: finalized,
      ...publishWindow,
    });
    if (publishDecision.kind === "skip") {
      console.log(`skip: publish for market ${marketAddress} -- ${publishDecision.reason}`);
    } else {
      try {
        // FIX for a confirmed live bug: fetchLatestPythUpdate always returns
        // the NEWEST Hermes print, which publish_pyth_settlement only
        // accepts under tier 1 (and only when this pass happens to land
        // inside the 30-second observation window) and can NEVER satisfy
        // tier 2 -- measured live, 13 of 14 expired markets had unfinalized
        // oracles as a direct result. fetchPythUpdateForSettlement fetches
        // the print appropriate to whichever tier is currently viable
        // instead (see its doc comment in lib/settlement.ts).
        //
        // SECOND fix for a confirmed live rejection (error 6039,
        // OracleConfidenceTooWide): the tier's "latest available" print can
        // still be one Pyth published with a too-wide confidence band (e.g.
        // the feed's final print at market close) -- fetchPythUpdateForSettlement
        // now walks backward from that print until it finds one the market's
        // own maxConfidenceBps would actually accept, so market.maxConfidenceBps
        // must be threaded through here.
        const fetched = await fetchPythUpdateForSettlement(hermes, market.pythFeedId, publishWindow, market.maxConfidenceBps, now);
        if (!fetched.ok) throw new Error(fetched.reason);
        const { update, tier, publishTime, ageSeconds, probeCount } = fetched;
        const result = await publishSettlementForMarket({
          connection,
          cranker,
          program,
          config,
          market: new PublicKey(marketAddress),
          oracle: oracleAddress,
          feedId: market.pythFeedId,
          update,
        });
        // Surfaces the tier and print age directly in the log line -- an
        // operator can see "settled from a 9-hour-old pre-close print" (the
        // ordinary tier-2 case whenever a market expires outside equity
        // hours) without reading chain state.
        console.log(
          `published: settlement for market ${marketAddress} via ${tier} -- print published ` +
            `${new Date(publishTime * 1000).toISOString()} (${ageSeconds}s old, ${probeCount} Hermes probe(s)) ` +
            `(signature ${result.signature})`,
        );
        counters.published += 1;
        finalized = true;
      } catch (error) {
        // Covers: neither settlement tier is satisfiable yet
        // (InvalidObservationTime), a concurrent run already finalized the
        // oracle first (OracleAlreadyFinalized), Hermes has no fresh print,
        // or any other transient failure -- all are skips, never a reason to
        // abort the whole run.
        console.log(`skip: publish for market ${marketAddress} -- ${describeSettlementError(error, rpcUrl)}`);
        counters.skipped += 1;
      }
    }

    for (const position of marketPositions) {
      const decision = decidePositionAction({ now, oracleFinalized: finalized, ...window });
      if (decision.kind === "skip") {
        console.log(`skip: position ${position.address} -- ${decision.reason}`);
        counters.skipped += 1;
        continue;
      }
      try {
        if (decision.kind === "settle") {
          const signature = await settlePoolPositionOnChain({
            program,
            cranker: cranker.publicKey,
            config,
            oracle: oracleAddress,
            treasuryOwner: configAccount.treasuryOwner,
            position,
          });
          console.log(`settled: position ${position.address} (signature ${signature})`);
          counters.settled += 1;
        } else {
          const signature = await refundPoolPositionOnChain({
            program,
            cranker: cranker.publicKey,
            config,
            oracle: oracleAddress,
            position,
          });
          console.log(`refunded: position ${position.address} (signature ${signature})`);
          counters.refunded += 1;
        }
      } catch (error) {
        // A position already settled or refunded (by this cranker's own
        // prior pass, a concurrent cranker run, or the buyer settling
        // themselves) surfaces here as PositionNotOpen or an
        // account-does-not-exist error -- a skip, not a failure.
        console.log(`skip: ${decision.kind} for position ${position.address} -- ${describeSettlementError(error, rpcUrl)}`);
        counters.skipped += 1;
      }
    }
  }
}

async function main(): Promise<void> {
  console.log(`VSOL cranker on ${cluster} through the configured RPC`);

  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) {
    throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  }

  // Settlement is permissionless -- the on-chain `cranker` signer carries no
  // authority constraint, so any funded key works. This reuses the same
  // persisted automation key as scripts/keeper.ts ("creator") rather than
  // minting a fresh one, since it is already funded on this deployment. This
  // key (the cranker operator) pays every transaction fee below, plus the
  // Pyth receiver's price-update posting fee when it publishes a settlement.
  // The same key doubles as the market-cleanup authority below, since it is
  // documented to be the market creator on this deployment.
  const cranker = await loadRequiredKeypair(`${cluster}-creator`);
  const program = programFor(cranker);
  const config = deriveConfig();

  const counters: Counters = { published: 0, settled: 0, refunded: 0, closed: 0, skipped: 0 };

  await runSettlementPhase({ connection, program, cranker, config, counters });

  const cleanupEnabled = isCleanupEnabled(process.argv.slice(2), process.env);
  if (cleanupEnabled) {
    await runMarketCleanup({ connection, program, cranker, config, counters });
  } else {
    console.log("skip: market cleanup disabled (--no-cleanup)");
  }

  logSummary(counters);
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error), rpcUrl));
  process.exitCode = 1;
});
