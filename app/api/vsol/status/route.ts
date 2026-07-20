import "../../../lib/runtime-env-worker";
import { formatAtoms } from "../../../lib/format";
import { describeRpcFailure, getVsolConnection, getVsolLiquidityState, getVsolSeriesStates } from "../../../lib/vsol-server";
import {
  VSOL_PROGRAM_ID,
  VSOL_PYTH_FEED_ID,
  VSOL_PYTH_RECEIVER_PROGRAM_ID,
  VSOL_PYTH_UPGRADE_DEPLOYED,
  solanaExplorerUrl,
} from "../../../lib/vsol";

export async function GET() {
  if (!VSOL_PYTH_UPGRADE_DEPLOYED) {
    return Response.json({
      ok: false,
      cluster: "devnet",
      deploymentReady: false,
      programId: VSOL_PROGRAM_ID.toBase58(),
      pythFeedId: VSOL_PYTH_FEED_ID,
      oracleProgram: VSOL_PYTH_RECEIVER_PROGRAM_ID.toBase58(),
      explorerUrl: solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58()),
      error: "The Pyth-bound VSOL deployment is pending verification.",
      checkedAt: new Date().toISOString(),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const connection = getVsolConnection();
    const [program, pythReceiver, liquidity, series] = await Promise.all([
      connection.getAccountInfo(VSOL_PROGRAM_ID, "confirmed"),
      connection.getAccountInfo(VSOL_PYTH_RECEIVER_PROGRAM_ID, "confirmed"),
      getVsolLiquidityState(undefined, connection),
      getVsolSeriesStates(),
    ]);
    if (!liquidity.pool) throw new Error("The published V2 liquidity pool is unavailable");
    const availableSeries = series.filter((entry) => entry.available);
    const ok = Boolean(program?.executable && pythReceiver?.executable && liquidity.ready && availableSeries.length > 0);
    return Response.json({
      ok,
      deploymentReady: true,
      cluster: "devnet",
      programId: VSOL_PROGRAM_ID.toBase58(),
      pool: liquidity.pool.address,
      poolLiquidity: formatAtoms(liquidity.pool.availableAssetsAtoms, liquidity.pool.decimals),
      lockedCollateralAtoms: liquidity.pool.lockedCollateralAtoms,
      openPositions: liquidity.pool.openPositions,
      seriesCount: availableSeries.length,
      publishedSeriesCount: series.length,
      oracleProgram: VSOL_PYTH_RECEIVER_PROGRAM_ID.toBase58(),
      pythFeedId: VSOL_PYTH_FEED_ID,
      executable: Boolean(program?.executable),
      explorerUrl: solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58()),
      error: ok ? undefined : "No currently executable, pool-authorized VSOL V2 series passed verification.",
      checkedAt: new Date().toISOString(),
    }, {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" },
    });
  } catch (error) {
    const safeMessage = describeRpcFailure(error, "Devnet RPC is temporarily unavailable.");
    console.error("VSOL V2 status RPC check failed", { name: error instanceof Error ? error.name : "UnknownError", message: safeMessage });
    return Response.json({
      ok: false,
      cluster: "devnet",
      deploymentReady: true,
      programId: VSOL_PROGRAM_ID.toBase58(),
      explorerUrl: solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58()),
      error: safeMessage || "Devnet RPC is temporarily unavailable.",
      checkedAt: new Date().toISOString(),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
