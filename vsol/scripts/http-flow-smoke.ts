import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Keypair, Transaction } from "@solana/web3.js";
import { liveMarkets } from "../../app/lib/markets.ts";

const appUrl = process.env.VSOL_APP_URL ?? "http://localhost:3001";
const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(resolve(import.meta.dirname, "../.devnet/web-smoke-buyer.json"), "utf8")) as number[]));
const headers = { "content-type": "application/json", origin: appUrl };

async function post(path: string, body: object) {
  const response = await fetch(`${appUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path}: ${String(result.error ?? response.status)}`);
  return result;
}

async function postResponse(path: string, body: object) {
  const response = await fetch(`${appUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { response, result: await response.json() as Record<string, unknown> };
}

async function get(path: string) {
  const response = await fetch(`${appUrl}${path}`, { headers: { origin: appUrl } });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path}: ${String(result.error ?? response.status)}`);
  return result;
}

// Read from the market config so this smoke follows the live market rather
// than a hardcoded ticker (a coming-soon market has no entitled feed and
// would 422 here by design). Mirrors app/lib/vsol-launch.ts's launchSymbol().
const SMOKE_SYMBOL = liveMarkets[0]?.symbol
  ?? (() => { throw new Error("No live market is configured in app/lib/markets.ts"); })();

const status = await get("/api/vsol/status") as { ok?: boolean };
if (!status.ok) throw new Error("VSOL status endpoint did not verify devnet");
const marketData = await get(`/api/market-data?symbol=${SMOKE_SYMBOL}`) as { snapshot?: { mode?: string } };
const markets = await get("/api/markets");
await post("/api/vsol/faucet", { walletAddress: buyer.publicKey.toBase58() });
const quoteRequest = {
  symbol: SMOKE_SYMBOL,
  direction: "up",
  amount: 200,
  expiryCode: "30D",
  payoff: 5,
  walletAddress: buyer.publicKey.toBase58(),
};
if (marketData.snapshot?.mode !== "live") {
  const { response, result } = await postResponse("/api/quotes", quoteRequest);
  if (response.status !== 503 || !String(result.error ?? "").includes("pause")) {
    throw new Error(`/api/quotes: expected a fail-closed market-session pause, received ${response.status}`);
  }
  console.log(JSON.stringify({ ok: true, status, marketData, markets, quotePaused: result.error }, null, 2));
  process.exit(0);
}
const quote = await post("/api/quotes", quoteRequest);
const vsol = quote.vsol as { transaction: string; positionAddress: string };
const transaction = Transaction.from(Buffer.from(vsol.transaction, "base64"));
transaction.partialSign(buyer);
const sent = await post("/api/vsol/send", {
  transaction: transaction.serialize().toString("base64"),
  quoteId: vsol.positionAddress,
  walletAddress: buyer.publicKey.toBase58(),
});
const simulation = sent.simulation as { id: string; status: string };
if (!simulation?.id || simulation.status !== "passed") throw new Error("Fill simulation was not persisted as passing");
const position = await post("/api/positions", {
  walletAddress: buyer.publicKey.toBase58(),
  quoteId: vsol.positionAddress,
  transactionSignature: sent.signature,
  simulationId: simulation.id,
});
const savedSimulation = await get(`/api/vsol/simulations?id=${encodeURIComponent(simulation.id)}`);
const savedPositions = await get("/api/positions");

console.log(JSON.stringify({
  ok: true,
  status,
  marketData,
  markets,
  position: position.position,
  simulation: savedSimulation.simulation,
  positions: savedPositions.positions,
  signature: sent.signature,
}, null, 2));
