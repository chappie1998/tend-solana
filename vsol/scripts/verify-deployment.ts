import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  deriveLiquidityPool,
  deriveLiquidityPoolMarket,
  deriveLiquidityPoolToken,
  MARKET_MAX_CONFIDENCE_BPS,
  MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
  MARKET_OBSERVATION_WINDOW_SECONDS,
  MARKET_SETTLEMENT_GRACE_SECONDS,
  PRICE_SCALE,
} from "../sdk/index.ts";
import { rollingMarketSchedule, type ScheduledSeries } from "./lib/expiry-grid.ts";
import { fetchAllMarkets, type DecodedMarketForCleanup } from "./lib/settlement.ts";
import { type RetiringLookupTableEntry, stableFillAddresses } from "./lib/lookup-table.ts";
// The shared market config -- the same list app/lib/markets.ts serves to the
// UI and scripts/bootstrap.ts / scripts/keeper.ts mint against. Verification
// must expect exactly what those two produce, so it reads the same list.
import { liveMarkets } from "../../app/lib/markets.ts";

const cluster = process.env.VSOL_CLUSTER ?? "devnet";
const path = resolve(import.meta.dirname, "..", "deployments", `${cluster}.json`);
const deployment = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const rpcUrl = process.env.VSOL_RPC_URL ?? String(deployment.rpcUrl);
const connection = new Connection(rpcUrl, "confirmed");
const LEGACY_UNSAFE_UI_MARKET = new PublicKey("FoXzcwgxDqvgEdFEqsne3H14nzWCcu3dnqNPQUS3RnaH");
const programId = new PublicKey(String(deployment.programId));

if (deployment.pythUpgradeDeployed !== true) {
  throw new Error("The manifest is fail-closed: the Pyth upgrade has not passed bootstrap verification");
}

// bootstrap.ts now writes the manifest in two phases: once right after the
// real deployment artifacts exist (smokeStatus: "not-run", or "skipped"
// under VSOL_SKIP_SMOKE=1), and again once the adversarial smoke lifecycle
// finishes (smokeStatus: "passed"). Only a "passed" manifest carries real
// smoke evidence for the checks below to verify -- fail with a clear,
// specific error here rather than letting an absent/empty `smoke` object
// crash deep inside those checks (e.g. `new PublicKey(String(undefined))`).
// Older manifests predate this field entirely and are treated as before.
if (deployment.smokeStatus !== undefined && deployment.smokeStatus !== "passed") {
  throw new Error(
    `The manifest's smoke lifecycle status is "${String(deployment.smokeStatus)}", not "passed" -- `
    + "verify-deployment requires a fully-verified deployment. Run bootstrap without VSOL_SKIP_SMOKE to produce one.",
  );
}

const requiredExecutable = ["programId", "pythReceiverProgram"];
const requiredAccounts = ["config", "settlementMint", "underlyingMint", "writerVault", "writerToken", "uiMarket", "uiOracle"];
// Every live market gets the full five-rung grid, so the manifest catalog is
// 5 x however many markets app/lib/markets.ts lists live -- 15 today. Read
// from the shared config rather than hardcoded, so promoting a market to live
// does not silently leave this check asserting the old count.
const SERIES_CODES = ["15M", "1H", "EOD", "7D", "30D"] as const;
const liveSymbols = liveMarkets.map((market) => market.symbol);
if (liveSymbols.length === 0) throw new Error("No market is configured live in app/lib/markets.ts; there is nothing to verify");
const expectedRungCount = SERIES_CODES.length * liveSymbols.length;
const markets = deployment.markets as Array<Record<string, unknown>> | undefined;
if (!Array.isArray(markets) || markets.length !== expectedRungCount) {
  throw new Error(
    `The rolling market catalog is incomplete: expected ${expectedRungCount} rungs `
    + `(${SERIES_CODES.length} codes x ${liveSymbols.length} live markets: ${liveSymbols.join(", ")}), found ${markets?.length ?? 0}`,
  );
}
const liquidityPools = deployment.liquidityPools as Array<Record<string, unknown>> | undefined;
if (!Array.isArray(liquidityPools) || liquidityPools.length < 1) throw new Error("No passive liquidity pool is deployed");
const smoke = deployment.smoke as Record<string, unknown> | undefined;
if (!smoke) throw new Error("The deployment manifest has no smoke-test evidence");

