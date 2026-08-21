import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorError, AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import BN from "bn.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { rollingMarketSchedule, type ScheduledSeries } from "./lib/expiry-grid.ts";
import {
  ALT_NOT_DEACTIVATED_SENTINEL,
  isLookupTableReadyToClose,
  isLookupTableSafeToDeactivate,
  missingAddresses,
  type RetiringLookupTableEntry,
} from "./lib/lookup-table.ts";
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
const manifestPath = resolve(workspace, "deployments", `${cluster}.json`);

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
// MUST match the pool label in scripts/bootstrap.ts. The label is versioned
// because a change to the LiquidityPool account layout requires a NEW PDA —
// the program cannot grow an existing account, so bootstrap mints a fresh
// pool at a new label and the old one is abandoned.
//
// Bumped v3 -> v4 on 2026-08-19 when `total_assets` and the pending_* timelock
// fields took the struct from 214 to 266 bytes. Leaving this at v3 pointed the
// keeper at the abandoned 214-byte pool and it died decoding it
// ("offset out of range: 238 > 204") before minting a single rung, so the app
// had no tradable series at all.
const MAIN_POOL_LABEL = `${cluster}:tUSDC:main-v4`;

/**
 * Mirrors `MIN_MARKET_LEAD_SECONDS` in vsol/programs/vsol/src/lib.rs exactly
 * (the on-chain constant is not exported through the SDK, so this is a
 * hardcoded copy in the same spirit as PYTH_FEED_ID/MARKET_SYMBOL above --
 * the keeper must agree with the program's own check, never re-derive it).
 * `set_liquidity_pool_market` rejects with InvalidLastTradeCutoff unless
 * `last_trade_at >= now + MIN_MARKET_LEAD_SECONDS && last_trade_at < expiry`.
 */
const MIN_MARKET_LEAD_SECONDS = 15;

/**
 * Extra headroom (beyond MIN_MARKET_LEAD_SECONDS) required before the keeper
 * will bother creating a rung at all. Creating a market costs at least one
 * confirmed transaction (plus an ALT extend), and this rung is authorized
 * immediately afterward in the same pass -- so the cutoff must still be
 * comfortably ahead of the lead window by the time that second transaction
 * lands, not just at the instant the create decision is made. 60 seconds is
 * generous relative to a single confirmed-commitment transaction's typical
 * latency, while still tiny next to the shortest (15M) rung's own cadence.
 */
const CREATE_AUTHORIZE_MARGIN_SECONDS = 60;

/**
 * Pure mirror of the on-chain `set_liquidity_pool_market` cutoff check: true
 * while `lastTradeAt` is still at least `minLeadSeconds` in the future and
 * strictly before `expiry`. Exported so vsol/tests/keeper.test.ts can assert
 * this in isolation -- no live RPC, no Connection, no Program instance.
 *
 * Used two ways here: (1) with the default (bare) lead, right before
 * submitting an authorization, to proactively skip a rung that has aged out
 * instead of sending a transaction the program will reject; and (2) with
 * `minLeadSeconds` inflated by CREATE_AUTHORIZE_MARGIN_SECONDS, before ever
 * creating a rung, so the keeper never mints a market that could not survive
 * long enough to be authorized in the same pass.
 */
export function isRungAuthorizable(params: {
  now: number;
  lastTradeAt: number;
  expiry: number;
  minLeadSeconds?: number;
}): boolean {
  const minLead = params.minLeadSeconds ?? MIN_MARKET_LEAD_SECONDS;
  return params.lastTradeAt >= params.now + minLead && params.lastTradeAt < params.expiry;
}

type Counters = {
  created: number;
  authorized: number;
  skipped: number;
  altExtended: number;
  altDeactivated: number;
  altClosed: number;
};

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

/**
 * Best-effort, read-only peek at the manifest for a single optional field.
 * The keeper otherwise never depends on (or writes) the deployment manifest
 * for market creation -- this exists only so newly created markets can be
 * folded into the address lookup table (ALT) when create-lookup-table.ts has
 * already published one. Any failure to read it (missing file, bad JSON,
 * field absent) is treated as "no table yet", never as a keeper failure.
 */
