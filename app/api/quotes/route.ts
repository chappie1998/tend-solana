import { markets } from "../../lib/markets";
import { quoteFor, type Direction } from "../../lib/options";
import { ensureDb, getDb } from "../../../db";
import { rfqQuotes } from "../../../db/schema";
import { lt } from "drizzle-orm";

const makers = [
  { name: "Aster", multiplier: 1, latencyMs: 780, badge: "Best price" },
  { name: "Northstar", multiplier: 1.018, latencyMs: 1_080, badge: "Deepest" },
  { name: "Maverick", multiplier: 1.043, latencyMs: 610, badge: "Fastest" },
] as const;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  await ensureDb();
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "The quote request must be valid JSON." }, 400);
  }

  const symbol = typeof input.symbol === "string" ? input.symbol.toUpperCase() : "";
  const direction = input.direction === "up" || input.direction === "down" ? input.direction as Direction : null;
  const amount = Number(input.amount);
  const days = Number(input.days);
  const payoff = Number(input.payoff);
  const market = markets.find((item) => item.symbol === symbol);

  if (!market || !direction) return json({ error: "Choose a supported market and direction." }, 422);
  if (!Number.isFinite(amount) || amount < 100 || amount > 50_000) return json({ error: "Order size must be between $100 and $50,000." }, 422);
  if (![7, 14, 30].includes(days)) return json({ error: "Expiry must be 7, 14, or 30 days." }, 422);
  if (![2, 5, 10].includes(payoff)) return json({ error: "Target payoff must be 2×, 5×, or 10×." }, 422);

  const economics = quoteFor({
    spot: market.price,
    amount,
    days,
    direction,
    payoff,
    volatility: market.iv,
  });
  const requestedAt = Date.now();
  const requestId = crypto.randomUUID();
  const quoteRows = makers.map((maker, index) => ({
    id: `${symbol}-${requestedAt}-${index + 1}`,
    requestId,
    maker: maker.name,
    symbol,
    direction,
    amount,
    premium: Number((economics.premium * maker.multiplier).toFixed(2)),
    maxPayout: Number(economics.maxPayout.toFixed(2)),
    strike: Number(economics.strike.toFixed(2)),
    capPrice: Number(economics.cap.toFixed(2)),
    breakeven: Number(economics.breakeven.toFixed(2)),
    impliedVolatility: market.iv,
    effectiveLeverage: Number((economics.maxPayout / (economics.premium * maker.multiplier)).toFixed(2)),
    latencyMs: maker.latencyMs,
    badge: maker.badge,
    expiryDays: days,
    payoff,
    expiresAt: new Date(requestedAt + 30_000),
    consumedAt: null,
    createdAt: new Date(requestedAt),
  }));
  try {
    const db = getDb();
    await db.delete(rfqQuotes).where(lt(rfqQuotes.expiresAt, new Date(requestedAt - 86_400_000)));
    await db.insert(rfqQuotes).values(quoteRows);
  } catch {
    return json({ error: "Quote service is temporarily unavailable. Please retry." }, 503);
  }
  const quotes = quoteRows.map((quote) => ({
    id: quote.id,
    maker: quote.maker,
    premium: quote.premium,
    maxPayout: quote.maxPayout,
    strike: quote.strike,
    cap: quote.capPrice,
    breakeven: quote.breakeven,
    impliedVolatility: quote.impliedVolatility,
    effectiveLeverage: quote.effectiveLeverage,
    latencyMs: quote.latencyMs,
    badge: quote.badge,
    expiresAt: quote.expiresAt.getTime(),
  }));

  return json({
    requestId,
    symbol,
    tokenAddress: market.tokenAddress,
    oracleStatus: market.oracleStatus,
    settlement: "European cash-settled · observation-window oracle",
    quotes,
  });
}
