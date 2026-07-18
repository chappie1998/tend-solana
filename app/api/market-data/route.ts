import "../../lib/runtime-env-worker";
import { marketBySymbol } from "../../lib/markets";
import { getPythSnapshot } from "../../lib/pyth-market-data";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const symbol = (new URL(request.url).searchParams.get("symbol") ?? "").toUpperCase();
  const market = marketBySymbol(symbol);
  if (!market) return json({ error: "Choose a market with a verified Pyth feed." }, 422);
  try {
    return json({ symbol, feedId: market.pythFeedId, snapshot: await getPythSnapshot(market) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pyth market data is unavailable";
    return json({ error: message.slice(0, 180), provider: "Pyth Core Hermes" }, 503);
  }
}
