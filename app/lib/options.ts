export type Direction = "up" | "down";

// Real options pricing, ported from the verified engine in
// tend-monad/quote-service/pricing.ts (reviewed against an independent
// implementation and live market data). The old `quoteFor` computed
// `expectedMove` and a `riskFactor` but never actually valued the
// (strike, cap) spread it quoted -- premium was `(amount / payoff) *
// riskFactor`, a number that moved ~1.07x across the entire realistic vol
// range while the spread's true Black-Scholes fair value moved ~55x over
// the same range. This engine prices the spread for real: Black-Scholes
// call/put (r=0) valued at the actual strike/width/vol/time, with a strike
// solver that finds the strike whose OWN fair value (maker edge included)
// matches the requested payoff tier.
//
// Every function below is pure and synchronous, so it is unit-tested with
// zero network access (see tests/pricing.test.mjs).

// ---------------------------------------------------------------------------
// erf / normal CDF — Abramowitz & Stegun 7.1.26 (max absolute error ~1.5e-7).
// No dependency: this is the one piece of math Black-Scholes needs that
// JavaScript doesn't ship, so it's implemented inline rather than pulling in
// a stats library for one function.
// ---------------------------------------------------------------------------
const ERF_P = 0.3275911;
const ERF_A1 = 0.254829592;
const ERF_A2 = -0.284496736;
const ERF_A3 = 1.421413741;
const ERF_A4 = -1.453152027;
const ERF_A5 = 1.061405429;

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + ERF_P * ax);
  const poly = ((((ERF_A5 * t + ERF_A4) * t + ERF_A3) * t + ERF_A2) * t + ERF_A1) * t;
  const y = 1 - poly * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF, N(x), built on `erf` above. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// Black-Scholes, r = 0.
//
// Ported unchanged from the Monad engine's reasoning, re-justified for
// Tend's wider duration range (15 minutes to 30 days here, vs. Monad's
// sub-24h series): at 30 days, a ~4-5% annualized risk-free rate contributes
// roughly 0.3-0.4% of drift -- still a fraction of the underlying's vol
// (typically 20-100%+, and this engine prices up to 400% pre-gap-risk) but
// no longer microscopic the way it was at Monad's few-hour horizon. r=0
// remains deliberate rather than an oversight: it's the conservative,
// direction-neutral choice (no assumed drift inflating UP or deflating
// DOWN), and dated/long-tenor series should revisit this if Tend ever prices
// materially longer than 30 days.
// ---------------------------------------------------------------------------
export interface BsParams {
  /** Human USD spot price. */
  spot: number;
  /** Human USD strike price. */
  strike: number;
  /** Annualized volatility, e.g. 0.32 for 32%. */
  volAnnual: number;
  /** Time to expiry in years. */
  timeYears: number;
}

function bsD1D2(p: BsParams): { d1: number; d2: number } {
  const sqrtT = Math.sqrt(p.timeYears);
  const sigmaSqrtT = p.volAnnual * sqrtT;
  const d1 = (Math.log(p.spot / p.strike) + 0.5 * p.volAnnual * p.volAnnual * p.timeYears) / sigmaSqrtT;
  return { d1, d2: d1 - sigmaSqrtT };
}

/** Black-Scholes call price, r=0. Degenerates to intrinsic value when time or vol is non-positive. */
export function blackScholesCall(p: BsParams): number {
  if (p.timeYears <= 0 || p.volAnnual <= 0) return Math.max(p.spot - p.strike, 0);
  const { d1, d2 } = bsD1D2(p);
  return p.spot * normalCdf(d1) - p.strike * normalCdf(d2);
}

/** Black-Scholes put price, r=0. Degenerates to intrinsic value when time or vol is non-positive. */
export function blackScholesPut(p: BsParams): number {
  if (p.timeYears <= 0 || p.volAnnual <= 0) return Math.max(p.strike - p.spot, 0);
  const { d1, d2 } = bsD1D2(p);
  return p.strike * normalCdf(-d2) - p.spot * normalCdf(-d1);
}