async function readAddressLookupTable(): Promise<PublicKey | undefined> {
  try {
    const deployment = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    return typeof deployment.addressLookupTable === "string" ? new PublicKey(deployment.addressLookupTable) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extends the ALT with a newly created market's address and oracle, skipping
 * whichever of the two are already present. A failure here must never fail
 * the keeper run -- the market itself was already created successfully,
 * which is the operation that matters; a later keeper run or a manual
 * "npm run lookup-table" pass will pick up the missing address next time.
 */
async function extendLookupTableWithMarket(params: {
  authority: Keypair;
  lookupTable: PublicKey;
  code: string;
  market: PublicKey;
  oracle: PublicKey;
  counters: Counters;
}): Promise<void> {
  try {
    const lookup = await connection.getAddressLookupTable(params.lookupTable, { commitment });
    const existing = lookup.value?.state.addresses ?? [];
    const toAdd = missingAddresses(existing, [params.market, params.oracle]);
    if (toAdd.length === 0) {
      console.log(`skip: ${params.code} market and oracle already present in ALT ${params.lookupTable.toBase58()}`);
      return;
    }
    const instruction = AddressLookupTableProgram.extendLookupTable({
      payer: params.authority.publicKey,
      authority: params.authority.publicKey,
      lookupTable: params.lookupTable,
      addresses: toAdd,
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [params.authority], { commitment });
    console.log(`extended: ALT ${params.lookupTable.toBase58()} with ${toAdd.length} address(es) for ${params.code}`);
    params.counters.altExtended += toAdd.length;
  } catch (error) {
    console.log(`warn: failed to extend ALT for ${params.code} market ${params.market.toBase58()} -- market creation still succeeded (${describeError(error)})`);
  }
}

/**
 * Progresses every table in the manifest's `retiringLookupTables` array
 * toward deactivation and, once its mandatory cooldown has elapsed, closure
 * (reclaiming rent to `authority`). A table only ever moves into this array
 * from vsol/scripts/create-lookup-table.ts's rotation path -- see
 * app/lib/vsol.ts's ExtendedDeployment comment for the manifest shape.
 *
 * Deactivate -> close has a mandatory onchain slot cooldown
 * (isLookupTableReadyToClose); a table that has just been deactivated (or
 * whose cooldown has not yet elapsed) is left in the manifest for a later
 * keeper pass to finish. A table is only deactivated once
 * isLookupTableSafeToDeactivate confirms every market that was live in it at
 * rotation time has expired and cleared its settlement window.
 *
 * Every failure here (RPC error, a lost race with a manual close, etc.) is
 * caught and logged, never thrown -- market maintenance (processRungs's
 * ensureMarketRung / authorizeRung pass) is the keeper's priority and must
 * never be failed by ALT lifecycle bookkeeping. This is the one place the
 * keeper writes the deployment manifest; it only ever rewrites
 * `retiringLookupTables`, never touches `addressLookupTable` or any
 * market-creation state.
 */
async function processRetiringLookupTables(params: { authority: Keypair; counters: Counters }): Promise<void> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const deployment = JSON.parse(raw) as Record<string, unknown>;
    const retiring = Array.isArray(deployment.retiringLookupTables)
      ? (deployment.retiringLookupTables as RetiringLookupTableEntry[])
      : [];
    if (retiring.length === 0) return;

    const now = await clusterUnixTime();
    const remaining: RetiringLookupTableEntry[] = [];

    for (const entry of retiring) {
      try {
        const tableKey = new PublicKey(entry.address);
        const lookup = await connection.getAddressLookupTable(tableKey, { commitment });
        const table = lookup.value;
        if (!table) {
          // Already closed (by this keeper or a manual operation) -- drop it.
          console.log(`alt-retire: ${entry.address} no longer exists onchain; removing from retiringLookupTables`);
          continue;
        }

        if (table.state.deactivationSlot === ALT_NOT_DEACTIVATED_SENTINEL) {
          if (!isLookupTableSafeToDeactivate(entry, now)) {
            console.log(
              `skip: retiring ALT ${entry.address} not yet safe to deactivate (must outlive until ${new Date(entry.outliveExpiry * 1000).toISOString()})`,
            );
            remaining.push(entry);
            continue;
          }
          const instruction = AddressLookupTableProgram.deactivateLookupTable({
            lookupTable: tableKey,
            authority: params.authority.publicKey,
          });
          await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [params.authority], { commitment });
          console.log(`deactivated: retiring ALT ${entry.address}`);
          params.counters.altDeactivated += 1;
          remaining.push(entry);
          continue;
        }

        const currentSlot = await connection.getSlot(commitment);
        if (!isLookupTableReadyToClose(table.state.deactivationSlot, currentSlot)) {
          console.log(`skip: retiring ALT ${entry.address} deactivated but its close cooldown has not elapsed yet`);
          remaining.push(entry);
          continue;
        }

        const instruction = AddressLookupTableProgram.closeLookupTable({
          lookupTable: tableKey,
          authority: params.authority.publicKey,
          recipient: params.authority.publicKey,
        });
        await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [params.authority], { commitment });
        console.log(`closed: retiring ALT ${entry.address} (rent reclaimed to ${params.authority.publicKey.toBase58()})`);
        params.counters.altClosed += 1;
        // Not pushed to `remaining`: closed tables are dropped from the manifest.
      } catch (error) {
        console.log(`warn: failed to progress retiring ALT ${entry.address} -- will retry next keeper pass (${describeError(error)})`);
        remaining.push(entry);
      }
    }

    if (remaining.length !== retiring.length) {
      deployment.retiringLookupTables = remaining;
      await writeFile(manifestPath, `${JSON.stringify(deployment, null, 2)}\n`);
    }
  } catch (error) {
    console.log(`warn: failed to process retiring lookup tables -- market maintenance still succeeded (${describeError(error)})`);
  }
}

