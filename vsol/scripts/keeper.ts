import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorError, AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import BN from "bn.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { rollingMarketSchedule, type ScheduledSeries } from "./lib/expiry-grid.ts";
import {
  deriveConfig,
  deriveLiquidityPool,
  deriveLiquidityPoolMarket,
  deriveMarket,
  deriveMarketId,
  deriveOracle,
  liquidityPoolId,
  MARKET_MAX_CONFIDENCE_BPS as MAX_CONFIDENCE_BPS,
  MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
  MARKET_OBSERVATION_WINDOW_SECONDS as USER_MARKET_OBSERVATION_SECONDS,
  MARKET_SETTLEMENT_GRACE_SECONDS as USER_MARKET_SETTLEMENT_GRACE_SECONDS,
  PRICE_SCALE,
  symbolBytes,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";

// The series keeper is the lightweight, idempotent counterpart to
// bootstrap.ts: it never funds signers, mints assets, or runs the adversarial
// smoke lifecycle. It only (1) mints the next rolling 15M/1H/EOD/7D/30D
// markets that bootstrap's UTC grid says should exist right now, and (2)
// authorizes those series on the passive liquidity pool bootstrap deployed.
// It is safe to run on a short interval (see vsol/README.md) and safe to run
// concurrently with itself: every write is idempotent or treated as a skip.

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");

// Mirrors bootstrap.ts's rolling-catalog parameters exactly. These are not
// re-derived from the deployment manifest because the keeper must never
// depend on (or write) that manifest -- it only has to agree with bootstrap
// on the deterministic factory inputs, which is why both scripts import the
// shared policy constants from ../sdk/index.ts rather than each hardcoding
// their own copies.
const PYTH_FEED_ID = "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593";
const PYTH_FEED_BYTES = [...Buffer.from(PYTH_FEED_ID, "hex")];
const MARKET_SYMBOL = "NVDA";
// USER_MARKET_OBSERVATION_SECONDS, USER_MARKET_SETTLEMENT_GRACE_SECONDS,
// MAX_CONFIDENCE_BPS, and MARKET_MAX_SETTLEMENT_STALENESS_SECONDS now live in
// ../sdk/index.ts (see the import above) — the single shared home with
// vsol/scripts/bootstrap.ts and app/lib/launch-params.ts, so the keeper can
// never mint a rung the app derives a different market address for.
const MAIN_POOL_LABEL = `${cluster}:tUSDC:main-v3`;

type Counters = { created: number; authorized: number; skipped: number };

async function loadRequiredKeypair(name: string): Promise<Keypair> {
  const path = resolve(devnetDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing required signer "${name}" (expected ${path}). Run "npm run devnet:bootstrap" at least once before the keeper.`,
    );
  }
  const secret = Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

function programFor(signer: Keypair): Program<Vsol> {
  const provider = new AnchorProvider(connection, new AnchorWallet(signer), { commitment, preflightCommitment: commitment });
  return new Program<Vsol>(idl, provider);
}

async function accountExists(address: PublicKey): Promise<boolean> {
  return (await connection.getAccountInfo(address, commitment)) !== null;
}

async function clusterUnixTime(): Promise<number> {
  const slot = await connection.getSlot(commitment);
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error(`No block time is available for slot ${slot}`);
  return blockTime;
}

/** Redacts the configured RPC URL from a string so logs never leak it. */
function redact(text: string): string {
  return rpcUrl.length > 0 ? text.split(rpcUrl).join("[rpc]") : text;
}

function describeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

/**
 * A lost create/init race manifests as a System Program "already in use"
 * error (or, for accounts Anchor already validated as initialized, an
 * AccountDiscriminatorAlreadySet-style message). Either way it means a
 * concurrent keeper run won the race for the exact same deterministic
 * account -- the desired end state already holds, so this is a skip, not a
 * failure.
 */
function isLostCreateRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("already in use") || message.includes("already been processed");
}

function anchorErrorCode(error: unknown): string | undefined {
  return error instanceof AnchorError ? error.error.errorCode.code : undefined;
}

type MarketRung = {
  series: ScheduledSeries;
  id: Buffer;
  market: PublicKey;
  oracle: PublicKey;
};

async function ensureMarkets(params: {
  creatorProgram: Program<Vsol>;
  creator: Keypair;
  config: PublicKey;
  settlementMint: PublicKey;
  underlyingMint: PublicKey;
  schedule: ScheduledSeries[];
  counters: Counters;
}): Promise<MarketRung[]> {
  const rungs: MarketRung[] = [];
  for (const series of params.schedule) {
    const symbol = symbolBytes(MARKET_SYMBOL);
    const id = await deriveMarketId({
      pythFeedId: PYTH_FEED_BYTES,
      settlementMint: params.settlementMint,
      expiry: BigInt(series.expiry),
      observationWindowSeconds: USER_MARKET_OBSERVATION_SECONDS,
      settlementGraceSeconds: USER_MARKET_SETTLEMENT_GRACE_SECONDS,
      priceScale: PRICE_SCALE,
      maxConfidenceBps: MAX_CONFIDENCE_BPS,
      symbol,
      maxSettlementStalenessSeconds: MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
    });
    const market = deriveMarket(params.config, id);
    const oracle = deriveOracle(market);
    rungs.push({ series, id, market, oracle });

    if (await accountExists(market)) {
      console.log(`skip: ${series.code} market already exists at ${market.toBase58()}`);
      params.counters.skipped += 1;
      continue;
    }

    try {
      await params.creatorProgram.methods
        .createMarket({
          marketId: [...id],
          underlyingMint: params.underlyingMint,
          symbol,
          priceScale: new BN(PRICE_SCALE.toString()),
          expiry: new BN(series.expiry),
          observationWindowSeconds: USER_MARKET_OBSERVATION_SECONDS,
          settlementGraceSeconds: USER_MARKET_SETTLEMENT_GRACE_SECONDS,
          maxConfidenceBps: MAX_CONFIDENCE_BPS,
          pythFeedId: PYTH_FEED_BYTES,
          maxSettlementStalenessSeconds: MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
        })
        .accountsStrict({
          creator: params.creator.publicKey,
          config: params.config,
          market,
          oracle,
          settlementMint: params.settlementMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(
        `created: ${series.code} market ${market.toBase58()} expiring ${new Date(series.expiry * 1000).toISOString()}`,
      );
      params.counters.created += 1;
    } catch (error) {
      if (isLostCreateRace(error) || (await accountExists(market))) {
        console.log(`skip: ${series.code} market creation lost a create race at ${market.toBase58()}`);
        params.counters.skipped += 1;
        continue;
      }
      throw new Error(`Failed to create ${series.code} market ${market.toBase58()}: ${describeError(error)}`);
    }
  }
  return rungs;
}

async function ensurePoolAuthorizations(params: {
  managerProgram: Program<Vsol>;
  manager: Keypair;
  creatorProgram: Program<Vsol>;
  config: PublicKey;
  pool: PublicKey;
  rungs: MarketRung[];
  counters: Counters;
}): Promise<void> {
  const poolInfo = await connection.getAccountInfo(params.pool, commitment);
  if (!poolInfo) {
    console.log(
      `skip: liquidity pool ${params.pool.toBase58()} does not exist yet; run "npm run devnet:bootstrap" before the keeper can authorize series on it`,
    );
    params.counters.skipped += params.rungs.length;
    return;
  }

  const poolAccount = await params.creatorProgram.account.liquidityPool.fetch(params.pool);
  if (!poolAccount.manager.equals(params.manager.publicKey)) {
    console.log(
      `skip: persisted key ${params.manager.publicKey.toBase58()} is not the manager of pool ${params.pool.toBase58()} (onchain manager is ${poolAccount.manager.toBase58()}); cannot authorize series`,
    );
    params.counters.skipped += params.rungs.length;
    return;
  }

  // set_liquidity_pool_market reverts (PoolHasOpenPositions) while the pool
  // still has open positions or locked collateral -- it cannot safely
  // recompute a trade cutoff mid-obligation. Checking this once up front
  // avoids sending obviously-doomed transactions for every rung; the
  // per-rung try/catch below still handles the case where the pool's state
  // flips between this check and the actual submit.
  const poolBusy = !poolAccount.openPositions.isZero() || !poolAccount.lockedCollateral.isZero();

  for (const { series, market } of params.rungs) {
    const poolMarket = deriveLiquidityPoolMarket(params.pool, market);
    const existing = await params.managerProgram.account.liquidityPoolMarket.fetchNullable(poolMarket);
    if (existing && existing.enabled && existing.lastTradeAt.toNumber() === series.lastTradeAt) {
      console.log(`skip: ${series.code} pool authorization already current on ${params.pool.toBase58()}`);
      params.counters.skipped += 1;
      continue;
    }

    if (poolBusy) {
      console.log(
        `skip: ${series.code} pool authorization deferred -- pool ${params.pool.toBase58()} has open positions (${poolAccount.openPositions.toString()}) or locked collateral (${poolAccount.lockedCollateral.toString()}); will retry once positions settle`,
      );
      params.counters.skipped += 1;
      continue;
    }

    try {
      await params.managerProgram.methods
        .setLiquidityPoolMarket({ lastTradeAt: new BN(series.lastTradeAt), enabled: true })
        .accountsStrict({
          manager: params.manager.publicKey,
          config: params.config,
          pool: params.pool,
          market,
          poolMarket,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`authorized: ${series.code} series on pool ${params.pool.toBase58()} (lastTradeAt ${series.lastTradeAt})`);
      params.counters.authorized += 1;
    } catch (error) {
      if (anchorErrorCode(error) === "PoolHasOpenPositions") {
        console.log(
          `skip: ${series.code} pool authorization deferred -- pool ${params.pool.toBase58()} reported open positions at submit time; will retry once positions settle`,
        );
        params.counters.skipped += 1;
        continue;
      }
      if (isLostCreateRace(error)) {
        console.log(`skip: ${series.code} pool authorization lost a race on ${params.pool.toBase58()}`);
        params.counters.skipped += 1;
        continue;
      }
      throw new Error(`Failed to authorize ${series.code} series on pool ${params.pool.toBase58()}: ${describeError(error)}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`VSOL keeper on ${cluster} through the configured RPC`);

  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) {
    throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  }

  // Market creation is permissionless -- any funded key works. Only pool
  // authorization requires the pool's manager. On this deployment bootstrap
  // creates the passive pool with the same "creator" signer as its manager
  // (see bootstrap.ts's ensureLiquidityPool), so reusing that one persisted
  // key for both roles keeps the keeper aligned with the existing
  // deployment without minting a new key file. ensurePoolAuthorizations
  // still verifies this on-chain before authorizing anything.
  const creator = await loadRequiredKeypair(`${cluster}-creator`);
  const poolManager = creator;
  const settlementMintKeypair = await loadRequiredKeypair(`${cluster}-mock-usdc-mint`);
  const underlyingMintKeypair = await loadRequiredKeypair(`${cluster}-mock-rwa-mint`);
  const settlementMint = settlementMintKeypair.publicKey;
  const underlyingMint = underlyingMintKeypair.publicKey;

  const config = deriveConfig();
  if (!(await accountExists(config))) {
    throw new Error(`VSOL config ${config.toBase58()} is not initialized on ${cluster}; run "npm run devnet:bootstrap" first`);
  }

  const creatorProgram = programFor(creator);
  // poolManager is creator on this deployment (see the comment above), so
  // the same Program instance signs both roles.
  const managerProgram = creatorProgram;

  const pool = deriveLiquidityPool(config, settlementMint, liquidityPoolId(MAIN_POOL_LABEL));

  const now = await clusterUnixTime();
  const schedule = rollingMarketSchedule(now);
  // Bounded by construction: rollingMarketSchedule always returns exactly
  // the five current rungs, so this run can never create more than five
  // markets or authorize more than five series.
  const counters: Counters = { created: 0, authorized: 0, skipped: 0 };

  const rungs = await ensureMarkets({
    creatorProgram,
    creator,
    config,
    settlementMint,
    underlyingMint,
    schedule,
    counters,
  });

  await ensurePoolAuthorizations({
    managerProgram,
    manager: poolManager,
    creatorProgram,
    config,
    pool,
    rungs,
    counters,
  });

  console.log(`Keeper summary: created ${counters.created} markets, authorized ${counters.authorized} series, skipped ${counters.skipped}`);
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