// ---------------------------------------------------------------------------
// The instrument: a call/put SPREAD, not a vanilla option -- this is the
// piece the audit confirmed transfers directly from the EVM contract:
// `definedRiskPayout` below (unchanged) has the identical capped-spread
// shape as TendPoolVault.calculatePayout on Monad:
//   delta  = direction == Up ? max(S-K,0) : max(K-S,0); delta = min(delta, width)
//   payout = maxPayout * delta / width
// i.e. (maxPayout/width) units of a spread struck at K, capped at K±width:
//   UP  : (maxPayout/width) * [ C(K) − C(K+width) ]
//   DOWN: (maxPayout/width) * [ P(K) − P(K−width) ]
// ---------------------------------------------------------------------------
export interface SpreadParams {
  direction: Direction;
  spot: number;
  strike: number;
  width: number;
  volAnnual: number;
  timeYears: number;
}

/**
 * Present value of ONE unit of the spread — the terminal payoff
 * min(max(delta, 0), width), NOT yet scaled by maxPayout/width. Bounded to
 * [0, width] in exact arithmetic (a vanilla call/put is at most 1-Lipschitz
 * in strike); the outer `Math.max(0, ...)` only guards the floating-point
 * edge (this engine spans a much wider width/vol/duration range than
 * Monad's, so it's a defensive addition on top of the ported math, not part
 * of the original proof).
 */
export function spreadUnitValue(p: SpreadParams): number {
  if (p.direction === "up") {
    return Math.max(
      0,
      blackScholesCall({ spot: p.spot, strike: p.strike, volAnnual: p.volAnnual, timeYears: p.timeYears }) -
        blackScholesCall({ spot: p.spot, strike: p.strike + p.width, volAnnual: p.volAnnual, timeYears: p.timeYears }),
    );
  }
  return Math.max(
    0,
    blackScholesPut({ spot: p.spot, strike: p.strike, volAnnual: p.volAnnual, timeYears: p.timeYears }) -
      blackScholesPut({ spot: p.spot, strike: p.strike - p.width, volAnnual: p.volAnnual, timeYears: p.timeYears }),
  );
}

/** Scales a per-unit spread value up to the position's maxPayout — in [0, maxPayout] since spreadUnitValue is in [0, width]. */
export function spreadFairValue(maxPayout: number, width: number, unitValue: number): number {
  if (width <= 0) return 0;
  return maxPayout * (unitValue / width);
}

// ---------------------------------------------------------------------------
// Maker edge — the pool's compensation for selling the risk, applied on top
// of fair value. A named constant (not folded into fair value silently), so
// `probabilityItm`/fair value stay inspectable rather than the markup being
// baked invisibly into `premium`. Ported directly from the Monad engine
// (15%, tuned there against live market data); revisit independently if
// Tend's risk/liquidity profile ever needs a different edge.
//
// CRITICAL: this must be applied INSIDE the strike solve (see
// `solveStrikeForTargetPremium` below), not added to a fair value solved
// without it. Solving on fair value and adding the edge afterward means an
// advertised "10×" quotes a strike that's fairly priced at 10x but is then
// SOLD at a higher premium -- so it actually delivers less than 10x payout
// per dollar paid. Solving so the EDGE-INCLUSIVE premium hits the target
// means the edge shows up as a slightly worse strike, and the advertised
// multiple is the one actually delivered.
// ---------------------------------------------------------------------------
export const MAKER_EDGE_BPS = 1_500; // 15% over fair value.

export function applyMakerEdge(fair: number, edgeBps: number = MAKER_EDGE_BPS): number {
  return fair * (1 + edgeBps / 10_000);
}

