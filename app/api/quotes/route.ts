import "../../lib/runtime-env-worker";
import { clampVolatilityForMarket, tradableMarketBySymbol } from "../../lib/markets";
import { payoffTiersFor, payoutForStake, quoteFor, stakeBoundsForPayoff, type Direction } from "../../lib/options";

// Any positive size works as the reference: the premium/payout ratio the
// inversion needs is size-independent (see payoutForStake). 1,000 sits in the
// middle of the pool's range, so the reference quote never hits a clamp.
const STAKE_REFERENCE_NOTIONAL = 1_000;
import { ensureDb, getDb } from "../../../db";
import { rfqQuotes } from "../../../db/schema";
import { and, gte, like, lt } from "drizzle-orm";
import { expiryCodes, resolveExpiry, type ExpiryCode } from "../../lib/expiries";
import { getMarketRealizedVolatility, getMarketSnapshot } from "../../lib/market-data";
import { getVsolExecutionReadiness } from "../../lib/custom-oracle-readiness";
import {
  buildVsolQuoteTransaction,
  checkVsolPoolDepth,
  describeRpcFailure,
  fromPoolAtoms,
  getPoolCore,
  getVsolSeriesStateOrPlan,
  parsePublicKey,
  toPoolAtoms,
} from "../../lib/vsol-server";
import { solanaExplorerUrl, VSOL_CUSTOM_SETTLEMENT_DEPLOYED } from "../../lib/vsol";
import { resolveOrPlanVsolSeries } from "../../lib/series-resolver";
import { json, resolveUserKey, sameOrigin } from "../../lib/session";
import { enforceInMemoryRateLimit } from "../../lib/in-memory-rate-limit";
import { buildRfqRequestId, checkExecutableQuoteRateLimit, RFQ_REQUEST_ID_DELIMITER, userKeyFromRfqRequestId } from "../../lib/rate-limit";

/**
 * Two intents share this route, split so that merely PREVIEWING a price can
 * never cost the server money (see app/lib/rate-limit.ts's doc comment for
 * the concrete cost: an unlisted strike triggers a real, server-paid listing
 * transaction). `indicative` is the safe DEFAULT -- an unrecognised or
 * missing `intent` gets the cheap, side-effect-free path, never the one that
 * lists/signs/persists. Only an explicit `intent: "execute"` reaches that
 * path.
 *
 * - `indicative`: the pricing engine's honest read on this ticket right now
 *   (premium, strike, maxPayout, probability, implied vol), computed exactly
 *   like `execute` does, PLUS the pool-depth pre-check (a single read-only
 *   account fetch -- see its own comment below for why that one stays for
 *   both intents). It NEVER resolves-and-lists a series onchain, never asks
 *   the pool authority to sign anything, and never writes an `rfq_quotes`
 *   row -- so it is safe to fire on every keystroke (see the 600ms auto-quote
 *   debounce in app/components/TendTerminal.tsx). The response has no `vsol`
 *   field and marks its quote `executable: false`; nothing this route returns
 *   for this intent may ever reach the wallet-signing path.
 * - `execute`: today's original behaviour -- series resolution (minting an
 *   unlisted rung if needed), a server-signed transaction, and a persisted
 *   `rfq_quotes` row -- gated additionally by the DB-backed per-wallet cap
 *   below, since this is the intent that can actually spend the server's SOL.
 *   Only requested when the trader clicks "Review & execute".
 */
