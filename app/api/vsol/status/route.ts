import { getAccount } from "@solana/spl-token";
import { VSOL_CONNECTION } from "../../../lib/vsol-server";
import {
  VSOL_CONFIG,
  VSOL_MARKET,
  VSOL_ORACLE,
  VSOL_PROGRAM_ID,
  VSOL_WRITER_TOKEN,
  solanaExplorerUrl,
} from "../../../lib/vsol";

export async function GET() {
  try {
    const [program, config, market, oracle, writer] = await Promise.all([
      VSOL_CONNECTION.getAccountInfo(VSOL_PROGRAM_ID, "confirmed"),
      VSOL_CONNECTION.getAccountInfo(VSOL_CONFIG, "confirmed"),
      VSOL_CONNECTION.getAccountInfo(VSOL_MARKET, "confirmed"),
      VSOL_CONNECTION.getAccountInfo(VSOL_ORACLE, "confirmed"),
      getAccount(VSOL_CONNECTION, VSOL_WRITER_TOKEN, "confirmed"),
    ]);
    return Response.json({
      ok: Boolean(program?.executable && config && market && oracle),
      cluster: "devnet",
      programId: VSOL_PROGRAM_ID.toBase58(),
      config: VSOL_CONFIG.toBase58(),
      market: VSOL_MARKET.toBase58(),
      oracle: VSOL_ORACLE.toBase58(),
      writerLiquidity: Number(writer.amount) / 1_000_000,
      executable: Boolean(program?.executable),
      explorerUrl: solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58()),
      checkedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } });
  } catch {
    return Response.json({ ok: false, cluster: "devnet", error: "Devnet RPC is temporarily unavailable." }, { status: 503 });
  }
}
