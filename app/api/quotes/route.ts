import { markets } from "../../lib/markets";
import { quoteFor, type Direction } from "../../lib/options";
import { ensureDb, getDb } from "../../../db";
import { rfqQuotes } from "../../../db/schema";
import { lt } from "drizzle-orm";
import { expiryCodes, resolveExpiry, type ExpiryCode } from "../../lib/expiries";
import type { Market } from "../../lib/markets";
import { buildVsolQuoteTransaction, parsePublicKey } from "../../lib/vsol-server";
import { solanaExplorerUrl } from "../../lib/vsol";
import { getChatGPTUser } from "../../chatgpt-auth";

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function authorized(request: Request) {
  if (await getChatGPTUser()) return true;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
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
  if (!sameOrigin(request)) return json({ error: "Cross-site quote requests are not allowed." }, 403);
  if (!(await authorized(request))) return json({ error: "Sign in to request executable quotes." }, 401);
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
  const buyer = parsePublicKey(input.walletAddress);
  const market = markets.find((item) => item.symbol === symbol);

  if (!market || !direction) return json({ error: "Choose a supported market and direction." }, 422);
  if (!buyer) return json({ error: "Connect a valid Solana wallet before requesting an executable quote." }, 422);
  if (!Number.isFinite(amount) || amount < 100 || amount > 5_000) return json({ error: "Devnet order size must be between $100 and $5,000." }, 422);
  if (requestedExpiry && !expiryCodes.includes(requestedExpiry as ExpiryCode)) return json({ error: "Choose a supported expiry." }, 422);
  if (expiryCode !== "30D") return json({ error: "The live devnet sandbox currently quotes the rolling 30-day market. Shorter series remain gated until the production oracle is connected." }, 422);
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
  const startedAt = Date.now();
  let vsol;
  try {
    vsol = await buildVsolQuoteTransaction({
      buyer,
      direction,
      strike: economics.strike,
      cap: economics.cap,
      premium: economics.premium,
      maxPayout: economics.maxPayout,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "VsolTestFundsRequired") {
      return json({ error: error.message, code: "VSOL_TEST_FUNDS_REQUIRED" }, 409);
    }
    return json({ error: error instanceof Error ? error.message : "The VSOL maker did not return an executable quote." }, 503);
  }
  const quoteRows = [{
    id: vsol.positionAddress,
    requestId,
    maker: "VSOL Devnet MM",
    symbol,
    direction,
    amount,
    premium: Number(economics.premium.toFixed(2)),
    maxPayout: Number(economics.maxPayout.toFixed(2)),
    strike: Number(economics.strike.toFixed(2)),
    capPrice: Number(economics.cap.toFixed(2)),
    breakeven: Number(economics.breakeven.toFixed(2)),
    impliedVolatility: market.iv,
    effectiveLeverage: Number((economics.maxPayout / economics.premium).toFixed(2)),
    latencyMs: Date.now() - startedAt,
    badge: "Onchain escrow",
    expiryDays: expiry.expiryDays,
    expiryCode: expiry.code,
    optionExpiryAt: new Date(expiry.expiryAt),
    observationWindowSeconds: expiry.observationWindowSeconds,
    tradeLockSeconds: expiry.tradeLockSeconds,
    payoff,
    expiresAt: new Date(requestedAt + 30_000),
    consumedAt: null,
    createdAt: new Date(requestedAt),
  }];
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
    vsol: {
      ...vsol,
      explorerUrl: solanaExplorerUrl("address", vsol.positionAddress),
    },
  });
}