type QuoteIntent = "indicative" | "execute";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site quote requests are not allowed." }, 403);
  const userKey = await resolveUserKey(request);
  if (!userKey) return json({ error: "Sign in to request a quote." }, 401);
  // Best-effort burst dampener only, applied to BOTH intents (see
  // app/lib/in-memory-rate-limit.ts's doc comment) -- indicative auto-quoting
  // is the frequent case this bucket sizes for. The DB-backed cap below is
  // the one that actually protects the server's SOL on the execute path.
  const inMemoryLimit = enforceInMemoryRateLimit(request, "quotes", userKey);
  if (inMemoryLimit.limited) {
    return json(
      { error: "Too many quote requests. Wait a moment and try again." },
      429,
      { "Retry-After": String(inMemoryLimit.retryAfterSeconds) },
    );
  }
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "The quote request must be valid JSON." }, 400);
  }

  // Default to the safe, side-effect-free intent -- see the doc comment
  // above. Only the literal string "execute" ever reaches the costly path.
  const intent: QuoteIntent = input.intent === "execute" ? "execute" : "indicative";

  if (intent === "execute" && !VSOL_CUSTOM_SETTLEMENT_DEPLOYED) {
    // This gate is about EXECUTION specifically (whether it is safe to open
    // a real position against the current settlement path), not about
    // computing a preview -- an indicative price is honest regardless of
    // whether the custom settlement upgrade has been verified, since nothing
    // gets minted, signed, or settled from it.
    return json({
      error: "Executable quotes are paused: the custom settlement observation upgrade has not yet been verified on devnet.",
      code: "VSOL_CUSTOM_SETTLEMENT_DEPLOYMENT_PENDING",
    }, 503);
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
  // The buyer types what they PAY. `stake` is that number; `amount` is the
  // legacy payout-notional input, still accepted so scripts and the SDK
  // smoke tests keep working unchanged.
  const stake = Number(input.stake);
  const stakeMode = Number.isFinite(stake) && stake > 0;
  const buyer = parsePublicKey(input.walletAddress);
  // tradableMarketBySymbol, NOT marketBySymbol: a coming-soon market (see
  // `MarketStatus` in app/lib/markets.ts) is listed for display but has no
  // usable price feed, so it must never reach the quote path. Quoting
  // something that cannot settle is worse than showing nothing.
  const market = tradableMarketBySymbol(symbol);

  // Input validation below is shared by both intents: an indicative preview
  // is only useful if it prices the SAME ticket an execute request would, so
  // there is exactly one set of bounds checks, not two that could drift.
  if (!market || !direction) return json({ error: "Choose a supported market and direction." }, 422);
  if (!buyer) return json({ error: "Connect a valid Solana wallet before requesting a quote." }, 422);
  if (!stakeMode && (!Number.isFinite(amount) || amount < 100 || amount > 5_000)) {
    return json({ error: "Devnet order size must be between $100 and $5,000." }, 422);
  }
  if (stakeMode) {
    // The exact tier ladder is tenor-dependent (see payoffTiersFor) and the
    // tenor isn't resolved yet at this point in the request -- 5 is just a
    // reasonable fallback for bounds-checking an as-yet-unvalidated payoff;
    // the real tier check happens below, once durationMinutes is known.
    const bounds = stakeBoundsForPayoff(Number.isFinite(payoff) && payoff > 0 ? payoff : 5);
    if (stake < bounds.min || stake > bounds.max) {
      return json({ error: `At ${payoff}x, pay between $${bounds.min} and $${bounds.max.toLocaleString()}.` }, 422);
    }
  }
  if (requestedExpiry && !expiryCodes.includes(requestedExpiry as ExpiryCode)) return json({ error: "Choose a supported expiry." }, 422);
  // Coarse sanity check only -- the exact set of valid tiers depends on the
  // resolved onchain series' actual duration, checked against
  // payoffTiersFor once durationMinutes is known below.
  if (!Number.isFinite(payoff) || payoff <= 0) return json({ error: "Choose a valid target payoff." }, 422);

  const requestedAt = Date.now();

  if (intent === "execute") {
    // Authoritative, DB-backed per-wallet cap -- see app/lib/rate-limit.ts's
    // doc comment for why this (not the in-memory limiter above) is the
    // control that actually bounds the server's SOL exposure. Runs BEFORE
    // any chain read below (oracle readiness, series resolution, pool depth),
    // so a rate-limited caller never causes any of that work, let alone
    // reaching listVsolSeriesOnChain.
    await ensureDb();
    const db = getDb();
    const rateLimitWindowStart = new Date(requestedAt - 3_600_000);
    // Narrowed in SQL rather than fetching every wallet's rows for the hour:
    // `expires_at` is indexed (rfq_quotes_expiry_idx) and is always
    // created_at + 30s, so bounding it by the window start lets Postgres use
    // the index; the requestId prefix then keeps only this caller's rows.
    // LIKE metacharacters in the key are escaped, and the exact
    // userKeyFromRfqRequestId match below stays the final authority in case
    // an escaped pattern still over-matches. `rfq_quotes` has no wallet
    // column (see buildRfqRequestId's doc comment); a real indexed column
    // is the proper fix if this ever needs to scale.
    const escapedKey = userKey.replace(/[\\%_]/g, (character) => `\\${character}`);
    const recentRows = await db
      .select({ requestId: rfqQuotes.requestId, createdAt: rfqQuotes.createdAt })
      .from(rfqQuotes)
      .where(and(
        gte(rfqQuotes.expiresAt, rateLimitWindowStart),
        gte(rfqQuotes.createdAt, rateLimitWindowStart),
        like(rfqQuotes.requestId, `${escapedKey}${RFQ_REQUEST_ID_DELIMITER}%`),
      ));
    const recentCreatedAtMsForWallet = recentRows
      .filter((row) => userKeyFromRfqRequestId(row.requestId) === userKey)
      .map((row) => row.createdAt.getTime());
    const rateLimit = checkExecutableQuoteRateLimit(recentCreatedAtMsForWallet, requestedAt);
    if (rateLimit.limited) {
      return json(
        { error: rateLimit.message, code: "VSOL_EXECUTABLE_QUOTE_RATE_LIMITED" },
        429,
        { "Retry-After": String(rateLimit.retryAfterSeconds) },
      );
    }
  }

  try {
    // Gated on whether this market can actually be SETTLED, not on whether its
    // price was pushed recently. Prices are now published only at expiry, by
    // the oracle runner, for markets with open interest -- so a symbol's feed
    // is normally minutes or hours old and "fresh within 150s" would block
    // nearly every quote. What a sale genuinely depends on is (a) the runner
    // being alive to publish+capture at expiry (its heartbeat) and (b) this
    // symbol's feed account being structurally able to accept that capture.
    // Fills never read the feed (CUSTOM_ORACLE_MAX_STALENESS_SECONDS is only
    // enforced by update_custom_price_feed), so neither check is about price.
    const readiness = await getVsolExecutionReadiness([market.symbol]);
    if (!readiness.ok) {
      return json({
        error: `${market.symbol} quoting is paused because its settlement oracle cannot currently settle new positions. ${readiness.reason ?? "Oracle state is unavailable."}`,
        code: "VSOL_CUSTOM_ORACLE_NOT_READY",
        oracle: { symbol: market.symbol, ready: false, reason: readiness.reason },
      }, 503);
    }
  } catch (error) {
    return json({
      error: describeRpcFailure(error, `${market.symbol} settlement oracle readiness could not be verified.`),
      code: "VSOL_CUSTOM_ORACLE_UNVERIFIED",
    }, 503);
  }

  // requestedAt was captured earlier (before the execute-only rate-limit
  // check above) so both share one timestamp.
  const expiry = resolveExpiry(expiryCode, symbol, requestedAt);
  if (!expiry.available) return json({ error: expiry.availabilityReason }, 422);
  const resolution = await resolveOrPlanVsolSeries(symbol, expiryCode, requestedAt);
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
  // The tier ladder is per-tenor (see payoffTiersFor): short-dated series
  // sell a near-binary 1.5x/2x/3x menu, longer ones the original 2x/5x/10x.
  // Only reachable here (not in the coarse check above) because it depends
  // on the ACTUAL resolved onchain duration, not the requested expiry code.
  const validPayoffTiers = payoffTiersFor(durationMinutes);
  if (!validPayoffTiers.includes(payoff)) {
    return json({ error: `Target payoff must be ${validPayoffTiers.map((tier) => `${tier}×`).join(", ")} for this expiry.` }, 422);
  }
  let snapshot;
  let volatility;
  try {
    [snapshot, volatility] = await Promise.all([
      getMarketSnapshot(market),
      getMarketRealizedVolatility(market),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Market pricing data is unavailable";
    return json({ error: `Pricing requires a fresh spot reference and historical observations: ${reason}` }, 503);
  }
  // In stake mode the payout that costs exactly `stake` is derived from one
  // reference quote -- premium is exactly linear in payout, see
  // payoutForStake -- and then re-priced below so the buyer signs the quote
  // they were shown.
  //
  // volatility and makerEdgeBps go through the market's own pricingOverrides
  // (app/lib/markets.ts) -- a no-op clamp/pass-through for every market today
  // (see tests/market-pricing-overrides.test.mjs), infrastructure for a
  // pricing decision made later, per market, with real data behind it.
  const pricingInputs = {
    spot: snapshot.price,
    durationMinutes,
    direction,
    payoff,
    volatility: clampVolatilityForMarket(market, volatility.value),
    referenceAgeSeconds: snapshot.ageSeconds,
    makerEdgeBps: market.pricingOverrides?.makerEdgeBps,
  };
  const notional = stakeMode
    ? payoutForStake({
        stake,
        referenceNotional: STAKE_REFERENCE_NOTIONAL,
        referencePremium: quoteFor({ ...pricingInputs, amount: STAKE_REFERENCE_NOTIONAL }).premium,
      })
    : amount;
  const economics = quoteFor({ ...pricingInputs, amount: notional });

  // Pool-depth pre-check (Split's "max stake = free pool / payout multiple",
  // checked before quoting): mirrors fill_pool_quote's on-chain
  // utilization/position/liquidity gate EXACTLY (checkVsolPoolDepth, using
  // calculate_bps_limit's own formula -- see vsol/programs/vsol/src/lib.rs
  // and math.rs), so a quote rejected here would always revert on chain, and
  // a quote accepted here can never revert on chain for exceeding pool
  // depth. Runs BEFORE buildVsolQuoteTransaction, which would otherwise call
  // listVsolSeriesOnChain (a real listing transaction for an unlisted rung)
  // and build/sign a doomed fill for nothing. One read-only account fetch,
  // reused below via poolCore instead of fetched twice.
  let poolCore;
  try {
    poolCore = await getPoolCore();
  } catch (error) {
    return json({ error: describeRpcFailure(error, "The VSOL V2 pool state could not be verified.") }, 503);
  }
  const depthCheck = checkVsolPoolDepth(
    {
      poolAssetsAtoms: poolCore.poolAssets,
      lockedCollateralAtoms: poolCore.pool.lockedCollateral,
      maxUtilizationBps: poolCore.pool.maxUtilizationBps,
      maxPositionBps: poolCore.pool.maxPositionBps,
    },
    toPoolAtoms(economics.maxPayout),
  );
  if (!depthCheck.ok) {
    const maxFittingPayout = fromPoolAtoms(depthCheck.maxFittingPayoutAtoms);
    // premium is exactly linear in maxPayout for a fixed tier/spot/vol (see
    // payoutForStake's own comment), so the same ratio converts "largest
    // payout that fits" into "largest stake that fits" without re-quoting.
    const premiumFraction = economics.premium / economics.maxPayout;
    const maxFittingStake = Math.max(0, Math.floor(maxFittingPayout * premiumFraction * 100) / 100);
    return json({
      error: maxFittingPayout > 0
        ? `${depthCheck.message} The pool can currently underwrite at most $${maxFittingPayout.toFixed(2)} of payout at this tier (about $${maxFittingStake.toFixed(2)} in stake) -- take a smaller size, or a lower payoff multiple.`
        : `${depthCheck.message} The pool cannot underwrite any payout at this tier right now.`,
      code: "VSOL_POOL_DEPTH_EXCEEDED",
      maxStake: maxFittingStake,
      maxPayout: maxFittingPayout,
    }, 422);
  }

  // Read live off the Config account fetched above for the depth check
  // (poolCore), rather than trusting PROTOCOL_WIN_FEE_BPS
  // (app/lib/options.ts) -- a hand-maintained mirror of this same value that
  // can only ever be updated after the fact. Returned in BOTH intents' response
  // so the UI can show the real fee before a trade is ever signed.
  const protocolFeeBps = poolCore.config.feeBps;

  // Fields both intents report identically, computed once so indicative and
  // execute can never disagree about market/expiry state -- only about
  // whether a real transaction backs the numbers.
  const responseEnvelope = {
    symbol,
    tokenAddress: market.tokenAddress,
    oracleStatus: market.oracleStatus,
    referencePrice: snapshot.price,
    referenceConfidence: snapshot.confidence,
    referencePublishTime: snapshot.publishTime,
    referenceAgeSeconds: snapshot.ageSeconds,
    pricingMode: snapshot.mode,
    referenceSource: snapshot.source === "Hyperliquid"
      ? "Hyperliquid xyz mark · timestamp records Tend's HTTP fetch"
      : `${snapshot.source} · signed into Tend's custom oracle feed`,
    settlement: "European cash-settled · centrally signed custom oracle with an immutable expiry observation",
    expiry: {
      code: expiry.code,
      label: expiry.label,
      optionExpiryAt: onchainExpiryAt,
      observationWindowSeconds: seriesState.observationWindowSeconds,
      tradeLockSeconds: Math.max(0, seriesState.expiry - seriesState.lastTradeAt),
    },
    protocolFeeBps,
  };

  if (intent === "indicative") {
    // NEVER resolves-and-lists a series onchain, never asks the pool
    // authority to sign anything, and never writes an `rfq_quotes` row -- see
    // the intent doc comment at the top of this file. `id` has no database
    // row behind it (there is nothing to look up), and `executable: false` is
    // the flag app/components/TendTerminal.tsx's signing path checks before
    // it will ever hand a quote to the wallet -- this response must never
    // reach that path.
    return json({
      ...responseEnvelope,
      intent,
      requestId: crypto.randomUUID(),
      quotes: [{
        id: crypto.randomUUID(),
        maker: "VSOL V2 Pool",
        premium: Number(economics.premium.toFixed(2)),
        maxPayout: Number(economics.maxPayout.toFixed(2)),
        strike: Number(economics.strike.toFixed(2)),
        cap: Number(economics.cap.toFixed(2)),
        breakeven: Number(economics.breakeven.toFixed(2)),
        pricingVolatility: volatility.value,
        volatilitySource: volatility.source,
        effectiveLeverage: Number((economics.maxPayout / economics.premium).toFixed(2)),
        latencyMs: Date.now() - requestedAt,
        badge: "Pool escrow",
        // Indicative prices carry no real signing window (nothing is signed
        // yet), but the client's auto-refresh cadence keys off this field
        // regardless of intent -- see the quoteState countdown effect in
        // TendTerminal.tsx -- so it still gets a short, honest TTL.
        expiresAt: requestedAt + 30_000,
        probabilityItm: economics.probabilityItm,
        impliedVolatility: economics.impliedVolatility,
        executable: false,
      }],
    });
  }

  // From here on: EXECUTE ONLY. The DB-backed per-wallet rate limit already
  // ran, before any of the chain reads above, so reaching this point means
  // this wallet is still within its cap.
  // Embeds `userKey` (never the unauthenticated `walletAddress` request
  // field) so the rate-limit check above can find this wallet's own rows on
  // its next request -- see app/lib/rate-limit.ts.
  const requestId = buildRfqRequestId(userKey);
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
      poolCore,
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
    amount: notional,
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
    // A real, server-signed transaction backs this quote (see `vsol` below)
    // -- this is the flag app/components/TendTerminal.tsx's signing path
    // requires before it will hand a quote to the wallet.
    executable: true,
  }));

  return json({
    ...responseEnvelope,
    intent,
    requestId,
    quotes,
    vsol: {
      ...vsol,
      explorerUrl: solanaExplorerUrl("address", vsol.positionAddress),
    },
  });
}
