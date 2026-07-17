import { markets } from "../../lib/markets";

export async function GET() {
  return Response.json(
    { chainId: 4663, chain: "Robinhood Chain", updatedAt: new Date().toISOString(), markets },
    { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=45" } },
  );
}