// ---------------------------------------------------------------------------
// Probability of finishing in the money — the honest counterweight to a big
// leverage number. N(d2) is exactly the risk-neutral P(S_T > K) for a call
// (P(S_T < K) = N(-d2) for a put), which is r=0 here since the whole engine
// prices with r=0 throughout.
// ---------------------------------------------------------------------------
export function probabilityItm(direction: Direction, spot: number, strike: number, volAnnual: number, timeYears: number): number {
  if (timeYears <= 0 || volAnnual <= 0) {
    const itm = direction === "up" ? spot > strike : spot < strike;
    return itm ? 1 : 0;
  }
  const { d2 } = bsD1D2({ spot, strike, volAnnual, timeYears });
  return direction === "up" ? normalCdf(d2) : normalCdf(-d2);
}

// ---------------------------------------------------------------------------
// Width — the strike-to-cap distance that `definedRiskPayout` ramps the
// payout over. This is a Solana-specific decision, not a straight port:
// Monad's engine fixes width at a flat 0.5% of spot because it only prices
// short (sub-24h), symmetric-tenor series where the settlement window and
// the quote's own duration are close in scale. Tend prices 15 minutes to
// 30 days on the SAME feed, so a duration-blind flat width is wrong at
// either end (too wide for a 15-minute quote, too narrow to matter for a
// 30-day one) -- hence the old `expectedMove`-scaled formula's shape is
// kept, but its floor is rebuilt from a different, and correct, anchor.
//
// THE FLOOR: this is the parameter the audit identified as broken --
// `max(0.03, expectedMove * 1.25)` bound the ramp width below at 3% of spot
// for every realistically short-dated, real-vol quote, so the true
// Black-Scholes fair value of a spread that wide (given the underlying
// barely moves 0.3-1% in an hour) collapsed toward zero while the old
// pricing formula charged a near-fixed premium regardless.
//
// The floor cannot simply be deleted, though: `width` is also the
// denominator of the settlement's cherry-pick exposure. `publish_pyth_settlement`
// (vsol/programs/vsol/src/lib.rs) accepts ANY Pyth print inside
// [expiry, expiry + observation_window_seconds] (60s for 15M/1H/EOD, 900s
// for 7D/30D, see app/lib/expiries.ts) -- so whoever calls settle can pick
// the most favorable print Pyth happened to publish in that window. The
// fraction of maxPayout that ordinary (non-adversarial) price noise inside
// the observation window can capture is bounded by (price range achievable
// in that window) / width -- so a width that's too small relative to
// realistic in-window dispersion lets settlement-time noise alone approach
// full payout, independent of the true price move over the full quote
// duration. Zeroing the floor would make every short-dated, low-vol quote
// (exactly the regime this audit is fixing) also the most exposed to that.
//
// The new floor is sized against THAT risk specifically, not against the
// quote's own duration: 0.6% of spot is ~2.2x the expected (1-sigma) price
// move over the SHORTEST observation window this product has (60 seconds)
// at 200% annualized vol -- already far above any realistic realized vol
// (usually 20-80%) and with headroom under the accepted [1%, 400%] input
// range before the gap-risk multiplier. That leaves a defensible margin
// against benign in-window dispersion capturing the ramp, while being ~5x
// smaller than the old 3% floor -- small enough that it stops dominating
// real Black-Scholes pricing once vol/duration exceed roughly the 25-50%
// annualized range (vs. never, before). Tradeoff, stated plainly: at
// genuinely extreme effective vol (approaching the 400% cap after the
// gap-risk multiplier) a single observation-window print could still move
// close to a full width; that residual is accepted the same way the
// gap-risk multiplier itself already accepts wider quotes rather than
// refusing to quote, consistent with Tend never gating on conditions short
// of a hard data failure.
// ---------------------------------------------------------------------------
export const WIDTH_MIN_FRACTION = 0.006; // 0.6% of spot -- see rationale above.
export const WIDTH_MAX_FRACTION = 0.4; // Unchanged from the prior engine; not implicated in the audit.
export const WIDTH_EXPECTED_MOVE_MULTIPLIER = 1.25; // Unchanged from the prior engine.

