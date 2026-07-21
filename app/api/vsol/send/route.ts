import "../../../lib/runtime-env-worker";
import { eq } from "drizzle-orm";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { decodeSignedTransaction, getVsolConnection, inspectVsolFillTransaction } from "../../../lib/vsol-server";
import { ensureDb, getDb } from "../../../../db";
import { rfqQuotes, transactionSimulations } from "../../../../db/schema";
import { boundedLogs, hashHex, resolveUserKey, safeJson, sameOrigin } from "../../../lib/session";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-site transaction requests are not allowed." }, { status: 403 });
  const owner = await resolveUserKey(request);
  if (!owner) return Response.json({ error: "Sign in to submit transactions." }, { status: 401 });
  await ensureDb();
  const input = await request.json().catch(() => null) as { transaction?: unknown; quoteId?: unknown; walletAddress?: unknown } | null;
  if (typeof input?.transaction !== "string" || typeof input.quoteId !== "string" || typeof input.walletAddress !== "string") {
    return Response.json({ error: "A signed transaction, quote id, and wallet address are required." }, { status: 422 });
  }

  const db = getDb();
  const connection = getVsolConnection();
  let simulationId = "";
  try {
    const raw = decodeSignedTransaction(input.transaction);
    const transaction = Transaction.from(raw);
    if (!transaction.verifySignatures()) return Response.json({ error: "The wallet signature is invalid." }, { status: 422 });
    const inspected = await inspectVsolFillTransaction(transaction);
    if (!inspected) return Response.json({ error: "Only maker-signed VSOL fill transactions are accepted." }, { status: 422 });
    if (inspected.position.toBase58() !== input.quoteId || inspected.buyer.toBase58() !== input.walletAddress) {
      return Response.json({ error: "The signed buyer and position do not match this quote request." }, { status: 422 });
    }
    const [quote] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, input.quoteId)).limit(1);
    if (!quote || quote.consumedAt) return Response.json({ error: "The quote is missing or already consumed." }, { status: 409 });
    if (inspected.market.toBase58() !== quote.marketAddress) {
      return Response.json({ error: "The signed transaction targets a different onchain series." }, { status: 422 });
    }

    const transactionHash = await hashHex(raw);
    const result = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), {
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

    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
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
