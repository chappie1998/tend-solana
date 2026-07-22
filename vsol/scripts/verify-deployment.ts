import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  deriveLiquidityPool,
  deriveLiquidityPoolMarket,
  deriveLiquidityPoolToken,
  deriveMarketId,
} from "../sdk/index.ts";
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

// Factory market layout, offsets from the start of the account data
// (including the 8-byte Anchor discriminator): ... settlement_decimals @ 243,
// enabled @ 244, creator @ 245..277, max_settlement_staleness_seconds (u32)
// @ 277..281 -- appended after launch, so total account size is 281 bytes.
async function expectFactoryMarket(label: string, data: Buffer, expectedCreator?: unknown) {
  if (data.length < 281) throw new Error(`${label} does not use the factory market layout`);
  const maxSettlementStalenessSeconds = data.readUInt32LE(277);
  if (maxSettlementStalenessSeconds <= 0 || maxSettlementStalenessSeconds > 604_800) {
    throw new Error(`${label} has an invalid max settlement staleness`);
  }
  const id = await deriveMarketId({
    pythFeedId: data.subarray(211, 243),
    settlementMint: new PublicKey(data.subarray(105, 137)),
    expiry: data.readBigInt64LE(193),
    observationWindowSeconds: data.readUInt32LE(201),
    settlementGraceSeconds: data.readUInt32LE(205),
    priceScale: data.readBigUInt64LE(185),
    maxConfidenceBps: data.readUInt16LE(209),
    symbol: data.subarray(169, 185),
    maxSettlementStalenessSeconds,
  });
  if (!id.equals(data.subarray(41, 73))) {
    throw new Error(`${label} market id is not the deterministic hash of its onchain parameters`);
  }
  const creator = new PublicKey(data.subarray(245, 277));
  if (creator.equals(PublicKey.default)) throw new Error(`${label} has no recorded creator`);
  if (typeof expectedCreator === "string" && creator.toBase58() !== expectedCreator) {
    throw new Error(`${label} creator does not match the manifest`);
  }
  return maxSettlementStalenessSeconds;
}

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

// Read the entire public deployment state in one RPC batch. Public devnet endpoints
// aggressively rate-limit sequential account lookups, and verification should not
// fail merely because the manifest contains a complete rolling series catalog.
const poolAuthorizationAddresses = new Map<string, PublicKey[]>();
const accountAddresses: PublicKey[] = [
  ...requiredExecutable.map((field) => new PublicKey(String(deployment[field]))),
  ...requiredAccounts.map((field) => new PublicKey(String(deployment[field]))),
  LEGACY_UNSAFE_UI_MARKET,
  ...markets.map((series) => new PublicKey(String(series.address))),
  new PublicKey(String(smoke.successMarket)),
  new PublicKey(String(smoke.refundMarket)),
  new PublicKey(String(smoke.successOracle)),
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

const expectedCodes = new Set(["15M", "1H", "EOD", "7D", "30D"]);
for (const series of markets) {
  const code = String(series.code);
  if (!expectedCodes.delete(code)) throw new Error(`Unexpected or duplicate rolling market code ${code}`);
  const address = new PublicKey(String(series.address));
  const account = accountInfo(address);
  if (!account || !account.owner.equals(programId) || account.data.length < 281) {
    throw new Error(`Rolling market ${code} is missing or invalid`);
  }
  const maxSettlementStalenessSeconds = await expectFactoryMarket(`Rolling market ${code}`, Buffer.from(account.data), series.creator);
  const feedId = Buffer.from(account.data.subarray(211, 243)).toString("hex");
  const expiry = Number(account.data.readBigInt64LE(193));
  const observationWindow = account.data.readUInt32LE(201);
  const manifestExpiry = Number(series.expiry);
  const lastTradeAt = Number(series.lastTradeAt);
  if (feedId !== expectedFeedId || expiry !== manifestExpiry) throw new Error(`Rolling market ${code} has mismatched onchain terms`);
  if (observationWindow !== Number(series.observationWindowSeconds) || observationWindow > 30) {
    throw new Error(`Rolling market ${code} does not use the narrow Pyth settlement window`);
  }
  if (
    typeof series.maxSettlementStalenessSeconds === "number"
    && maxSettlementStalenessSeconds !== series.maxSettlementStalenessSeconds
  ) {
    throw new Error(`Rolling market ${code} settlement staleness bound does not match the manifest`);
  }
  if (!(lastTradeAt > 0 && lastTradeAt < expiry)) throw new Error(`Rolling market ${code} has an invalid trade cutoff`);
}
if (String(deployment.uiMarket) !== String(markets.find((series) => series.code === "30D")?.address)) {
  throw new Error("The legacy UI pointer does not reference the catalog's 30D market");
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

const smokeFeedId = String(deployment.smokePythFeedId);
for (const field of ["successMarket", "refundMarket"]) {
  const account = accountInfo(new PublicKey(String(smoke[field])));
  const feedId = account && account.data.length >= 243
    ? Buffer.from(account.data.subarray(211, 243)).toString("hex")
    : "";
  if (!account || feedId !== smokeFeedId) throw new Error(`${field} is not bound to the configured 24/7 Pyth smoke feed`);
  await expectFactoryMarket(field, Buffer.from(account.data), deployment.creator);
}
const successOracle = accountInfo(new PublicKey(String(smoke.successOracle)));
const successOracleFeedId = successOracle && successOracle.data.length >= 137
  ? Buffer.from(successOracle.data.subarray(105, 137)).toString("hex")
  : "";
if (successOracleFeedId !== smokeFeedId) throw new Error("Finalized smoke oracle does not record the expected Pyth feed");
// Oracle layout offsets: finalized @ 141, settled_from_stale_price (bool,
// appended after launch) @ 142 -- total account size 143 bytes.
if (!successOracle || successOracle.data.length < 143 || successOracle.data[141] !== 1) {
  throw new Error("The smoke settlement oracle is not finalized onchain");
}

const smokePoolAddress = new PublicKey(String(smoke.smokePool));
const smokePoolAccount = accountInfo(smokePoolAddress);
const smokePoolTokenAddress = new PublicKey(String(smoke.smokePoolToken));
const smokePoolToken = unpackAccount(smokePoolTokenAddress, accountInfo(smokePoolTokenAddress), TOKEN_PROGRAM_ID);
const smokeProvider = accountInfo(new PublicKey(String(smoke.smokeProvider)));
if (
  !smokePoolAccount?.owner.equals(programId)
  || smokePoolAccount.data.length < 214
  || new PublicKey(smokePoolAccount.data.subarray(182, 214)).equals(PublicKey.default)
  || smokePoolAccount.data.readBigUInt64LE(138) !== 0n
  || smokePoolAccount.data.readBigUInt64LE(146) !== 0n
  || smokePoolAccount.data.readBigUInt64LE(154) !== 0n
  || smokePoolToken.amount !== 0n
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