// ---------------------------------------------------------------------------
// Strike solver — finds the strike offset (as a fraction of spot, 0 to
// MAX_STRIKE_OFFSET_FRACTION; UP moves the strike up, DOWN moves it down)
// whose priced spread — fair value plus maker edge, computed together, see
// the maker-edge comment above — matches `targetPremium` (= maxPayout /
// payoff) within tolerance. Premium is monotonically non-increasing in
// offset (pushing the strike further out-of-the-money can only lower a
// spread's value), so this bisects rather than inverting Black-Scholes
// closed-form, which has no clean inverse in strike.
//
// MAX_STRIKE_OFFSET_FRACTION is a generous sanity bound (40% of spot,
// matching WIDTH_MAX_FRACTION), not a normal operating value: real quotes
// (see tests/pricing.test.mjs) solve to offsets of a few percent at most.
// It exists so the search terminates, and is wide enough to price 2×/5×/10×
// without ever failing to converge across the full documented vol range
// (1%-400% pre-gap-risk, up to 700% after) -- verified by the extreme-
// volatility regression in tests/product.test.mjs.
//
// UNLIKE the Monad engine, this NEVER throws when a target is unreachable.
// Monad's `UnreachableLeverageError` is the right call for a service that
// can 502 a single RFQ; Tend is a 24/7 protocol that must always return a
// bounded quote (see the "Tend is 24/7" rule this repo already enforces for
// session/market-hours gating -- the same principle applies to refusing a
// quote over a pricing corner case). So instead this clamps gracefully to
// whichever boundary is closest to the target:
//   - target >= the at-the-money premium: the requested payoff tier is too
//     rich for the current vol/width even at the money (moving further
//     out-of-the-money only lowers value further). Clamps to the
//     at-the-money strike -- the richest honestly priceable premium -- and
//     reports the ACTUAL achieved leverage (callers already compute
//     maxPayout/premium independently rather than assuming it equals the
//     requested tier).
//   - target <= the max-offset premium: the tier is too aggressive (too
//     cheap) to reach even at the widest allowed offset. Clamps there.
// Both cases are reported via `reachability` so callers/tests can
// distinguish a solved quote from a clamped one.
// ---------------------------------------------------------------------------
export const MAX_STRIKE_OFFSET_FRACTION = 0.4;
const SOLVER_TOLERANCE_RELATIVE = 1e-7;
const SOLVER_MAX_ITERATIONS = 200;

export interface StrikeSolveParams {
  direction: Direction;
  spot: number;
  width: number;
  maxPayout: number;
  /** = maxPayout / payoff, the premium this strike must fairly price to (edge included). */
  targetPremium: number;
  volAnnual: number;
  timeYears: number;
  makerEdgeBps?: number;
}

export interface StrikeSolveResult {
  strike: number;
  strikeOffsetFraction: number;
  /** Pre-edge Black-Scholes fair value of the spread at the solved strike. */
  fairValue: number;
  /** Fair value with the maker edge applied — the premium actually charged. */
  premium: number;
  probabilityItm: number;
  /** "solved" if the bisection converged to targetPremium within tolerance; otherwise which boundary it clamped to. See the module comment above. */
  reachability: "solved" | "clamped-at-the-money" | "clamped-max-offset";
}

function priceAtStrikeOffset(p: StrikeSolveParams, offsetFraction: number): { strike: number; fair: number; premium: number } {
  const offset = p.spot * offsetFraction;
  const strike = p.direction === "up" ? p.spot + offset : p.spot - offset;
  const unitValue = spreadUnitValue({ direction: p.direction, spot: p.spot, strike, width: p.width, volAnnual: p.volAnnual, timeYears: p.timeYears });
  const fair = spreadFairValue(p.maxPayout, p.width, unitValue);
  const premium = applyMakerEdge(fair, p.makerEdgeBps);
  return { strike, fair, premium };
}

