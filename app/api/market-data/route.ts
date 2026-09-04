import "../../lib/runtime-env-worker";
import { tradableMarketBySymbol } from "../../lib/markets";
import { getPythSnapshot } from "../../lib/pyth-market-data";

function json(body: unknown, status = 200, cacheControl = "no-store") {
  return Response.json(body, { status, headers: { "Cache-Control": cacheControl } });
}

export async function GET(request: Request) {
  const symbol = (new URL(request.url).searchParams.get("symbol") ?? "").toUpperCase();
  // tradableMarketBySymbol: a coming-soon market's feed is not entitled on
  // this deployment, so there is no snapshot to serve for it.
  const market = tradableMarketBySymbol(symbol);
  if (!market) return json({ error: "Choose a market with a verified Pyth feed." }, 422);
  try {
    return json(
      { symbol, feedId: market.pythFeedId, snapshot: await getPythSnapshot(market) },
      200,
      "public, max-age=3, stale-while-revalidate=7",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pyth market data is unavailable";
    return json({ error: message.slice(0, 180), provider: "Pyth Core Hermes" }, 503);
  }
}
