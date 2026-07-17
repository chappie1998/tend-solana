import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Keypair, Transaction } from "@solana/web3.js";

const appUrl = process.env.VSOL_APP_URL ?? "http://localhost:3001";
const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(resolve(import.meta.dirname, "../.devnet/web-smoke-buyer.json"), "utf8")) as number[]));
const headers = { "content-type": "application/json", origin: appUrl };

async function post(path: string, body: object) {
  const response = await fetch(`${appUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path}: ${String(result.error ?? response.status)}`);
  return result;
}

const statusResponse = await fetch(`${appUrl}/api/vsol/status`);
const status = await statusResponse.json() as { ok?: boolean };
if (!statusResponse.ok || !status.ok) throw new Error("VSOL status endpoint did not verify devnet");
await post("/api/vsol/faucet", { walletAddress: buyer.publicKey.toBase58() });
const quote = await post("/api/quotes", {
  symbol: "NVDA",
  direction: "up",
  amount: 200,
  expiryCode: "30D",
  payoff: 5,
  walletAddress: buyer.publicKey.toBase58(),
});
const vsol = quote.vsol as { transaction: string; positionAddress: string };
const transaction = Transaction.from(Buffer.from(vsol.transaction, "base64"));
transaction.partialSign(buyer);
const sent = await post("/api/vsol/send", { transaction: transaction.serialize().toString("base64") });
const position = await post("/api/positions", {
  walletAddress: buyer.publicKey.toBase58(),
  quoteId: vsol.positionAddress,
  transactionSignature: sent.signature,
});

console.log(JSON.stringify({ ok: true, status, position: position.position, signature: sent.signature }, null, 2));