export function solveStrikeForTargetPremium(p: StrikeSolveParams): StrikeSolveResult {
  const atMoney = priceAtStrikeOffset(p, 0);
  if (p.targetPremium >= atMoney.premium) {
    return {
      strike: atMoney.strike,
      strikeOffsetFraction: 0,
      fairValue: atMoney.fair,
      premium: atMoney.premium,
      probabilityItm: probabilityItm(p.direction, p.spot, atMoney.strike, p.volAnnual, p.timeYears),
      reachability: p.targetPremium > atMoney.premium ? "clamped-at-the-money" : "solved",
    };
  }

  const atMax = priceAtStrikeOffset(p, MAX_STRIKE_OFFSET_FRACTION);
  if (p.targetPremium <= atMax.premium) {
    return {
      strike: atMax.strike,
      strikeOffsetFraction: MAX_STRIKE_OFFSET_FRACTION,
      fairValue: atMax.fair,
      premium: atMax.premium,
      probabilityItm: probabilityItm(p.direction, p.spot, atMax.strike, p.volAnnual, p.timeYears),
      reachability: p.targetPremium < atMax.premium ? "clamped-max-offset" : "solved",
    };
  }

  let lo = 0;
  let hi = MAX_STRIKE_OFFSET_FRACTION;
  let best = atMoney;
  let bestOffset = 0;
  for (let i = 0; i < SOLVER_MAX_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;
    const at = priceAtStrikeOffset(p, mid);
    best = at;
    bestOffset = mid;
    if (Math.abs(at.premium - p.targetPremium) <= SOLVER_TOLERANCE_RELATIVE * Math.max(p.targetPremium, 1e-9)) break;
    if (at.premium > p.targetPremium) lo = mid;
    else hi = mid; // premium is non-increasing in offset
  }

  return {
    strike: best.strike,
    strikeOffsetFraction: bestOffset,
    fairValue: best.fair,
    premium: best.premium,
    probabilityItm: probabilityItm(p.direction, p.spot, best.strike, p.volAnnual, p.timeYears),
    reachability: "solved",
  };
}

// A Pyth feed can stop printing fresh updates (a session-bound equity feed
// off-hours, or any feed during an outage), so the reference price can go
// stale. Tend never closes for that — instead the
// gap-risk (the price could jump before the feed resumes) gets priced into
// the premium via a bounded, monotonic vol bump. Every extra hour of
// unobserved time scales the effective volatility up by sqrt(elapsed time),
// capped so it can never push the premium past the existing 0.95×amount
// ceiling.
const GAP_RISK_VOL_SCALE_PER_HOUR = 0.35;
const GAP_RISK_MAX_VOL_MULTIPLIER = 1.75;

