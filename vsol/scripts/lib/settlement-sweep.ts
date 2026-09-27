import type { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Vsol } from "../../target/types/vsol.ts";
import { deriveCustomSettlementObservation } from "../../sdk/index.ts";
import {
  anchorErrorCode,
  decideMarketPublishAction,
  decidePositionAction,
  describeSettlementError,
  fetchCollateralVaultBalances,
  fetchOracleStates,
  marketsWithOpenPositions,
  marketsWithOutstandingCollateral,
  refundPoolPositionOnChain,
  selectMarketsNeedingSettlementAttempt,
  settlePoolPositionOnChain,
  type DecodedDirectPosition,
  type DecodedMarketForCleanup,
  type DecodedPoolPosition,
} from "./settlement.ts";

// The publish/settle/refund half of every 15-minute boundary pass, adapted
// from the old custom-settle.ts's `runOnePass` (its non-capture-only branch).
// UNCHANGED from that file: every timing and safety decision still delegates
// to lib/settlement.ts's pure predicates (`decideMarketPublishAction`,
// `decidePositionAction`, `selectMarketsNeedingSettlementAttempt`) -- this
// module contributes no new settlement RULES, only the orchestration loop.
// What DID change: this no longer tries to opportunistically capture a
// missing observation inline (that used to lean on a separately-running
// capture lane's continuously-refreshed feed) -- oracle-runner.ts's boundary
// lane now captures BEFORE calling this, in one publish+capture transaction,
// for every market due this pass (see lib/publish-capture-transaction.ts). A
// market whose observation is still missing here (this pass's own capture
// failed, or an earlier pass's did) is simply skipped -- exactly as before --
// and becomes refundable once its settlement deadline passes, same as ever.
//
// Takes ALL of `markets`/`poolPositions`/`directPositions` already fetched
// this pass (the runner's own single getProgramAccounts round) rather than
// fetching anything program-wide itself, other than the two bounded
// `getMultipleAccountsInfo`-style lookups (`fetchCollateralVaultBalances`,
// `fetchOracleStates`) that were always priced per-market, not per-scan.

export type SettlementSweepCounters = {
  published: number;
  settled: number;
  refunded: number;
  skipped: number;
  operationalFailures: number;
};

function emptyCounters(): SettlementSweepCounters {
  return { published: 0, settled: 0, refunded: 0, skipped: 0, operationalFailures: 0 };
}

export async function runFullSettlementPass(params: {
  connection: Connection;
  program: Program<Vsol>;
  cranker: Keypair;
  config: PublicKey;
  rpcUrl: string;
  markets: readonly DecodedMarketForCleanup[];
  poolPositions: readonly DecodedPoolPosition[];
  directPositions: readonly DecodedDirectPosition[];
  now: number;
}): Promise<SettlementSweepCounters> {
  const { connection, program, cranker, config, rpcUrl, markets, poolPositions, directPositions, now } = params;
  const counters = emptyCounters();

  const marketByAddress = new Map(markets.map((market) => [market.address, market]));
  const openPositionMarkets = marketsWithOpenPositions({ poolPositions, directPositions });

  const vaultBalances = await fetchCollateralVaultBalances(connection, markets.map((market) => new PublicKey(market.address)));
  const outstandingCollateralMarkets = marketsWithOutstandingCollateral(vaultBalances);

  const oracleStates = await fetchOracleStates(program, markets.map((market) => new PublicKey(market.oracle)));
  const marketsWithFinalizedOracle = new Set(
    markets.filter((market) => oracleStates.get(market.oracle)?.finalized === true).map((market) => market.address),
  );

  const publishCandidates = selectMarketsNeedingSettlementAttempt({
    markets,
    now,
    marketsWithFinalizedOracle,
    marketsWithOpenPositions: openPositionMarkets,
    marketsWithOutstandingCollateral: outstandingCollateralMarkets,
  }).sort((left, right) => left.expiry - right.expiry);

  const newlyFinalized = new Set<string>();

  for (const market of publishCandidates) {
    const decision = decideMarketPublishAction({
      expiry: market.expiry,
      observationWindowSeconds: market.observationWindowSeconds,
      settlementGraceSeconds: market.settlementGraceSeconds,
      maxSettlementStalenessSeconds: market.maxSettlementStalenessSeconds,
      now,
      oracleFinalized: oracleStates.get(market.oracle)?.finalized ?? false,
    });
    if (decision.kind === "skip") {
      console.log(`skip: publish for ${market.address} (${market.symbol}) -- ${decision.reason}`);
      counters.skipped += 1;
      continue;
    }

    const observationPk = deriveCustomSettlementObservation(market.symbol, BigInt(market.expiry));
    const observation = await program.account.customSettlementObservation.fetchNullable(observationPk);
    if (!observation) {
      console.log(`skip: publish for ${market.address} (${market.symbol}) -- no retained in-window observation (capture did not land this window)`);
      counters.skipped += 1;
      continue;
    }

    try {
      const signature = await program.methods
        .publishCustomSettlement()
        .accountsStrict({ config, market: new PublicKey(market.address), oracle: new PublicKey(market.oracle), observation: observationPk })
        .rpc();
      console.log(
        `published: custom settlement for ${market.address} (${market.symbol}) at price ${observation.price.toString()} (signature ${signature})`,
      );
      counters.published += 1;
      newlyFinalized.add(market.address);
    } catch (error) {
      // A concurrent publish (another runner, or a buyer's own settlement
      // call landing first) surfaces as OracleAlreadyFinalized -- a skip, not
      // a failure.
      console.log(`skip: publish for ${market.address} (${market.symbol}) -- ${describeSettlementError(error, rpcUrl)}`);
      counters.skipped += 1;
      if (anchorErrorCode(error) !== "OracleAlreadyFinalized") counters.operationalFailures += 1;
    }
  }

  const configAccount = await program.account.config.fetch(config);
  for (const position of poolPositions) {
    const market = marketByAddress.get(position.market);
    if (!market || now < market.expiry) continue;
    const finalized = oracleStates.get(market.oracle)?.finalized === true || newlyFinalized.has(market.address);
    const decision = decidePositionAction({
      now,
      oracleFinalized: finalized,
      expiry: market.expiry,
      observationWindowSeconds: market.observationWindowSeconds,
      settlementGraceSeconds: market.settlementGraceSeconds,
    });
    if (decision.kind === "skip") continue;
    try {
      const signature = decision.kind === "settle"
        ? await settlePoolPositionOnChain({
          program,
          cranker: cranker.publicKey,
          config,
          oracle: new PublicKey(market.oracle),
          treasuryOwner: configAccount.treasuryOwner,
          position,
        })
        : await refundPoolPositionOnChain({ program, cranker: cranker.publicKey, config, oracle: new PublicKey(market.oracle), position });
      console.log(`${decision.kind === "settle" ? "settled" : "refunded"}: position ${position.address} (signature ${signature})`);
      if (decision.kind === "settle") counters.settled += 1; else counters.refunded += 1;
    } catch (error) {
      // A position already settled/refunded by a concurrent runner or the
      // buyer themselves surfaces as PositionNotOpen -- a skip, not a failure.
      console.log(`skip: ${decision.kind} for position ${position.address} -- ${describeSettlementError(error, rpcUrl)}`);
      counters.skipped += 1;
      if (anchorErrorCode(error) !== "PositionNotOpen") counters.operationalFailures += 1;
    }
  }

  return counters;
}
