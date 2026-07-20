import "../../../../lib/runtime-env-worker";
import { and, eq } from "drizzle-orm";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { ensureDb, getDb } from "../../../../../db";
import { launchActions } from "../../../../../db/schema";
import {
  boundedLogs,
  hashHex,
  json,
  readSessionWallet,
  resolveUserKey,
  safeJson,
  sameOrigin,
} from "../../../../lib/session";
import { inspectVsolLaunchTransaction } from "../../../../lib/vsol-launch";
import {
  decodeMarketAccount,
  decodePoolAccount,
  decodePoolMarketAccount,
  decodeSignedTransaction,
  getVsolConnection,
  parsePublicKey,
} from "../../../../lib/vsol-server";
import { VSOL_PROGRAM_ID } from "../../../../lib/vsol";

type LaunchIntent = typeof launchActions.$inferSelect;

async function verifyPostState(intent: LaunchIntent, connection = getVsolConnection()) {
  const params = JSON.parse(intent.paramsJson) as Record<string, unknown>;
  const account = await connection.getAccountInfo(new PublicKey(intent.targetAddress), "confirmed");
  if (!account?.owner.equals(VSOL_PROGRAM_ID)) return false;
  const data = Buffer.from(account.data);
  if (intent.kind === "create_market") {
    const market = decodeMarketAccount(data);
    return Buffer.from(market.marketId).toString("hex") === params.marketId
      && market.expiry === params.expiry
      && market.observationWindowSeconds === params.observationWindowSeconds
      && market.settlementGraceSeconds === params.settlementGraceSeconds
      && market.creator.toBase58() === intent.walletAddress
      && market.enabled;
  }
  if (intent.kind === "create_pool") {
    const pool = decodePoolAccount(data);
    return pool.poolId.toString("hex") === params.poolId
      && pool.quoteAuthority.toBase58() === params.quoteAuthority
      && pool.maxUtilizationBps === params.maxUtilizationBps
      && pool.maxPositionBps === params.maxPositionBps
      && pool.manager.toBase58() === intent.walletAddress;
  }
  const poolMarket = decodePoolMarketAccount(data);
  return poolMarket.pool.toBase58() === params.poolAddress
    && poolMarket.market.toBase58() === params.marketAddress
    && poolMarket.lastTradeAt === params.lastTradeAt
    && poolMarket.enabled === true;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site launch requests are not allowed." }, 403);
  const userKey = await resolveUserKey(request);
  if (!userKey) return json({ error: "Sign in to submit launch transactions." }, 401);
  await ensureDb();
  const input = await request.json().catch(() => null) as { intentId?: unknown; walletAddress?: unknown; transaction?: unknown } | null;
  const owner = parsePublicKey(input?.walletAddress);
  if (!owner || typeof input?.intentId !== "string" || typeof input.transaction !== "string") {
    return json({ error: "A signed transaction, intent id, and valid wallet are required." }, 422);
  }
  const sessionWallet = await readSessionWallet(request);
  if (sessionWallet && sessionWallet !== owner.toBase58()) {
    return json({ error: "The signed-in wallet does not match this launch request." }, 403);
  }
  const db = getDb();
  const [intent] = await db.select().from(launchActions).where(and(
    eq(launchActions.id, input.intentId),
    eq(launchActions.userKey, userKey),
    eq(launchActions.walletAddress, owner.toBase58()),
  )).limit(1);
  if (!intent) return json({ error: "Launch intent not found." }, 404);
  if (intent.submissionStatus !== "prepared") return json({ error: "This launch intent has already been submitted." }, 409);

  let simulationStored = false;
  try {
    const raw = decodeSignedTransaction(input.transaction);
    const transaction = Transaction.from(raw);
    if (!transaction.verifySignatures()) throw new Error("The wallet signature is invalid.");
    const inspected = inspectVsolLaunchTransaction(transaction);
    if (!inspected) throw new Error("Only exact VSOL launch transactions are accepted.");
    if (inspected.kind !== intent.kind
        || inspected.signer.toBase58() !== intent.walletAddress
        || inspected.targetAddress.toBase58() !== intent.targetAddress
        || (intent.secondaryAddress && inspected.secondaryAddress.toBase58() !== intent.secondaryAddress)) {
      throw new Error("The signed launch instruction does not match the prepared intent.");
    }
    const messageHash = await hashHex(transaction.serializeMessage());
    if (messageHash !== intent.transactionMessageHash) throw new Error("The signed transaction message was changed after preparation.");
    const transactionHash = await hashHex(raw);
    const connection = getVsolConnection();
    const simulationResult = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), {
      sigVerify: true,
      commitment: "confirmed",
    });
    const logs = boundedLogs(simulationResult.value.logs);
    const logsJson = JSON.stringify(logs);
    const logsHash = await hashHex(logsJson);
    const simulationStatus = simulationResult.value.err ? "failed" as const : "passed" as const;
    await db.update(launchActions).set({
      transactionHash,
      simulationStatus,
      simulationSlot: simulationResult.context.slot,
      simulationUnitsConsumed: simulationResult.value.unitsConsumed ?? null,
      simulationLogsJson: logsJson,
      simulationLogsHash: logsHash,
      simulationErrorJson: simulationResult.value.err ? safeJson(simulationResult.value.err) : null,
      submissionStatus: simulationResult.value.err ? "failed" : "prepared",
      submissionError: simulationResult.value.err ? "Devnet simulation rejected the transaction." : null,
    }).where(eq(launchActions.id, intent.id));
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
      return json({ error: "Devnet simulation rejected the launch transaction.", simulation }, 422);
    }

    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    let postStateVerified = false;
    for (let attempt = 0; attempt < 5 && !postStateVerified; attempt += 1) {
      postStateVerified = await verifyPostState(intent, connection).catch(() => false);
      if (!postStateVerified) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!postStateVerified) throw new Error("The confirmed launch transaction did not produce the expected onchain state.");
    await db.update(launchActions).set({
      transactionSignature: signature,
      submissionStatus: "confirmed",
      submissionError: null,
      postStateVerified: true,
      confirmedAt: new Date(),
    }).where(eq(launchActions.id, intent.id));
    return json({
      signature,
      kind: intent.kind,
      targetAddress: intent.targetAddress,
      secondaryAddress: intent.secondaryAddress,
      simulation,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The launch transaction failed.";
    await db.update(launchActions).set({
      submissionStatus: "failed",
      submissionError: message.slice(0, 500),
      ...(!simulationStored ? { simulationStatus: "failed" as const, simulationErrorJson: safeJson({ message }) } : {}),
    }).where(eq(launchActions.id, intent.id)).catch(() => undefined);
    return json({ error: message.slice(0, 300), simulationId: simulationStored ? intent.id : undefined }, 422);
  }
}
