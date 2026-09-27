import "../../../lib/runtime-env-worker";
import { ensureDb, getDb } from "../../../../db";
import { sql } from "drizzle-orm";
import { formatAtoms } from "../../../lib/format";
import { decodeConfigAccount, describeRpcFailure, getVsolConnection, getVsolLiquidityState, getVsolSeriesStates, vsolQuoteAuthority } from "../../../lib/vsol-server";
import { getVsolExecutionReadiness } from "../../../lib/custom-oracle-readiness";
import { createSingleEntryTtlCache } from "../../../lib/ttl-cache";
import { sessionSecret } from "../../../lib/session";
import {
  VSOL_PROGRAM_ID,
  VSOL_CUSTOM_SETTLEMENT_DEPLOYED,
  VSOL_CONFIG,
  solanaExplorerUrl,
} from "../../../lib/vsol";

// This route is polled by every visitor's status badge and hit on every
// page load -- a major share of this deployment's RPC/DB cost when nothing
// changed since the last check. `statusCache` shares ONE computed result
// across concurrent requests (in-flight de-duplication) and reuses it for
// STATUS_CACHE_TTL_MS afterward, so a burst of visitors during that window
// costs exactly one round of RPC/DB reads, not one per request. Session
// authentication (`authReady`, request-scoped) is deliberately read OUTSIDE
// the cached computation -- see below.
const STATUS_CACHE_TTL_MS = 20_000;

type VsolStatusData = {
  ok: boolean;
  deploymentReady: true;
  cluster: "devnet";
  programId: string;
  pool: string;
  poolLiquidity: string;
  lockedCollateralAtoms: string;
  openPositions: number;
  seriesCount: number;
  publishedSeriesCount: number;
  oracle: {
    model: string;
    cryptoReference: string;
    stockReference: string;
    heartbeat: Awaited<ReturnType<typeof getVsolExecutionReadiness>>["heartbeat"];
    feeds: Awaited<ReturnType<typeof getVsolExecutionReadiness>>["feeds"];
    ready: boolean;
  };
  executable: boolean;
  protocolPaused: boolean;
  databaseReady: boolean;
  quoteSigner: string;
  explorerUrl: string;
  checkedAt: string;
  // Reason is computed once `authReady` is known -- see `withAuthReady` below.
  baseError?: string;
};

async function computeVsolStatus(): Promise<VsolStatusData> {
  const connection = getVsolConnection();
  const quoteAuthority = vsolQuoteAuthority();
  const [program, configAccount, liquidity, series, executionReadiness] = await Promise.all([
    connection.getAccountInfo(VSOL_PROGRAM_ID, "confirmed"),
    connection.getAccountInfo(VSOL_CONFIG, "confirmed"),
    getVsolLiquidityState(undefined, connection),
    getVsolSeriesStates(),
    getVsolExecutionReadiness(undefined, connection),
    ensureDb().then(() => getDb().execute(sql`select 1 as ready`)),
  ]);
  if (!configAccount?.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The VSOL config account is unavailable");
  const config = decodeConfigAccount(Buffer.from(configAccount.data));
  if (!liquidity.pool) throw new Error("The published V2 liquidity pool is unavailable");
  const availableSeries = series.filter((entry) => entry.available);
  const executableOnChain = Boolean(program?.executable && !config.paused && liquidity.ready && availableSeries.length > 0 && executionReadiness.ok);

  return {
    ok: executableOnChain,
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
      heartbeat: executionReadiness.heartbeat,
      feeds: executionReadiness.feeds,
      ready: executionReadiness.ok,
    },
    executable: Boolean(program?.executable),
    protocolPaused: config.paused,
    databaseReady: true,
    quoteSigner: quoteAuthority.publicKey.toBase58(),
    explorerUrl: solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58()),
    checkedAt: new Date().toISOString(),
    baseError: executableOnChain ? undefined : config.paused
      ? "The protocol is paused on-chain."
      : !executionReadiness.ok
      ? `The settlement runner is not ready. ${executionReadiness.reason ?? ""}`.trim()
      : "No currently executable, pool-authorized VSOL V2 series passed verification.",
  };
}

const statusCache = createSingleEntryTtlCache({ ttlMs: STATUS_CACHE_TTL_MS, compute: computeVsolStatus });

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
    // Session authentication is per-REQUEST (it reads this caller's own
    // cookie), so it is deliberately evaluated outside the shared cache --
    // caching it would leak one visitor's auth state into another's response.
    const authReady = Boolean(sessionSecret(request));
    const data = await statusCache.get();
    const ok = data.ok && authReady;
    return Response.json({
      ok,
      deploymentReady: data.deploymentReady,
      cluster: data.cluster,
      programId: data.programId,
      pool: data.pool,
      poolLiquidity: data.poolLiquidity,
      lockedCollateralAtoms: data.lockedCollateralAtoms,
      openPositions: data.openPositions,
      seriesCount: data.seriesCount,
      publishedSeriesCount: data.publishedSeriesCount,
      oracle: data.oracle,
      executable: data.executable,
      protocolPaused: data.protocolPaused,
      databaseReady: data.databaseReady,
      authReady,
      quoteSigner: data.quoteSigner,
      explorerUrl: data.explorerUrl,
      error: ok ? undefined : !authReady ? "Wallet authentication is not configured." : data.baseError,
      checkedAt: data.checkedAt,
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
