export type Direction = "up" | "down";

// Real options pricing, ported from the verified engine in
// tend-monad/quote-service/pricing.ts (reviewed against an independent
// implementation and live market data), then converted from a capped-spread
// ramp to a TRUE BINARY: every quote now prices a cash-or-nothing digital
// (`digitalFairValue`, `maxPayout * N(d2)`/`N(-d2)` at r=0) and signs the
// smallest legal on-chain width (`BINARY_WIDTH`, one atom), which turns the
// deployed program's UNCHANGED `calculate_payout` ramp formula into an exact
// step function -- hit the target and win the full payout, miss it and lose
// the entire premium. No program change; see BINARY_WIDTH's comment below.
// A strike solver finds the strike whose OWN fair value (maker edge
// included) matches the requested payoff tier, searching both in-the-money
// and out-of-the-money strikes since low tiers need P(win) > 0.5.
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
// The instrument: a cash-or-nothing DIGITAL (TRUE BINARY), not a spread.
//
// The deployed program never changed: `calculate_payout` on chain is still
// `maxPayout * min(delta, width) / width` (vsol/programs/vsol/src/math.rs),
// with `strike` and `width` stored per position and the only on-chain
// constraint `width > 0`. Setting `width` to the smallest legal value --
// `BINARY_WIDTH` below, one atom at the on-chain 1e6 price scale -- makes
// that identical formula an exact step function: 0 at or below strike,
// maxPayout starting one atom above (mirrored for DOWN). No program change
// needed; this is purely what the quote server now signs.
//
// So the instrument this file prices is a cash-or-nothing digital: pays
// maxPayout if the direction condition holds at settlement, 0 otherwise. At
// r=0 its fair value is exactly `maxPayout * N(d2)` (UP) / `maxPayout *
// N(-d2)` (DOWN) -- see `digitalFairValue` below. Do NOT price it as a
// spread with a tiny width: `blackScholesCall(K) - blackScholesCall(K+width)`
// subtracts two nearly-equal numbers at width = 1e-6 and loses essentially
// all floating-point precision. `digitalFairValue` prices N(d2) directly via
// `probabilityItm`, which needs no subtraction of close values at all.
// ---------------------------------------------------------------------------

/**
 * Fair value (r=0) of a cash-or-nothing digital paying `maxPayout` if the
 * settlement condition holds, 0 otherwise: `maxPayout * N(d2)` for UP,
 * `maxPayout * N(-d2)` for DOWN. This is exactly `probabilityItm(...) *
 * maxPayout` -- N(d2) IS the risk-neutral P(S_T > K) at r=0, which is also
 * this instrument's own risk-neutral expected payoff -- named and exported
 * separately from `probabilityItm` because it is now the actual traded
 * instrument's fair value, not just an honesty readout alongside a spread's.
 */