type CreatedMarketRung = {
  market: PublicKey;
  oracle: PublicKey;
};

/**
 * Ensures a single rung's market exists (creating it if missing) and returns
 * its address so the caller can immediately attempt authorization -- this is
 * the interleaving that replaces the old create-all-then-authorize-all
 * structure. On a cold start where all five rungs are missing at once, this
 * keeps the create->authorize gap for any one rung down to roughly one
 * transaction (this create) plus one best-effort ALT extend, instead of the
 * full batch of up to ten transactions the previous two-pass design incurred.
 *
 * Returns undefined when there is (and will be) no market to authorize:
 * either the rung is already too close to its own trade cutoff to be worth
 * minting at all (see isRungAuthorizable/CREATE_AUTHORIZE_MARGIN_SECONDS), in
 * which case it is about to roll onto the next boundary anyway.
 */
async function ensureMarketRung(params: {
  creatorProgram: Program<Vsol>;
  creator: Keypair;
  config: PublicKey;
  settlementMint: PublicKey;
  underlyingMint: PublicKey;
  series: ScheduledSeries;
  counters: Counters;
  addressLookupTable?: PublicKey;
  now: number;
}): Promise<CreatedMarketRung | undefined> {
  const { series } = params;
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

  if (await accountExists(market)) {
    console.log(`skip: ${series.code} market already exists at ${market.toBase58()}`);
    params.counters.skipped += 1;
    return { market, oracle };
  }

  // Don't mint a rung that can never be authorized: if its trade cutoff is
  // already inside (or within CREATE_AUTHORIZE_MARGIN_SECONDS of) the
  // program's minimum lead window, creating it now would only produce a
  // market this same pass's authorization attempt is guaranteed to reject.
  if (
    !isRungAuthorizable({
      now: params.now,
      lastTradeAt: series.lastTradeAt,
      expiry: series.expiry,
      minLeadSeconds: MIN_MARKET_LEAD_SECONDS + CREATE_AUTHORIZE_MARGIN_SECONDS,
    })
  ) {
    console.log(
      `skip: ${series.code} market not created -- its trade cutoff (${new Date(series.lastTradeAt * 1000).toISOString()}) is already within the ${MIN_MARKET_LEAD_SECONDS + CREATE_AUTHORIZE_MARGIN_SECONDS}s minimum-lead-plus-margin window of the current cluster time; it would only fail authorization and this rung is about to roll onto the next boundary`,
    );
    params.counters.skipped += 1;
    return undefined;
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

    if (params.addressLookupTable) {
      await extendLookupTableWithMarket({
        authority: params.creator,
        lookupTable: params.addressLookupTable,
        code: series.code,
        market,
        oracle,
        counters: params.counters,
      });
    } else {
      console.log(`skip: ALT extension for ${series.code} -- no addressLookupTable is published in the manifest`);
    }
    return { market, oracle };
  } catch (error) {
    if (isLostCreateRace(error) || (await accountExists(market))) {
      console.log(`skip: ${series.code} market creation lost a create race at ${market.toBase58()}`);
      params.counters.skipped += 1;
      return { market, oracle };
    }
    throw new Error(`Failed to create ${series.code} market ${market.toBase58()}: ${describeError(error)}`);
  }
}

