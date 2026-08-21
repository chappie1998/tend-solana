import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  deriveLiquidityPool,
  deriveLiquidityPoolMarket,
  deriveLiquidityPoolToken,
  deriveMarket,
  deriveMarketId,
  deriveOracle,
  MARKET_MAX_CONFIDENCE_BPS,
  MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
  MARKET_OBSERVATION_WINDOW_SECONDS,
  MARKET_SETTLEMENT_GRACE_SECONDS,
  PRICE_SCALE,
  symbolBytes,
} from "../sdk/index.ts";
import { rollingMarketSchedule, type ScheduledSeries } from "./lib/expiry-grid.ts";
import { type RetiringLookupTableEntry, stableFillAddresses } from "./lib/lookup-table.ts";

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

const requiredExecutable = ["programId", "pythReceiverProgram"];
const requiredAccounts = ["config", "settlementMint", "underlyingMint", "writerVault", "writerToken", "uiMarket", "uiOracle"];
const expectedFeedId = String(deployment.pythFeedId);
const markets = deployment.markets as Array<Record<string, unknown>> | undefined;
if (!Array.isArray(markets) || markets.length !== 5) throw new Error("The rolling NVDA market catalog is incomplete");
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
// onchain" is instead re-derived straight from chain, the same way the app
// resolves the tradeable grid (see app/lib/series-resolver.ts /
// resolveVsolSeries and app/lib/expiries.ts): recompute the current grid
// from the cluster clock via the shared rollingMarketSchedule that
// bootstrap.ts and keeper.ts both import, then rebuild each rung's
// deterministic market id/address with the same series-policy constants
// they use. rollingMarketSchedule always returns rungs strictly ahead of
// `now` (see expiry-grid.ts's nextFixedBoundary/advanceUntilAfter), so every
// rung it returns is, by construction, currently tradeable -- there is no
// separate "is this expired" filter to apply here.
const MARKET_SYMBOL = "NVDA"; // Not an SDK export -- mirrors the same local constant in scripts/keeper.ts and scripts/bootstrap.ts.
// Anchor account discriminator for the `Market` struct (see
// target/idl/vsol.json's accounts[].discriminator), so a same-owner account
// of a different type can never be mistaken for a rolling-grid market.
const MARKET_ACCOUNT_DISCRIMINATOR = Buffer.from([219, 190, 213, 55, 0, 227, 198, 154]);
const configAddress = new PublicKey(String(deployment.config));
const settlementMintAddress = new PublicKey(String(deployment.settlementMint));
const pythFeedBytes = [...Buffer.from(expectedFeedId, "hex")];

async function clusterUnixTime(): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error(`No block time is available for slot ${slot}`);
  return blockTime;
}

type CurrentGridRung = { series: ScheduledSeries; id: Buffer; market: PublicKey; oracle: PublicKey };

