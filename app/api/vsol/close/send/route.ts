import "../../../../lib/runtime-env-worker";
import { and, eq } from "drizzle-orm";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ensureDb, getDb } from "../../../../../db";
import { closeActions } from "../../../../../db/schema";
import { boundedLogs, hashHex, json, readSessionWallet, safeJson, sameOrigin } from "../../../../lib/session";
import { inspectVsolCloseTransaction } from "../../../../lib/vsol-close";
import { decodeSignedTransaction, describeRpcFailure, getVsolClusterTime, getVsolConnection } from "../../../../lib/vsol-server";

type CloseIntent = typeof closeActions.$inferSelect;

/**
 * The confirmed close must have closed the position account and paid the
 * buyer exactly `buybackAmountAtoms` more than they held before -- nothing
 * less (a partial fill) and nothing more (a bug elsewhere). Returns the
 * confirmed buyer balance once verified, or null while state is still
 * catching up (the caller retries).
 */
async function verifyPostState(intent: CloseIntent, connection: ReturnType<typeof getVsolConnection>) {
  const [positionAccount, buyerToken] = await Promise.all([
    connection.getAccountInfo(new PublicKey(intent.positionAddress), "confirmed"),
    getAccount(connection, new PublicKey(intent.buyerDestinationAddress), "confirmed", TOKEN_PROGRAM_ID).catch(() => null),
  ]);
  if (positionAccount) return null;
  if (!buyerToken) return null;
  const postBuyerAtoms = buyerToken.amount;
  const delta = postBuyerAtoms - BigInt(intent.preBuyerAtoms);
  if (delta !== BigInt(intent.buybackAmountAtoms)) return null;
  return postBuyerAtoms;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site close requests are not allowed." }, 403);
  const wallet = await readSessionWallet(request);
  if (!wallet) {
    return json({
      error: "Sign in with your wallet signature to close positions.",
      code: "WALLET_SESSION_REQUIRED",
    }, 401);
  }
  await ensureDb();
  const input = await request.json().catch(() => null) as { intentId?: unknown; transaction?: unknown } | null;
  if (typeof input?.intentId !== "string" || typeof input.transaction !== "string") {
    return json({ error: "A signed transaction and intent id are required." }, 422);
  }
  const db = getDb();
  const [intent] = await db.select().from(closeActions).where(and(
    eq(closeActions.id, input.intentId),
    eq(closeActions.walletAddress, wallet),
  )).limit(1);
  if (!intent) return json({ error: "Close intent not found." }, 404);
  if (intent.submissionStatus !== "prepared") return json({ error: "This close intent has already been submitted." }, 409);

  let simulationStored = false;
  try {
    const raw = decodeSignedTransaction(input.transaction);
    const transaction = Transaction.from(raw);
    if (!transaction.verifySignatures()) throw new Error("The wallet signature is invalid.");
    const inspected = inspectVsolCloseTransaction(transaction);
    if (!inspected) throw new Error("Only exact VSOL close transactions are accepted.");
    if (inspected.buyer.toBase58() !== wallet
        || inspected.position.toBase58() !== intent.positionAddress
        || inspected.market.toBase58() !== intent.marketAddress
        || inspected.buyerDestination.toBase58() !== intent.buyerDestinationAddress
        || inspected.treasuryDestination.toBase58() !== intent.treasuryDestinationAddress
        || inspected.buybackAmount.toString() !== intent.buybackAmountAtoms
        || inspected.minProceeds.toString() !== intent.minProceedsAtoms
        || inspected.quoteExpiry.toString() !== String(intent.quoteExpiry)) {
      throw new Error("The signed close instruction does not match the prepared intent.");
    }
    const messageHash = await hashHex(transaction.serializeMessage());
    if (messageHash !== intent.transactionMessageHash) throw new Error("The signed transaction message was changed after preparation.");
    const connection = getVsolConnection();
    const clusterNow = await getVsolClusterTime(connection);
    if (clusterNow > intent.quoteExpiry) throw new Error("The quoted close expired. Prepare a fresh quote and try again.");

    const transactionHash = await hashHex(raw);
    const simulationResult = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), {
      sigVerify: true,
      commitment: "confirmed",
    });
    const logs = boundedLogs(simulationResult.value.logs);
    const logsJson = JSON.stringify(logs);
    const logsHash = await hashHex(logsJson);
    const simulationStatus = simulationResult.value.err ? "failed" as const : "passed" as const;
    await db.update(closeActions).set({
      transactionHash,
      simulationStatus,
      simulationSlot: simulationResult.context.slot,
      simulationUnitsConsumed: simulationResult.value.unitsConsumed ?? null,
      simulationLogsJson: logsJson,
      simulationLogsHash: logsHash,
      simulationErrorJson: simulationResult.value.err ? safeJson(simulationResult.value.err) : null,
      submissionStatus: simulationResult.value.err ? "failed" : "prepared",
      submissionError: simulationResult.value.err ? "Devnet simulation rejected the transaction." : null,
    }).where(eq(closeActions.id, intent.id));
    simulationStored = true;
    const simulation = {
      id: intent.id,
      status: simulationStatus,
      slot: simulationResult.context.slot,
      unitsConsumed: simulationResult.value.unitsConsumed ?? null,
      logsHash,
      error: simulationResult.value.err ?? null,
    };
    if (simulationResult.value.err) {
      return json({ error: "Devnet simulation rejected the close transaction.", simulation }, 422);
    }

    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);

    let postBuyerAtoms: bigint | null = null;
    for (let attempt = 0; attempt < 5 && postBuyerAtoms === null; attempt += 1) {
      postBuyerAtoms = await verifyPostState(intent, connection).catch(() => null);
      if (postBuyerAtoms === null) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (postBuyerAtoms === null) {
      throw new Error("The confirmed close transaction did not produce the expected onchain state.");
    }

    await db.update(closeActions).set({
      transactionSignature: signature,
      submissionStatus: "confirmed",
      submissionError: null,
      postBuyerAtoms: postBuyerAtoms.toString(),
      postStateVerified: true,
      confirmedAt: new Date(),
    }).where(eq(closeActions.id, intent.id));

    return json({
      signature,
      positionAddress: intent.positionAddress,
      buybackAtoms: intent.buybackAmountAtoms,
      simulation,
    });
  } catch (error) {
    const message = describeRpcFailure(error, "The close transaction failed.");
    await db.update(closeActions).set({
      submissionStatus: "failed",
      submissionError: message.slice(0, 500),
      ...(!simulationStored ? { simulationStatus: "failed" as const, simulationErrorJson: safeJson({ message }) } : {}),
    }).where(eq(closeActions.id, intent.id)).catch(() => undefined);
    return json({ error: message.slice(0, 300), simulationId: simulationStored ? intent.id : undefined }, 422);
  }
}