export function quoteFor(params: {
  spot: number;
  amount: number;
  durationMinutes: number;
  direction: Direction;
  payoff: number;
  volatility: number;
  referenceAgeSeconds?: number;
}) {
  const { spot, amount, direction, durationMinutes } = params;
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(amount) || amount <= 0) {
    throw new RangeError("Spot and amount must be positive finite values");
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1) throw new RangeError("Duration must be positive");
  if (![2, 5, 10].includes(params.payoff)) throw new RangeError("Payoff must be 2×, 5×, or 10×");
  if (!Number.isFinite(params.volatility) || params.volatility < 1 || params.volatility > 400) {
    throw new RangeError("Volatility is outside maker risk bounds");
  }
  const referenceAgeSeconds = params.referenceAgeSeconds ?? 0;
  if (!Number.isFinite(referenceAgeSeconds) || referenceAgeSeconds < 0) {
    throw new RangeError("Reference age must be a non-negative finite value");
  }
  const payoff = params.payoff;
  const gapRiskHours = referenceAgeSeconds / 3_600;
  const gapRiskMultiplier = Math.min(GAP_RISK_MAX_VOL_MULTIPLIER, 1 + GAP_RISK_VOL_SCALE_PER_HOUR * Math.sqrt(gapRiskHours));
  // Annualized vol as a fraction (e.g. 0.32), gap-risk bumped -- this is the
  // ACTUAL volatility Black-Scholes prices with, so it (not the raw input)
  // is what gets surfaced to callers as `impliedVolatility`.
  const volAnnual = (params.volatility / 100) * gapRiskMultiplier;
  const timeYears = Math.max(durationMinutes, 15) / 525_600;
  const expectedMove = volAnnual * Math.sqrt(timeYears);

  // NOTE: unlike the old engine, `expectedMove` here feeds ONLY the width
  // (the payout ramp's shape) -- never the premium directly. Premium is
  // whatever `solveStrikeForTargetPremium` finds actually fairly prices the
  // requested payoff tier at this width/vol/time. See the width comment
  // block above for the floor's derivation and tradeoff.
  const moveScale = Math.min(WIDTH_MAX_FRACTION, Math.max(WIDTH_MIN_FRACTION, expectedMove * WIDTH_EXPECTED_MOVE_MULTIPLIER));
  const width = spot * moveScale;

  const maxPayout = amount;
  const targetPremium = maxPayout / payoff;

  // No hand-tuned direction skew here (the old engine charged "down" 6% more
  // than "up" via a flat `directionFactor`, undocumented as to why). Any
  // real up/down asymmetry is now priced by the math itself: calls and puts
  // are NOT symmetric under lognormal returns even at r=0, and
  // `solveStrikeForTargetPremium` prices each side with its own
  // Black-Scholes formula rather than a shared fudge factor.
  const solved = solveStrikeForTargetPremium({ direction, spot, width, maxPayout, targetPremium, volAnnual, timeYears });

  const premium = Math.min(maxPayout * 0.95, Math.max(1, solved.premium));
  const strike = solved.strike;
  const leverage = maxPayout / premium;
  const cap = direction === "up" ? strike + width : strike - width;
  const breakeven = direction === "up"
    ? strike + (premium / maxPayout) * width
    : strike - (premium / maxPayout) * width;

  return {
    premium,
    maxPayout,
    leverage,
    strike,
    cap,
    breakeven,
    /** P(finishing in the money) at expiry, at the solved strike -- the honest counterweight to `leverage`. */
    probabilityItm: solved.probabilityItm,
    /** The gap-risk-adjusted annualized vol actually used to price this quote, as a percentage (e.g. 32.3 for 32.3%). */
    impliedVolatility: volAnnual * 100,
    /** Whether the payoff tier was fairly reachable at this vol/width, or gracefully clamped -- see solveStrikeForTargetPremium. */
    reachability: solved.reachability,
  };
}

export function definedRiskPayout(params: {
  direction: Direction;
  settlement: number;
  strike: number;
  cap: number;
  maxPayout: number;
}) {
  const { direction, settlement, strike, cap, maxPayout } = params;
  if (direction === "up") {
    if (settlement <= strike) return 0;
    return maxPayout * (Math.min(settlement, cap) - strike) / (cap - strike);
  }
  if (settlement >= strike) return 0;
  return maxPayout * (strike - Math.max(settlement, cap)) / (strike - cap);
}

// The pool must always buy back below fair value. Without a spread, a trader
// could fill a quote and immediately close it for the mid price, round-tripping
// the pool for free and bleeding LPs on every cycle. Real options venues don't
// hold that spread flat: it's tight for liquid near-the-money, short-dated
// positions and widens for far out-of-the-money or long-dated ones, because
// the writer's hedging/inventory risk scales with both. `dynamicSpreadBps`
// below composes three bounded, multiplicative factors on top of this floor:
//   spreadBps = BASE * moneynessFactor * timeFactor * gapRiskMultiplier
// each factor is >= 1, so the composed spread is never below BASE and the
// result is hard-capped at BUYBACK_MAX_SPREAD_BPS. Because every factor is
// bounded below by 1, `dynamicSpreadBps(...) >= BUYBACK_BASE_SPREAD_BPS`
// always -- which is what keeps the fill-then-immediately-close round trip
// unprofitable for every input (see the sweep in
// tests/close-position.test.mjs): that invariant only ever needed the spread
// to be at least the old flat 250 bps, never exactly it.
export const BUYBACK_BASE_SPREAD_BPS = 250;

// Hard ceiling: however far out-of-the-money, long-dated, or stale the
// inputs are, the pool never discounts a buyback by more than this.
export const BUYBACK_MAX_SPREAD_BPS = 1_500;

