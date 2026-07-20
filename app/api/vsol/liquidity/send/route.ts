import "../../../../lib/runtime-env-worker";
import { and, eq } from "drizzle-orm";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { ensureDb, getDb } from "../../../../../db";
import { liquidityActions } from "../../../../../db/schema";
import { boundedLogs, hashHex, resolveUserKey, safeJson, sameOrigin } from "../../../../lib/session";
import {
  decodeSignedTransaction,
  getVsolClusterTime,
  getVsolConnection,
  getVsolLiquidityState,
  inspectVsolLiquidityTransaction,
  parsePublicKey,
} from "../../../../lib/vsol-server";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-site liquidity requests are not allowed." }, { status: 403 });
  const ownerKey = await resolveUserKey(request);
  if (!ownerKey) return Response.json({ error: "Sign in to submit liquidity transactions." }, { status: 401 });
  await ensureDb();
  const input = await request.json().catch(() => null) as { intentId?: unknown; walletAddress?: unknown; transaction?: unknown } | null;
  const owner = parsePublicKey(input?.walletAddress);
  if (!owner || typeof input?.intentId !== "string" || typeof input.transaction !== "string") {
    return Response.json({ error: "A signed transaction, intent id, and valid wallet are required." }, { status: 422 });
  }
  const db = getDb();
  const [intent] = await db.select().from(liquidityActions).where(and(
    eq(liquidityActions.id, input.intentId),
    eq(liquidityActions.userEmail, ownerKey),
    eq(liquidityActions.walletAddress, owner.toBase58()),
  )).limit(1);
  if (!intent) return Response.json({ error: "Liquidity intent not found." }, { status: 404 });
  if (intent.submissionStatus !== "prepared") return Response.json({ error: "This liquidity intent has already been submitted." }, { status: 409 });

  let simulationStored = false;
  try {
    const raw = decodeSignedTransaction(input.transaction);
    const transaction = Transaction.from(raw);
    if (!transaction.verifySignatures()) throw new Error("The wallet signature is invalid.");
    const inspected = inspectVsolLiquidityTransaction(transaction);
    if (!inspected) throw new Error("Only exact VSOL V2 deposit or withdrawal transactions are accepted.");
    const expectedInput = intent.action === "deposit" ? BigInt(intent.amountAtoms) : BigInt(intent.sharesAtoms ?? "0");
    if (inspected.owner.toBase58() !== intent.walletAddress
        || inspected.provider.toBase58() !== intent.providerAddress
        || inspected.action !== intent.action
        || inspected.inputAtoms !== expectedInput
        || inspected.minimumOutputAtoms !== BigInt(intent.minimumOutputAtoms)
        || inspected.deadline !== BigInt(intent.deadline)) {
      throw new Error("The signed liquidity instruction does not match the prepared intent.");
    }
    if (await getVsolClusterTime() > intent.deadline) throw new Error("The prepared liquidity transaction expired. Prepare a fresh one.");
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
    await db.update(liquidityActions).set({
      transactionHash,
      simulationStatus,
      simulationSlot: simulationResult.context.slot,
      simulationUnitsConsumed: simulationResult.value.unitsConsumed ?? null,
      simulationLogsJson: logsJson,
      simulationLogsHash: logsHash,
      simulationErrorJson: simulationResult.value.err ? safeJson(simulationResult.value.err) : null,
      submissionStatus: simulationResult.value.err ? "failed" : "prepared",
      submissionError: simulationResult.value.err ? "Devnet simulation rejected the transaction." : null,
    }).where(eq(liquidityActions.id, intent.id));
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
      return Response.json({ error: "Devnet simulation rejected the liquidity transaction.", simulation }, { status: 422 });
    }

    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    let postState = await getVsolLiquidityState(owner, connection);
    for (let attempt = 0; attempt < 5 && postState.provider?.walletAssetsAtoms === intent.preWalletAtoms; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      postState = await getVsolLiquidityState(owner, connection);
    }
    if (!postState.pool || !postState.provider) throw new Error("Could not reconcile the confirmed post-state.");
    const preWallet = BigInt(intent.preWalletAtoms);
    const prePool = BigInt(intent.prePoolAtoms);
    const preShares = BigInt(intent.preSharesAtoms);
    const postWallet = BigInt(postState.provider.walletAssetsAtoms);
    const postPool = BigInt(postState.pool.availableAssetsAtoms);
    const postShares = BigInt(postState.provider.sharesAtoms);
    let actualAmount: bigint;
    let actualShares: bigint;
    if (intent.action === "deposit") {
      actualAmount = BigInt(intent.amountAtoms);
      actualShares = postShares - preShares;
      if (preWallet - postWallet !== actualAmount || postPool - prePool !== actualAmount || actualShares < BigInt(intent.minimumOutputAtoms)) {
        throw new Error("The confirmed deposit post-state does not match its token and share obligations.");
      }
    } else {
      actualShares = BigInt(intent.sharesAtoms ?? "0");
      actualAmount = postWallet - preWallet;
      if (preShares - postShares !== actualShares || prePool - postPool !== actualAmount || actualAmount < BigInt(intent.minimumOutputAtoms)) {
        throw new Error("The confirmed withdrawal post-state does not match its token and share obligations.");
      }
    }
    await db.update(liquidityActions).set({
      amountAtoms: actualAmount.toString(),
      sharesAtoms: actualShares.toString(),
      transactionSignature: signature,
      submissionStatus: "confirmed",
      submissionError: null,
      postWalletAtoms: postWallet.toString(),
      postPoolAtoms: postPool.toString(),
      postSharesAtoms: postShares.toString(),
      confirmedAt: new Date(),
    }).where(eq(liquidityActions.id, intent.id));
    return Response.json({ signature, action: intent.action, amountAtoms: actualAmount.toString(), sharesAtoms: actualShares.toString(), simulation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The liquidity transaction failed.";
    await db.update(liquidityActions).set({
      submissionStatus: "failed",
      submissionError: message.slice(0, 500),
      ...(!simulationStored ? { simulationStatus: "failed" as const, simulationErrorJson: safeJson({ message }) } : {}),
    }).where(eq(liquidityActions.id, intent.id)).catch(() => undefined);
    return Response.json({ error: message.slice(0, 300), simulationId: simulationStored ? intent.id : undefined }, { status: 422 });
  }
}
