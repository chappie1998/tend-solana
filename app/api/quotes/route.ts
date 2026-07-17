import { markets } from "../../lib/markets";
import { quoteFor, type Direction } from "../../lib/options";
import { ensureDb, getDb } from "../../../db";
import { rfqQuotes } from "../../../db/schema";
import { lt } from "drizzle-orm";
import { expiryCodes, resolveExpiry, type ExpiryCode } from "../../lib/expiries";
import type { Market } from "../../lib/markets";

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

async function freshIntradayReference(market: Market) {
  const apiKey = process.env.MASSIVE_API_KEY?.trim();
  if (!apiKey || !market.marketDataSymbol) throw new Error("missing-feed");
  const endpoint = new URL(`https://api.massive.com/v2/last/trade/${market.marketDataSymbol}`);
  endpoint.searchParams.set("apiKey", apiKey);
  const response = await fetch(endpoint, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error("provider-error");
  const result = await response.json() as { results?: { p?: number; t?: number } };
  const price = Number(result.results?.p);
  const rawTimestamp = Number(result.results?.t);
  const timestampMs = rawTimestamp > 1e15 ? rawTimestamp / 1e6 : rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestampMs) || Date.now() - timestampMs > 120_000) {
    throw new Error("stale-feed");
  }
  return price;
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
  const requestedExpiry = typeof input.expiryCode === "string" ? input.expiryCode.toUpperCase() : "";
  const legacyDays = Number(input.days);
  const expiryCode = (expiryCodes.includes(requestedExpiry as ExpiryCode)
    ? requestedExpiry
    : legacyDays === 14 ? "7D" : legacyDays === 30 ? "30D" : "7D") as ExpiryCode;
  const payoff = Number(input.payoff);
  const market = markets.find((item) => item.symbol === symbol);

  if (!market || !direction) return json({ error: "Choose a supported market and direction." }, 422);
  if (!Number.isFinite(amount) || amount < 100 || amount > 50_000) return json({ error: "Order size must be between $100 and $50,000." }, 422);
  if (requestedExpiry && !expiryCodes.includes(requestedExpiry as ExpiryCode)) return json({ error: "Choose a supported expiry." }, 422);
  if (![2, 5, 10].includes(payoff)) return json({ error: "Target payoff must be 2×, 5×, or 10×." }, 422);

  const requestedAt = Date.now();
  const expiry = resolveExpiry(expiryCode, symbol, requestedAt);
  if (!expiry.available) return json({ error: expiry.availabilityReason }, 422);
  let referencePrice = market.price;
  if (expiry.group === "intraday") {
    try {
      referencePrice = await freshIntradayReference(market);
    } catch {
      return json({ error: "Intraday quotes require a fresh licensed reference feed. Try again when the feed is live." }, 503);
    }
  }

  const economics = quoteFor({
    spot: referencePrice,
    amount,
    durationMinutes: expiry.durationMinutes,
    direction,
    payoff,
    volatility: market.iv,
  });
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
    expiryDays: expiry.expiryDays,
    expiryCode: expiry.code,
    optionExpiryAt: new Date(expiry.expiryAt),
    observationWindowSeconds: expiry.observationWindowSeconds,
    tradeLockSeconds: expiry.tradeLockSeconds,
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
    referencePrice,
    referenceSource: expiry.group === "intraday" ? "Massive latest eligible trade" : "Tend preview reference",
    settlement: "European cash-settled · observation-window oracle",
    expiry: {
      code: expiry.code,
      label: expiry.label,
      optionExpiryAt: expiry.expiryAt,
      observationWindowSeconds: expiry.observationWindowSeconds,
      tradeLockSeconds: expiry.tradeLockSeconds,
    },
    quotes,
  });
}