/**
 * The outcome of the one-time (not per-rung) pool existence + manager-key
 * check: `canAuthorize: false` means every rung's authorization attempt must
 * be skipped for this run, but market creation (permissionless, checked
 * separately) still proceeds normally. `poolBusy` mirrors the pool's
 * open-positions/locked-collateral snapshot taken at the same time.
 */
type PoolAuthorizationContext =
  | { canAuthorize: false }
  | { canAuthorize: true; poolBusy: boolean; openPositions: string; lockedCollateral: string };

/**
 * Resolves the pool-level prerequisites for authorization exactly once per
 * run (not once per rung): does the pool exist yet, and is the persisted key
 * actually its manager. Both are one-time, whole-pool facts -- checking them
 * per rung would just repeat the same RPC round trips five times for the
 * same answer. Logs the existing skip lines when authorization cannot
 * proceed at all; callers still create markets regardless of this result.
 */
async function resolvePoolAuthorizationContext(params: {
  creatorProgram: Program<Vsol>;
  manager: Keypair;
  pool: PublicKey;
}): Promise<PoolAuthorizationContext> {
  const poolInfo = await connection.getAccountInfo(params.pool, commitment);
  if (!poolInfo) {
    console.log(
      `skip: liquidity pool ${params.pool.toBase58()} does not exist yet; run "npm run devnet:bootstrap" before the keeper can authorize series on it`,
    );
    return { canAuthorize: false };
  }

  const poolAccount = await params.creatorProgram.account.liquidityPool.fetch(params.pool);
  if (!poolAccount.manager.equals(params.manager.publicKey)) {
    console.log(
      `skip: persisted key ${params.manager.publicKey.toBase58()} is not the manager of pool ${params.pool.toBase58()} (onchain manager is ${poolAccount.manager.toBase58()}); cannot authorize series`,
    );
    return { canAuthorize: false };
  }

  // set_liquidity_pool_market reverts (PoolHasOpenPositions) while the pool
  // still has open positions or locked collateral -- it cannot safely
  // recompute a trade cutoff mid-obligation. Checking this once up front
  // avoids sending obviously-doomed transactions for every rung; the
  // per-rung try/catch below still handles the case where the pool's state
  // flips between this check and the actual submit.
  const poolBusy = !poolAccount.openPositions.isZero() || !poolAccount.lockedCollateral.isZero();
  return {
    canAuthorize: true,
    poolBusy,
    openPositions: poolAccount.openPositions.toString(),
    lockedCollateral: poolAccount.lockedCollateral.toString(),
  };
}

/**
 * Authorizes a single rung on the pool immediately after ensureMarketRung
 * creates (or confirms) it -- the interleaved counterpart to the old
 * ensurePoolAuthorizations batch loop. A timing-related rejection here must
 * never abort the run (see the module docstring on this file's cold-start
 * bug): it is always a logged skip, counted in `counters.skipped`, exactly
 * like the pre-existing idempotent-skip and pool-busy cases. Only genuinely
 * unexpected errors (e.g. Unauthorized, a missing/undeployed program) are
 * still allowed to throw and fail the run.
 */
