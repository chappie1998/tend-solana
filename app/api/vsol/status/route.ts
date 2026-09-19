import "../../../lib/runtime-env-worker";
import { ensureDb, getDb } from "../../../../db";
import { sql } from "drizzle-orm";
import { formatAtoms } from "../../../lib/format";
import { decodeConfigAccount, describeRpcFailure, getVsolConnection, getVsolLiquidityState, getVsolSeriesStates, vsolQuoteAuthority } from "../../../lib/vsol-server";
import { getCustomOracleReadiness } from "../../../lib/custom-oracle-readiness";
import { sessionSecret } from "../../../lib/session";
import {
  VSOL_PROGRAM_ID,
  VSOL_CUSTOM_SETTLEMENT_DEPLOYED,
  VSOL_CONFIG,
  solanaExplorerUrl,
} from "../../../lib/vsol";

export async function GET(request: Request) {
  if (!VSOL_CUSTOM_SETTLEMENT_DEPLOYED) {
    return Response.json({
      ok: false,
      cluster: "devnet",
      deploymentReady: false,
      programId: VSOL_PROGRAM_ID.toBase58(),
      explorerUrl: solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58()),
      oracle: { model: "Centrally signed custom oracle", deploymentReady: false },
      error: "The custom settlement observation upgrade is pending verification.",
      checkedAt: new Date().toISOString(),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const connection = getVsolConnection();
    const quoteAuthority = vsolQuoteAuthority();
    const authReady = Boolean(sessionSecret(request));
    const [program, configAccount, liquidity, series, oracleFeeds] = await Promise.all([
      connection.getAccountInfo(VSOL_PROGRAM_ID, "confirmed"),
      connection.getAccountInfo(VSOL_CONFIG, "confirmed"),
      getVsolLiquidityState(undefined, connection),
      getVsolSeriesStates(),
      getCustomOracleReadiness(undefined, connection),
      ensureDb().then(() => getDb().execute(sql`select 1 as ready`)),
    ]);
    if (!configAccount?.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The VSOL config account is unavailable");
    const config = decodeConfigAccount(Buffer.from(configAccount.data));
    if (!liquidity.pool) throw new Error("The published V2 liquidity pool is unavailable");
    const availableSeries = series.filter((entry) => entry.available);
    const oracleReady = oracleFeeds.every((feed) => feed.ready);
    const ok = Boolean(program?.executable && !config.paused && liquidity.ready && availableSeries.length > 0 && oracleReady && authReady);
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
      oracle: {
        model: "Centrally signed custom oracle",
        cryptoReference: "Coinbase Exchange",
        stockReference: "Hyperliquid xyz mark price (timestamp is HTTP fetch time)",
        feeds: oracleFeeds,
        ready: oracleReady,
      },
      executable: Boolean(program?.executable),
      protocolPaused: config.paused,
      databaseReady: true,
      authReady,
      quoteSigner: quoteAuthority.publicKey.toBase58(),
      explorerUrl: solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58()),
      error: ok ? undefined : config.paused
        ? "The protocol is paused on-chain."
        : !authReady
        ? "Wallet authentication is not configured."
        : !oracleReady
        ? "One or more custom settlement feeds are unavailable or stale."
        : "No currently executable, pool-authorized VSOL V2 series passed verification.",
      checkedAt: new Date().toISOString(),
    }, {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
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
