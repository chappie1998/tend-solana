import "../../../../lib/runtime-env-worker";
import { ensureDb, getDb } from "../../../../../db";
import { liquidityActions } from "../../../../../db/schema";
import { hashHex, resolveUserKey, sameOrigin } from "../../../../lib/session";
import {
  buildVsolLiquidityTransaction,
  calculateDepositShares,
  calculateWithdrawAmount,
  getVsolClusterTime,
  getVsolLiquidityState,
  parsePublicKey,
  type LiquidityActionKind,
} from "../../../../lib/vsol-server";

function parseAtoms(value: unknown, decimals: number) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const atoms = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
  if (atoms <= 0n || atoms > 0xffff_ffff_ffff_ffffn) throw new Error("The amount is outside the supported range.");
  return atoms;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-site liquidity requests are not allowed." }, { status: 403 });
  const ownerKey = await resolveUserKey(request);
  if (!ownerKey) return Response.json({ error: "Sign in to manage liquidity." }, { status: 401 });
  const input = await request.json().catch(() => null) as { walletAddress?: unknown; action?: unknown; amount?: unknown } | null;
  const owner = parsePublicKey(input?.walletAddress);
  const action = input?.action === "deposit" || input?.action === "withdraw" ? input.action as LiquidityActionKind : null;
  if (!owner || !action) return Response.json({ error: "A valid wallet and liquidity action are required." }, { status: 422 });

  try {
    const state = await getVsolLiquidityState(owner);
    if (!state.ready || !state.pool || !state.provider) throw new Error(state.reason ?? "The V2 liquidity pool is unavailable.");
    if (!state.pool.depositsOpen || !state.pool.withdrawalsOpen) {
      throw new Error("Liquidity changes are locked while the pool has active positions or collateral obligations.");
    }
    const inputAtoms = parseAtoms(input?.amount, state.pool.decimals);
    const walletAtoms = BigInt(state.provider.walletAssetsAtoms);
    const poolAtoms = BigInt(state.pool.availableAssetsAtoms);
    const totalShares = BigInt(state.pool.totalSharesAtoms);
    const providerShares = BigInt(state.provider.sharesAtoms);
    let amountAtoms: bigint;
    let sharesAtoms: bigint;
    let minimumOutputAtoms: bigint;
    if (action === "deposit") {
      if (inputAtoms > walletAtoms) throw new Error("The wallet does not have enough devnet tUSDC.");
      amountAtoms = inputAtoms;
      sharesAtoms = calculateDepositShares(inputAtoms, totalShares, poolAtoms);
      minimumOutputAtoms = sharesAtoms;
    } else {
      if (inputAtoms > providerShares) throw new Error("The wallet does not own that many pool shares.");
      sharesAtoms = inputAtoms;
      amountAtoms = calculateWithdrawAmount(inputAtoms, totalShares, poolAtoms);
      minimumOutputAtoms = amountAtoms;
    }
    const now = await getVsolClusterTime();
    const deadline = BigInt(now + 90);
    const built = await buildVsolLiquidityTransaction({
      owner,
      action,
      inputAtoms,
      minimumOutputAtoms,
      deadline,
    });
    const messageHash = await hashHex(built.transaction.serializeMessage());
    const intentId = crypto.randomUUID();
    await ensureDb();
    await getDb().insert(liquidityActions).values({
      id: intentId,
      userEmail: ownerKey,
      walletAddress: owner.toBase58(),
      poolAddress: state.pool.address,
      providerAddress: built.providerAddress,
      action,
      amountAtoms: amountAtoms.toString(),
      minimumOutputAtoms: minimumOutputAtoms.toString(),
      sharesAtoms: sharesAtoms.toString(),
      deadline: Number(deadline),
      transactionMessageHash: messageHash,
      transactionHash: null,
      simulationStatus: null,
      simulationSlot: null,
      simulationUnitsConsumed: null,
      simulationLogsJson: null,
      simulationLogsHash: null,
      simulationErrorJson: null,
      transactionSignature: null,
      submissionStatus: "prepared",
      submissionError: null,
      preWalletAtoms: state.provider.walletAssetsAtoms,
      prePoolAtoms: state.pool.availableAssetsAtoms,
      preSharesAtoms: state.provider.sharesAtoms,
      postWalletAtoms: null,
      postPoolAtoms: null,
      postSharesAtoms: null,
      createdAt: new Date(),
      confirmedAt: null,
    });
    return Response.json({
      intentId,
      transaction: built.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      action,
      amountAtoms: amountAtoms.toString(),
      sharesAtoms: sharesAtoms.toString(),
      minimumOutputAtoms: minimumOutputAtoms.toString(),
      deadline: Number(deadline),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The liquidity transaction could not be prepared." }, { status: 422 });
  }
}
