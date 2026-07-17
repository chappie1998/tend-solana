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
import {
  buildVsolQuoteTransaction,
  verifyVsolFill,
  VSOL_CONNECTION,
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
  const faucet = await loadKeypair(resolve(secretDir, "devnet-faucet.json"));
  const buyer = await loadOrCreateBuyer();
  const buyerToken = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, buyer.publicKey);
  const instructions = new Transaction();
  if ((await VSOL_CONNECTION.getBalance(buyer.publicKey, "confirmed")) < 10_000_000) {
    instructions.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: buyer.publicKey, lamports: 20_000_000 }));
  }
  if (instructions.instructions.length) {
    await sendAndConfirmTransaction(VSOL_CONNECTION, instructions, [faucet], { commitment: "confirmed" });
  }
  if (!(await VSOL_CONNECTION.getAccountInfo(buyerToken, "confirmed"))) {
    await createAssociatedTokenAccount(VSOL_CONNECTION, faucet, VSOL_SETTLEMENT_MINT, buyer.publicKey, {}, TOKEN_PROGRAM_ID);
  }
  const balance = (await getAccount(VSOL_CONNECTION, buyerToken, "confirmed", TOKEN_PROGRAM_ID)).amount;
  if (balance < 1_000n * 1_000_000n) {
    await mintTo(VSOL_CONNECTION, faucet, VSOL_SETTLEMENT_MINT, buyerToken, faucet, 1_000n * 1_000_000n, [], {}, TOKEN_PROGRAM_ID);
  }

  const economics = quoteFor({ spot: 171.86, amount: 250, durationMinutes: 43_200, direction: "up", payoff: 5, volatility: 46.2 });
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
  const signature = await VSOL_CONNECTION.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  await VSOL_CONNECTION.confirmTransaction(signature, "confirmed");
  const verified = await verifyVsolFill(signature, buyer.publicKey, new PublicKey(quote.positionAddress));
  if (!verified) throw new Error("Web execution fill did not verify");
  console.log(JSON.stringify({ ok: true, buyer: buyer.publicKey, position: quote.positionAddress, signature }, null, 2));
}

await main();
