import "../../lib/runtime-env-worker";
import deployment from "../../../vsol/deployments/devnet.json";
import { marketBySymbol } from "../../lib/markets";
import { quoteFor, type Direction } from "../../lib/options";
import { ensureDb, getDb } from "../../../db";
import { rfqQuotes } from "../../../db/schema";
import { lt } from "drizzle-orm";
import { expiryCodes, resolveExpiry, type ExpiryCode } from "../../lib/expiries";
import { getPythRealizedVolatility, getPythSnapshot } from "../../lib/pyth-market-data";
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

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site quote requests are not allowed." }, 403);
  if (!(await authorized(request))) return json({ error: "Sign in to request executable quotes." }, 401);
  if (!deployment.pythUpgradeDeployed) {
    return json({
      error: "Executable quotes are paused: the Pyth-bound VSOL program and market have not yet been verified on devnet.",
      code: "VSOL_PYTH_DEPLOYMENT_PENDING",
    }, 503);
  }
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
  const market = marketBySymbol(symbol);

  if (!market || !direction) return json({ error: "Choose a supported market and direction." }, 422);
  if (!buyer) return json({ error: "Connect a valid Solana wallet before requesting an executable quote." }, 422);
  if (!Number.isFinite(amount) || amount < 100 || amount > 5_000) return json({ error: "Devnet order size must be between $100 and $5,000." }, 422);
  if (requestedExpiry && !expiryCodes.includes(requestedExpiry as ExpiryCode)) return json({ error: "Choose a supported expiry." }, 422);
  if (expiryCode !== "30D") return json({ error: "The live devnet sandbox currently quotes the rolling 30-day market. Shorter series remain gated until the production oracle is connected." }, 422);
  if (![2, 5, 10].includes(payoff)) return json({ error: "Target payoff must be 2×, 5×, or 10×." }, 422);

  const requestedAt = Date.now();
  const expiry = resolveExpiry(expiryCode, symbol, requestedAt);
  if (!expiry.available) return json({ error: expiry.availabilityReason }, 422);
  const onchainExpiryAt = Number(deployment.uiExpiry) * 1_000;
  const durationMinutes = Math.ceil((onchainExpiryAt - requestedAt) / 60_000);
  if (durationMinutes <= 5) return json({ error: "The published devnet series is too close to expiry. A new series must be deployed." }, 503);
  let snapshot;
  let volatility;
  try {
    [snapshot, volatility] = await Promise.all([
      getPythSnapshot(market),
      getPythRealizedVolatility(market),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Pyth pricing is unavailable";
    return json({ error: `Executable pricing requires fresh Pyth spot and historical observations: ${reason}` }, 503);
  }
  if (snapshot.mode !== "live") {
    return json({ error: "Executable quotes pause unless the Pyth equity feed is fresh during the US reference session." }, 503);
  }

  const economics = quoteFor({
    spot: snapshot.price,
    amount,
    durationMinutes,
    direction,
    payoff,
    volatility: volatility.value,
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
    pricingVolatility: volatility.value,
    volatilitySource: volatility.source,
    effectiveLeverage: Number((economics.maxPayout / economics.premium).toFixed(2)),
    latencyMs: Date.now() - startedAt,
    badge: "Onchain escrow",
    expiryDays: expiry.expiryDays,
    expiryCode: expiry.code,
    optionExpiryAt: new Date(onchainExpiryAt),
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
    pricingVolatility: quote.pricingVolatility,
    volatilitySource: quote.volatilitySource,
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
    referencePrice: snapshot.price,
    referenceConfidence: snapshot.confidence,
    referencePublishTime: snapshot.publishTime,
    referenceSource: "Pyth Core Hermes · exact onchain feed id",
    settlement: "European cash-settled · fully verified Pyth PriceUpdateV2",
    expiry: {
      code: expiry.code,
      label: expiry.label,
      optionExpiryAt: onchainExpiryAt,
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
