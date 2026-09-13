import "../../lib/runtime-env-worker";
import { liveMarkets, marketsForWire } from "../../lib/markets";
import { getMarketSnapshot, marketDataSourceLabel } from "../../lib/market-data";
import { getVsolChainCatalog } from "../../lib/chain-catalog";
import { describeRpcFailure, getVsolSeriesStates } from "../../lib/vsol-server";

export async function GET() {
  const [snapshots, seriesResult, catalogResult] = await Promise.all([
    // Snapshots come from LIVE markets only. A coming-soon market has no
    // usable feed on either provider, so polling for it every 15s would
    // produce a guaranteed failure per poll and nothing else. The full
    // `markets` list is still returned below so the UI can render it as a
    // disabled chip.
    Promise.all(liveMarkets.map(async (market) => {
    try {
      return { symbol: market.symbol, snapshot: await getMarketSnapshot(market) };
    } catch (error) {
      return { symbol: market.symbol, error: error instanceof Error ? error.message : "Market data unavailable" };
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
      // Which off-chain provider produced every `snapshots[].snapshot` above
      // (one provider for the whole catalog -- see app/lib/market-data.ts).
      // Onchain settlement is unaffected either way.
      dataSource: marketDataSourceLabel(),
      // marketsForWire, not `markets`: a Market carries a bigint ladder step
      // and Response.json() cannot serialize one -- see MarketWireEntry.
      markets: marketsForWire,
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
