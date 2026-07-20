import "../../../lib/runtime-env-worker";
import { and, eq } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { ensureDb, getDb } from "../../../../db";
import { positions, transactionSimulations } from "../../../../db/schema";
import { getChainPositions } from "../../../lib/chain-positions";
import { json, readSessionWallet, sameOrigin } from "../../../lib/session";
import { describeRpcFailure } from "../../../lib/vsol-server";

type Provenance = {
  transactionSignature: string | null;
  simulationId: string | null;
  simulationLogsHash: string | null;
  simulationSlot: number | null;
  simulationUnitsConsumed: number | null;
};

async function loadProvenance(wallet: string, positionAddresses: string[]) {
  // DB rows are a provenance cache only; failures must not hide chain truth.
  const provenance = new Map<string, Provenance>();
  if (!positionAddresses.length) return provenance;
  try {
    await ensureDb();
    const rows = await getDb()
      .select({
        quoteId: positions.quoteId,
        transactionSignature: positions.transactionSignature,
        simulationId: positions.simulationId,
        simulationLogsHash: positions.simulationLogsHash,
        simulationSlot: positions.simulationSlot,
        simulationUnitsConsumed: positions.simulationUnitsConsumed,
        simulationStatus: transactionSimulations.status,
        submissionStatus: transactionSimulations.submissionStatus,
      })
      .from(positions)
      .innerJoin(transactionSimulations, eq(positions.simulationId, transactionSimulations.id))
      .where(and(eq(positions.walletAddress, wallet)));
    for (const row of rows) {
      if (row.simulationStatus !== "passed" || row.submissionStatus !== "confirmed") continue;
      if (!positionAddresses.includes(row.quoteId)) continue;
      provenance.set(row.quoteId, {
        transactionSignature: row.transactionSignature,
        simulationId: row.simulationId,
        simulationLogsHash: row.simulationLogsHash,
        simulationSlot: row.simulationSlot,
        simulationUnitsConsumed: row.simulationUnitsConsumed,
      });
    }
  } catch {
    // No provenance available; the chain-derived rows remain authoritative.
  }
  return provenance;
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site position requests are not allowed." }, 403);
  // Chain positions are private to the signed-in wallet: only a valid wallet
  // session (SIWS) may read them, and only for its own address.
  const wallet = await readSessionWallet(request);
  if (!wallet) {
    return json({
      error: "Sign in with your wallet signature to read chain positions.",
      code: "WALLET_SESSION_REQUIRED",
    }, 401);
  }
  try {
    const chainPositions = await getChainPositions(new PublicKey(wallet));
    const provenance = await loadProvenance(wallet, chainPositions.map((position) => position.address));
    return json({
      wallet,
      checkedAt: new Date().toISOString(),
      positions: chainPositions.map((position) => ({
        ...position,
        provenance: provenance.get(position.address) ?? null,
      })),
    }, 200, { "Cache-Control": "private, no-store" });
  } catch (error) {
    return json({
      error: describeRpcFailure(error, "Chain positions could not be read from devnet."),
      code: "CHAIN_POSITIONS_UNAVAILABLE",
    }, 503);
  }
}
