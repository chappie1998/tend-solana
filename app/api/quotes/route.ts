import "../../lib/runtime-env-worker";
import { tradableMarketBySymbol } from "../../lib/markets";
import { quoteFor, type Direction } from "../../lib/options";
import { ensureDb, getDb } from "../../../db";
import { rfqQuotes } from "../../../db/schema";
import { lt } from "drizzle-orm";
import { expiryCodes, resolveExpiry, type ExpiryCode } from "../../lib/expiries";
import { getPythRealizedVolatility, getPythSnapshot } from "../../lib/pyth-market-data";
import { buildVsolQuoteTransaction, describeRpcFailure, getVsolSeriesStateOrPlan, parsePublicKey } from "../../lib/vsol-server";
import { solanaExplorerUrl, VSOL_PYTH_UPGRADE_DEPLOYED } from "../../lib/vsol";
import { resolveVsolSeries } from "../../lib/series-resolver";
import { json, resolveUserKey, sameOrigin } from "../../lib/session";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site quote requests are not allowed." }, 403);
  if (!(await resolveUserKey(request))) return json({ error: "Sign in to request executable quotes." }, 401);
  if (!VSOL_PYTH_UPGRADE_DEPLOYED) {
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
  // tradableMarketBySymbol, NOT marketBySymbol: a coming-soon market (see
  // `MarketStatus` in app/lib/markets.ts) is listed for display but has no
  // usable price feed, so it must never reach the quote path. Quoting
  // something that cannot settle is worse than showing nothing.
  const market = tradableMarketBySymbol(symbol);

  if (!market || !direction) return json({ error: "Choose a supported market and direction." }, 422);
  if (!buyer) return json({ error: "Connect a valid Solana wallet before requesting an executable quote." }, 422);
  if (!Number.isFinite(amount) || amount < 100 || amount > 5_000) return json({ error: "Devnet order size must be between $100 and $5,000." }, 422);
  if (requestedExpiry && !expiryCodes.includes(requestedExpiry as ExpiryCode)) return json({ error: "Choose a supported expiry." }, 422);
  if (![2, 5, 10].includes(payoff)) return json({ error: "Target payoff must be 2×, 5×, or 10×." }, 422);

  const requestedAt = Date.now();
  const expiry = resolveExpiry(expiryCode, symbol, requestedAt);
  if (!expiry.available) return json({ error: expiry.availabilityReason }, 422);
  const resolution = await resolveVsolSeries(symbol, expiryCode, requestedAt);
  if (!resolution.available) {
    return json({
      error: resolution.reason,
      code: "VSOL_SERIES_NOT_DEPLOYED",
    }, 503);
  }
  const series = resolution.series;
  // Not-yet-minted rungs resolve here as an available "plan" rather than an
  // error -- buildVsolQuoteTransaction below mints the market as part of the
  // buyer's own fill instead of requiring a keeper to have pre-minted it.
  let seriesState;
  try {
    seriesState = await getVsolSeriesStateOrPlan(series);
  } catch (error) {
    return json({
      error: describeRpcFailure(error, "The onchain series could not be verified."),
      code: "VSOL_SERIES_UNVERIFIED",
    }, 503);
  }
  if (!seriesState.available) return json({ error: seriesState.availabilityReason, code: "VSOL_SERIES_UNAVAILABLE" }, 422);
  const onchainExpiryAt = seriesState.expiry * 1_000;
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
  const economics = quoteFor({
    spot: snapshot.price,
    amount,
    durationMinutes,
    direction,
    payoff,
    volatility: volatility.value,
    referenceAgeSeconds: snapshot.ageSeconds,
  });
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let vsol;
  try {
    vsol = await buildVsolQuoteTransaction({
      buyer,
      series,
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
    if (error instanceof Error && error.name === "VsolPoolManagerUnavailable") {
      // Fails closed, honestly: mint-on-demand cannot proceed without the
      // pool manager key. Ordinary fills on already-minted series never take
      // this branch, so this never blocks the common case.
      return json({ error: error.message, code: "VSOL_MINT_ON_DEMAND_UNAVAILABLE" }, 503);
    }
    if (error instanceof Error && error.name === "VsolTransactionTooLarge") {
      // The composed mint-on-demand transaction did not fit in a packet.
      // Report the series as unavailable with the measured size rather than
      // shipping a transaction that can never be sent.
      return json({ error: error.message, code: "VSOL_TRANSACTION_TOO_LARGE" }, 503);
    }
    return json({ error: describeRpcFailure(error, "The VSOL maker did not return an executable quote.") }, 503);
  }
  const quoteRows = [{
    id: vsol.positionAddress,
    requestId,
    maker: "VSOL V2 Pool",
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
    badge: "Pool escrow",
    marketAddress: seriesState.market,
    oracleAddress: seriesState.oracle,
    expiryDays: expiry.expiryDays,
    expiryCode: expiry.code,
    optionExpiryAt: new Date(onchainExpiryAt),
    observationWindowSeconds: seriesState.observationWindowSeconds,
    tradeLockSeconds: Math.max(0, seriesState.expiry - seriesState.lastTradeAt),
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
    // Not persisted (no schema column) -- these come straight from the
    // pricing engine's own return value for this single quote, the honest
    // counterweight to the payoff multiple: P(finishing ITM) at the solved
    // strike, and the gap-risk-adjusted vol actually priced into `premium`
    // (which can run above `pricingVolatility`, the raw Pyth realized-vol
    // reading, when the reference is stale).
    probabilityItm: economics.probabilityItm,
    impliedVolatility: economics.impliedVolatility,
  }));

  return json({
    requestId,
    symbol,
    tokenAddress: market.tokenAddress,
    oracleStatus: market.oracleStatus,
    referencePrice: snapshot.price,
    referenceConfidence: snapshot.confidence,
    referencePublishTime: snapshot.publishTime,
    referenceAgeSeconds: snapshot.ageSeconds,
    pricingMode: snapshot.mode,
    referenceSource: "Pyth Core Hermes · exact onchain feed id",
    settlement: "European cash-settled · fully verified Pyth PriceUpdateV2",
    expiry: {
      code: expiry.code,
      label: expiry.label,
      optionExpiryAt: onchainExpiryAt,
      observationWindowSeconds: seriesState.observationWindowSeconds,
      tradeLockSeconds: Math.max(0, seriesState.expiry - seriesState.lastTradeAt),
    },
    quotes,
    vsol: {
      ...vsol,
      explorerUrl: solanaExplorerUrl("address", vsol.positionAddress),
    },
  });
}
