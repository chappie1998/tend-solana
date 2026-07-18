import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { quoteFor } from "../../app/lib/options.ts";
import { marketBySymbol } from "../../app/lib/markets.ts";
import { getPythRealizedVolatility, getPythSnapshot } from "../../app/lib/pyth-market-data.ts";
import deployment from "../deployments/devnet.json" with { type: "json" };
import {
  buildVsolQuoteTransaction,
  getVsolConnection,
  verifyVsolFill,
} from "../../app/lib/vsol-server.ts";
import { VSOL_SETTLEMENT_MINT } from "../../app/lib/vsol.ts";

const workspace = resolve(import.meta.dirname, "..");
const secretDir = resolve(workspace, ".devnet");

async function loadKeypair(path: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]));
}

async function loadOrCreateBuyer() {
  const path = resolve(secretDir, "web-smoke-buyer.json");
  await mkdir(secretDir, { recursive: true });
  if (existsSync(path)) return loadKeypair(path);
  const buyer = Keypair.generate();
  await writeFile(path, JSON.stringify([...buyer.secretKey]), { mode: 0o600 });
  return buyer;
}

async function main() {
  if (deployment.pythUpgradeDeployed !== true) {
    throw new Error("The Pyth-bound devnet deployment has not passed bootstrap verification");
  }
  const connection = getVsolConnection();
  const faucet = await loadKeypair(resolve(secretDir, "devnet-faucet.json"));
  const buyer = await loadOrCreateBuyer();
  const buyerToken = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, buyer.publicKey);
  const instructions = new Transaction();
  if ((await connection.getBalance(buyer.publicKey, "confirmed")) < 10_000_000) {
    instructions.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: buyer.publicKey, lamports: 20_000_000 }));
  }
  if (instructions.instructions.length) {
    await sendAndConfirmTransaction(connection, instructions, [faucet], { commitment: "confirmed" });
  }
  if (!(await connection.getAccountInfo(buyerToken, "confirmed"))) {
    await createAssociatedTokenAccount(connection, faucet, VSOL_SETTLEMENT_MINT, buyer.publicKey, {}, TOKEN_PROGRAM_ID);
  }
  const balance = (await getAccount(connection, buyerToken, "confirmed", TOKEN_PROGRAM_ID)).amount;
  if (balance < 1_000n * 1_000_000n) {
    await mintTo(connection, faucet, VSOL_SETTLEMENT_MINT, buyerToken, faucet, 1_000n * 1_000_000n, [], {}, TOKEN_PROGRAM_ID);
  }

  const market = marketBySymbol("NVDA");
  if (!market) throw new Error("NVDA market metadata is missing");
  const [snapshot, volatility] = await Promise.all([getPythSnapshot(market), getPythRealizedVolatility(market)]);
  if (snapshot.mode !== "live") throw new Error(`Pyth NVDA feed is not fresh: ${snapshot.mode}`);
  const durationMinutes = Math.max(1, Math.floor((deployment.uiExpiry * 1_000 - Date.now()) / 60_000));
  const economics = quoteFor({ spot: snapshot.price, amount: 250, durationMinutes, direction: "up", payoff: 5, volatility: volatility.value });
  const quote = await buildVsolQuoteTransaction({
    buyer: buyer.publicKey,
    direction: "up",
    strike: economics.strike,
    cap: economics.cap,
    premium: economics.premium,
    maxPayout: economics.maxPayout,
  });
  const transaction = Transaction.from(Buffer.from(quote.transaction, "base64"));
  transaction.partialSign(buyer);
  const raw = transaction.serialize();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(signature, "confirmed");
  const verified = await verifyVsolFill(signature, buyer.publicKey, new PublicKey(quote.positionAddress));
  if (!verified) throw new Error("Web execution fill did not verify");
  console.log(JSON.stringify({ ok: true, buyer: buyer.publicKey, position: quote.positionAddress, signature }, null, 2));
}

await main();