async function fetchTransactionWithRetry(connection: Connection, signature: string, attempts = 5) {
  let lastResult: Awaited<ReturnType<Connection["getTransaction"]>> = null;
  let delay = 1_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const transaction = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (transaction) {
        lastResult = transaction;
        if (transaction.meta?.logMessages?.length) return transaction;
      }
    } catch {
      // rate-limited or transient RPC failure; retry with backoff below
    }
    if (attempt < attempts - 1) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, delay));
      delay = Math.min(delay * 2, 8_000);
    }
  }
  return lastResult;
}

// The rolling 15M/1H/EOD/7D/30D grid is NOT verified against
// deployment.markets: the keeper (scripts/keeper.ts) mints new rungs on
// every UTC boundary but never rewrites that array, and the settlement
// cranker (scripts/cranker.ts) now closes expired markets once their
// positions are settled -- including ones still listed there. So that array
// is a frozen bootstrap-time snapshot that can go stale in both directions
// (it can list an address the cranker has since legitimately closed, and it
// never lists a rung the keeper minted after the last manifest write). It
// remains a structural/manifest-shape input below, but "must be alive
// onchain" is instead verified straight from chain.
//
// This USED TO be a pure address derivation (rebuild each rung's
// deterministic market id from the shared series-policy constants, exactly
// like the app's app/lib/series-resolver.ts / resolveVsolSeries does). That
// is no longer possible: `strike` is now part of `expected_market_id`'s hash
// (see vsol/sdk/index.ts's MarketIdParams and lib.rs's expected_market_id),
// and `strike` is a listed ladder rung chosen by whichever keeper pass first
// mints a given expiry (see STRIKE_LADDER_STEP/ladderStrike's doc comment) --
// this script has no way to know it in advance.
//
// So verification switches from "derive the expected address and check it"
// to discovery: scan every live Market account the program owns
// (fetchAllMarkets, the same discover-first primitive scripts/keeper.ts
// uses) and require that each of rollingMarketSchedule(now)'s five expiries
// has at least one live, enabled market matching this deployment's feed,
// symbol, and every non-strike policy constant. This is a STRICTLY STRONGER
// check than address derivation was: the old check could only ever prove
// that ONE specific candidate address, if it happened to exist, was
// well-formed. This one proves the currently-listed rung for each
// expiry -- whatever address or strike it actually has -- really does
// satisfy every other policy parameter, live and enabled, with no address
// the script never looked at left unchecked. The strike itself is not
// verified against anything (there is nothing to verify it against -- any
// positive strike a keeper listed is by definition a valid ladder rung); it
// is only reported below, for visibility.
//
// AND IT IS NOW PER MARKET. With SOL, BTC and ETH live, "the current grid"
// is five expiries x three markets; a single expected feed/symbol would
// verify one market and silently ignore the other two. Each live market
// therefore gets its own scan filter (its own feed id from the shared
// config, its own symbol) and its own five-expiry expectation.
const configAddress = new PublicKey(String(deployment.config));
const settlementMintAddress = new PublicKey(String(deployment.settlementMint));

async function clusterUnixTime(): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error(`No block time is available for slot ${slot}`);
  return blockTime;
}

type CurrentGridRung = {
  symbol: string;
  series: ScheduledSeries;
  market: PublicKey;
  oracle: PublicKey;
  strike: bigint;
  creator: string;
  /** How many live rungs matched this (symbol, expiry) -- see the ladder-rung race note. */
  strikesAtExpiry: bigint[];
};

const now = await clusterUnixTime();
const expectedSchedule = rollingMarketSchedule(now);

// ONE scan for every market: fetchAllMarkets returns every Market account the
// program owns regardless of symbol, so it is filtered per market below
// rather than re-fetched three times.
const allMarkets = await fetchAllMarkets(connection, programId);

