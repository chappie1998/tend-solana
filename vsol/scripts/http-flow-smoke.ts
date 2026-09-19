import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import nacl from "tweetnacl";
import { liveMarkets } from "../../app/lib/markets.ts";
import { siwsMessageBytes } from "../../app/lib/siws.ts";
import { SESSION_COOKIE_NAME } from "../../app/lib/session-token.ts";
import { verifyAndCloseSmokePosition } from "./lib/smoke-lifecycle.ts";
import { DEVNET_GENESIS_HASH } from "./custom-oracle-pusher.ts";
import { VSOL_RPC_URL, VSOL_SETTLEMENT_MINT } from "../../app/lib/vsol.ts";
import { decodePoolPositionAccount } from "../../app/lib/pool-position.ts";

const appUrl = new URL(process.env.VSOL_APP_URL ?? "http://localhost:3001").origin;
const configuredRpcUrl = process.env.VSOL_RPC_URL ?? VSOL_RPC_URL;
const redactError = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(configuredRpcUrl).join("[redacted]");
process.once("uncaughtException", (error) => { console.error(redactError(error)); process.exit(1); });
process.once("unhandledRejection", (error) => { console.error(redactError(error)); process.exit(1); });
const buyerPath = resolve(import.meta.dirname, "../.devnet/web-smoke-buyer.json");
await mkdir(resolve(import.meta.dirname, "../.devnet"), { recursive: true });
let buyer: Keypair;
try {
  buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(buyerPath, "utf8")) as number[]));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  buyer = Keypair.generate();
  await writeFile(buyerPath, JSON.stringify([...buyer.secretKey]), { mode: 0o600, flag: "wx" });
}
const walletAddress = buyer.publicKey.toBase58();
let cookie = "";
const headers = () => ({ "content-type": "application/json", origin: appUrl, ...(cookie ? { cookie } : {}) });

async function post(path: string, body: object) {
  const response = await fetch(`${appUrl}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path}: ${String(result.error ?? response.status)}`);
  const sessionCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (sessionCookie) cookie = sessionCookie.split(";")[0];
  return result;
}