// Moneyness: widths (strike -> cap distance) past the strike, on the losing
// side, before the moneyness multiplier saturates at its max.
export const BUYBACK_MONEYNESS_OTM_WIDTHS = 1;
// At full saturation (a full width out-of-the-money) the spread is this many
// times the base -- before the time and gap-risk factors are applied.
export const BUYBACK_MONEYNESS_MAX_MULTIPLIER = 3;

// Time to expiry: at full time remaining the spread is this many times the
// base (before moneyness/gap-risk); it relaxes linearly toward 1x (no
// widening) as minutesRemaining/originalMinutes -> 0.
export const BUYBACK_TIME_MAX_MULTIPLIER = 2;

/** @deprecated Kept for backward compatibility -- equals `BUYBACK_BASE_SPREAD_BPS`,
 * the tightest (near-the-money, short-dated, fresh-reference) floor of the
 * dynamic spread. Spread is no longer flat; see `dynamicSpreadBps`. */
export const BUYBACK_SPREAD_BPS = BUYBACK_BASE_SPREAD_BPS;

/**
 * The closing spread (in bps) the pool applies to an early-close fair value,
 * as a base floor scaled by three bounded, multiplicative factors:
 *
 * - moneyness: how far spot sits from strike relative to the option's width
 *   (strike -> cap distance). At or past the strike (spot already on the
 *   favorable side) the factor is 1 (tightest); it scales up to
 *   `BUYBACK_MONEYNESS_MAX_MULTIPLIER` as spot moves up to
 *   `BUYBACK_MONEYNESS_OTM_WIDTHS` widths past the strike on the losing
 *   side, and saturates there.
 * - time to expiry: `fraction = minutesRemaining / originalMinutes`. More
 *   time remaining means more can happen before the pool can unwind its
 *   hedge, so the factor scales from 1 (at expiry) up to
 *   `BUYBACK_TIME_MAX_MULTIPLIER` (at full time remaining).
 * - gap risk: identical widening to `quoteFor`'s entry pricing -- a stale
 *   reference is riskier to close against.
 *
 * Every factor is bounded below by 1, so the result is always
 * >= `BUYBACK_BASE_SPREAD_BPS`, and it is hard-capped at
 * `BUYBACK_MAX_SPREAD_BPS`.
 */
export function dynamicSpreadBps(params: {
  direction: Direction;
  spot: number;
  strike: number;
  cap: number;
  fraction: number;
  referenceAgeSeconds?: number;
}): number {
  const { direction, spot, strike, cap } = params;
  const fraction = Math.max(0, Math.min(1, params.fraction));
  const referenceAgeSeconds = params.referenceAgeSeconds ?? 0;

  const width = Math.abs(cap - strike);
  const signedMoneyness = direction === "up" ? (spot - strike) / width : (strike - spot) / width;
  const otmWidths = Math.max(0, Math.min(BUYBACK_MONEYNESS_OTM_WIDTHS, -signedMoneyness)) / BUYBACK_MONEYNESS_OTM_WIDTHS;
  const moneynessFactor = 1 + (BUYBACK_MONEYNESS_MAX_MULTIPLIER - 1) * otmWidths;

  const timeFactor = 1 + (BUYBACK_TIME_MAX_MULTIPLIER - 1) * fraction;

  const gapRiskHours = referenceAgeSeconds / 3_600;
  const gapRiskMultiplier = Math.min(GAP_RISK_MAX_VOL_MULTIPLIER, 1 + GAP_RISK_VOL_SCALE_PER_HOUR * Math.sqrt(gapRiskHours));

  const raw = BUYBACK_BASE_SPREAD_BPS * moneynessFactor * timeFactor * gapRiskMultiplier;
  return Math.min(BUYBACK_MAX_SPREAD_BPS, raw);
}