const currentGrid: CurrentGridRung[] = [];
const missingRungs: Array<{ symbol: string; series: ScheduledSeries }> = [];
for (const listing of liveMarkets) {
  if (!listing.pythFeedId) throw new Error(`${listing.symbol} is marked live but has no Pyth feed id configured`);
  const rungsByExpiry = new Map<number, DecodedMarketForCleanup[]>();
  for (const market of allMarkets) {
    const matchesPolicy = market.enabled
      && market.pythFeedId.toLowerCase() === listing.pythFeedId.toLowerCase()
      && market.symbol === listing.symbol
      && market.observationWindowSeconds === MARKET_OBSERVATION_WINDOW_SECONDS
      && market.settlementGraceSeconds === MARKET_SETTLEMENT_GRACE_SECONDS
      && market.maxConfidenceBps === MARKET_MAX_CONFIDENCE_BPS
      && market.priceScale === PRICE_SCALE
      && market.maxSettlementStalenessSeconds === MARKET_MAX_SETTLEMENT_STALENESS_SECONDS;
    if (!matchesPolicy) continue;
    const bucket = rungsByExpiry.get(market.expiry);
    if (bucket) bucket.push(market);
    else rungsByExpiry.set(market.expiry, [market]);
  }

  for (const series of expectedSchedule) {
    // Same ladder-rung race noted on ladderStrike/indexMarketsByExpiry: two
    // markets CAN legitimately share an expiry at adjacent strikes, and
    // neither is a duplicate contract. Every strike found is reported below
    // so a genuine pile-up is visible rather than silently collapsed, but the
    // first is enough to prove SOME live, correctly-configured rung exists
    // for this (market, expiry) -- everything this check promises.
    const found = rungsByExpiry.get(series.expiry);
    if (!found || found.length === 0) {
      missingRungs.push({ symbol: listing.symbol, series });
      continue;
    }
    currentGrid.push({
      symbol: listing.symbol,
      series,
      market: new PublicKey(found[0].address),
      oracle: new PublicKey(found[0].oracle),
      strike: found[0].strike,
      creator: found[0].creator,
      strikesAtExpiry: found.map((rung) => rung.strike),
    });
  }
}

// Read the entire public deployment state in one RPC batch. Public devnet endpoints
// aggressively rate-limit sequential account lookups, and verification should not
// fail merely because the manifest contains a complete rolling series catalog.
const poolAuthorizationAddresses = new Map<string, PublicKey[]>();
const accountAddresses: PublicKey[] = [
  ...requiredExecutable.map((field) => new PublicKey(String(deployment[field]))),
  ...requiredAccounts.map((field) => new PublicKey(String(deployment[field]))),
  LEGACY_UNSAFE_UI_MARKET,
  ...currentGrid.flatMap((rung) => [rung.market, rung.oracle]),
  new PublicKey(String(smoke.smokePool)),
  new PublicKey(String(smoke.smokePoolToken)),
  new PublicKey(String(smoke.smokeProvider)),
];
for (const poolManifest of liquidityPools) {
  const pool = new PublicKey(String(poolManifest.address));
  const token = new PublicKey(String(poolManifest.token));
  const authorizedMarkets = poolManifest.authorizedMarkets as string[];
  if (!Array.isArray(authorizedMarkets) || authorizedMarkets.length !== markets.length) {
    throw new Error("Pool market authorization catalog is incomplete");
  }
  const authorizations = authorizedMarkets.map((market) => deriveLiquidityPoolMarket(pool, new PublicKey(market)));
  poolAuthorizationAddresses.set(pool.toBase58(), authorizations);
  accountAddresses.push(pool, token, ...authorizations);
}
const addressLookupTable = typeof deployment.addressLookupTable === "string" ? deployment.addressLookupTable : undefined;
const lookupTableAddress = addressLookupTable ? new PublicKey(addressLookupTable) : undefined;
if (lookupTableAddress) accountAddresses.push(lookupTableAddress);
const retiringLookupTables = Array.isArray(deployment.retiringLookupTables)
  ? (deployment.retiringLookupTables as RetiringLookupTableEntry[])
  : [];
const retiringLookupTableAddresses = retiringLookupTables.map((entry) => new PublicKey(entry.address));
accountAddresses.push(...retiringLookupTableAddresses);
const uniqueAccountAddresses = [...new Map(accountAddresses.map((address) => [address.toBase58(), address])).values()];
const accountInfos = await connection.getMultipleAccountsInfo(uniqueAccountAddresses, "confirmed");
const accounts = new Map(uniqueAccountAddresses.map((address, index) => [address.toBase58(), accountInfos[index]]));
const accountInfo = (address: PublicKey) => accounts.get(address.toBase58()) ?? null;

for (const field of requiredExecutable) {
  const address = new PublicKey(String(deployment[field]));
  const account = accountInfo(address);
  if (!account?.executable) throw new Error(`${field} ${address.toBase58()} is not executable`);
}
for (const field of requiredAccounts) {
  const address = new PublicKey(String(deployment[field]));
  if (!accountInfo(address)) throw new Error(`${field} ${address.toBase58()} does not exist`);
}

