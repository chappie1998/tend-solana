import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { deriveConfig, deriveCustomPriceFeed, VSOL_PROGRAM_ID } from "../sdk/index.ts";
import {
  decideMarketPublishAction,
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
} from "./lib/settlement.ts";

// A one-shot counterpart to `publish_pyth_settlement` for the backup/demo
// `CustomPriceFeed` path (see vsol/programs/vsol/src/lib.rs). Run manually
// (npm run custom-oracle:settle), NOT on a loop -- unlike scripts/cranker.ts,
// which stays the standing, always-on settlement liveness layer for the
// normal Pyth path and is deliberately left untouched by this file.
//
// Discovery mirrors scripts/cranker.ts's own settlement phase exactly (same
// fetchAllMarkets/fetchOracleStates/selectMarketsNeedingSettlementAttempt
// pipeline from scripts/lib/settlement.ts, same decideMarketPublishAction
// timing gate -- `final_settlement_deadline` is shared byte-for-byte between
// `publish_pyth_settlement` and `publish_custom_settlement` on-chain, so the
// same pure timing helper applies unchanged to either path). The only thing
// this script does differently from the cranker is WHICH publish
// instruction it calls, and it additionally checks the corresponding
// `CustomPriceFeed`'s freshness locally first, so a doomed call never
// even reaches the chain.

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
const CUSTOM_ORACLE_MAX_STALENESS_SECONDS = 300;

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
  const slot = await connection.getSlot(commitment);
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error(`No block time is available for slot ${slot}`);
  return blockTime;
}

async function main(): Promise<void> {
  console.log(`VSOL custom settlement (one-shot) on ${cluster} through the configured RPC`);

  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) {
    throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  }

  // Settlement publication is permissionless -- like cranker.ts, any funded
  // key works, so this reuses the same persisted "creator" automation key
  // rather than minting a new one.
  const broadcaster = await loadRequiredKeypair(`${cluster}-creator`);
  const program = programFor(broadcaster);
  const config = deriveConfig();

  const [poolPositions, directPositions, markets, now] = await Promise.all([
    fetchOpenPoolPositions(connection),
    fetchOpenDirectPositions(connection),
    fetchAllMarkets(connection),
    clusterUnixTime(),
  ]);

  const openPositionMarkets = marketsWithOpenPositions({ poolPositions, directPositions });
  const vaultBalances = await fetchCollateralVaultBalances(
    connection,
    markets.map((market) => new PublicKey(market.address)),
  );
  const outstandingCollateralMarkets = marketsWithOutstandingCollateral(vaultBalances);

  const oracleStates = await fetchOracleStates(
    program,
    markets.map((market) => new PublicKey(market.oracle)),
  );
  const marketsWithFinalizedOracle = new Set(
    markets.filter((market) => oracleStates.get(market.oracle)?.finalized === true).map((market) => market.address),
  );

  const candidates = selectMarketsNeedingSettlementAttempt({
    markets,
    now,
    marketsWithFinalizedOracle,
    marketsWithOpenPositions: openPositionMarkets,
    marketsWithOutstandingCollateral: outstandingCollateralMarkets,
  });

  if (candidates.length === 0) {
    console.log("No expired, unsettled markets found on-chain (nothing to publish)");
    return;
  }
  console.log(`Found ${candidates.length} expired, unsettled market(s) to attempt`);

  let published = 0;
  let skipped = 0;

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

    let feed: Awaited<ReturnType<typeof program.account.customPriceFeed.fetchNullable>>;
    try {
      feed = await program.account.customPriceFeed.fetchNullable(feedPk);
    } catch (error) {
      console.log(`skip: ${market.address} (${market.symbol}) -- failed to read custom price feed ${feedPk.toBase58()}: ${describeSettlementError(error, rpcUrl)}`);
      skipped += 1;
      continue;
    }
    if (!feed) {
      console.log(`skip: ${market.address} (${market.symbol}) -- custom price feed ${feedPk.toBase58()} is not initialized (run init_custom_price_feed first)`);
      skipped += 1;
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
      continue;
    }
    const publishedAt = Number(feed.publishedAt.toString());
    if (publishedAt < market.expiry) {
      console.log(
        `skip: ${market.address} (${market.symbol}) -- feed's last update (${new Date(publishedAt * 1000).toISOString()}) predates this market's expiry (${new Date(market.expiry * 1000).toISOString()}); is custom-oracle-pusher.ts running?`,
      );
      skipped += 1;
      continue;
    }
    const ageSeconds = now - publishedAt;
    if (ageSeconds > CUSTOM_ORACLE_MAX_STALENESS_SECONDS) {
      console.log(
        `skip: ${market.address} (${market.symbol}) -- feed is ${ageSeconds}s stale, over the ${CUSTOM_ORACLE_MAX_STALENESS_SECONDS}s ceiling; is custom-oracle-pusher.ts running?`,
      );
      skipped += 1;
      continue;
    }

    try {
      const signature = await program.methods
        .publishCustomSettlement()
        .accountsStrict({ config, market: marketPk, oracle: oraclePk, feed: feedPk })
        .rpc();
      console.log(
        `published: custom settlement for market ${market.address} (${market.symbol}) at price ${feed.price.toString()} (signature ${signature})`,
      );
      published += 1;
    } catch (error) {
      // A concurrent publish_pyth_settlement (or another run of this same
      // script) finalizing first surfaces as OracleAlreadyFinalized here --
      // a skip, not a failure.
      console.log(`skip: ${market.address} (${market.symbol}) -- ${describeSettlementError(error, rpcUrl)}`);
      skipped += 1;
    }
  }

  console.log(`Custom settlement summary: published ${published}, skipped ${skipped}, of ${candidates.length} candidate(s)`);
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error), rpcUrl));
  process.exitCode = 1;
});
