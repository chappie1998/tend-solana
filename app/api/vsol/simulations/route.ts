import { and, eq } from "drizzle-orm";
import { ensureDb, getDb } from "../../../../db";
import { transactionSimulations } from "../../../../db/schema";
import { resolveUserKey } from "../../../lib/session";

export async function GET(request: Request) {
  const owner = await resolveUserKey(request);
  if (!owner) return Response.json({ error: "Sign in to view transaction simulations." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "A valid simulation id is required." }, { status: 422 });
  await ensureDb();
  const [simulation] = await getDb().select().from(transactionSimulations).where(and(
    eq(transactionSimulations.id, id),
    eq(transactionSimulations.userEmail, owner),
  )).limit(1);
  if (!simulation) return Response.json({ error: "Simulation not found." }, { status: 404 });
  return Response.json({
    simulation: {
      ...simulation,
      logs: JSON.parse(simulation.logsJson) as string[],
      logsJson: undefined,
      integrity: {
        transactionHashAlgorithm: "SHA-256",
        logsHashAlgorithm: "SHA-256",
      },
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
