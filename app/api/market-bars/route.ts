import "../../lib/runtime-env-worker";
import { isChartResolution } from "../../lib/market-bars";
import { tradableMarketBySymbol } from "../../lib/markets";
import { getPythMarketBars } from "../../lib/pyth-market-bars";

function json(body: unknown, status: number, headers: Record<string, string>) {
  return Response.json(body, { status, headers });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const symbol = (params.get("symbol") ?? "").trim().toUpperCase();
  const resolution = (params.get("resolution") ?? "5").trim().toUpperCase();
  // tradableMarketBySymbol: chart bars come from the same entitled Pyth
  // benchmarks endpoint the snapshot does, so a coming-soon market has none.
  const market = tradableMarketBySymbol(symbol);
  if (!market) {
    return json({ error: "Choose a market with verified Pyth chart data.", code: "INVALID_MARKET" }, 422, {
      "Cache-Control": "no-store",
    });
  }
  if (!isChartResolution(resolution)) {
    return json({ error: "Choose a supported chart resolution.", code: "INVALID_RESOLUTION" }, 422, {
      "Cache-Control": "no-store",
    });
  }

  try {
    const result = await getPythMarketBars(market, resolution);
    return json(result, 200, {
      "Cache-Control": result.freshness === "live"
        ? "public, max-age=10, stale-while-revalidate=20"
        : "public, max-age=300, stale-while-revalidate=900",
      "X-Data-Source": "Pyth Benchmarks",
    });
  } catch {
    return json({
      error: "Real Pyth chart data is temporarily unavailable.",
      code: "PYTH_BENCHMARKS_UNAVAILABLE",
    }, 502, {
      "Cache-Control": "no-store",
      "Retry-After": "15",
    });
  }
}