async function get(path: string) {
  const response = await fetch(`${appUrl}${path}`, { headers: headers(), signal: AbortSignal.timeout(120_000) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path}: ${String(result.error ?? response.status)}`);
  return result;
}

const requestedSymbol = (process.env.VSOL_SMOKE_SYMBOL ?? "NVDA").toUpperCase();
const smokeMarket = liveMarkets.find((market) => market.symbol === requestedSymbol);
if (!smokeMarket) throw new Error(`VSOL_SMOKE_SYMBOL ${requestedSymbol} is not a live configured market`);
const SMOKE_SYMBOL = smokeMarket.symbol;
const settlementMode = process.env.VSOL_SMOKE_SETTLEMENT === "1";
const receiptPath = process.env.VSOL_SMOKE_RECEIPT ?? "/tmp/tend-smoke-settlement-receipt.json";
const connection = new Connection(configuredRpcUrl, "confirmed");
if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
  throw new Error("Refusing smoke transactions: configured RPC is not Solana devnet");
}

const nonce = await post("/api/auth/nonce", {}) as { nonce: string; issuedAt: number; expiresAt: number };
const message = siwsMessageBytes({
  domain: new URL(appUrl).host,
  walletAddress,
  nonce: nonce.nonce,
  issuedAtMs: nonce.issuedAt,
  expiresAtMs: nonce.expiresAt,
});
await post("/api/auth/verify", {
  walletAddress,
  nonce: nonce.nonce,
  signature: Buffer.from(nacl.sign.detached(message, buyer.secretKey)).toString("base64"),
});
const session = await get("/api/auth/session") as { wallet?: string };
if (session.wallet !== walletAddress) throw new Error("The wallet session cookie was not persisted");

const status = await get("/api/vsol/status") as {
  ok?: boolean; cluster?: string; protocolPaused?: boolean; lockedCollateralAtoms?: string;
};
if (!status.ok || status.cluster !== "devnet" || status.protocolPaused) {
  throw new Error("VSOL status did not prove an unpaused devnet deployment");
}
const marketData = await get(`/api/market-data?symbol=${SMOKE_SYMBOL}`) as { snapshot?: { mode?: string } };
const markets = await get("/api/markets");
await post("/api/vsol/faucet", { walletAddress: buyer.publicKey.toBase58() });
const buyerToken = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, buyer.publicKey);
const preBalanceAtoms = (await connection.getTokenAccountBalance(buyerToken, "confirmed")).value.amount;
const quoteRequest = {
  symbol: SMOKE_SYMBOL,
  direction: "up",
  amount: 200,
  expiryCode: "15M",
  payoff: 2,
  walletAddress,
};
if (marketData.snapshot?.mode !== "live") {
  throw new Error(`${SMOKE_SYMBOL} snapshot is not live; refusing a false-positive smoke pass`);
}
const quote = await post("/api/quotes", quoteRequest);
const vsol = quote.vsol as { transaction: string; positionAddress: string; marketAddress: string };
const expiry = quote.expiry as { optionExpiryAt: number; observationWindowSeconds: number };
const transaction = VersionedTransaction.deserialize(Buffer.from(vsol.transaction, "base64"));
transaction.sign([buyer]);
const sent = await post("/api/vsol/send", {
  transaction: Buffer.from(transaction.serialize()).toString("base64"),
  quoteId: vsol.positionAddress,
  walletAddress: buyer.publicKey.toBase58(),
});
const simulation = sent.simulation as { id: string; status: string };
if (settlementMode) {
const positionAccount = await connection.getAccountInfo(new PublicKey(vsol.positionAddress), "confirmed");
if (!positionAccount) throw new Error("Confirmed smoke position account is unavailable");
const exactPosition = decodePoolPositionAccount(Buffer.from(positionAccount.data));
const settlementReceipt = {
  version: 1,
  createdAt: new Date().toISOString(),
  appUrl,
  symbol: SMOKE_SYMBOL,
  walletAddress,
  buyerToken: buyerToken.toBase58(),
  position: vsol.positionAddress,
  pool: exactPosition.pool.toBase58(),
  market: exactPosition.market.toBase58(),
  direction: exactPosition.direction,
  strikeAtoms: exactPosition.strike.toString(),
  widthAtoms: exactPosition.width.toString(),
  premiumAtoms: exactPosition.premium.toString(),
  maxPayoutAtoms: exactPosition.maxPayout.toString(),
  feeBps: exactPosition.feeBps,
  expiryAt: expiry.optionExpiryAt,
  observationWindowSeconds: expiry.observationWindowSeconds,
  preBalanceAtoms,
  preFillLockedCollateralAtoms: status.lockedCollateralAtoms,
  fillSignature: sent.signature,
};
await writeFile(receiptPath, `${JSON.stringify(settlementReceipt, null, 2)}\n`, { mode: 0o600 });
  if (!simulation?.id || simulation.status !== "passed") throw new Error("Fill simulation was not persisted as passing");
  const position = await post("/api/positions", {
    walletAddress, quoteId: vsol.positionAddress, transactionSignature: sent.signature, simulationId: simulation.id,
  });
  const chain = await get("/api/positions/chain") as { positions?: Array<{ address: string }> };
  if (!chain.positions?.some((entry) => entry.address === vsol.positionAddress)) {
    throw new Error(`Confirmed fill ${vsol.positionAddress} is missing from the chain portfolio`);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: "settlement-receipt",
    receiptPath,
    ...settlementReceipt,
    simulationId: simulation.id,
    persistedPosition: position.position,
    instruction: "Leave this receipt for the independent settlement verifier; the oracle runner alone captures and publishes the price.",
  }, null, 2));
} else {
  const closed = await verifyAndCloseSmokePosition(async () => {
    if (!simulation?.id || simulation.status !== "passed") throw new Error("Fill simulation was not persisted as passing");
    await post("/api/positions", {
      walletAddress, quoteId: vsol.positionAddress, transactionSignature: sent.signature, simulationId: simulation.id,
    });
    await get(`/api/vsol/simulations?id=${encodeURIComponent(simulation.id)}`);
    await get("/api/positions");
    const chain = await get("/api/positions/chain") as { positions?: Array<{ address: string }> };
    if (!chain.positions?.some((entry) => entry.address === vsol.positionAddress)) {
      throw new Error(`Confirmed fill ${vsol.positionAddress} is missing from the chain portfolio`);
    }
  }, async () => {
    const prepared = await post("/api/vsol/close/prepare", { positionAddress: vsol.positionAddress }) as { intentId: string; transaction: string };
    const closeTransaction = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
    closeTransaction.sign([buyer]);
    return post("/api/vsol/close/send", {
      intentId: prepared.intentId,
      transaction: Buffer.from(closeTransaction.serialize()).toString("base64"),
    });
  });
  const after = await get("/api/positions/chain") as { positions?: Array<{ address: string }> };
  if (after.positions?.some((entry) => entry.address === vsol.positionAddress)) {
    throw new Error("The early-close cleanup left the smoke position open");
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "fill-and-close",
    status,
    marketData,
    markets,
    position: vsol.positionAddress,
    simulationId: simulation.id,
    fillSignature: sent.signature,
    close: closed,
  }, null, 2));
}

if (cookie) await post("/api/auth/signout", {}).catch(() => undefined);
