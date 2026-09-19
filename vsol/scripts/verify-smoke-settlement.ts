import { readFile } from "node:fs/promises";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeConfigAccount, decodeOracleAccount, decodePoolAccount } from "../../app/lib/vsol-server.ts";
import { decodeMarketAccount } from "../../app/lib/vsol-market-accounts.ts";
import { deriveConfig, deriveCustomSettlementObservation } from "../sdk/index.ts";
import idl from "../target/idl/vsol.json" with { type: "json" };
import { DEVNET_GENESIS_HASH } from "./custom-oracle-pusher.ts";
import { VSOL_PROGRAM_ID } from "../../app/lib/vsol.ts";
import { VSOL_RPC_URL } from "../../app/lib/vsol.ts";

type Receipt = {
  symbol: string;
  expiryAt: number;
  walletAddress: string;
  buyerToken: string;
  position: string;
  pool: string;
  market: string;
  direction: "up" | "down";
  strikeAtoms: string;
  widthAtoms: string;
  premiumAtoms: string;
  maxPayoutAtoms: string;
  feeBps: number;
  preBalanceAtoms: string;
  preFillLockedCollateralAtoms?: string;
  fillSignature: string;
};

const receiptPath = process.argv[2] ?? process.env.VSOL_SMOKE_RECEIPT ?? "/tmp/tend-smoke-settlement-receipt.json";
const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
const configuredRpcUrl = process.env.VSOL_RPC_URL ?? VSOL_RPC_URL;
const redactError = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(configuredRpcUrl).join("[redacted]");
process.once("uncaughtException", (error) => { console.error(redactError(error)); process.exit(1); });
process.once("unhandledRejection", (error) => { console.error(redactError(error)); process.exit(1); });
const connection = new Connection(configuredRpcUrl, "confirmed");
if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error("Receipt verifier requires Solana devnet");

const [positionAccount, marketAccount, poolAccount, configAccount, buyerBalance] = await Promise.all([
  connection.getAccountInfo(new PublicKey(receipt.position), "confirmed"),
  connection.getAccountInfo(new PublicKey(receipt.market), "confirmed"),
  connection.getAccountInfo(new PublicKey(receipt.pool), "confirmed"),
  connection.getAccountInfo(deriveConfig(), "confirmed"),
  connection.getTokenAccountBalance(new PublicKey(receipt.buyerToken), "confirmed"),
]);
if (positionAccount) throw new Error("Smoke position is still open; settlement has not completed");
if (!marketAccount?.owner.equals(VSOL_PROGRAM_ID) || !poolAccount?.owner.equals(VSOL_PROGRAM_ID) || !configAccount?.owner.equals(VSOL_PROGRAM_ID)) {
  throw new Error("Receipt references an unavailable or foreign VSOL account");
}

const oracleAddress = new PublicKey(marketAccount.data.subarray(137, 169));
const oracleAccount = await connection.getAccountInfo(oracleAddress, "confirmed");
if (!oracleAccount?.owner.equals(VSOL_PROGRAM_ID)) {
  throw new Error("Market settlement oracle is not finalized");
}
const market = decodeMarketAccount(Buffer.from(marketAccount.data));
const oracle = decodeOracleAccount(Buffer.from(oracleAccount.data));
if (!oracle.finalized || !oracle.market.equals(new PublicKey(receipt.market))) throw new Error("Market settlement oracle is not finalized or bound to the receipt market");
const settlementPrice = oracle.price;
const observationAddress = deriveCustomSettlementObservation(receipt.symbol, BigInt(receipt.expiryAt / 1000));
const observationAccount = await connection.getAccountInfo(observationAddress, "confirmed");
const observationDefinition = (idl.accounts as Array<{ name: string; discriminator: number[] }>).find((entry) => entry.name === "CustomSettlementObservation");
if (!observationAccount?.owner.equals(VSOL_PROGRAM_ID) || observationAccount.data.length !== 173 || !observationDefinition ||
    !Buffer.from(observationAccount.data.subarray(0, 8)).equals(Buffer.from(observationDefinition.discriminator))) {
  throw new Error("The immutable custom settlement observation is unavailable");
}
const observationExpiry = Number(observationAccount.data.readBigInt64LE(57));
const observationPrice = observationAccount.data.readBigUInt64LE(77);
const observationObservedAt = Number(observationAccount.data.readBigInt64LE(93));
const observationCapturedAt = Number(observationAccount.data.readBigInt64LE(101));
if (observationExpiry !== market.expiry || observationPrice !== settlementPrice || oracle.observedAt !== observationObservedAt ||
    !oracle.priceUpdate.equals(observationAddress) ||
    observationObservedAt < market.expiry || observationObservedAt > market.expiry + market.observationWindowSeconds ||
    observationCapturedAt > market.expiry + market.observationWindowSeconds) {
  throw new Error("Finalized settlement is not bound to the retained in-window observation");
}

