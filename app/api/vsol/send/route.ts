import { and, eq } from "drizzle-orm";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { decodeSignedTransaction, inspectVsolFillTransaction, VSOL_CONNECTION } from "../../../lib/vsol-server";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureDb, getDb } from "../../../../db";
import { rfqQuotes, transactionSimulations } from "../../../../db/schema";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function userKey(request: Request) {
  const user = await getChatGPTUser();
  if (user?.email) return user.email;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-preview@tend.local" : null;
}

async function hashHex(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const copied = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boundedLogs(logs: string[] | null | undefined) {
  const bounded: string[] = [];
  let size = 2;
  for (const log of logs?.slice(0, 160) ?? []) {
    const line = log.slice(0, 800);
    if (size + line.length > 30_000) break;
    bounded.push(line);
    size += line.length;
  }
  return bounded;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)?.slice(0, 4_000) ?? null;
  } catch {
    return JSON.stringify({ error: "Unserializable simulation error" });
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-site transaction requests are not allowed." }, { status: 403 });
  const owner = await userKey(request);
  if (!owner) return Response.json({ error: "Sign in to submit transactions." }, { status: 401 });
  await ensureDb();
  const input = await request.json().catch(() => null) as { transaction?: unknown; quoteId?: unknown; walletAddress?: unknown } | null;
  if (typeof input?.transaction !== "string" || typeof input.quoteId !== "string" || typeof input.walletAddress !== "string") {
    return Response.json({ error: "A signed transaction, quote id, and wallet address are required." }, { status: 422 });
  }

  const db = getDb();
  let simulationId = "";
  try {
    const raw = decodeSignedTransaction(input.transaction);
    const transaction = Transaction.from(raw);
    if (!transaction.verifySignatures()) return Response.json({ error: "The wallet signature is invalid." }, { status: 422 });
    const inspected = inspectVsolFillTransaction(transaction);
    if (!inspected) return Response.json({ error: "Only maker-signed VSOL fill transactions are accepted." }, { status: 422 });
    if (inspected.position.toBase58() !== input.quoteId || inspected.buyer.toBase58() !== input.walletAddress) {
      return Response.json({ error: "The signed buyer and position do not match this quote request." }, { status: 422 });
    }
    const [quote] = await db.select().from(rfqQuotes).where(and(eq(rfqQuotes.id, input.quoteId), eq(rfqQuotes.symbol, "NVDA"))).limit(1);
    if (!quote || quote.consumedAt) return Response.json({ error: "The quote is missing or already consumed." }, { status: 409 });

    const transactionHash = await hashHex(raw);
    const result = await VSOL_CONNECTION.simulateTransaction(VersionedTransaction.deserialize(raw), {
      sigVerify: true,
      commitment: "confirmed",
    });
    const logs = boundedLogs(result.value.logs);
    const logsJson = JSON.stringify(logs);
    const logsHash = await hashHex(logsJson);
    simulationId = crypto.randomUUID();
    const simulationStatus = result.value.err ? "failed" as const : "passed" as const;
    await db.insert(transactionSimulations).values({
      id: simulationId,
      userEmail: owner,
      walletAddress: input.walletAddress,
      quoteId: input.quoteId,
      positionAddress: inspected.position.toBase58(),
      transactionHash,
      status: simulationStatus,
      slot: result.context.slot,
      unitsConsumed: result.value.unitsConsumed ?? null,
      logsJson,
      logsHash,
      errorJson: result.value.err ? safeJson(result.value.err) : null,
      transactionSignature: null,
      submissionStatus: "not_sent",
      submissionError: null,
      createdAt: new Date(),
      confirmedAt: null,
    });
    const simulation = {
      id: simulationId,
      status: simulationStatus,
      slot: result.context.slot,
      unitsConsumed: result.value.unitsConsumed ?? null,
      logsHash,
      error: result.value.err ?? null,
    };
    if (result.value.err) {
      return Response.json({ error: "Devnet simulation rejected the transaction.", simulation }, { status: 422 });
    }

    const signature = await VSOL_CONNECTION.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    const confirmation = await VSOL_CONNECTION.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    await db.update(transactionSimulations).set({
      transactionSignature: signature,
      submissionStatus: "confirmed",
      confirmedAt: new Date(),
    }).where(eq(transactionSimulations.id, simulationId));
    return Response.json({ signature, simulation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transaction failed";
    if (simulationId) {
      await db.update(transactionSimulations).set({
        submissionStatus: "failed",
        submissionError: message.slice(0, 500),
      }).where(eq(transactionSimulations.id, simulationId)).catch(() => undefined);
    }
    return Response.json({ error: `Devnet rejected the transaction: ${message.slice(0, 220)}`, simulationId: simulationId || undefined }, { status: 422 });
  }
}
