import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";

const cluster = process.env.VSOL_CLUSTER ?? "devnet";
const path = resolve(import.meta.dirname, "..", "deployments", `${cluster}.json`);
const deployment = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const rpcUrl = process.env.VSOL_RPC_URL ?? String(deployment.rpcUrl);
const connection = new Connection(rpcUrl, "confirmed");

const requiredExecutable = ["programId"];
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

const smoke = deployment.smoke as Record<string, unknown>;
if (smoke.replayRejected !== true || smoke.successPositionClosed !== true || smoke.refundPositionClosed !== true) {
  throw new Error("The saved smoke-test invariants are incomplete");
}
for (const field of ["successFillSignature", "refundFillSignature", "publishSignature", "settleSignature", "refundSignature"]) {
  const signature = String(smoke[field]);
  const transaction = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!transaction || transaction.meta?.err) throw new Error(`Transaction ${field} is missing or failed: ${signature}`);
}

console.log(JSON.stringify({
  ok: true,
  cluster,
  programId: deployment.programId,
  config: deployment.config,
  uiMarket: deployment.uiMarket,
  verifiedAt: new Date().toISOString(),
}, null, 2));

