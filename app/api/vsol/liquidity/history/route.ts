import "../../../../lib/runtime-env-worker";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { ensureDb, getDb } from "../../../../../db";
import { liquidityActions } from "../../../../../db/schema";
import { resolveUserKey } from "../../../../lib/session";
import { parsePublicKey } from "../../../../lib/vsol-server";

export async function GET(request: Request) {
  const ownerKey = await resolveUserKey(request);
  if (!ownerKey) return Response.json({ error: "Sign in to view liquidity history." }, { status: 401 });
  const wallet = parsePublicKey(new URL(request.url).searchParams.get("walletAddress"));
  if (!wallet) return Response.json({ error: "Connect a valid Solana wallet." }, { status: 422 });
  await ensureDb();
  const rows = await getDb().select().from(liquidityActions).where(and(
    eq(liquidityActions.userEmail, ownerKey),
    eq(liquidityActions.walletAddress, wallet.toBase58()),
    eq(liquidityActions.simulationStatus, "passed"),
    eq(liquidityActions.submissionStatus, "confirmed"),
    isNotNull(liquidityActions.transactionSignature),
    isNotNull(liquidityActions.simulationLogsHash),
  )).orderBy(desc(liquidityActions.createdAt)).limit(100);
  return Response.json({ actions: rows.map((row) => ({
    id: row.id,
    action: row.action,
    amountAtoms: row.amountAtoms,
    sharesAtoms: row.sharesAtoms,
    transactionSignature: row.transactionSignature,
    simulationSlot: row.simulationSlot,
    simulationUnitsConsumed: row.simulationUnitsConsumed,
    createdAt: row.createdAt,
  })) }, { headers: { "Cache-Control": "private, no-store" } });
}
