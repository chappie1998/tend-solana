import "../../../lib/runtime-env-worker";
import { getAccount } from "@solana/spl-token";
import { getVsolConnection } from "../../../lib/vsol-server";
import {
  VSOL_CONFIG,
  VSOL_MARKET,
  VSOL_ORACLE,
  VSOL_PROGRAM_ID,
  VSOL_PYTH_FEED_ID,
  VSOL_PYTH_RECEIVER_PROGRAM_ID,
  VSOL_PYTH_UPGRADE_DEPLOYED,
  VSOL_WRITER_VAULT,
  VSOL_WRITER_TOKEN,
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
    const [program, pythReceiver, config, market, oracle, writer] = await Promise.all([
      connection.getAccountInfo(VSOL_PROGRAM_ID, "confirmed"),
      connection.getAccountInfo(VSOL_PYTH_RECEIVER_PROGRAM_ID, "confirmed"),
      connection.getAccountInfo(VSOL_CONFIG, "confirmed"),
      connection.getAccountInfo(VSOL_MARKET, "confirmed"),
      connection.getAccountInfo(VSOL_ORACLE, "confirmed"),
      getAccount(connection, VSOL_WRITER_TOKEN, "confirmed"),
    ]);
    const marketFeed = market?.data.length && market.data.length >= 243 ? Buffer.from(market.data.subarray(211, 243)).toString("hex") : "";
    const oracleFeed = oracle?.data.length && oracle.data.length >= 137 ? Buffer.from(oracle.data.subarray(105, 137)).toString("hex") : "";
    const accountsOwnedByProgram = Boolean(config?.owner.equals(VSOL_PROGRAM_ID) && market?.owner.equals(VSOL_PROGRAM_ID) && oracle?.owner.equals(VSOL_PROGRAM_ID));
    const pythBound = marketFeed === VSOL_PYTH_FEED_ID && oracleFeed === VSOL_PYTH_FEED_ID;
    return Response.json({
      ok: Boolean(VSOL_PYTH_UPGRADE_DEPLOYED && program?.executable && pythReceiver?.executable && accountsOwnedByProgram && pythBound),
      deploymentReady: VSOL_PYTH_UPGRADE_DEPLOYED,
      cluster: "devnet",
      programId: VSOL_PROGRAM_ID.toBase58(),
      config: VSOL_CONFIG.toBase58(),
      market: VSOL_MARKET.toBase58(),
      oracle: VSOL_ORACLE.toBase58(),
      writerVault: VSOL_WRITER_VAULT.toBase58(),
      oracleProgram: VSOL_PYTH_RECEIVER_PROGRAM_ID.toBase58(),
      pythFeedId: VSOL_PYTH_FEED_ID,
      pythBound,
      writerLiquidity: Number(writer.amount) / 1_000_000,
      executable: Boolean(program?.executable),
      explorerUrl: solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58()),
      checkedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = rawMessage.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 300);
    console.error("VSOL status RPC check failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: safeMessage,
    });
    return Response.json({
      ok: false,
      cluster: "devnet",
      deploymentReady: VSOL_PYTH_UPGRADE_DEPLOYED,
      error: VSOL_PYTH_UPGRADE_DEPLOYED
        ? "Devnet RPC is temporarily unavailable."
        : "The Pyth-bound VSOL deployment is pending verification.",
    }, { status: 503 });
  }
}