export function digitalFairValue(params: {
  direction: Direction;
  spot: number;
  strike: number;
  maxPayout: number;
  volAnnual: number;
  timeYears: number;
}): number {
  if (!(params.maxPayout > 0)) return 0;
  const prob = probabilityItm(params.direction, params.spot, params.strike, params.volAnnual, params.timeYears);
  return params.maxPayout * prob;
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

/**
 * The protocol's cut of a WINNING payout, in basis points -- mirrors
 * `config.fee_bps` on chain (set to 500 on 2026-09-19).
 *
 * `settle_pool_position` charges this against the payout and takes it from the
 * buyer's side, so a LOSING position pays nothing at all and a winner receives
 * `payout - fee`. It is duplicated here (rather than read from chain) purely so
 * the ticket can show the net before a quote exists; the authoritative value is
 * always the `fee_bps` snapshotted on the position itself, which is what
 * settlement actually uses. A filled quote therefore cannot be re-priced by a
 * later governance change.
 */
export const PROTOCOL_WIN_FEE_BPS = 500;

/** What a winner actually receives after the protocol's cut of the payout. */
export function netWinning(maxPayout: number, feeBps: number = PROTOCOL_WIN_FEE_BPS): number {
  if (!Number.isFinite(maxPayout) || maxPayout <= 0) return 0;
  return maxPayout * (1 - feeBps / 10_000);
}

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
// BINARY_WIDTH — the strike-to-cap distance every quote now signs, always:
// one atom at the on-chain 1e6 price scale (see PRICE_SCALE in
// app/lib/vsol-server.ts), i.e. $0.000001 in human USD. `Math.max(1,
// Math.round(...))` in `buildVsolQuoteTransaction` already floors the
// encoded width atoms at 1 (never 0, which the program rejects as
// InvalidWidth) -- BINARY_WIDTH just makes that floor the value actually
// requested, not an accident of rounding a much larger economic width.
//
// This used to be a real economic lever (see git history: a duration-scaled
// floor between 0.6% and 40% of spot, sized against the settlement's
// cherry-pick exposure). That whole tradeoff is superseded by the product
// decision this file now implements: a TRUE BINARY has no partial-payout
// zone to protect with a wider ramp -- hit the target, win the full payout;
// miss it, lose the entire premium. Making that literal on chain (rather
// than approximating it with a thin spread) is the point.
// ---------------------------------------------------------------------------
export const BINARY_WIDTH = 0.000001; // 1e-6 human USD == 1 atom at PRICE_SCALE (1e6).

// ---------------------------------------------------------------------------
// Strike solver — finds the strike offset (as a fraction of spot, from
// -MAX_STRIKE_OFFSET_FRACTION to +MAX_STRIKE_OFFSET_FRACTION; POSITIVE moves
// the strike OUT of the money -- up for UP, down for DOWN -- NEGATIVE moves
// it IN the money -- down for UP, up for DOWN) whose priced digital — fair
// value plus maker edge, computed together, see the maker-edge comment
// above — matches `targetPremium` (= maxPayout / payoff) within tolerance.
//
// THE DOMAIN IS SYMMETRIC (not just out-of-the-money) because P > 0.5 is a
// legitimate target: `premium = maxPayout * P * (1 + edge)`, so a "careful"
// low multiple (e.g. 1.5x, target premium = 66.7% of maxPayout) needs
// P = 1 / (1.15 * 1.5) ≈ 0.58 -- a win probability above 50%, which for UP
// only exists at a strike BELOW spot (in-the-money). Richer tiers (5x, 10x)
// need P well under 0.5, reachable only out-of-the-money. Searching only one
// side would make the low tiers unreachable exactly the way the old
// one-sided ramp search did.
//
// Premium (= maxPayout * N(d2) * (1+edge) for UP, N(-d2) for DOWN) is
// monotonically non-increasing in OFFSET across the whole domain (deep
// in-the-money -> P near 1, the richest end; deep out-of-the-money -> P near
// 0, the cheapest; decreasing smoothly through at-the-money, P = 0.5, in
// between), so this still bisects rather than inverting N(d2) in closed
// form, which has no clean inverse in strike.
//
// MAX_STRIKE_OFFSET_FRACTION is a generous sanity bound -- not a normal
// operating value: real quotes (see tests/pricing.test.mjs) solve to offsets
// of a few percent at most. It exists so the search terminates.
//
// 60%, not the old spread engine's 40%: switching from a capped spread to a
// true digital moved the goalposts on how far OTM "cheap" tiers actually
// need to go. A capped spread's fair value (a finite difference over its own
// width) falls off FASTER than a digital's N(d2) does as the strike moves
// OTM (the spread is bounded by width and collapses once spot clears the
// cap; the digital has no cap to clear), so for the same rich target premium
// the digital strike sits further out. Measured worst case in the tier x
// tenor x vol matrix this product actually sells (payoffTiersFor tiers,
// 15M-30D, 20-120% vol): 30D 10x at 120% vol needs ~50.5% OTM to hit
// P = 1/(10 * 1.15) ≈ 8.7% -- unreachable at the old 40% bound (clamped
// there to ~12.5% instead, delivering only ~6.95x, 30% off the advertised
// 10x). 60% leaves comfortable margin above that measured worst case so
// every tier in tests/pricing.test.mjs's per-tenor sweep SOLVES exactly
// rather than clamping. No on-chain constraint is implicated: the deployed
// program's `calculate_payout` only ever sees `PoolPosition.strike`, set
// directly from the quote the pool's own quote authority signs (never
// bounded relative to spot on chain) -- entirely distinct from the market's
// own listed ladder strike (`ladderStrike`, hashed into the market PDA),
// which this solver never touches.
//
// UNLIKE the Monad engine, this NEVER throws when a target is unreachable.
// Monad's `UnreachableLeverageError` is the right call for a service that
// can 502 a single RFQ; Tend is a 24/7 protocol that must always return a
// bounded quote (see the "Tend is 24/7" rule this repo already enforces for
// session/market-hours gating -- the same principle applies to refusing a
// quote over a pricing corner case). So instead this clamps gracefully to
// whichever boundary is closest to the target:
//   - target >= the deepest in-the-money premium (offset
//     -MAX_STRIKE_OFFSET_FRACTION): the requested payoff tier is too rich
//     for the current vol/time even at the most in-the-money strike this
//     solver will search (P is already close to 1 there). Clamps there --
//     the richest honestly priceable premium -- and reports the ACTUAL
//     achieved leverage (callers already compute maxPayout/premium
//     independently rather than assuming it equals the requested tier).
//   - target <= the deepest out-of-the-money premium (offset
//     +MAX_STRIKE_OFFSET_FRACTION): the tier is too aggressive (too cheap)
//     to reach even at the widest allowed out-of-the-money offset (P is
//     already close to 0 there). Clamps there.
// Both cases are reported via `reachability` so callers/tests can
// distinguish a solved quote from a clamped one.
// ---------------------------------------------------------------------------
export const MAX_STRIKE_OFFSET_FRACTION = 0.6;
const SOLVER_TOLERANCE_RELATIVE = 1e-7;
const SOLVER_MAX_ITERATIONS = 200;

export interface StrikeSolveParams {
  direction: Direction;
  spot: number;
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
  /** Pre-edge digital fair value (`maxPayout * N(d2)` / `N(-d2)`) at the solved strike. */
  fairValue: number;
  /** Fair value with the maker edge applied — the premium actually charged. */
  premium: number;
  probabilityItm: number;
  /** "solved" if the bisection converged to targetPremium within tolerance; otherwise which boundary it clamped to -- "clamped-max-itm" is the deepest in-the-money strike this solver searches (-MAX_STRIKE_OFFSET_FRACTION), "clamped-max-otm" the deepest out-of-the-money one (+MAX_STRIKE_OFFSET_FRACTION). See the module comment above. */
  reachability: "solved" | "clamped-max-itm" | "clamped-max-otm";
}

function priceAtStrikeOffset(p: StrikeSolveParams, offsetFraction: number): { strike: number; fair: number; premium: number } {
  const offset = p.spot * offsetFraction;
  const strike = p.direction === "up" ? p.spot + offset : p.spot - offset;
  const fair = digitalFairValue({ direction: p.direction, spot: p.spot, strike, maxPayout: p.maxPayout, volAnnual: p.volAnnual, timeYears: p.timeYears });
  const premium = applyMakerEdge(fair, p.makerEdgeBps);
  return { strike, fair, premium };
}

export function solveStrikeForTargetPremium(p: StrikeSolveParams): StrikeSolveResult {
  const atMaxItm = priceAtStrikeOffset(p, -MAX_STRIKE_OFFSET_FRACTION);
  if (p.targetPremium >= atMaxItm.premium) {
    return {
      strike: atMaxItm.strike,
      strikeOffsetFraction: -MAX_STRIKE_OFFSET_FRACTION,
      fairValue: atMaxItm.fair,
      premium: atMaxItm.premium,
      probabilityItm: probabilityItm(p.direction, p.spot, atMaxItm.strike, p.volAnnual, p.timeYears),
      reachability: p.targetPremium > atMaxItm.premium ? "clamped-max-itm" : "solved",
    };
  }

  const atMaxOtm = priceAtStrikeOffset(p, MAX_STRIKE_OFFSET_FRACTION);
  if (p.targetPremium <= atMaxOtm.premium) {
    return {
      strike: atMaxOtm.strike,
      strikeOffsetFraction: MAX_STRIKE_OFFSET_FRACTION,
      fairValue: atMaxOtm.fair,
      premium: atMaxOtm.premium,
      probabilityItm: probabilityItm(p.direction, p.spot, atMaxOtm.strike, p.volAnnual, p.timeYears),
      reachability: p.targetPremium < atMaxOtm.premium ? "clamped-max-otm" : "solved",
    };
  }

  let lo = -MAX_STRIKE_OFFSET_FRACTION;
  let hi = MAX_STRIKE_OFFSET_FRACTION;
  let best = atMaxItm;
  let bestOffset = -MAX_STRIKE_OFFSET_FRACTION;
  for (let i = 0; i < SOLVER_MAX_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;
    const at = priceAtStrikeOffset(p, mid);
    best = at;
    bestOffset = mid;
    if (Math.abs(at.premium - p.targetPremium) <= SOLVER_TOLERANCE_RELATIVE * Math.max(p.targetPremium, 1e-9)) break;
    if (at.premium > p.targetPremium) lo = mid; // premium is non-increasing in offset -- still too rich, move toward the OTM side
    else hi = mid;
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

// ---------------------------------------------------------------------------
// Payoff ladder -- which target multiples a tenor is allowed to sell.
// Longer tenors keep the original [2x, 5x, 10x] menu. Anything expiring
// within INTRADAY_TIER_MAX_MINUTES instead offers a [1.5x, 2x, 3x] menu --
// "near-binary" only in name now that every tier is a true binary (see the
// BINARY_WIDTH comment above): every tier in this ladder is reached purely
// by moving the strike, richer (lower multiple, higher P(win)) tiers moving
// further in-the-money, the way `solveStrikeForTargetPremium` already
// searches both directions for.
//
// `payoffTiersFor` is the PRODUCT-facing gate (which tier is actually FOR
// SALE at a given duration) -- app/api/quotes/route.ts validates against it
// directly so the two surfaces cannot drift. `quoteFor` itself validates
// against the wider, duration-independent UNION below: it is a general
// pricing primitive (any known tier, priced honestly at any duration you
// hand it), not the product catalog -- callers that already know their own
// valid tenor/tier pairing (e.g. tests exercising `buybackFor`'s pricing in
// isolation) are not forced through the product's own sales restrictions.
// ---------------------------------------------------------------------------
export const INTRADAY_TIER_MAX_MINUTES = 60; // 15M and 1H.
// Intraday is a 1.5x / 2x / 3x menu, deliberately reversing the earlier
// "start at the money" rule (which set 2x/3x/6x). A 1.5x binary needs
// P(win) ~58%, which puts its target slightly BELOW spot -- you win if the
// price merely holds. That was previously rejected as "not a directional
// bet", but it is the right shape for this product now that a protocol fee
// is taken from winning payouts: a high-hit-rate ticket is what makes a
// win-side fee meaningful, and a trader who wants a genuine directional
// move still has 3x here and 5x/10x on the standard tenors.
//
// These are distinct contracts, not three labels on one: the traded strike
// is the value the pricing engine SOLVES (minted on demand, see
// listVsolSeriesOnChain), not a coarse ladder rung -- at spot $100/vol 60
// the 15M targets land at $99.94 / $100.05 / $100.18. `ladderStrike` only
// picks the default at-the-money rung when PLANNING a listing.
export const PAYOFF_TIERS_INTRADAY: readonly number[] = [1.5, 2, 3];
export const PAYOFF_TIERS_STANDARD: readonly number[] = [2, 5, 10];
export const PAYOFF_TIERS_ALL: readonly number[] = [1.5, 2, 3, 5, 6, 10];

export function payoffTiersFor(durationMinutes: number): number[] {
  return durationMinutes <= INTRADAY_TIER_MAX_MINUTES
    ? [...PAYOFF_TIERS_INTRADAY]
    : [...PAYOFF_TIERS_STANDARD];
}

export function quoteFor(params: {
  spot: number;
  amount: number;
  durationMinutes: number;
  direction: Direction;
  payoff: number;
  volatility: number;
  referenceAgeSeconds?: number;
  /** Overrides `MAKER_EDGE_BPS` for this quote -- e.g. a per-market override (see `pricingOverrides` on `Market` in app/lib/markets.ts). Undefined means "use the global default", identical to today's behavior. */
  makerEdgeBps?: number;
}) {
  const { spot, amount, direction, durationMinutes } = params;
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(amount) || amount <= 0) {
    throw new RangeError("Spot and amount must be positive finite values");
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1) throw new RangeError("Duration must be positive");
  if (!PAYOFF_TIERS_ALL.includes(params.payoff)) {
    throw new RangeError(`Payoff must be one of ${PAYOFF_TIERS_ALL.map((tier) => `${tier}×`).join(", ")}`);
  }
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

  const maxPayout = amount;
  const targetPremium = maxPayout / payoff;

  // No hand-tuned direction skew here (the old engine charged "down" 6% more
  // than "up" via a flat `directionFactor`, undocumented as to why). Any
  // real up/down asymmetry is now priced by the math itself: calls and puts
  // are NOT symmetric under lognormal returns even at r=0, and
  // `solveStrikeForTargetPremium` prices each side with its own N(d2)/N(-d2)
  // formula rather than a shared fudge factor.
  const solved = solveStrikeForTargetPremium({ direction, spot, maxPayout, targetPremium, volAnnual, timeYears, makerEdgeBps: params.makerEdgeBps });

  const premium = Math.min(maxPayout * 0.95, Math.max(1, solved.premium));
  const strike = solved.strike;
  const leverage = maxPayout / premium;
  // BINARY_WIDTH, always -- see its own comment above. `cap` is kept as a
  // field (not collapsed into `strike`) because vsol-server.ts still derives
  // the on-chain `width` from `cap - strike`, and because it is the exact
  // atom the program's step function flips on.
  const cap = direction === "up" ? strike + BINARY_WIDTH : strike - BINARY_WIDTH;

  return {
    premium,
    maxPayout,
    leverage,
    strike,
    cap,
    // A binary has no partial-payout zone to have a separate breakeven
    // price: hit the target (the strike) and win the full payout, miss it
    // and lose the whole premium -- breakeven IS the target. Kept as a field
    // (not removed) because db/schema.ts and app/api/quotes/route.ts still
    // persist/return it; the UI drops the separate "Breakeven" row (see
    // TendTerminal.tsx) since it would just be a second name for `strike`.
    breakeven: strike,
    /** P(finishing in the money) at expiry, at the solved strike -- the honest counterweight to `leverage`, and exactly what this quote's fair value is a fraction of (fairValue = maxPayout * probabilityItm). */
    probabilityItm: solved.probabilityItm,
    /** The gap-risk-adjusted annualized vol actually used to price this quote, as a percentage (e.g. 32.3 for 32.3%). */
    impliedVolatility: volAnnual * 100,
    /** Whether the payoff tier was fairly reachable at this vol/time, or gracefully clamped -- see solveStrikeForTargetPremium. */
    reachability: solved.reachability,
  };
}

// With `cap - strike` pinned at BINARY_WIDTH (one atom), this identical
// on-chain-matching formula degenerates to an exact step function: 0 at or
// below strike, maxPayout starting exactly one atom above (mirrored for
// DOWN) -- see the BINARY_WIDTH comment above. Unchanged code, new shape.
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
 *
 * SECOND double-count, same failure mode, found once `solveStrikeForTargetPremium`
 * started searching in-the-money strikes (see its comment above): AT
 * INCEPTION (fraction === 1, i.e. minutesRemaining === originalMinutes,
 * meaning literally no time has elapsed since the quote was struck) spot
 * cannot have moved either, so `intrinsic` computed here is exactly the
 * intrinsic value AT THE MOMENT THE QUOTE WAS STRUCK -- and `premium`
 * already prices that in, by construction, whether the solved strike
 * landed out-of-the-money (intrinsic = 0, the only case this formula used
 * to see) or in-the-money (intrinsic > 0, now reachable). `intrinsic +
 * premium` at fraction === 1 therefore double-counts exactly like the
 * volScale bug above, just via a different term -- so fair value at
 * inception is pinned to `premium` directly, unconditionally, rather than
 * derived from `intrinsic + timeValue`. Away from fraction === 1, genuine
 * time has elapsed and spot may have genuinely moved since the quote was
 * struck, so `intrinsic` there is REAL, newly-realized P/L the (unchanged)
 * decaying time-value term must still be added on top of.
 *
 * TRUE BINARY: the position `buybackFor` re-prices is now a cash-or-nothing
 * digital, not a capped spread -- `quoteFor` signs BINARY_WIDTH (one atom)
 * for every quote, so `definedRiskPayout` is an exact step function at
 * settlement. `buybackFor` prices the SAME instrument at today's spot and
 * remaining time: `maxPayout * N(d2)` (UP) / `N(-d2)` (DOWN) via
 * `digitalFairValue`, which is exactly `maxPayout` or `0` at expiry
 * (timeYears <= 0). This is the position's actual fair value, not an
 * approximation of it -- the invariant that must always hold (closing
 * immediately returns strictly less than was paid, for every tier, tenor,
 * vol, direction and time remaining) follows directly from `fairValue` being
 * the pre-edge value `premium` was derived from (`premium = fairValue *
 * (1 + MAKER_EDGE_BPS)`), not from any width-dependent shape.
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
  /** Annualized volatility as a percentage (e.g. 62.1), same units as `quoteFor`. */
  volatility: number;
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
  if (!Number.isFinite(params.volatility) || params.volatility <= 0) {
    throw new RangeError("Volatility must be a positive finite value");
  }

  const fraction = Math.max(0, Math.min(1, minutesRemaining / originalMinutes));

  // Re-price the SAME digital with the SAME model that sold it, at today's
  // spot and whatever time is actually left -- `maxPayout * N(d2)` (UP) /
  // `N(-d2)` (DOWN), exactly `quoteFor`'s own pre-edge fair value formula run
  // again at the current spot/time. `intrinsic + premium * decay` is not used
  // at all any more: it double-counted whenever the struck strike was in the
  // money, because `premium` already prices that in-the-moneyness by
  // construction. Pinning only the fraction === 1 instant did not fix it --
  // one second later the heuristic returned, and a 15M 2x bought for $250
  // closed for $427. Valuing the position instead of approximating it removes
  // the whole class: at inception the model returns the fair value `premium`
  // was derived from, so a round trip gives back fair-minus-spread and always
  // loses the maker edge plus the buyback spread, for in-the-money and
  // out-of-the-money strikes alike. At expiry (timeYears <= 0) this degenerates
  // to exactly `maxPayout` or `0` -- the same step `definedRiskPayout` computes
  // at the real BINARY_WIDTH -- via `probabilityItm`'s own timeYears<=0 branch.
  const gapRiskHours = referenceAgeSeconds / 3_600;
  const gapRiskMultiplier = Math.min(GAP_RISK_MAX_VOL_MULTIPLIER, 1 + GAP_RISK_VOL_SCALE_PER_HOUR * Math.sqrt(gapRiskHours));
  const volAnnual = (params.volatility / 100) * gapRiskMultiplier;
  // Actual time left, NOT quoteFor's 15-minute floor: a position being closed
  // genuinely has less time than that, and probabilityItm degenerates to an
  // indicator (1 or 0) at timeYears <= 0, which is the correct terminal value.
  const timeYears = Math.max(0, minutesRemaining) / 525_600;
  const fairValue = Math.max(0, Math.min(maxPayout, digitalFairValue({ direction, spot, strike, maxPayout, volAnnual, timeYears })));
  // Moneyness + time-to-expiry + gap-risk, composed multiplicatively and
  // bounded -- see `dynamicSpreadBps` above. This never re-touches the
  // fair-value math above; it only scales the discount applied to it.
  const spreadBps = dynamicSpreadBps({ direction, spot, strike, cap, fraction, referenceAgeSeconds });

  // THIRD round-trip hazard, specific to a TRUE BINARY: an in-the-money
  // digital has POSITIVE theta. Unlike a vanilla option (whose intrinsic
  // value is fixed by spot/strike alone, so an unmoved spot means the price
  // only ever decays toward that fixed intrinsic), a digital's fair value
  // IS the win probability itself -- and with spot held fixed past the
  // strike, every minute that passes without an adverse move makes that win
  // MORE certain, so `fairValue` climbs toward `maxPayout` as timeYears -> 0.
  // For a rich (low-multiple) tier struck in the money (1.5x needs
  // P ~= 0.58 at inception, see solveStrikeForTargetPremium's comment),
  // that climb genuinely carries fairValue past `premium` well before
  // expiry -- `dynamicSpreadBps`'s moneyness factor is tightest exactly on
  // this favorable side (by design: it protects against the LOSING side,
  // see its own doc comment), so no discount there stops it, and even
  // `BUYBACK_MAX_SPREAD_BPS` (15%) is far short of what a fully-realized
  // certain win at a 1.5x premium (66.7% of maxPayout) would need (>33%).
  // This is genuine, textbook digital-option behavior, not a pricing
  // error -- real venues handle it by simply not selling early-exit
  // liquidity at a price above what they collected. This pool does the
  // same, explicitly: it never buys back for more than the premium it was
  // paid. THAT CEILING WAS REMOVED: it was answering an over-strict
  // invariant ("closing at unchanged spot must lose at EVERY time
  // remaining"), which is false for a binary. An in-the-money digital has
  // POSITIVE theta -- as expiry approaches with spot unchanged, its win
  // probability rises toward 1 and it is genuinely worth close to
  // `maxPayout`. Capping the payout at the premium meant a buyer whose
  // target had already been crossed could only close for less than they
  // paid, which makes taking profit impossible and is simply the wrong
  // price. The invariant that IS true, and the one the tests pin, is
  // narrower: an IMMEDIATE round trip -- no time elapsed, no price move --
  // must lose. Profit that requires holding through real time, and
  // therefore real risk, is legitimate P/L, not arbitrage.
  const buyback = Math.max(0, Math.min(maxPayout, fairValue * (1 - spreadBps / 10_000)));

  if (!Number.isFinite(fairValue) || !Number.isFinite(buyback) || !Number.isFinite(spreadBps)) {
    throw new RangeError("Buyback pricing produced a non-finite result");
  }
  return { fairValue, buyback, spreadBps };
}

// ---------------------------------------------------------------------------
// Stake -> payout inversion.
//
// The buyer types what they are willing to PAY. The engine prices from the
// payout, so the payout that costs exactly that stake has to be derived.
//
// This is exact, not a search. `quoteFor` solves the strike such that
// premium == maxPayout / payoff, and `digitalFairValue` is
// maxPayout * probabilityItm(...), so maxPayout cancels out of the solver's
// target: the strike, cap, probability and the premium RATIO depend only on
// (spot, vol, duration, direction, payoff) -- never on size. Premium is
// therefore exactly linear in maxPayout, and one reference quote inverts it
// in closed form.
//
// The caller re-prices at the returned notional rather than scaling the
// reference numbers, because `quoteFor` applies two absolute clamps to the
// premium (a $1 floor and a 95%-of-payout ceiling) that are not linear. Those
// only bite at extreme sizes, and re-pricing means the quote the buyer signs
// is always the quote they were shown.

/** Smallest and largest payout the devnet pool will underwrite, in tUSDC. */
export const MIN_PAYOUT_NOTIONAL = 100;
export const MAX_PAYOUT_NOTIONAL = 5_000;

/**
 * The payout notional whose premium is `stake`, given one reference quote
 * priced at `referenceNotional`. Clamped to what the pool can underwrite --
 * callers must re-price at the result and show THAT premium, which is the
 * one the buyer actually pays when the clamp binds.
 */
export function payoutForStake(params: {
  stake: number;
  referencePremium: number;
  referenceNotional: number;
}): number {
  const { stake, referencePremium, referenceNotional } = params;
  if (!Number.isFinite(stake) || stake <= 0) throw new RangeError("Stake must be a positive finite value");
  if (!Number.isFinite(referencePremium) || referencePremium <= 0) throw new RangeError("Reference premium must be positive");
  if (!Number.isFinite(referenceNotional) || referenceNotional <= 0) throw new RangeError("Reference notional must be positive");
  const premiumFraction = referencePremium / referenceNotional;
  const notional = stake / premiumFraction;
  const clamped = Math.min(MAX_PAYOUT_NOTIONAL, Math.max(MIN_PAYOUT_NOTIONAL, notional));
  return Number(clamped.toFixed(2));
}

/** The stake range that keeps the derived payout inside the pool's limits at this payoff tier. */
export function stakeBoundsForPayoff(payoff: number): { min: number; max: number } {
  return {
    min: Math.ceil(MIN_PAYOUT_NOTIONAL / payoff),
    max: Math.floor(MAX_PAYOUT_NOTIONAL / payoff),
  };
}

// ---------------------------------------------------------------------------
// Two-sided display -- "cents on the dollar" framing (Split's docs: for one
// strike, UP + DOWN premiums sum to the payout width; "pay 30c to win a
// dollar, or pay 70c for the other side of the same dollar"). Tend's TRUE
// BINARY has the identical shape at r=0: `probabilityItm` IS N(d2) (UP) or
// N(-d2) (DOWN), and N(d2) + N(-d2) == 1 EXACTLY for any d2 (normalCdf's own
// symmetry, pinned by the "normalCdf is a sane standard normal CDF" test) --
// so the opposite direction's pre-edge fair value at THIS SAME STRIKE is
// exactly `maxPayout * (1 - probabilityItm)`, no second Black-Scholes call
// and no network round trip needed.
// ---------------------------------------------------------------------------

/**
 * The fair-value-plus-edge premium of the OPPOSITE direction's digital, at
 * the SAME STRIKE a quote already solved to. Exact (not a heuristic
 * approximation): derived from the same `probabilityItm` a real quote
 * already returns, via the N(d2) + N(-d2) == 1 identity above.
 *
 * NOT the executable premium a real quote for the opposite direction would
 * carry -- an actual opposite-direction quote solves its OWN strike to hit
 * the same payoff tier (see `solveStrikeForTargetPremium`), which lands at a
 * different strike than this one. This is the honest complementary price at
 * THIS quote's own strike, for indicative display only -- callers must never
 * sign or submit it as a fill (only the requested direction's own quote from
 * `/api/quotes` is ever executable).
 */
export function otherSidePremium(params: {
  maxPayout: number;
  /** `probabilityItm` from a `quoteFor` result for the quoted direction, at its solved strike. */
  probabilityItm: number;
  makerEdgeBps?: number;
}): number {
  const { maxPayout, probabilityItm, makerEdgeBps } = params;
  if (!Number.isFinite(maxPayout) || maxPayout <= 0) throw new RangeError("Max payout must be a positive finite value");
  if (!Number.isFinite(probabilityItm) || probabilityItm < 0 || probabilityItm > 1) {
    throw new RangeError("probabilityItm must be within [0, 1]");
  }
  const otherFairValue = maxPayout * (1 - probabilityItm);
  const withEdge = applyMakerEdge(otherFairValue, makerEdgeBps);
  // Same clamp `quoteFor` applies to every real premium (line ~438: `Math.min(
  // maxPayout * 0.95, Math.max(1, solved.premium))`) -- without it, a low-P
  // side (any tier at 5x+, where the OTHER side is the near-certain one) puts
  // `withEdge` past `maxPayout` itself: measured, a 10x tier's other side
  // priced at $525 to win a $500 payout. That is not "indicative", it is
  // arithmetically impossible as a real price (guaranteed loss even on a
  // win), and it would have sat right next to the real premium on the ticket.
  return Math.min(maxPayout * 0.95, Math.max(1, withEdge));
}