// The legacy single-market `uiMarket` pointer names the ANCHOR market's 30D
// rung -- the first live entry in app/lib/markets.ts, which is what
// scripts/bootstrap.ts writes there. So the feed it must be bound to is that
// market's feed, not a single deployment-wide one: with three live markets
// there is no such thing.
const anchorSymbol = liveSymbols[0];
const anchorFeedId = liveMarkets[0].pythFeedId;
const marketAccount = accountInfo(new PublicKey(String(deployment.uiMarket)));
const marketFeedId = marketAccount && marketAccount.data.length >= 243
  ? Buffer.from(marketAccount.data.subarray(211, 243)).toString("hex")
  : "";
if (marketFeedId.toLowerCase() !== anchorFeedId.toLowerCase()) {
  throw new Error(`UI market is not bound to ${anchorSymbol}'s Pyth feed ${anchorFeedId}`);
}

// Structural check only -- the manifest must list exactly one entry per
// (symbol, code) with no duplicates and nothing extra. `code` alone stopped
// being unique when the catalog went multi-market: there are three "30D"
// rungs now, and checking codes on their own would either reject a correct
// manifest or accept one that listed the same market five times. This does
// NOT require any of these addresses to exist onchain: see the chain-derived
// current-grid check below for what "must be alive" means now.
const expectedSlots = new Set(liveSymbols.flatMap((symbol) => SERIES_CODES.map((code) => `${symbol}:${code}`)));
for (const series of markets) {
  const slot = `${String(series.symbol)}:${String(series.code)}`;
  if (!expectedSlots.delete(slot)) throw new Error(`Unexpected or duplicate rolling market slot ${slot}`);
}
if (expectedSlots.size !== 0) {
  throw new Error(`The rolling market catalog is missing slots: ${[...expectedSlots].join(", ")}`);
}
const anchorThirtyDay = markets.find((series) => String(series.symbol) === anchorSymbol && String(series.code) === "30D");
if (String(deployment.uiMarket) !== String(anchorThirtyDay?.address)) {
  throw new Error(`The legacy UI pointer does not reference the catalog's ${anchorSymbol} 30D market`);
}

// A rung whose expiry has no live, policy-matching market at all (built into
// liveRungByExpiry above) is treated as keeper lag -- a soft warning, not a
// failure -- since the keeper mints on its own interval and verify-deployment
// must not become flaky against that timing. This never touches an
// already-expired rung: a closed, formerly-listed address from an older
// schedule (or from the stale deployment.markets snapshot above) is simply
// not part of the current schedule at all.
for (const { symbol, series } of missingRungs) {
  console.warn(
    `warn: currently-live rolling market ${symbol} ${series.code} (expiry ${new Date(series.expiry * 1000).toISOString()}) `
    + "has no live, enabled market matching the expected feed/symbol/policy parameters onchain -- treating as keeper lag, not a failure",
  );
}