const signatureInfos = await connection.getSignaturesForAddress(new PublicKey(receipt.position), { limit: 20 }, "confirmed");
let settlementSignature: string | undefined;
const settleDefinition = (idl.instructions as Array<{
  name: string; discriminator: number[]; accounts: Array<{ name: string }>;
}>).find((entry) => entry.name === "settle_pool_position");
if (!settleDefinition) throw new Error("VSOL IDL is missing settle_pool_position");
const positionAccountIndex = settleDefinition.accounts.findIndex((account) => account.name === "position");
if (positionAccountIndex < 0) throw new Error("VSOL IDL settle_pool_position is missing its position account");
for (const signatureInfo of signatureInfos) {
  if (signatureInfo.err || (signatureInfo.blockTime ?? 0) < market.expiry) continue;
  const transaction = await connection.getTransaction(signatureInfo.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!transaction || transaction.meta?.err !== null) continue;
  const keys = transaction.transaction.message.getAccountKeys({
    accountKeysFromLookups: transaction.meta?.loadedAddresses ?? undefined,
  });
  for (const instruction of transaction.transaction.message.compiledInstructions) {
    if (!keys.get(instruction.programIdIndex)?.equals(VSOL_PROGRAM_ID) ||
        !Buffer.from(instruction.data).subarray(0, 8).equals(Buffer.from(settleDefinition.discriminator))) continue;
    const positionKeyIndex = instruction.accountKeyIndexes[positionAccountIndex];
    if (positionKeyIndex === undefined || !keys.get(positionKeyIndex)?.equals(new PublicKey(receipt.position))) continue;
    settlementSignature = signatureInfo.signature;
    break;
  }
  if (settlementSignature) break;
}
if (!settlementSignature) throw new Error("No confirmed settle_pool_position transaction was found for the receipt position");
const strike = BigInt(receipt.strikeAtoms);
const width = BigInt(receipt.widthAtoms);
const premium = BigInt(receipt.premiumAtoms);
const maxPayout = BigInt(receipt.maxPayoutAtoms);
const delta = receipt.direction === "up"
  ? (settlementPrice > strike ? settlementPrice - strike : 0n)
  : (strike > settlementPrice ? strike - settlementPrice : 0n);
const payout = maxPayout * (delta < width ? delta : width) / width;
const fee = premium === 0n || receipt.feeBps === 0
  ? 0n
  : (premium * BigInt(receipt.feeBps) + 9_999n) / 10_000n;
const config = decodeConfigAccount(Buffer.from(configAccount.data));
const buyerReceivesFee = config.treasuryOwner.equals(new PublicKey(receipt.walletAddress));
const expectedBalance = BigInt(receipt.preBalanceAtoms) - premium + payout + (buyerReceivesFee ? fee : 0n);
const actualBalance = BigInt(buyerBalance.value.amount);
if (actualBalance !== expectedBalance) {
  throw new Error(`Buyer balance mismatch: expected ${expectedBalance}, received ${actualBalance}`);
}

const pool = decodePoolAccount(Buffer.from(poolAccount.data));
if (receipt.preFillLockedCollateralAtoms !== undefined && pool.lockedCollateral !== BigInt(receipt.preFillLockedCollateralAtoms)) {
  throw new Error(`Pool collateral was not released: expected ${receipt.preFillLockedCollateralAtoms}, received ${pool.lockedCollateral}`);
}

console.log(JSON.stringify({
  ok: true,
  scope: "read-only post-expiry settlement verification",
  receiptPath,
  position: receipt.position,
  fillSignature: receipt.fillSignature,
  settlementSignature,
  settlementPriceAtoms: settlementPrice.toString(),
  observation: observationAddress.toBase58(),
  observationObservedAt,
  observationCapturedAt,
  expectedPayoutAtoms: payout.toString(),
  protocolFeeAtoms: fee.toString(),
  buyerReceivesFee,
  expectedBuyerBalanceAtoms: expectedBalance.toString(),
  actualBuyerBalanceAtoms: actualBalance.toString(),
  poolLockedCollateralAtoms: pool.lockedCollateral.toString(),
  positionClosed: true,
}, null, 2));