/**
 * Prices an early close (buyer sells an open pool position back to the pool
 * before expiry). Fair value is intrinsic (the same `definedRiskPayout` used
 * at settlement) plus a time-value term anchored to the premium actually
 * paid, decaying to zero as the position approaches expiry. The pool's
 * actual buyback is fair value minus a spread, so filling and immediately
 * closing a position can never be free for the trader.
 *
 * IMPORTANT: time value must NOT re-derive a volatility multiplier here.
 * `quoteFor` already prices volatility into `premium` via its own
 * `riskFactor` (`min(1.5, max(0.65, 0.8 + expectedMove * 1.2))`). An earlier
 * version of this function multiplied `premium` by an equivalent `volScale`
 * a second time, so at inception (decay = 1, intrinsic = 0) fair value came
 * out to `premium * riskFactor` -- which exceeds `premium` whenever
 * `riskFactor > 1` (high vol and/or long tenor) -- making buyback exceed the
 * premium paid and letting a trader fill-then-close for free, repeatedly,
 * draining the pool. Anchoring time value to `premium * decay` alone means
 * fair value at inception is exactly `premium`, so a same-instant round
 * trip always costs the spread, for every volatility and tenor. Genuine
 * price moves still flow through `intrinsic`, which is real P/L, not
 * arbitrage. See the round-trip-never-profitable sweep in
 * tests/close-position.test.mjs.
 */
export function buybackFor(params: {
  direction: Direction;
  spot: number;
  strike: number;
  cap: number;
  maxPayout: number;
  premium: number;
  minutesRemaining: number;
  originalMinutes: number;
  referenceAgeSeconds?: number;
}) {
  const { direction, spot, strike, cap, maxPayout, premium, minutesRemaining, originalMinutes } = params;
  if (direction !== "up" && direction !== "down") throw new RangeError("Direction must be up or down");
  if (!Number.isFinite(spot) || spot <= 0) throw new RangeError("Spot must be a positive finite value");
  if (!Number.isFinite(strike) || strike <= 0) throw new RangeError("Strike must be a positive finite value");
  if (!Number.isFinite(cap) || cap === strike) throw new RangeError("Cap must be a finite value distinct from strike");
  if (!Number.isFinite(maxPayout) || maxPayout <= 0) throw new RangeError("Max payout must be a positive finite value");
  if (!Number.isFinite(premium) || premium < 0) throw new RangeError("Premium must be a non-negative finite value");
  if (!Number.isFinite(minutesRemaining) || minutesRemaining < 0) {
    throw new RangeError("Minutes remaining must be a non-negative finite value");
  }
  if (!Number.isFinite(originalMinutes) || originalMinutes <= 0) {
    throw new RangeError("Original duration must be a positive finite value");
  }
  const referenceAgeSeconds = params.referenceAgeSeconds ?? 0;
  if (!Number.isFinite(referenceAgeSeconds) || referenceAgeSeconds < 0) {
    throw new RangeError("Reference age must be a non-negative finite value");
  }

  const intrinsic = definedRiskPayout({ direction, settlement: spot, strike, cap, maxPayout });

  // Time value decays to zero as minutesRemaining/originalMinutes -> 0 (sqrt
  // shape), anchored to the premium actually paid -- not re-derived from
  // volatility, which `premium` already prices in (see the doc comment above).
  const fraction = Math.max(0, Math.min(1, minutesRemaining / originalMinutes));
  const decay = Math.sqrt(fraction);
  const timeValue = Math.max(0, premium * decay);

  const fairValue = Math.min(maxPayout, intrinsic + timeValue);
  // Moneyness + time-to-expiry + gap-risk, composed multiplicatively and
  // bounded -- see `dynamicSpreadBps` above. This never re-touches the
  // fair-value math above; it only scales the discount applied to it.
  const spreadBps = dynamicSpreadBps({ direction, spot, strike, cap, fraction, referenceAgeSeconds });
  const buyback = Math.max(0, Math.min(maxPayout, fairValue * (1 - spreadBps / 10_000)));

  if (!Number.isFinite(fairValue) || !Number.isFinite(buyback) || !Number.isFinite(spreadBps)) {
    throw new RangeError("Buyback pricing produced a non-finite result");
  }
  return { fairValue, buyback, spreadBps };
}