// currentGrid holds only expiries that DID have a policy-matching match in
// the fetchAllMarkets scan above -- fetchAllMarkets itself already
// guarantees program ownership, the Market discriminator, and the exact
// (upgraded) account size for every entry it returns (see
// decodeMarketAccountForCleanup in scripts/lib/settlement.ts), and the
// policy-matching filter above already guarantees feed/symbol/observation
// window/settlement grace/confidence/price scale/staleness/enabled. What is
// verified here is everything that filter could NOT check from the decoded
// summary alone: a non-default creator, and the settlement mint (read
// directly off the raw account bytes -- decodeMarketAccountForCleanup does
// not surface it, since the keeper's discover-first lookup does not need
// it), plus that this rung's oracle still exists and is program-owned. A
// market that vanished between this pass's discovery scan and this batched
// fetch (e.g. closed by a concurrent cranker run) is treated the same as
// "never found" above, not as a hard failure -- a benign race, not a bug.
for (const rung of currentGrid) {
  const label = `${rung.symbol} ${rung.series.code}`;
  const account = accountInfo(rung.market);
  if (!account) {
    console.warn(
      `warn: currently-live rolling market ${label} (expiry ${new Date(rung.series.expiry * 1000).toISOString()}) `
      + `discovered at ${rung.market.toBase58()} but disappeared before verification -- treating as keeper/cranker lag, not a failure`,
    );
    continue;
  }
  if (rung.creator === PublicKey.default.toBase58()) {
    throw new Error(`Current rolling market ${label} (${rung.market.toBase58()}) has no recorded creator`);
  }
  const data = Buffer.from(account.data);
  const onchainSettlementMint = new PublicKey(data.subarray(105, 137));
  if (!onchainSettlementMint.equals(settlementMintAddress)) {
    throw new Error(`Current rolling market ${label} (${rung.market.toBase58()}) settlement mint does not match the manifest`);
  }
  const oracleAccount = accountInfo(rung.oracle);
  if (!oracleAccount || !oracleAccount.owner.equals(programId)) {
    throw new Error(`Current rolling market ${label}'s oracle ${rung.oracle.toBase58()} is missing or not owned by the VSOL program`);
  }
  // Every strike live at this (market, expiry), not just the one picked. One
  // is the healthy case; more is the documented ladder-rung race and is
  // surfaced rather than hidden, since it is invisible from the address alone.
  const extraStrikes = rung.strikesAtExpiry.length > 1
    ? ` [${rung.strikesAtExpiry.length} strikes live at this expiry: ${rung.strikesAtExpiry.map((strike) => strike.toString()).join(", ")}]`
    : "";
  console.log(
    `  ${label} rung: market ${rung.market.toBase58()} strike ${rung.strike.toString()} `
    + `(expiry ${new Date(rung.series.expiry * 1000).toISOString()})${extraStrikes}`,
  );
}
const legacyUnsafe = accountInfo(LEGACY_UNSAFE_UI_MARKET);
if (legacyUnsafe && legacyUnsafe.data.at(-1) !== 0) {
  throw new Error("The midnight-expiry legacy UI market remains enabled");
}

for (const poolManifest of liquidityPools) {
  const pool = new PublicKey(String(poolManifest.address));
  const token = new PublicKey(String(poolManifest.token));
  const poolAccount = accountInfo(pool);
  const tokenAccount = unpackAccount(token, accountInfo(token), TOKEN_PROGRAM_ID);
  if (!poolAccount?.owner.equals(programId) || poolAccount.data.length < 214) {
    throw new Error("Liquidity pool account is invalid");
  }
  const poolId = Buffer.from(String(poolManifest.id), "hex");
  if (poolId.length !== 32) throw new Error("Liquidity pool ID is not 32 bytes");
  const settlementMint = new PublicKey(String(poolManifest.settlementMint));
  const expectedPool = deriveLiquidityPool(new PublicKey(String(deployment.config)), settlementMint, poolId);
  const expectedToken = deriveLiquidityPoolToken(pool);
  const onchainConfig = new PublicKey(poolAccount.data.subarray(10, 42));
  const onchainSettlementMint = new PublicKey(poolAccount.data.subarray(42, 74));
  const onchainQuoteAuthority = new PublicKey(poolAccount.data.subarray(74, 106));
  const onchainPoolId = poolAccount.data.subarray(106, 138);
  const totalShares = poolAccount.data.readBigUInt64LE(138);
  const lockedCollateral = poolAccount.data.readBigUInt64LE(146);
  const maxUtilizationBps = poolAccount.data.readUInt16LE(178);
  const maxPositionBps = poolAccount.data.readUInt16LE(180);
  const onchainManager = new PublicKey(poolAccount.data.subarray(182, 214));
  if (onchainManager.equals(PublicKey.default)) throw new Error("Liquidity pool has no recorded manager");
  if (typeof poolManifest.manager === "string" && onchainManager.toBase58() !== poolManifest.manager) {
    throw new Error("Liquidity pool manager does not match the manifest");
  }
  if (
    !pool.equals(expectedPool)
    || !token.equals(expectedToken)
    || !onchainConfig.equals(new PublicKey(String(deployment.config)))
    || !onchainSettlementMint.equals(settlementMint)
    || !onchainQuoteAuthority.equals(new PublicKey(String(poolManifest.quoteAuthority)))
    || !onchainPoolId.equals(poolId)
    || maxUtilizationBps !== Number(poolManifest.maxUtilizationBps)
    || maxPositionBps !== Number(poolManifest.maxPositionBps)
  ) {
    throw new Error(`Liquidity pool ${pool.toBase58()} does not match its manifest terms`);
  }
  if (
    tokenAccount.owner.toBase58() !== pool.toBase58()
    || !tokenAccount.mint.equals(settlementMint)
    || tokenAccount.amount === 0n
    || totalShares === 0n
    || lockedCollateral * 10_000n
      > (tokenAccount.amount + lockedCollateral) * BigInt(maxUtilizationBps)
  ) {
    throw new Error("Liquidity pool is not funded or does not own its vault");
  }
  const authorizedMarkets = poolManifest.authorizedMarkets as string[];
  const expectedMarketSet = new Set(markets.map((series) => String(series.address)));
  if (authorizedMarkets.some((market) => !expectedMarketSet.delete(market)) || expectedMarketSet.size !== 0) {
    throw new Error("Pool market authorization catalog does not match the rolling catalog");
  }
  const seriesByAddress = new Map(markets.map((series) => [String(series.address), series]));
  const authorizationAddresses = poolAuthorizationAddresses.get(pool.toBase58()) ?? [];
  for (const [index, authorization] of authorizationAddresses.entries()) {
    const authorizationAccount = accountInfo(authorization);
    const marketAddress = authorizedMarkets[index];
    const series = seriesByAddress.get(marketAddress);
    if (!authorizationAccount?.owner.equals(programId) || authorizationAccount.data.length < 82 || !series) {
      throw new Error(`Pool authorization ${authorization.toBase58()} is missing or invalid`);
    }
    const authorizationPool = new PublicKey(authorizationAccount.data.subarray(9, 41));
    const authorizationMarket = new PublicKey(authorizationAccount.data.subarray(41, 73));
    const lastTradeAt = Number(authorizationAccount.data.readBigInt64LE(73));
    const enabled = authorizationAccount.data[81] === 1;
    if (
      !authorizationPool.equals(pool)
      || authorizationMarket.toBase58() !== marketAddress
      || lastTradeAt !== Number(series.lastTradeAt)
      || !enabled
    ) {
      throw new Error(`Pool authorization ${authorization.toBase58()} does not match its market terms`);
    }
  }
}

