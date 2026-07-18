import { markets } from "../../lib/markets";
import { getPythSnapshot } from "../../lib/pyth-market-data";

export async function GET() {
  const snapshots = await Promise.all(markets.map(async (market) => {
    try {
      return { symbol: market.symbol, snapshot: await getPythSnapshot(market) };
    } catch (error) {
      return { symbol: market.symbol, error: error instanceof Error ? error.message : "Pyth unavailable" };
    }
  }));
  return Response.json(
    { cluster: "solana-devnet", chain: "Solana", updatedAt: new Date().toISOString(), markets, snapshots },
    { headers: { "Cache-Control": "no-store" } },
  );
}
