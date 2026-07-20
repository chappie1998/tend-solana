import "../../../../lib/runtime-env-worker";
import { and, eq } from "drizzle-orm";
import { ensureDb, getDb } from "../../../../../db";
import { liquidityActions } from "../../../../../db/schema";
import { resolveUserKey } from "../../../../lib/session";

export async function GET(request: Request) {
  const ownerKey = await resolveUserKey(request);
  if (!ownerKey) return Response.json({ error: "Sign in to view simulations." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "A valid liquidity action id is required." }, { status: 422 });
  await ensureDb();
  const [row] = await getDb().select().from(liquidityActions).where(and(
    eq(liquidityActions.id, id),
    eq(liquidityActions.userEmail, ownerKey),
  )).limit(1);
  if (!row || !row.simulationLogsJson || !row.simulationLogsHash) return Response.json({ error: "Simulation not found." }, { status: 404 });
  return Response.json({ simulation: {
    id: row.id,
    walletAddress: row.walletAddress,
    poolAddress: row.poolAddress,
    action: row.action,
    transactionHash: row.transactionHash,
    status: row.simulationStatus,
    slot: row.simulationSlot,
    unitsConsumed: row.simulationUnitsConsumed,
    logs: JSON.parse(row.simulationLogsJson) as string[],
    logsHash: row.simulationLogsHash,
    error: row.simulationErrorJson ? JSON.parse(row.simulationErrorJson) as unknown : null,
    transactionSignature: row.transactionSignature,
    submissionStatus: row.submissionStatus,
    integrity: { transactionHashAlgorithm: "SHA-256", logsHashAlgorithm: "SHA-256" },
  } }, { headers: { "Cache-Control": "private, no-store" } });
}