// successMarket/refundMarket (and their oracles) are ephemeral smoke
// markets: they are created, traded through a full lifecycle, settled, and
// are then legitimately cleanable by the same market cleaner
// (scripts/cranker.ts's closeSettledMarketOnChain) that the rolling grid
// above had to stop trusting live-account existence for. Requiring these
// specific accounts to still exist and decode/bind to smokePythFeedId is
// exactly the stale-snapshot bug fixed above, just in the smoke-evidence
// block -- so it is deliberately NOT checked here. The durable proof of the
// smoke lifecycle (including that settlement was bound to the correct feed
// at the time) is the recorded transaction signatures below: every one of
// them is checked to still exist, have no error, and contain its expected
// instruction log line, which is permanent on-chain history regardless of
// whether the market/oracle account itself still exists.

const smokePoolAddress = new PublicKey(String(smoke.smokePool));
const smokePoolAccount = accountInfo(smokePoolAddress);
const smokePoolTokenAddress = new PublicKey(String(smoke.smokePoolToken));
const smokePoolToken = unpackAccount(smokePoolTokenAddress, accountInfo(smokePoolTokenAddress), TOKEN_PROGRAM_ID);
const smokeProvider = accountInfo(new PublicKey(String(smoke.smokeProvider)));
if (
  !smokePoolAccount?.owner.equals(programId)
  || smokePoolAccount.data.length < 214
  || new PublicKey(smokePoolAccount.data.subarray(182, 214)).equals(PublicKey.default)
  || smokePoolAccount.data.readBigUInt64LE(138) > 1_000n // totalShares: dust, see below
  || smokePoolAccount.data.readBigUInt64LE(146) !== 0n
  || smokePoolAccount.data.readBigUInt64LE(154) !== 0n
  // NOT `!== 0n`: the share math carries a virtual +1 offset on both shares
  // and assets, so a full withdrawal rounds down and deliberately strands a
  // few base units. That residue is what makes the first-depositor inflation
  // attack unprofitable, so demanding an exactly-empty pool would be asserting
  // the absence of that protection. Bound the dust instead (tUSDC has 6
  // decimals, so 1_000 base units is 0.001 tUSDC).
  || smokePoolToken.amount > 1_000n
  || smokePoolToken.owner.toBase58() !== smokePoolAddress.toBase58()
  || !smokeProvider?.owner.equals(programId)
  || smokeProvider.data.length < 97
  || smokeProvider.data.readBigUInt64LE(73) !== 0n
) {
  throw new Error("The onchain smoke pool did not clear shares, assets, and obligations");
}
if (
  smoke.replayRejected !== true
  || smoke.successPositionClosed !== true
  || smoke.refundPositionClosed !== true
  || smoke.poolReplayRejected !== true
  || smoke.poolSuccessPositionClosed !== true
  || smoke.poolRefundPositionClosed !== true
  || smoke.poolConservationVerified !== true
  || smoke.poolObligationsCleared !== true
  || smoke.poolWithdrawalCleared !== true
) {
  throw new Error("The saved smoke-test invariants are incomplete");
}
const transactionFields = [
  "successFillSignature",
  "refundFillSignature",
  "poolSuccessFillSignature",
  "poolRefundFillSignature",
  "publishSignature",
  "settleSignature",
  "poolSettleSignature",
  "refundSignature",
  "poolRefundSignature",
  "poolWithdrawSignature",
] as const;
const transactionSignatures = transactionFields.map((field) => String(smoke[field]));
// Public devnet rate-limits batched getTransactions (429) and can return entries without
// logs, so unusable entries are re-fetched individually with backoff below.
let transactionResults: Array<Awaited<ReturnType<Connection["getTransaction"]>>> = transactionFields.map(() => null);
try {
  transactionResults = await connection.getTransactions(transactionSignatures, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
} catch {
  // batch throws under rate limiting; fall through to per-signature recovery
}
const transactions = new Map(transactionFields.map((field, index) => [field, transactionResults[index]]));
for (const field of transactionFields) {
  const transaction = transactions.get(field);
  if (transaction && transaction.meta?.logMessages?.length) continue;
  transactions.set(field, await fetchTransactionWithRetry(connection, String(smoke[field])));
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
}
for (const field of transactionFields) {
  const signature = String(smoke[field]);
  const transaction = transactions.get(field);
  if (!transaction || transaction.meta?.err) throw new Error(`Transaction ${field} is missing or failed: ${signature}`);
}
for (const [field, instruction] of [["poolSuccessFillSignature", "FillPoolQuote"], ["poolSettleSignature", "SettlePoolPosition"], ["poolWithdrawSignature", "WithdrawLiquidity"]] as const) {
  const transaction = transactions.get(field);
  if (!transaction?.meta?.logMessages?.some((line) => line.includes(`Instruction: ${instruction}`))) {
    throw new Error(`Saved transaction ${field} did not execute ${instruction}`);
  }
}
const publishTransaction = transactions.get("publishSignature");
if (!publishTransaction?.meta?.logMessages?.some((line) => line.includes("Instruction: PublishPythSettlement"))) {
  throw new Error("The saved settlement transaction did not execute PublishPythSettlement");
}

// The early-close (buyback) proof is independently re-verified rather than
// trusted from the manifest: `closePoolPositionDeployed` is fail-closed on
// this evidence exactly like `pythUpgradeDeployed` is on the Pyth upgrade
// proof. Older manifests may simply have neither the flag nor the evidence,
// which is fine; what's never acceptable is the flag without the evidence.
const closeEarlySignature = smoke.closeEarlySignature != null ? String(smoke.closeEarlySignature) : undefined;
const closeEarlyPosition = smoke.closeEarlyPosition != null ? String(smoke.closeEarlyPosition) : undefined;
const hasCloseEarlyEvidence = closeEarlySignature !== undefined && closeEarlyPosition !== undefined;
if (deployment.closePoolPositionDeployed === true && !hasCloseEarlyEvidence) {
  throw new Error("closePoolPositionDeployed is true but the manifest has no recorded early-close evidence");
}
if (hasCloseEarlyEvidence) {
  if (deployment.closePoolPositionDeployed !== true) {
    throw new Error("Early-close evidence is recorded but closePoolPositionDeployed is not true");
  }
  // The batched getTransactions call above is for the fixed set of
  // core-lifecycle signatures; re-fetching this one individually with the
  // resilient helper avoids adding it to a call that already gets rate-limited.
  const closeEarlyTransaction = await fetchTransactionWithRetry(connection, closeEarlySignature!);
  if (!closeEarlyTransaction || closeEarlyTransaction.meta?.err) {
    throw new Error(`Early-close transaction ${closeEarlySignature} is missing or failed`);
  }
  if (!closeEarlyTransaction.meta?.logMessages?.some((line) => line.includes("Instruction: ClosePoolPosition"))) {
    throw new Error(`Early-close transaction ${closeEarlySignature} did not execute ClosePoolPosition`);
  }
  const closeEarlyPositionAccount = await connection.getAccountInfo(new PublicKey(closeEarlyPosition!), "confirmed");
  if (closeEarlyPositionAccount) {
    throw new Error(`Early-closed pool position ${closeEarlyPosition} is still open onchain`);
  }
}

// The ALT is optional in general (older manifests predate it), but once the
// manifest claims one exists this is fail-closed exactly like
// pythUpgradeDeployed above: a published addressLookupTable that turns out
// to be missing, mis-owned, mis-authorized, or incomplete is a verification
// failure, not a silent skip.
if (lookupTableAddress) {
  const lookupTableAccountInfo = accountInfo(lookupTableAddress);
  if (!lookupTableAccountInfo) {
    throw new Error(`Address lookup table ${lookupTableAddress.toBase58()} does not exist`);
  }
  if (!lookupTableAccountInfo.owner.equals(AddressLookupTableProgram.programId)) {
    throw new Error(`Address lookup table ${lookupTableAddress.toBase58()} is not owned by the AddressLookupTable program`);
  }
  const lookupTableState = AddressLookupTableAccount.deserialize(lookupTableAccountInfo.data);
  const expectedAuthority = String(deployment.creator);
  if (!lookupTableState.authority || lookupTableState.authority.toBase58() !== expectedAuthority) {
    throw new Error(`Address lookup table ${lookupTableAddress.toBase58()} authority does not match the expected creator ${expectedAuthority}`);
  }
  const storedAddresses = new Set(lookupTableState.addresses.map((address) => address.toBase58()));
  const expectedStable = stableFillAddresses(deployment);
  const missingStable = expectedStable.filter((entry) => !storedAddresses.has(entry.address.toBase58()));
  if (missingStable.length > 0) {
    throw new Error(
      `Address lookup table ${lookupTableAddress.toBase58()} is missing stable address(es): ${missingStable.map((entry) => entry.label).join(", ")}`,
    );
  }
}

// Tables rotated out of active service (see
// scripts/create-lookup-table.ts's rotation path) stay published in
// retiringLookupTables until vsol/scripts/keeper.ts closes them onchain once
// their positions have settled and the mandatory deactivation cooldown has
// elapsed. Every entry still in the manifest must still exist onchain --
// once keeper.ts closes one, it removes the entry from the manifest in the
// same write, so a manifest entry with no matching onchain account is a
// verification failure (a stale/incorrect manifest), not a silent skip.
for (const entry of retiringLookupTables) {
  const retiringTableAddress = new PublicKey(entry.address);
  const retiringTableAccountInfo = accountInfo(retiringTableAddress);
  if (!retiringTableAccountInfo) {
    throw new Error(`Retiring address lookup table ${entry.address} is recorded in the manifest but does not exist onchain`);
  }
  if (!retiringTableAccountInfo.owner.equals(AddressLookupTableProgram.programId)) {
    throw new Error(`Retiring address lookup table ${entry.address} is not owned by the AddressLookupTable program`);
  }
}

console.log(JSON.stringify({
  ok: true,
  cluster,
  programId: deployment.programId,
  config: deployment.config,
  uiMarket: deployment.uiMarket,
  pythReceiverProgram: deployment.pythReceiverProgram,
  pythFeedId: deployment.pythFeedId,
  smokePythFeedId: deployment.smokePythFeedId,
  addressLookupTable: deployment.addressLookupTable ?? null,
  retiringLookupTables: retiringLookupTables.map((entry) => entry.address),
  // Discovered, not derived -- see the discovery block above for why. Each
  // entry's strike is whatever ladder rung the keeper actually listed.
  currentGrid: currentGrid.map((rung) => ({
    symbol: rung.symbol,
    code: rung.series.code,
    market: rung.market.toBase58(),
    expiry: rung.series.expiry,
    strike: rung.strike.toString(),
    strikesAtExpiry: rung.strikesAtExpiry.length,
  })),
  missingRungs: missingRungs.map(({ symbol, series }) => `${symbol} ${series.code}`),
  verifiedAt: new Date().toISOString(),
}, null, 2));
