import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";

const cluster = process.env.VSOL_CLUSTER ?? "devnet";
const path = resolve(import.meta.dirname, "..", "deployments", `${cluster}.json`);
const deployment = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const rpcUrl = process.env.VSOL_RPC_URL ?? String(deployment.rpcUrl);
const connection = new Connection(rpcUrl, "confirmed");

if (deployment.pythUpgradeDeployed !== true) {
  throw new Error("The manifest is fail-closed: the Pyth upgrade has not passed bootstrap verification");
}

const requiredExecutable = ["programId", "pythReceiverProgram"];
const requiredAccounts = ["config", "settlementMint", "underlyingMint", "writerVault", "writerToken", "uiMarket", "uiOracle"];
for (const field of requiredExecutable) {
  const address = new PublicKey(String(deployment[field]));
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account?.executable) throw new Error(`${field} ${address.toBase58()} is not executable`);
}
for (const field of requiredAccounts) {
  const address = new PublicKey(String(deployment[field]));
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account) throw new Error(`${field} ${address.toBase58()} does not exist`);
}

const marketAccount = await connection.getAccountInfo(new PublicKey(String(deployment.uiMarket)), "confirmed");
const expectedFeedId = String(deployment.pythFeedId);
const marketFeedId = marketAccount && marketAccount.data.length >= 243
  ? Buffer.from(marketAccount.data.subarray(211, 243)).toString("hex")
  : "";
if (marketFeedId !== expectedFeedId) throw new Error(`UI market is not bound to Pyth feed ${expectedFeedId}`);

const smoke = deployment.smoke as Record<string, unknown>;
const smokeFeedId = String(deployment.smokePythFeedId);
for (const field of ["successMarket", "refundMarket"]) {
  const account = await connection.getAccountInfo(new PublicKey(String(smoke[field])), "confirmed");
  const feedId = account && account.data.length >= 243
    ? Buffer.from(account.data.subarray(211, 243)).toString("hex")
    : "";
  if (feedId !== smokeFeedId) throw new Error(`${field} is not bound to the configured 24/7 Pyth smoke feed`);
}
const successOracle = await connection.getAccountInfo(new PublicKey(String(smoke.successOracle)), "confirmed");
const successOracleFeedId = successOracle && successOracle.data.length >= 137
  ? Buffer.from(successOracle.data.subarray(105, 137)).toString("hex")
  : "";
if (successOracleFeedId !== smokeFeedId) throw new Error("Finalized smoke oracle does not record the expected Pyth feed");
if (smoke.replayRejected !== true || smoke.successPositionClosed !== true || smoke.refundPositionClosed !== true) {
  throw new Error("The saved smoke-test invariants are incomplete");
}
for (const field of ["successFillSignature", "refundFillSignature", "publishSignature", "settleSignature", "refundSignature"]) {
  const signature = String(smoke[field]);
  const transaction = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!transaction || transaction.meta?.err) throw new Error(`Transaction ${field} is missing or failed: ${signature}`);
}
const publishTransaction = await connection.getTransaction(String(smoke.publishSignature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
if (!publishTransaction?.meta?.logMessages?.some((line) => line.includes("Instruction: PublishPythSettlement"))) {
  throw new Error("The saved settlement transaction did not execute PublishPythSettlement");
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
  verifiedAt: new Date().toISOString(),
}, null, 2));