async function authorizeRung(params: {
  series: ScheduledSeries;
  market: PublicKey;
  managerProgram: Program<Vsol>;
  manager: Keypair;
  config: PublicKey;
  pool: PublicKey;
  authContext: PoolAuthorizationContext;
  counters: Counters;
}): Promise<void> {
  const { series, market, pool, authContext, counters } = params;

  if (!authContext.canAuthorize) {
    // The one-time pool-missing/wrong-manager line was already logged by
    // resolvePoolAuthorizationContext; repeating it per rung would just spam
    // the same fact five times.
    counters.skipped += 1;
    return;
  }

  const poolMarket = deriveLiquidityPoolMarket(pool, market);
  const existing = await params.managerProgram.account.liquidityPoolMarket.fetchNullable(poolMarket);
  if (existing && existing.enabled && existing.lastTradeAt.toNumber() === series.lastTradeAt) {
    console.log(`skip: ${series.code} pool authorization already current on ${pool.toBase58()}`);
    counters.skipped += 1;
    return;
  }

  if (authContext.poolBusy) {
    console.log(
      `skip: ${series.code} pool authorization deferred -- pool ${pool.toBase58()} has open positions (${authContext.openPositions}) or locked collateral (${authContext.lockedCollateral}); will retry once positions settle`,
    );
    counters.skipped += 1;
    return;
  }

  // Proactive timing check against a freshly read cluster clock (not the
  // `now` captured at the top of main -- earlier rungs in this same pass may
  // have taken long enough that it is stale): mirrors set_liquidity_pool_market's
  // own last_trade_at >= now + MIN_MARKET_LEAD_SECONDS && last_trade_at <
  // expiry check, so an already-doomed transaction is never even sent.
  const authorizeNow = await clusterUnixTime();
  if (!isRungAuthorizable({ now: authorizeNow, lastTradeAt: series.lastTradeAt, expiry: series.expiry })) {
    console.log(
      `skip: ${series.code} pool authorization deferred -- its trade cutoff (${new Date(series.lastTradeAt * 1000).toISOString()}) is no longer at least ${MIN_MARKET_LEAD_SECONDS}s ahead of the cluster clock (or has passed expiry); this rung aged out during this keeper run and will be retried (or superseded by the next rolling rung) on the next pass`,
    );
    counters.skipped += 1;
    return;
  }

  try {
    await params.managerProgram.methods
      .setLiquidityPoolMarket({ lastTradeAt: new BN(series.lastTradeAt), enabled: true })
      .accountsStrict({
        manager: params.manager.publicKey,
        config: params.config,
        pool,
        market,
        poolMarket,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`authorized: ${series.code} series on pool ${pool.toBase58()} (lastTradeAt ${series.lastTradeAt})`);
    counters.authorized += 1;
  } catch (error) {
    if (anchorErrorCode(error) === "PoolHasOpenPositions") {
      console.log(
        `skip: ${series.code} pool authorization deferred -- pool ${pool.toBase58()} reported open positions at submit time; will retry once positions settle`,
      );
      counters.skipped += 1;
      return;
    }
    // The same timing rejection the proactive check above guards against,
    // caught here as a backstop for the (much smaller, now that create and
    // authorize are interleaved) race between that check and this submit
    // landing onchain. This -- not a thrown, run-aborting error -- is the
    // fix for the cold-start bug: one rung aging out must never take down
    // the other four with it.
    if (anchorErrorCode(error) === "InvalidLastTradeCutoff") {
      console.log(
        `skip: ${series.code} pool authorization rejected onchain (InvalidLastTradeCutoff) -- its trade cutoff is no longer at least ${MIN_MARKET_LEAD_SECONDS}s ahead of (or has passed) the cluster clock; will retry (or be superseded) on the next keeper pass (${describeError(error)})`,
      );
      counters.skipped += 1;
      return;
    }
    if (isLostCreateRace(error)) {
      console.log(`skip: ${series.code} pool authorization lost a race on ${pool.toBase58()}`);
      counters.skipped += 1;
      return;
    }
    // A disabled market is a DELIBERATE guardian action (set_market_enabled
    // false), and authorize_pool_market refuses to enable a series on one --
    // correctly. But it is not a reason to abandon the other rungs, for the
    // same reason InvalidLastTradeCutoff above is not: one bad rung must
    // never take down the other four.
    //
    // This bites on a real, recurring path rather than a hypothetical one:
    // bootstrap disables the PREVIOUS deployment's uiMarket after an upgrade
    // (see scripts/bootstrap.ts), and because market ids are a deterministic
    // hash of their parameters, a later rung on the same expiry grid can
    // derive that exact disabled account and inherit its state. Observed
    // 2026-08-20: the EOD rung hit a disabled market and aborted the run
    // before 7D and 30D were ever minted, leaving the app with no tradable
    // series at those tenors at all. Skip and carry on; the rung recovers by
    // itself at the next expiry boundary, when it derives a fresh address.
    if (anchorErrorCode(error) === "MarketDisabled") {
      console.log(
        `skip: ${series.code} market is disabled onchain -- it was retired by the guardian (or by a prior ` +
          `bootstrap) and cannot be authorized. The remaining rungs continue; this one recovers on its own ` +
          `once the grid rolls to a fresh expiry. (${describeError(error)})`,
      );
      counters.skipped += 1;
      return;
    }
    throw new Error(`Failed to authorize ${series.code} series on pool ${pool.toBase58()}: ${describeError(error)}`);
  }
}

/**
 * Drives the full per-rung pass: for every scheduled rung, in order (15M
 * first -- the most time-critical), ensure its market exists and then
 * immediately attempt its pool authorization, before moving on to the next
 * rung. This is the interleaving fix for the cold-start bug: previously all
 * five markets were created first and only then were all five
 * authorizations attempted, so by the time the loop reached the 15M rung's
 * authorization its trade cutoff (barely a quarter-hour out to begin with)
 * had often already aged past the program's minimum lead window. The pool
 * existence/manager-key check happens exactly once, up front, and never
 * blocks market creation (which is permissionless).
 */
async function processRungs(params: {
  creatorProgram: Program<Vsol>;
  creator: Keypair;
  managerProgram: Program<Vsol>;
  manager: Keypair;
  config: PublicKey;
  pool: PublicKey;
  settlementMint: PublicKey;
  underlyingMint: PublicKey;
  schedule: ScheduledSeries[];
  counters: Counters;
  addressLookupTable?: PublicKey;
  now: number;
}): Promise<void> {
  const authContext = await resolvePoolAuthorizationContext({
    creatorProgram: params.creatorProgram,
    manager: params.manager,
    pool: params.pool,
  });

  for (const series of params.schedule) {
    const rung = await ensureMarketRung({
      creatorProgram: params.creatorProgram,
      creator: params.creator,
      config: params.config,
      settlementMint: params.settlementMint,
      underlyingMint: params.underlyingMint,
      series,
      counters: params.counters,
      addressLookupTable: params.addressLookupTable,
      now: params.now,
    });
    if (!rung) continue; // No market exists (and none was worth creating) -- nothing to authorize.

    await authorizeRung({
      series,
      market: rung.market,
      managerProgram: params.managerProgram,
      manager: params.manager,
      config: params.config,
      pool: params.pool,
      authContext,
      counters: params.counters,
    });
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
  // deployment without minting a new key file. resolvePoolAuthorizationContext
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
  const counters: Counters = { created: 0, authorized: 0, skipped: 0, altExtended: 0, altDeactivated: 0, altClosed: 0 };

  // Read-only, best-effort: the keeper's market creation must not depend on
  // the manifest existing at all, let alone publishing an ALT yet.
  const addressLookupTable = await readAddressLookupTable();

  // Interleaved per-rung pass (create, then immediately authorize) -- see
  // processRungs's docstring for why this replaced the old
  // create-all-then-authorize-all two-pass structure.
  await processRungs({
    creatorProgram,
    creator,
    managerProgram,
    manager: poolManager,
    config,
    pool,
    settlementMint,
    underlyingMint,
    schedule,
    counters,
    addressLookupTable,
    now,
  });

  // ALT lifecycle bookkeeping runs last and is best-effort (see
  // processRetiringLookupTables's docstring): a failure here must never mask
  // the market-creation/authorization work above, which is the keeper's
  // priority and has already completed by this point.
  await processRetiringLookupTables({ authority: creator, counters });

  console.log(
    `Keeper summary: created ${counters.created} markets, authorized ${counters.authorized} series, ` +
      `ALT-extended ${counters.altExtended} addresses, ALT-deactivated ${counters.altDeactivated}, ` +
      `ALT-closed ${counters.altClosed}, skipped ${counters.skipped}`,
  );
}

// Guarded so vsol/tests/keeper.test.ts can import this module's pure
// decision helpers (isRungAuthorizable) without triggering a live run --
// import.meta.main is only true when this file is executed directly (e.g.
// via "npm run keeper"), never when another module imports from it.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 1;
  });
}