const now = await clusterUnixTime();
const currentGrid: CurrentGridRung[] = [];
for (const series of rollingMarketSchedule(now)) {
  const id = await deriveMarketId({
    pythFeedId: pythFeedBytes,
    settlementMint: settlementMintAddress,
    expiry: BigInt(series.expiry),
    observationWindowSeconds: MARKET_OBSERVATION_WINDOW_SECONDS,
    settlementGraceSeconds: MARKET_SETTLEMENT_GRACE_SECONDS,
    priceScale: PRICE_SCALE,
    maxConfidenceBps: MARKET_MAX_CONFIDENCE_BPS,
    symbol: symbolBytes(MARKET_SYMBOL),
    maxSettlementStalenessSeconds: MARKET_MAX_SETTLEMENT_STALENESS_SECONDS,
  });
  const market = deriveMarket(configAddress, id);
  const oracle = deriveOracle(market);
  currentGrid.push({ series, id, market, oracle });
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

const marketAccount = accountInfo(new PublicKey(String(deployment.uiMarket)));
const marketFeedId = marketAccount && marketAccount.data.length >= 243
  ? Buffer.from(marketAccount.data.subarray(211, 243)).toString("hex")
  : "";
if (marketFeedId !== expectedFeedId) throw new Error(`UI market is not bound to Pyth feed ${expectedFeedId}`);

// Structural check only -- the manifest must still list one entry per
// expected code with no duplicates. This does NOT require any of these
// addresses to exist onchain: see the chain-derived current-grid check
// below for what "must be alive" means now.
const expectedCodes = new Set(["15M", "1H", "EOD", "7D", "30D"]);
for (const series of markets) {
  const code = String(series.code);
  if (!expectedCodes.delete(code)) throw new Error(`Unexpected or duplicate rolling market code ${code}`);
}
if (String(deployment.uiMarket) !== String(markets.find((series) => series.code === "30D")?.address)) {
  throw new Error("The legacy UI pointer does not reference the catalog's 30D market");
}

// Chain-derived current grid: every rung rollingMarketSchedule(now) returns
// is currently tradeable by construction, so a market that DOES exist must
// be correctly formed (hard failure below). A rung that does NOT yet exist
// is treated as keeper lag -- a soft warning, not a failure -- since the
// keeper mints on its own interval and verify-deployment must not become
// flaky against that timing. This never touches an already-expired rung: a
// closed, formerly-listed address from an older schedule (or from the stale
// deployment.markets snapshot above) is simply not part of currentGrid at all.
for (const rung of currentGrid) {
  const account = accountInfo(rung.market);
  if (!account) {
    console.warn(
      `warn: currently-live rolling market ${rung.series.code} (expiry ${new Date(rung.series.expiry * 1000).toISOString()}) `
      + `is not yet minted onchain at ${rung.market.toBase58()} -- treating as keeper lag, not a failure`,
    );
    continue;
  }
  if (!account.owner.equals(programId)) {
    throw new Error(`Current rolling market ${rung.series.code} (${rung.market.toBase58()}) is not owned by the VSOL program`);
  }
  const data = Buffer.from(account.data);
  if (data.length < 281 || !data.subarray(0, 8).equals(MARKET_ACCOUNT_DISCRIMINATOR)) {
    throw new Error(`Current rolling market ${rung.series.code} (${rung.market.toBase58()}) does not decode as a Market account`);
  }
  if (!rung.id.equals(data.subarray(41, 73))) {
    throw new Error(`Current rolling market ${rung.series.code} (${rung.market.toBase58()}) market id does not match its derived parameters`);
  }
  const creator = new PublicKey(data.subarray(245, 277));
  if (creator.equals(PublicKey.default)) {
    throw new Error(`Current rolling market ${rung.series.code} (${rung.market.toBase58()}) has no recorded creator`);
  }
  const feedId = data.subarray(211, 243).toString("hex");
  if (feedId !== expectedFeedId) {
    throw new Error(`Current rolling market ${rung.series.code} (${rung.market.toBase58()}) is not bound to Pyth feed ${expectedFeedId}`);
  }
  const onchainExpiry = Number(data.readBigInt64LE(193));
  if (onchainExpiry !== rung.series.expiry) {
    throw new Error(`Current rolling market ${rung.series.code} (${rung.market.toBase58()}) expiry does not match the derived grid`);
  }
  const observationWindow = data.readUInt32LE(201);
  const settlementGrace = data.readUInt32LE(205);
  const maxConfidenceBps = data.readUInt16LE(209);
  const maxSettlementStalenessSeconds = data.readUInt32LE(277);
  if (
    observationWindow !== MARKET_OBSERVATION_WINDOW_SECONDS
    || settlementGrace !== MARKET_SETTLEMENT_GRACE_SECONDS
    || maxConfidenceBps !== MARKET_MAX_CONFIDENCE_BPS
    || maxSettlementStalenessSeconds !== MARKET_MAX_SETTLEMENT_STALENESS_SECONDS
  ) {
    throw new Error(`Current rolling market ${rung.series.code} (${rung.market.toBase58()}) does not use the expected series policy constants`);
  }
  const onchainSettlementMint = new PublicKey(data.subarray(105, 137));
  if (!onchainSettlementMint.equals(settlementMintAddress)) {
    throw new Error(`Current rolling market ${rung.series.code} (${rung.market.toBase58()}) settlement mint does not match the manifest`);
  }
  const oracleAccount = accountInfo(rung.oracle);
  if (!oracleAccount || !oracleAccount.owner.equals(programId)) {
    throw new Error(`Current rolling market ${rung.series.code}'s oracle ${rung.oracle.toBase58()} is missing or not owned by the VSOL program`);
  }
}
const legacyUnsafe = accountInfo(LEGACY_UNSAFE_UI_MARKET);
if (legacyUnsafe && legacyUnsafe.data.at(-1) !== 0) {
  throw new Error("The midnight-expiry legacy NVDA market remains enabled");
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
  verifiedAt: new Date().toISOString(),
}, null, 2));
