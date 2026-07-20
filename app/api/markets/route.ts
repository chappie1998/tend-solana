import "../../lib/runtime-env-worker";
import { markets } from "../../lib/markets";
import { getPythSnapshot } from "../../lib/pyth-market-data";
import { getVsolChainCatalog } from "../../lib/chain-catalog";
import { describeRpcFailure, getVsolSeriesStates } from "../../lib/vsol-server";

export async function GET() {
  const [snapshots, seriesResult, catalogResult] = await Promise.all([
    Promise.all(markets.map(async (market) => {
    try {
      return { symbol: market.symbol, snapshot: await getPythSnapshot(market) };
    } catch (error) {
      return { symbol: market.symbol, error: error instanceof Error ? error.message : "Pyth unavailable" };
    }
    })),
    getVsolSeriesStates().then(
      (series) => ({ series, error: null }),
      (error: unknown) => ({
        series: [],
        error: describeRpcFailure(error, "Onchain series verification failed"),
      }),
    ),
    getVsolChainCatalog().then(
      (catalog) => ({ ...catalog, error: null }),
      (error: unknown) => ({
        discovered: [],
        pools: [],
        error: describeRpcFailure(error, "Onchain market discovery failed"),
      }),
    ),
  ]);
  return Response.json(
    {
      cluster: "solana-devnet",
      chain: "Solana",
      updatedAt: new Date().toISOString(),
      markets,
      snapshots,
      series: seriesResult.series,
      seriesError: seriesResult.error,
      // Permissionless factory output beyond the verified manifest. Discovery
      // is explicit about tradability: a discovered series only becomes
      // executable once a liquidity pool manager authorizes it.
      discovered: catalogResult.discovered,
      pools: catalogResult.pools,
      discoveryError: catalogResult.error,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
