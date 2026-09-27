use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

mod math;
mod pyth;
mod signature;

use math::{
    calculate_bps_limit, calculate_deposit_shares, calculate_fee, calculate_payout,
    calculate_withdraw_amount,
};
use pyth::{parse_fully_verified_price_update, PythPrice};
// Re-exported purely so the LiteSVM integration test suite (a separate crate
// that depends on `vsol` with `no-entrypoint`) can construct a receiver-owned
// fixture account without duplicating this address; see tests/common.
pub use pyth::PYTH_RECEIVER_PROGRAM_ID;
use signature::{
    pool_buyback_message, pool_quote_message, verify_preceding_ed25519_instruction,
    PoolBuybackMessageContext, PoolQuoteMessageContext,
};

declare_id!("2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MARKET_SEED: &[u8] = b"market";
pub const ORACLE_SEED: &[u8] = b"oracle";
pub const ELIGIBILITY_SEED: &[u8] = b"eligibility";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_TOKEN_SEED: &[u8] = b"pool-token";
pub const PROVIDER_SEED: &[u8] = b"provider";
pub const POOL_MARKET_SEED: &[u8] = b"pool-market";
pub const POOL_NONCE_SEED: &[u8] = b"pool-nonce";
pub const POOL_POSITION_SEED: &[u8] = b"pool-position";
pub const POOL_POSITION_VAULT_SEED: &[u8] = b"pool-position-vault";
pub const POOL_QUOTE_DOMAIN: &[u8; 8] = b"VSOLPLP1";
// Distinct from the fill domains above so a signed early-close buyback quote
// can never be replayed as (or confused with) a fill quote, even though both
// are ultimately authenticated via the same Ed25519-precompile trust model.
pub const POOL_BUYBACK_DOMAIN: &[u8; 8] = b"VSOLCLS1";
pub const MARKET_ID_DOMAIN: &[u8; 8] = b"VSOLMKT1";
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_FEE_BPS: u16 = 1_000;
pub const MIN_MARKET_LEAD_SECONDS: i64 = 15;
pub const MAX_OBSERVATION_WINDOW_SECONDS: u32 = 3_600;
pub const MAX_SETTLEMENT_GRACE_SECONDS: u32 = 604_800;
pub const MAX_PYTH_EXPONENT_ABS: u32 = 18;
// Tier 2's last-known-price fallback: how far before `expiry` a print may
// have been published and still be accepted once the primary observation
// window has fully elapsed. Capped at 7 days for the same reason the
// settlement grace period is.
pub const MAX_SETTLEMENT_STALENESS_SECONDS: u32 = 604_800;

/// Extra buffer, layered on top of the full settlement deadline
/// (`expiry + observation_window_seconds + settlement_grace_seconds`), that
/// tier 2 must additionally wait past before `publish_pyth_settlement` will
/// accept it. Exists solely to break an exact-instant tie against
/// `refund_unsettled` / `refund_pool_position`, which both become callable
/// at precisely that deadline (see their own `deadline` computation --
/// deliberately untouched by this constant, so the invariant
/// `close_settled_market`'s doc comment depends on keeps holding exactly as
/// documented there). Without this buffer, tier 2's gate and the refund
/// gate would share the identical boundary second, so whether a given
/// still-open position gets a stale-price settlement or a clean refund
/// would depend on ambiguous same-slot transaction-ordering luck instead of
/// a deliberate protocol choice.
///
/// Refund deliberately wins the tie: for the whole window
/// `(deadline, deadline + SETTLEMENT_REFUND_PRIORITY_SECONDS]`, refund is
/// callable and tier 2 is not. A refund returns every escrowed token to
/// exactly where it came from -- no wealth transfer, no exposure to a stale
/// price -- so when both a refund and a first-ever tier-2 settlement would
/// otherwise be simultaneously "correct" outcomes, the protocol prefers the
/// one that cannot be gamed by either counterparty racing to submit first.
/// 60 seconds is generous slack over any realistic clock/slot ambiguity
/// while staying negligible against every other duration here
/// (`settlement_grace_seconds` defaults to 900s,
/// `max_settlement_staleness_seconds` to 86,400s): it does not make tier 2
/// meaningfully less useful as a fallback, it just removes the ambiguous
/// instant.
pub const SETTLEMENT_REFUND_PRIORITY_SECONDS: i64 = 60;

/// Cross-parameter bound enforced at `create_market`: how large
/// `max_settlement_staleness_seconds` may be relative to
/// `observation_window_seconds + settlement_grace_seconds`, i.e. how long a
/// tier-2 print's lookback may reach relative to how long the market must
/// wait before tier 2 opens at all.
///
/// Without this, a permissionless creator can pick a tiny
/// `(observation_window_seconds, settlement_grace_seconds)` -- as low as
/// `(1, 1)` -- completely independently of `max_settlement_staleness_seconds`,
/// which can go all the way up to the global 7-day ceiling
/// (`MAX_SETTLEMENT_STALENESS_SECONDS`). Gating tier 2 on the full deadline
/// (`SETTLEMENT_REFUND_PRIORITY_SECONDS` above) closes the *timing*
/// half of the original vulnerability -- tier 2 is no longer a free early
/// option -- but does nothing to stop a creator who controls their own
/// market's own timing parameters from making that deadline arrive almost
/// immediately anyway. A `(1, 1, 604_800)` market would still open tier 2
/// roughly a minute after `expiry` with a full week of historical prices to
/// choose from. This ratio is the other half of the fix: it ties how far
/// back tier 2 may look to how long the market actually made everyone wait
/// first.
///
/// 100x keeps the SDK's real configuration legal with headroom (30s window +
/// 900s grace = 930s wait, 86,400s staleness -- ratio ~93) while rejecting
/// the audit's degenerate `(1, 1, 604_800)` example by roughly three orders
/// of magnitude (ratio 302,400 against a cap of 100).
pub const MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO: u64 = 100;

/// How long AFTER the settlement deadline a market must sit before
/// `close_settled_market` may reclaim its rent.
///
/// `settle`, `refund_unsettled`, `settle_pool_position` and
/// `refund_pool_position` all load `Market`/`SettlementOracle` via `has_one`,
/// so closing those accounts makes every one of them permanently
/// unconstructible — an open position's escrowed `premium + max_payout` would
/// be stranded in its vault with no instruction left that can move it.
///
/// Before this constant existed, `close_settled_market` used the settlement
/// deadline *itself*, with zero buffer — the exact same instant at which
/// `refund_unsettled` first becomes callable. A late-but-valid refund racing
/// the automated cleaner (scripts/cranker.ts calls this instruction) could
/// therefore lose funds with no attacker involved and no bug in either caller.
///
/// This buffer does not make closing safe on its own — see point 3 of
/// `close_settled_market`'s doc comment for the enumeration gap that remains
/// the caller's responsibility. It converts a zero-margin race into a 7-day
/// window during which any stranded position can still be refunded, which is
/// what makes that off-chain assumption survivable in practice.
pub const MARKET_CLEANUP_BUFFER_SECONDS: i64 = 604_800;

/// Hard ceiling on `max_utilization_bps` for every liquidity pool, regardless
/// of what its (permissionless, therefore untrusted) manager configures.
/// `validate_pool_risk_limits` rejects anything above this, so a single
/// `fill_pool_quote` can never lock more than 80% of a pool's collateral --
/// "the entire pool in one fill" is no longer representable.
///
/// Be honest about what this is and is not: it is blast-radius reduction,
/// NOT a fix. A manager who controls `quote_authority` can still drain a
/// pool geometrically -- fill up to 80%, close/settle to realize it, fill
/// 80% of what remains, repeat -- across as many transactions as they like.
/// The actual defense against a hostile manager is the timelock on raising
/// this cap or rotating `quote_authority` at all; see
/// `POOL_UPDATE_TIMELOCK_SECONDS` and `update_liquidity_pool`.
pub const MAX_POOL_UTILIZATION_BPS: u16 = 8_000;

/// How long a manager must wait after proposing to raise `max_utilization_bps`
/// and/or `max_position_bps`, or rotate `quote_authority`, before
/// `apply_liquidity_pool_update` may commit the change. `update_liquidity_pool`
/// records the proposal and emits `LiquidityPoolUpdateProposed` with the
/// `effective_at` timestamp so LPs and indexers can actually observe it --
/// the delay is worthless if nobody can see it coming. 24h is meant to give
/// LPs a realistic window to notice a hostile change and call
/// `withdraw_liquidity` before it takes effect.
///
/// This is the real defense against a permissionless pool manager rotating
/// `quote_authority` to a key they control and self-filling for a large
/// fraction of the pool: without this delay, propose-then-self-fill can
/// happen in a single transaction with zero notice. See
/// `update_liquidity_pool`'s doc comment for the residual gap this does NOT
/// close (a manager can still open a position mid-window to block
/// `withdraw_liquidity`, which requires the pool be idle).
pub const POOL_UPDATE_TIMELOCK_SECONDS: i64 = 86_400;

/// Seed for `CustomPriceFeed`, the centrally-sourced backup/demo settlement
/// price feed -- see that account's own doc comment for the full trust-model
/// disclosure.
pub const CUSTOM_FEED_SEED: &[u8] = b"custom-feed";
pub const CUSTOM_SETTLEMENT_OBSERVATION_SEED: &[u8] = b"custom-observation";
// Generous vs. an off-chain pusher cadence of ~45-60s; tight enough that a
// dead pusher fails settlement closed rather than allowing a frozen price to
// keep being used indefinitely.
pub const CUSTOM_ORACLE_MAX_STALENESS_SECONDS: i64 = 300;
pub const CUSTOM_OBSERVATION_MAX_CAPTURE_AGE_SECONDS: i64 = 30;

#[program]
pub mod vsol {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        require!(args.fee_bps <= MAX_FEE_BPS, VsolError::FeeTooHigh);
        require!(
            args.treasury_owner != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        require!(
            args.pause_authority != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        require!(
            args.oracle_authority != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        require!(
            args.eligibility_authority != Pubkey::default(),
            VsolError::InvalidAuthority
        );

        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;
        config.admin = ctx.accounts.admin.key();
        config.pending_admin = Pubkey::default();
        config.pause_authority = args.pause_authority;
        config.oracle_authority = args.oracle_authority;
        config.eligibility_authority = args.eligibility_authority;
        config.treasury_owner = args.treasury_owner;
        config.fee_bps = args.fee_bps;
        config.paused = false;
        config.eligibility_required = args.eligibility_required;
        config.domain_separator = args.domain_separator;
        config.domain_version = 1;

        emit!(ConfigInitialized {
            config: config.key(),
            admin: config.admin,
            fee_bps: config.fee_bps,
        });
        Ok(())
    }

    pub fn update_config(ctx: Context<AdminConfig>, args: UpdateConfigArgs) -> Result<()> {
        require!(args.fee_bps <= MAX_FEE_BPS, VsolError::FeeTooHigh);
        require!(
            args.treasury_owner != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        require!(
            args.pause_authority != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        require!(
            args.oracle_authority != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        require!(
            args.eligibility_authority != Pubkey::default(),
            VsolError::InvalidAuthority
        );

        let config = &mut ctx.accounts.config;
        config.pause_authority = args.pause_authority;
        config.oracle_authority = args.oracle_authority;
        config.eligibility_authority = args.eligibility_authority;
        config.treasury_owner = args.treasury_owner;
        config.fee_bps = args.fee_bps;
        config.eligibility_required = args.eligibility_required;
        config.domain_version = config
            .domain_version
            .checked_add(1)
            .ok_or(VsolError::MathOverflow)?;

        emit!(ConfigUpdated {
            config: config.key(),
            domain_version: config.domain_version,
        });
        Ok(())
    }

    pub fn nominate_admin(ctx: Context<AdminConfig>, pending_admin: Pubkey) -> Result<()> {
        require!(
            pending_admin != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        ctx.accounts.config.pending_admin = pending_admin;
        emit!(AdminNominated { pending_admin });
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(
            config.pending_admin,
            ctx.accounts.pending_admin.key(),
            VsolError::Unauthorized
        );
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();
        emit!(AdminAccepted {
            admin: config.admin
        });
        Ok(())
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PauseUpdated { paused });
        Ok(())
    }

    pub fn create_market(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.config.paused, VsolError::ProtocolPaused);
        require!(
            args.expiry >= now.saturating_add(MIN_MARKET_LEAD_SECONDS),
            VsolError::InvalidExpiry
        );
        require!(
            args.observation_window_seconds > 0
                && args.observation_window_seconds <= MAX_OBSERVATION_WINDOW_SECONDS,
            VsolError::InvalidObservationWindow
        );
        require!(
            args.settlement_grace_seconds > 0
                && args.settlement_grace_seconds <= MAX_SETTLEMENT_GRACE_SECONDS,
            VsolError::InvalidSettlementGrace
        );
        require!(
            args.max_settlement_staleness_seconds > 0
                && args.max_settlement_staleness_seconds <= MAX_SETTLEMENT_STALENESS_SECONDS,
            VsolError::InvalidSettlementStaleness
        );
        // Cross-parameter bound: see `MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO`
        // for why the absolute cap just above is not enough on its own -- a
        // creator can still pick an arbitrarily tiny
        // `(observation_window_seconds, settlement_grace_seconds)` and pair
        // it with the full 7-day staleness allowance.
        let tier_one_window = u64::from(args.observation_window_seconds)
            .checked_add(u64::from(args.settlement_grace_seconds))
            .ok_or(VsolError::MathOverflow)?;
        let max_allowed_staleness = tier_one_window
            .checked_mul(MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO)
            .ok_or(VsolError::MathOverflow)?;
        require!(
            u64::from(args.max_settlement_staleness_seconds) <= max_allowed_staleness,
            VsolError::InvalidSettlementStaleness
        );
        require!(
            args.max_confidence_bps > 0 && args.max_confidence_bps <= 2_000,
            VsolError::InvalidConfidence
        );
        require!(
            args.symbol.iter().any(|byte| *byte != 0),
            VsolError::InvalidSymbol
        );
        require!(args.price_scale > 0, VsolError::InvalidPriceScale);
        require!(
            args.pyth_feed_id.iter().any(|byte| *byte != 0),
            VsolError::InvalidPythFeed
        );
        require!(
            args.underlying_mint != Pubkey::default(),
            VsolError::InvalidUnderlyingMint
        );
        require!(args.strike > 0, VsolError::InvalidStrike);
        require!(
            args.market_id == expected_market_id(&args, ctx.accounts.settlement_mint.key()),
            VsolError::InvalidMarketId
        );

        let market = &mut ctx.accounts.market;
        market.bump = ctx.bumps.market;
        market.config = ctx.accounts.config.key();
        market.market_id = args.market_id;
        market.underlying_mint = args.underlying_mint;
        market.settlement_mint = ctx.accounts.settlement_mint.key();
        market.oracle = ctx.accounts.oracle.key();
        market.symbol = args.symbol;
        market.price_scale = args.price_scale;
        market.expiry = args.expiry;
        market.observation_window_seconds = args.observation_window_seconds;
        market.settlement_grace_seconds = args.settlement_grace_seconds;
        market.max_confidence_bps = args.max_confidence_bps;
        market.pyth_feed_id = args.pyth_feed_id;
        market.settlement_decimals = ctx.accounts.settlement_mint.decimals;
        market.enabled = true;
        market.creator = ctx.accounts.creator.key();
        market.max_settlement_staleness_seconds = args.max_settlement_staleness_seconds;
        market.strike = args.strike;

        let oracle = &mut ctx.accounts.oracle;
        oracle.bump = ctx.bumps.oracle;
        oracle.market = market.key();
        oracle.price = 0;
        oracle.confidence = 0;
        oracle.observed_at = 0;
        oracle.published_at = 0;
        oracle.price_update = Pubkey::default();
        oracle.feed_id = args.pyth_feed_id;
        oracle.exponent = 0;
        oracle.finalized = false;
        oracle.settled_from_stale_price = false;

        emit!(MarketCreated {
            market: market.key(),
            market_id: market.market_id,
            expiry: market.expiry,
            settlement_mint: market.settlement_mint,
            creator: market.creator,
        });
        Ok(())
    }

    pub fn set_market_enabled(ctx: Context<AdminMarket>, enabled: bool) -> Result<()> {
        ctx.accounts.market.enabled = enabled;
        emit!(MarketEnabled {
            market: ctx.accounts.market.key(),
            enabled,
        });
        Ok(())
    }

    pub fn set_eligibility(
        ctx: Context<SetEligibility>,
        wallet: Pubkey,
        can_trade: bool,
        expires_at: i64,
    ) -> Result<()> {
        require!(
            expires_at > Clock::get()?.unix_timestamp || !can_trade,
            VsolError::InvalidExpiry
        );
        let eligibility = &mut ctx.accounts.eligibility;
        eligibility.bump = ctx.bumps.eligibility;
        eligibility.config = ctx.accounts.config.key();
        eligibility.wallet = wallet;
        eligibility.can_trade = can_trade;
        eligibility.expires_at = expires_at;
        emit!(EligibilityUpdated {
            wallet,
            can_trade,
            expires_at
        });
        Ok(())
    }

    pub fn publish_pyth_settlement(ctx: Context<PublishPythSettlement>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let market = &ctx.accounts.market;
        let oracle = &mut ctx.accounts.oracle;
        require!(!oracle.finalized, VsolError::OracleAlreadyFinalized);
        require!(now >= market.expiry, VsolError::MarketNotExpired);

        let observation_end = market
            .expiry
            .checked_add(i64::from(market.observation_window_seconds))
            .ok_or(VsolError::MathOverflow)?;
        // The FULL settlement deadline: exactly the instant
        // `refund_unsettled` / `refund_pool_position` first become callable
        // (see their own, deliberately-untouched `deadline` computation).
        // Tier 1 has no separate upper bound on `now` of its own -- a
        // tier-1-eligible print stays tier-1-valid all the way out to
        // `final_deadline` below. This variable's only other job is gating
        // tier 2, immediately below.
        let settlement_deadline = observation_end
            .checked_add(i64::from(market.settlement_grace_seconds))
            .ok_or(VsolError::MathOverflow)?;
        // The instant tier 2 may first be used. See
        // `SETTLEMENT_REFUND_PRIORITY_SECONDS` for why this is
        // `settlement_deadline` PLUS a buffer rather than
        // `settlement_deadline` itself -- in short, so tier 2 never becomes
        // eligible in the exact same instant `refund_unsettled` does.
        let tier_two_open_at = settlement_deadline
            .checked_add(SETTLEMENT_REFUND_PRIORITY_SECONDS)
            .ok_or(VsolError::MathOverflow)?;
        // The instruction's own hard close: past this, NEITHER tier can ever
        // publish again. Deliberately `settlement_deadline + staleness`, NOT
        // `tier_two_open_at + staleness` -- the priority buffer above trims
        // tier 2's window from the front only, so it never pushes this back
        // edge later. That keeps this within `MARKET_CLEANUP_BUFFER_SECONDS`
        // of `settlement_deadline` for every legal market (staleness is
        // capped at `MAX_SETTLEMENT_STALENESS_SECONDS`, which is exactly
        // `MARKET_CLEANUP_BUFFER_SECONDS`), which is what lets
        // `close_settled_market`'s doc comment claim that nothing can ever
        // publish past its own cleanup cutoff.
        //
        // Computed via the shared `final_settlement_deadline` helper, not
        // inline: `redeem_unresolved`'s escape hatch opens at exactly this
        // instant (`now > final_settlement_deadline(market)`), and the two
        // paths must stay strictly mutually exclusive -- see that function's
        // own doc comment.
        let final_deadline = final_settlement_deadline(market)?;
        require!(now <= final_deadline, VsolError::SettlementWindowClosed);

        let pyth_price = parse_fully_verified_price_update(
            &ctx.accounts.price_update.to_account_info(),
            market.pyth_feed_id,
        )?;

        // Tier 1 (preferred, unchanged): a print inside the primary
        // observation window settles exactly as before, at any point up to
        // `final_deadline`. This is the only path used while Pyth equities
        // are actively publishing, and -- because it has no upper bound on
        // `now` beyond the instruction's own hard close -- anyone holding a
        // genuine tier-1 print can always publish it right up until tier 2
        // (or refund) would otherwise apply, so a real print always wins the
        // race against a stale one.
        let tier_one_ok = pyth_price.publish_time >= market.expiry
            && pyth_price.publish_time <= observation_end
            && pyth_price.publish_time <= now;

        // Tier 2 (last-known price, fallback -- FIXED): gated on the FULL
        // settlement deadline (`tier_two_open_at`, i.e.
        // `expiry + observation_window_seconds + settlement_grace_seconds +
        // SETTLEMENT_REFUND_PRIORITY_SECONDS`), not on `observation_end`.
        // Before this fix, tier 2 opened moments after `observation_end` --
        // with the SDK's 30s observation window, that is the steady state
        // starting 30 seconds after every single expiry, not a rare
        // fallback. Because a tier-1-eligible print stays valid forever
        // after (see `tier_one_ok` above), both branches of
        // `tier_one_ok || tier_two_ok` were simultaneously satisfiable for
        // the entire multi-hundred-second `settlement_grace_seconds` window
        // (and beyond), and the settler could simply pick whichever
        // historical price, within `max_settlement_staleness_seconds`,
        // produced the payout they wanted. Requiring the ENTIRE tier-1
        // window AND grace period (plus the small tie-breaking buffer) to
        // have elapsed with nobody settling makes tier 2 an actual last
        // resort: it is now unreachable for as long as any real print could
        // still be published, and only becomes usable once the feed has
        // genuinely gone dark for the equities overnight/weekend case this
        // exists for. The update itself remains cryptographically verified
        // by the Pyth receiver and the confidence-bound check below still
        // applies, so this only widens *when* a legitimate price is
        // acceptable, never *who* may supply one.
        let tier_two_ok = now > tier_two_open_at
            && pyth_price.publish_time <= market.expiry
            && market
                .expiry
                .checked_sub(pyth_price.publish_time)
                .map(|staleness| staleness <= i64::from(market.max_settlement_staleness_seconds))
                .unwrap_or(false);

        require!(tier_one_ok || tier_two_ok, VsolError::InvalidObservationTime);
        let settled_from_stale_price = !tier_one_ok;

        // Bounds the update's absolute staleness (publish_time -> now). This
        // must not defeat a legitimate tier-2 print, so it is widened to
        // cover the worst case across both tiers: a tier-1 print can be as
        // old as `expiry` when `now` reaches `final_deadline`, and a tier-2
        // print can additionally be published as late as `final_deadline`
        // while being as old as `expiry - max_settlement_staleness_seconds`
        // -- a gap of `final_deadline - (expiry - max_settlement_staleness_seconds)`,
        // i.e. `observation_window + settlement_grace + 2 * staleness` (the
        // staleness term appears twice: once bounding how old the print may
        // be, once more bounding how much later than `settlement_deadline`
        // it may still be published). The configured staleness bound remains
        // the operative limit on how stale a tier-2 price may be relative to
        // `expiry`; this check is a secondary sanity bound on the gap
        // between publish time and `now`.
        let maximum_age = i64::from(market.observation_window_seconds)
            .checked_add(i64::from(market.settlement_grace_seconds))
            .and_then(|value| {
                i64::from(market.max_settlement_staleness_seconds)
                    .checked_mul(2)
                    .and_then(|doubled_staleness| value.checked_add(doubled_staleness))
            })
            .ok_or(VsolError::MathOverflow)?;
        require!(
            pyth_price.publish_time.saturating_add(maximum_age) >= now,
            VsolError::InvalidPythPriceUpdate
        );
        let (price, confidence) = normalize_pyth_price(pyth_price, market.price_scale)?;

        let confidence_bps = (confidence as u128)
            .checked_mul(BPS_DENOMINATOR as u128)
            .ok_or(VsolError::MathOverflow)?;
        let max_confidence = (price as u128)
            .checked_mul(market.max_confidence_bps as u128)
            .ok_or(VsolError::MathOverflow)?;
        require!(
            confidence_bps <= max_confidence,
            VsolError::OracleConfidenceTooWide
        );

        oracle.price = price;
        oracle.confidence = confidence;
        oracle.observed_at = pyth_price.publish_time;
        oracle.published_at = now;
        oracle.price_update = ctx.accounts.price_update.key();
        oracle.feed_id = market.pyth_feed_id;
        oracle.exponent = pyth_price.exponent;
        oracle.finalized = true;
        oracle.settled_from_stale_price = settled_from_stale_price;
        emit!(SettlementPublished {
            market: market.key(),
            price,
            confidence,
            observed_at: pyth_price.publish_time,
            price_update: ctx.accounts.price_update.key(),
            feed_id: market.pyth_feed_id,
            settled_from_stale_price,
        });
        Ok(())
    }

    pub fn initialize_liquidity_pool(
        ctx: Context<InitializeLiquidityPool>,
        args: InitializeLiquidityPoolArgs,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, VsolError::ProtocolPaused);
        require!(
            args.quote_authority != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        validate_pool_risk_limits(args.max_utilization_bps, args.max_position_bps)?;

        let pool = &mut ctx.accounts.pool;
        pool.bump = ctx.bumps.pool;
        pool.token_bump = ctx.bumps.pool_token;
        pool.config = ctx.accounts.config.key();
        pool.settlement_mint = ctx.accounts.settlement_mint.key();
        pool.quote_authority = args.quote_authority;
        pool.pool_id = args.pool_id;
        pool.total_shares = 0;
        pool.locked_collateral = 0;
        pool.total_assets = 0;
        pool.open_positions = 0;
        pool.cumulative_premium = 0;
        pool.cumulative_payout = 0;
        pool.max_utilization_bps = args.max_utilization_bps;
        pool.max_position_bps = args.max_position_bps;
        pool.manager = ctx.accounts.creator.key();
        // No pending change on creation. `pending_effective_at == 0` is the
        // sentinel for "nothing pending" throughout update/apply/cancel
        // below; Anchor already zero-initializes this, but it's set
        // explicitly here for the same reason every other field above is.
        pool.pending_quote_authority = Pubkey::default();
        pool.pending_max_utilization_bps = 0;
        pool.pending_max_position_bps = 0;
        pool.pending_effective_at = 0;

        emit!(LiquidityPoolInitialized {
            pool: pool.key(),
            settlement_mint: pool.settlement_mint,
            quote_authority: pool.quote_authority,
            manager: pool.manager,
        });
        Ok(())
    }

    pub fn set_liquidity_pool_market(
        ctx: Context<SetLiquidityPoolMarket>,
        args: SetLiquidityPoolMarketArgs,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        // `pool_market` is created or mutated BY HAND here (not via Anchor's
        // `init_if_needed` sugar) -- see `SetLiquidityPoolMarket::pool_market`'s
        // own doc comment for why: that sugar's automatic
        // `space == data_len()` equality check would hard-reject every
        // pre-existing, legacy 82-byte `LiquidityPoolMarket` account the
        // moment the struct grew by `OpenPositionCount`'s 4 bytes, breaking
        // this instruction for every binding that already existed before
        // this upgrade. A brand new (never-created) PDA is still owned by
        // the System Program, which is what distinguishes the two cases --
        // this is the same signal Anchor's own `init_if_needed` codegen uses
        // internally, just applied by hand.
        let pool_market_info = ctx.accounts.pool_market.to_account_info();
        let needs_creation = pool_market_info.owner == &System::id();
        let is_first_time_enable = needs_creation && args.enabled;

        // Authorizing a brand-new series is additive: it cannot change the
        // risk of any position that already exists, because per-position
        // collateral is fixed at fill time and utilization/per-position caps
        // are enforced then too. Mutating an *existing* authorization is not
        // additive — e.g. disabling a series or moving its trade cutoff can
        // affect positions that were opened depending on it — so that case
        // stays gated on the pool being fully idle.
        if !is_first_time_enable {
            require!(
                ctx.accounts.pool.open_positions == 0 && ctx.accounts.pool.locked_collateral == 0,
                VsolError::PoolHasOpenPositions
            );
        }
        require_keys_eq!(
            ctx.accounts.market.settlement_mint,
            ctx.accounts.pool.settlement_mint,
            VsolError::InvalidMarket
        );
        if args.enabled {
            require!(ctx.accounts.market.enabled, VsolError::MarketDisabled);
            require!(
                args.last_trade_at >= now.saturating_add(MIN_MARKET_LEAD_SECONDS)
                    && args.last_trade_at < ctx.accounts.market.expiry,
                VsolError::InvalidLastTradeCutoff
            );
        }

        let bump = ctx.bumps.pool_market;
        let pool_key = ctx.accounts.pool.key();
        let market_key = ctx.accounts.market.key();

        if needs_creation {
            let space = 8 + LiquidityPoolMarket::INIT_SPACE;
            let lamports = Rent::get()?.minimum_balance(space);
            let signer_seeds: &[&[u8]] =
                &[POOL_MARKET_SEED, pool_key.as_ref(), market_key.as_ref(), &[bump]];
            anchor_lang::system_program::create_account(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::CreateAccount {
                        from: ctx.accounts.manager.to_account_info(),
                        to: pool_market_info.clone(),
                    },
                )
                .with_signer(&[signer_seeds]),
                lamports,
                space as u64,
                &crate::ID,
            )?;
            let fresh = LiquidityPoolMarket {
                bump,
                pool: pool_key,
                market: market_key,
                last_trade_at: args.last_trade_at,
                enabled: args.enabled,
                open_positions: OpenPositionCount::ZERO,
            };
            let mut data = pool_market_info.try_borrow_mut_data()?;
            let mut writer = anchor_lang::__private::BpfWriter::new(&mut data[..]);
            fresh.try_serialize(&mut writer)?;
        } else {
            // Owned by us already (the only two possible owners of this
            // exact PDA are the System Program, handled above, and this
            // program -- see the doc comment above).
            require_keys_eq!(
                *pool_market_info.owner,
                crate::ID,
                VsolError::InvalidPoolMarket
            );
            let mut existing: LiquidityPoolMarket = {
                let data = pool_market_info.try_borrow_data()?;
                LiquidityPoolMarket::try_deserialize(&mut &data[..])?
            };
            require_keys_eq!(existing.pool, pool_key, VsolError::InvalidPoolMarket);
            require_keys_eq!(existing.market, market_key, VsolError::InvalidPoolMarket);
            existing.last_trade_at = args.last_trade_at;
            existing.enabled = args.enabled;
            let mut data = pool_market_info.try_borrow_mut_data()?;
            let mut writer = anchor_lang::__private::BpfWriter::new(&mut data[..]);
            existing.try_serialize(&mut writer)?;
        }

        emit!(LiquidityPoolMarketUpdated {
            pool: pool_key,
            market: market_key,
            last_trade_at: args.last_trade_at,
            enabled: args.enabled,
        });
        Ok(())
    }

    /// Updates a liquidity pool's risk configuration. Split into an
    /// immediate path for LP-safe tightening and a timelocked path for
    /// everything else, because pool creation is permissionless -- a
    /// pool's `manager` is an untrusted role, not an insider. Before this
    /// split, a manager could raise `max_utilization_bps` to 100% and
    /// rotate `quote_authority` to a key they control in a single
    /// instruction with zero notice, then self-sign a `fill_pool_quote`
    /// for (almost) the whole pool and extract it via `close_pool_position`
    /// in the same transaction. `MAX_POOL_UTILIZATION_BPS` closes the
    /// "whole pool in one fill" half of that; this timelock closes the
    /// "zero notice" half, which is the half that actually matters --
    /// see `POOL_UPDATE_TIMELOCK_SECONDS`.
    ///
    /// - Lowering `max_utilization_bps` and/or `max_position_bps`, with
    ///   `quote_authority` left unchanged, applies immediately in this same
    ///   instruction: it can only shrink what the pool is exposed to, so LPs
    ///   never need advance notice of their own protection getting stricter.
    /// - Anything else -- raising either cap above its current value, or
    ///   rotating `quote_authority` at all, even alongside a lowered cap --
    ///   is recorded as a pending change (`pending_*` fields) with
    ///   `pending_effective_at = now + POOL_UPDATE_TIMELOCK_SECONDS`, and an
    ///   `LiquidityPoolUpdateProposed` event carrying `effective_at` so LPs
    ///   and indexers can observe it and choose to withdraw. Nothing about
    ///   the pool's *live*, currently-effective configuration changes until
    ///   `apply_liquidity_pool_update` commits it. `cancel_pending_pool_update`
    ///   lets the manager clear a mistaken proposal before that.
    ///
    /// RESIDUAL HOLE (documented, not fixed here): both this instruction and
    /// `apply_liquidity_pool_update` require the pool be idle
    /// (`open_positions == 0 && locked_collateral == 0`), the same gate
    /// `withdraw_liquidity` uses. During the timelock window a malicious
    /// manager can self-sign a `fill_pool_quote` to open a position, which
    /// blocks LP withdrawals for as long as it stays open, then close it
    /// again right before calling `apply_liquidity_pool_update` (which also
    /// requires idle). This does not make the window unbounded -- returning
    /// the pool to idle to apply the change is itself observable and gives
    /// LPs another chance to react between "position closed" and "update
    /// applied" -- but it is not guaranteed to give LPs a long clear window
    /// either. The complete fix is letting LPs withdraw *unlocked* capital
    /// while positions remain open, which is a larger redesign of
    /// `withdraw_liquidity`'s idle gate than this pass makes, and remains
    /// the right next step before real money.
    pub fn update_liquidity_pool(
        ctx: Context<UpdateLiquidityPool>,
        args: UpdateLiquidityPoolArgs,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.open_positions == 0 && ctx.accounts.pool.locked_collateral == 0,
            VsolError::PoolHasOpenPositions
        );
        require!(
            args.quote_authority != Pubkey::default(),
            VsolError::InvalidAuthority
        );
        validate_pool_risk_limits(args.max_utilization_bps, args.max_position_bps)?;

        let pool = &mut ctx.accounts.pool;
        let is_tightening_only = args.quote_authority == pool.quote_authority
            && args.max_utilization_bps <= pool.max_utilization_bps
            && args.max_position_bps <= pool.max_position_bps;

        if is_tightening_only {
            pool.max_utilization_bps = args.max_utilization_bps;
            pool.max_position_bps = args.max_position_bps;
            emit!(LiquidityPoolUpdated {
                pool: pool.key(),
                quote_authority: pool.quote_authority,
                max_utilization_bps: pool.max_utilization_bps,
                max_position_bps: pool.max_position_bps,
            });
            return Ok(());
        }

        let now = Clock::get()?.unix_timestamp;
        let effective_at = now
            .checked_add(POOL_UPDATE_TIMELOCK_SECONDS)
            .ok_or(VsolError::MathOverflow)?;
        pool.pending_quote_authority = args.quote_authority;
        pool.pending_max_utilization_bps = args.max_utilization_bps;
        pool.pending_max_position_bps = args.max_position_bps;
        pool.pending_effective_at = effective_at;

        emit!(LiquidityPoolUpdateProposed {
            pool: pool.key(),
            pending_quote_authority: pool.pending_quote_authority,
            pending_max_utilization_bps: pool.pending_max_utilization_bps,
            pending_max_position_bps: pool.pending_max_position_bps,
            effective_at,
        });
        Ok(())
    }

    /// Commits a pending `update_liquidity_pool` proposal once its timelock
    /// has elapsed. Requires the pool idle for the same reason
    /// `update_liquidity_pool` does: applying while `open_positions > 0`
    /// would change the risk backing an already-open position out from
    /// under it. See `update_liquidity_pool`'s doc comment for the residual
    /// gap this does not close.
    pub fn apply_liquidity_pool_update(ctx: Context<ApplyLiquidityPoolUpdate>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        require!(
            pool.open_positions == 0 && pool.locked_collateral == 0,
            VsolError::PoolHasOpenPositions
        );
        require!(pool.pending_effective_at != 0, VsolError::NoPendingPoolUpdate);
        require!(
            now >= pool.pending_effective_at,
            VsolError::PoolUpdateTimelocked
        );
        // Re-validate at APPLY time, not just at propose time. A proposal can
        // sit pending indefinitely, so if a program upgrade ever tightens
        // MAX_POOL_UTILIZATION_BPS, a proposal made under the old ceiling
        // must not be able to sail past the new one just because it was
        // recorded first.
        validate_pool_risk_limits(pool.pending_max_utilization_bps, pool.pending_max_position_bps)?;

        pool.quote_authority = pool.pending_quote_authority;
        pool.max_utilization_bps = pool.pending_max_utilization_bps;
        pool.max_position_bps = pool.pending_max_position_bps;
        pool.pending_quote_authority = Pubkey::default();
        pool.pending_max_utilization_bps = 0;
        pool.pending_max_position_bps = 0;
        pool.pending_effective_at = 0;

        emit!(LiquidityPoolUpdated {
            pool: pool.key(),
            quote_authority: pool.quote_authority,
            max_utilization_bps: pool.max_utilization_bps,
            max_position_bps: pool.max_position_bps,
        });
        Ok(())
    }

    /// Lets the manager clear a pending `update_liquidity_pool` proposal
    /// before its timelock elapses, so a mistaken or stale proposal is not
    /// stuck sitting there for `POOL_UPDATE_TIMELOCK_SECONDS`. Cancelling
    /// never touches the pool's live configuration -- there is nothing
    /// unsafe about allowing it regardless of whether the pool is idle.
    pub fn cancel_pending_pool_update(ctx: Context<CancelPendingPoolUpdate>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.pending_effective_at != 0, VsolError::NoPendingPoolUpdate);
        pool.pending_quote_authority = Pubkey::default();
        pool.pending_max_utilization_bps = 0;
        pool.pending_max_position_bps = 0;
        pool.pending_effective_at = 0;
        emit!(LiquidityPoolUpdateCancelled { pool: pool.key() });
        Ok(())
    }

    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        amount: u64,
        min_shares_out: u64,
        deadline: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.config.paused, VsolError::ProtocolPaused);
        require!(now <= deadline, VsolError::DeadlineExpired);
        require!(
            ctx.accounts.pool.open_positions == 0 && ctx.accounts.pool.locked_collateral == 0,
            VsolError::PoolHasOpenPositions
        );
        // Share-price denominator: the pool's own ledger, NOT the raw SPL
        // balance below. `pool_token.amount` can be inflated by anyone via a
        // plain `spl-token transfer` (a token account's owner cannot refuse
        // incoming transfers), which would otherwise let an attacker donate
        // funds to skew the price a victim's deposit is quoted against --
        // the classic first-depositor inflation attack. See `total_assets`'s
        // doc comment on `LiquidityPool`.
        let ledger_assets_before = ctx.accounts.pool.total_assets;
        let shares = calculate_deposit_shares(
            amount,
            ctx.accounts.pool.total_shares,
            ledger_assets_before,
        )?;
        require!(shares >= min_shares_out, VsolError::SlippageExceeded);

        // Separately, the raw pre-transfer balance -- used only to confirm
        // this specific transfer actually moved `amount` (below), which is
        // an orthogonal concern from what the share price is computed
        // against. This is deliberately NOT `ledger_assets_before`: an
        // intervening donation between the last ledger update and this
        // instruction would make them diverge, and the mismatch check must
        // still pass in that ordinary (if unusual) case.
        let token_balance_before = ctx.accounts.pool_token.amount;

        transfer_checked(
            ctx.accounts.token_program.key(),
            ctx.accounts.provider_source.to_account_info(),
            ctx.accounts.pool_token.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.provider.to_account_info(),
            amount,
            ctx.accounts.settlement_mint.decimals,
        )?;
        ctx.accounts.pool_token.reload()?;
        require!(
            ctx.accounts.pool_token.amount
                == token_balance_before
                    .checked_add(amount)
                    .ok_or(VsolError::MathOverflow)?,
            VsolError::CollateralMismatch
        );

        let provider_position = &mut ctx.accounts.provider_position;
        if provider_position.pool == Pubkey::default() {
            provider_position.bump = ctx.bumps.provider_position;
            provider_position.pool = ctx.accounts.pool.key();
            provider_position.owner = ctx.accounts.provider.key();
        }
        provider_position.shares = provider_position
            .shares
            .checked_add(shares)
            .ok_or(VsolError::MathOverflow)?;
        provider_position.total_deposited = provider_position
            .total_deposited
            .checked_add(amount)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.total_shares = ctx
            .accounts
            .pool
            .total_shares
            .checked_add(shares)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.total_assets = ctx
            .accounts
            .pool
            .total_assets
            .checked_add(amount)
            .ok_or(VsolError::MathOverflow)?;

        emit!(LiquidityDeposited {
            pool: ctx.accounts.pool.key(),
            provider: ctx.accounts.provider.key(),
            amount,
            shares,
        });
        Ok(())
    }

    pub fn withdraw_liquidity(
        ctx: Context<WithdrawLiquidity>,
        shares: u64,
        min_amount_out: u64,
        deadline: i64,
    ) -> Result<()> {
        require!(
            Clock::get()?.unix_timestamp <= deadline,
            VsolError::DeadlineExpired
        );
        require!(
            ctx.accounts.pool.open_positions == 0 && ctx.accounts.pool.locked_collateral == 0,
            VsolError::PoolHasOpenPositions
        );
        require!(
            ctx.accounts.provider_position.shares >= shares,
            VsolError::InvalidPoolShares
        );
        // Ledger, not raw SPL balance -- see `total_assets`'s doc comment on
        // `LiquidityPool` and the matching note in `deposit_liquidity`.
        let amount = calculate_withdraw_amount(
            shares,
            ctx.accounts.pool.total_shares,
            ctx.accounts.pool.total_assets,
        )?;
        require!(amount >= min_amount_out, VsolError::SlippageExceeded);

        ctx.accounts.provider_position.shares = ctx
            .accounts
            .provider_position
            .shares
            .checked_sub(shares)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.provider_position.total_withdrawn = ctx
            .accounts
            .provider_position
            .total_withdrawn
            .checked_add(amount)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.total_shares = ctx
            .accounts
            .pool
            .total_shares
            .checked_sub(shares)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.total_assets = ctx
            .accounts
            .pool
            .total_assets
            .checked_sub(amount)
            .ok_or(VsolError::MathOverflow)?;

        let config_key = ctx.accounts.config.key();
        let settlement_mint_key = ctx.accounts.settlement_mint.key();
        let pool_seeds: &[&[u8]] = &[
            POOL_SEED,
            config_key.as_ref(),
            settlement_mint_key.as_ref(),
            ctx.accounts.pool.pool_id.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        transfer_checked_signed(
            ctx.accounts.token_program.key(),
            ctx.accounts.pool_token.to_account_info(),
            ctx.accounts.provider_destination.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            amount,
            ctx.accounts.settlement_mint.decimals,
            pool_seeds,
        )?;
        emit!(LiquidityWithdrawn {
            pool: ctx.accounts.pool.key(),
            provider: ctx.accounts.provider.key(),
            amount,
            shares,
        });
        Ok(())
    }

    pub fn fill_pool_quote(ctx: Context<FillPoolQuote>, quote: PoolQuoteArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let market = &ctx.accounts.market;
        let pool = &ctx.accounts.pool;
        require!(!config.paused, VsolError::ProtocolPaused);
        require!(market.enabled, VsolError::MarketDisabled);
        require!(
            ctx.accounts.pool_market.enabled,
            VsolError::PoolMarketDisabled
        );
        require!(now < market.expiry, VsolError::MarketExpired);
        require!(
            now < ctx.accounts.pool_market.last_trade_at,
            VsolError::LastTradeCutoffReached
        );
        require!(
            now <= quote.quote_expiry
                && quote.quote_expiry <= ctx.accounts.pool_market.last_trade_at
                && quote.quote_expiry < market.expiry,
            VsolError::QuoteExpired
        );
        require!(
            quote.premium > 0 && quote.max_payout > 0,
            VsolError::InvalidAmount
        );
        require!(quote.strike > 0 && quote.width > 0, VsolError::InvalidWidth);
        Direction::try_from(quote.direction)?;
        require!(pool.total_shares > 0, VsolError::InvalidPoolShares);

        if config.eligibility_required {
            let eligibility = ctx
                .accounts
                .eligibility
                .as_ref()
                .ok_or(VsolError::EligibilityRequired)?;
            require_keys_eq!(
                eligibility.config,
                config.key(),
                VsolError::InvalidEligibility
            );
            require_keys_eq!(
                eligibility.wallet,
                ctx.accounts.buyer.key(),
                VsolError::InvalidEligibility
            );
            require!(
                eligibility.can_trade && eligibility.expires_at >= now,
                VsolError::IneligibleWallet
            );
        }

        let config_key = config.key();
        let pool_key = pool.key();
        let market_key = market.key();
        let buyer_key = ctx.accounts.buyer.key();
        let authority_key = ctx.accounts.quote_authority.key();
        let quote_context = PoolQuoteMessageContext {
            program_id: &crate::ID,
            config: &config_key,
            pool: &pool_key,
            market: &market_key,
            buyer: &buyer_key,
            quote_authority: &authority_key,
        };
        let message = pool_quote_message(
            &config.domain_separator,
            config.domain_version,
            &quote_context,
            &quote,
        );
        verify_preceding_ed25519_instruction(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &authority_key,
            &message,
        )?;

        // Ledger, not raw SPL balance -- see `total_assets`'s doc comment on
        // `LiquidityPool`. Using the donation-inflatable `pool_token.amount`
        // here would let anyone puff up the pool's apparent utilization
        // headroom (and the sufficiency check just below) without
        // depositing anything real.
        let total_collateral = pool
            .total_assets
            .checked_add(pool.locked_collateral)
            .ok_or(VsolError::MathOverflow)?;
        let utilization_limit = calculate_bps_limit(total_collateral, pool.max_utilization_bps)?;
        let position_limit = calculate_bps_limit(total_collateral, pool.max_position_bps)?;
        let locked_after = pool
            .locked_collateral
            .checked_add(quote.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        require!(
            locked_after <= utilization_limit,
            VsolError::PoolUtilizationExceeded
        );
        require!(
            quote.max_payout <= position_limit,
            VsolError::PoolPositionLimitExceeded
        );
        require!(
            pool.total_assets >= quote.max_payout,
            VsolError::InsufficientWriterLiquidity
        );

        transfer_checked(
            ctx.accounts.token_program.key(),
            ctx.accounts.buyer_source.to_account_info(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            quote.premium,
            ctx.accounts.settlement_mint.decimals,
        )?;
        let settlement_mint_key = ctx.accounts.settlement_mint.key();
        let pool_seeds: &[&[u8]] = &[
            POOL_SEED,
            config_key.as_ref(),
            settlement_mint_key.as_ref(),
            pool.pool_id.as_ref(),
            &[pool.bump],
        ];
        transfer_checked_signed(
            ctx.accounts.token_program.key(),
            ctx.accounts.pool_token.to_account_info(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            quote.max_payout,
            ctx.accounts.settlement_mint.decimals,
            pool_seeds,
        )?;
        ctx.accounts.position_vault.reload()?;
        let expected_escrow = quote
            .premium
            .checked_add(quote.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        require!(
            ctx.accounts.position_vault.amount == expected_escrow,
            VsolError::CollateralMismatch
        );

        let record = &mut ctx.accounts.nonce_record;
        record.bump = ctx.bumps.nonce_record;
        record.status = NonceStatus::Filled as u8;
        record.pool = pool_key;
        record.quote_authority = authority_key;
        record.nonce = quote.nonce;
        record.position = ctx.accounts.position.key();

        let position = &mut ctx.accounts.position;
        position.bump = ctx.bumps.position;
        position.vault_bump = ctx.bumps.position_vault;
        position.status = PositionStatus::Open as u8;
        position.direction = quote.direction;
        position.pool = pool_key;
        position.market = market_key;
        position.nonce_record = record.key();
        position.buyer = buyer_key;
        position.quote_authority = authority_key;
        position.settlement_mint = settlement_mint_key;
        position.nonce = quote.nonce;
        position.strike = quote.strike;
        position.width = quote.width;
        position.premium = quote.premium;
        position.max_payout = quote.max_payout;
        position.fee_bps = config.fee_bps;
        position.opened_at = now;
        position.quote_expiry = quote.quote_expiry;

        ctx.accounts.pool.locked_collateral = locked_after;
        ctx.accounts.pool.open_positions = ctx
            .accounts
            .pool
            .open_positions
            .checked_add(1)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.total_assets = ctx
            .accounts
            .pool
            .total_assets
            .checked_sub(quote.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        // Per-market counter used by `close_settled_market` to refuse
        // closing this market while it still has an open pool position --
        // see `OpenPositionCount`'s doc comment on `LiquidityPoolMarket`.
        ctx.accounts.pool_market.open_positions =
            ctx.accounts.pool_market.open_positions.checked_increment()?;
        emit!(PoolQuoteFilled {
            position: position.key(),
            pool: pool_key,
            market: market_key,
            buyer: buyer_key,
            quote_authority: authority_key,
            nonce: quote.nonce,
            premium: quote.premium,
            max_payout: quote.max_payout,
        });
        Ok(())
    }

    pub fn settle_pool_position(ctx: Context<SettlePoolPosition>) -> Result<()> {
        let position = &ctx.accounts.position;
        let market = &ctx.accounts.market;
        let oracle = &ctx.accounts.oracle;
        // See `SettlePoolPosition::pool_market`'s doc comment: this replaces
        // a `has_one` constraint that would have exceeded the BPF stack
        // frame limit in `try_accounts`.
        require_keys_eq!(
            ctx.accounts.pool_market.pool,
            ctx.accounts.pool.key(),
            VsolError::InvalidPoolMarket
        );
        require_keys_eq!(
            ctx.accounts.pool_market.market,
            market.key(),
            VsolError::InvalidPoolMarket
        );
        require!(
            position.status == PositionStatus::Open as u8,
            VsolError::PositionNotOpen
        );
        require!(oracle.finalized, VsolError::OracleNotFinalized);
        require!(
            Clock::get()?.unix_timestamp >= market.expiry,
            VsolError::MarketNotExpired
        );
        let payout = calculate_payout(
            position.direction,
            position.strike,
            position.width,
            oracle.price,
            position.max_payout,
        )?;
        // The protocol fee is a share of the WINNING PAYOUT, taken from the
        // buyer's side -- not a share of the premium taken from the pool's.
        // Two consequences follow, and both are the point:
        //   * a losing position has `payout == 0`, so it pays no fee at all;
        //   * a winner receives `payout - fee`, so the fee scales with what
        //     they actually won.
        // `fee_bps` is still read from the POSITION, not from config, so a
        // filled quote cannot become more expensive if governance changes the
        // fee before expiry.
        let fee = calculate_fee(payout, position.fee_bps)?;
        let buyer_amount = payout.checked_sub(fee).ok_or(VsolError::MathOverflow)?;
        // The pool's share is unchanged by the fee: it still recovers the
        // collateral it did not lose, plus the whole premium.
        let pool_amount = position
            .max_payout
            .checked_sub(payout)
            .and_then(|value| value.checked_add(position.premium))
            .ok_or(VsolError::MathOverflow)?;
        let expected = position
            .premium
            .checked_add(position.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        // Conservation still holds exactly, with the fee moved to the buyer's
        // side of the split:
        //   (payout - fee) + (max_payout - payout + premium) + fee
        //     == max_payout + premium
        require!(
            buyer_amount
                .checked_add(pool_amount)
                .and_then(|value| value.checked_add(fee))
                == Some(expected)
                && ctx.accounts.position_vault.amount == expected,
            VsolError::CollateralMismatch
        );

        ctx.accounts.pool.locked_collateral = ctx
            .accounts
            .pool
            .locked_collateral
            .checked_sub(position.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.open_positions = ctx
            .accounts
            .pool
            .open_positions
            .checked_sub(1)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool_market.open_positions =
            ctx.accounts.pool_market.open_positions.checked_decrement()?;
        ctx.accounts.pool.cumulative_premium = ctx
            .accounts
            .pool
            .cumulative_premium
            .checked_add(position.premium)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.cumulative_payout = ctx
            .accounts
            .pool
            .cumulative_payout
            .checked_add(payout)
            .ok_or(VsolError::MathOverflow)?;
        // `pool_amount` is what actually lands back in `pool_token` below --
        // see `total_assets`'s doc comment on `LiquidityPool`.
        ctx.accounts.pool.total_assets = ctx
            .accounts
            .pool
            .total_assets
            .checked_add(pool_amount)
            .ok_or(VsolError::MathOverflow)?;

        let nonce_record_key = ctx.accounts.nonce_record.key();
        let position_seeds: &[&[u8]] = &[
            POOL_POSITION_SEED,
            nonce_record_key.as_ref(),
            &[position.bump],
        ];
        // The buyer may also be `config.treasury_owner` (see
        // `SettlePoolPosition::treasury_destination`'s `dup` constraint,
        // which permits `buyer_destination == treasury_destination` while
        // the owner/mint constraints above still reject any OTHER alias).
        // When that happens, fold the two transfers into one: it is
        // economically identical (the buyer ends up with exactly
        // `buyer_amount + fee == payout`, same as two sequential transfers
        // into the same account would produce), and it means this program
        // never issues two token transfers into the literal same
        // destination account in one instruction.
        let buyer_is_treasury =
            ctx.accounts.buyer_destination.key() == ctx.accounts.treasury_destination.key();
        if buyer_is_treasury {
            let combined = buyer_amount.checked_add(fee).ok_or(VsolError::MathOverflow)?;
            if combined > 0 {
                transfer_checked_signed(
                    ctx.accounts.token_program.key(),
                    ctx.accounts.position_vault.to_account_info(),
                    ctx.accounts.buyer_destination.to_account_info(),
                    ctx.accounts.settlement_mint.to_account_info(),
                    ctx.accounts.position.to_account_info(),
                    combined,
                    ctx.accounts.settlement_mint.decimals,
                    position_seeds,
                )?;
            }
        } else {
            if buyer_amount > 0 {
                transfer_checked_signed(
                    ctx.accounts.token_program.key(),
                    ctx.accounts.position_vault.to_account_info(),
                    ctx.accounts.buyer_destination.to_account_info(),
                    ctx.accounts.settlement_mint.to_account_info(),
                    ctx.accounts.position.to_account_info(),
                    buyer_amount,
                    ctx.accounts.settlement_mint.decimals,
                    position_seeds,
                )?;
            }
            if fee > 0 {
                transfer_checked_signed(
                    ctx.accounts.token_program.key(),
                    ctx.accounts.position_vault.to_account_info(),
                    ctx.accounts.treasury_destination.to_account_info(),
                    ctx.accounts.settlement_mint.to_account_info(),
                    ctx.accounts.position.to_account_info(),
                    fee,
                    ctx.accounts.settlement_mint.decimals,
                    position_seeds,
                )?;
            }
        }
        if pool_amount > 0 {
            transfer_checked_signed(
                ctx.accounts.token_program.key(),
                ctx.accounts.position_vault.to_account_info(),
                ctx.accounts.pool_token.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.position.to_account_info(),
                pool_amount,
                ctx.accounts.settlement_mint.decimals,
                position_seeds,
            )?;
        }
        close_token_account(
            ctx.accounts.token_program.key(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.rent_recipient.to_account_info(),
            ctx.accounts.position.to_account_info(),
            position_seeds,
        )?;
        emit!(PoolPositionSettled {
            position: position.key(),
            pool: ctx.accounts.pool.key(),
            settlement_price: oracle.price,
            payout,
            pool_amount,
            fee,
        });
        Ok(())
    }

    pub fn refund_pool_position(ctx: Context<RefundPoolPosition>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let position = &ctx.accounts.position;
        let market = &ctx.accounts.market;
        // See `SettlePoolPosition::pool_market`'s doc comment: this replaces
        // a `has_one` constraint that would have exceeded the BPF stack
        // frame limit in `try_accounts`.
        require_keys_eq!(
            ctx.accounts.pool_market.pool,
            ctx.accounts.pool.key(),
            VsolError::InvalidPoolMarket
        );
        require_keys_eq!(
            ctx.accounts.pool_market.market,
            market.key(),
            VsolError::InvalidPoolMarket
        );
        require!(
            position.status == PositionStatus::Open as u8,
            VsolError::PositionNotOpen
        );
        require!(
            !ctx.accounts.oracle.finalized,
            VsolError::OracleAlreadyFinalized
        );
        let deadline = market
            .expiry
            .checked_add(i64::from(market.observation_window_seconds))
            .and_then(|value| value.checked_add(i64::from(market.settlement_grace_seconds)))
            .ok_or(VsolError::MathOverflow)?;
        require!(now > deadline, VsolError::SettlementWindowOpen);
        let expected = position
            .premium
            .checked_add(position.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        require!(
            ctx.accounts.position_vault.amount == expected,
            VsolError::CollateralMismatch
        );
        ctx.accounts.pool.locked_collateral = ctx
            .accounts
            .pool
            .locked_collateral
            .checked_sub(position.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.open_positions = ctx
            .accounts
            .pool
            .open_positions
            .checked_sub(1)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool_market.open_positions =
            ctx.accounts.pool_market.open_positions.checked_decrement()?;
        // `position.max_payout` is what actually lands back in `pool_token`
        // below (the premium goes to the buyer, not the pool) -- see
        // `total_assets`'s doc comment on `LiquidityPool`.
        ctx.accounts.pool.total_assets = ctx
            .accounts
            .pool
            .total_assets
            .checked_add(position.max_payout)
            .ok_or(VsolError::MathOverflow)?;

        let nonce_record_key = ctx.accounts.nonce_record.key();
        let position_seeds: &[&[u8]] = &[
            POOL_POSITION_SEED,
            nonce_record_key.as_ref(),
            &[position.bump],
        ];
        transfer_checked_signed(
            ctx.accounts.token_program.key(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.buyer_destination.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.position.to_account_info(),
            position.premium,
            ctx.accounts.settlement_mint.decimals,
            position_seeds,
        )?;
        transfer_checked_signed(
            ctx.accounts.token_program.key(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.pool_token.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.position.to_account_info(),
            position.max_payout,
            ctx.accounts.settlement_mint.decimals,
            position_seeds,
        )?;
        close_token_account(
            ctx.accounts.token_program.key(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.rent_recipient.to_account_info(),
            ctx.accounts.position.to_account_info(),
            position_seeds,
        )?;
        emit!(PoolPositionRefunded {
            position: position.key(),
            pool: ctx.accounts.pool.key(),
            premium: position.premium,
            collateral: position.max_payout,
        });
        Ok(())
    }

    /// Lets a buyer exit an open pool-backed position before expiry by
    /// selling it back to the pool at a price the pool's own
    /// `quote_authority` quotes and signs one-shot, exactly like it signs
    /// fills. This is the buyer's only way out before settlement/timeout
    /// refund; today they are locked in until one of those two paths.
    ///
    /// Guardian: this is a buyer exit, so -- like `settle`/`settle_pool_position`
    /// -- it must work even while the protocol is paused. It is intentionally
    /// NOT gated on `config.paused`.
    pub fn close_pool_position(ctx: Context<ClosePoolPosition>, args: PoolBuybackArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let position = &ctx.accounts.position;
        let market = &ctx.accounts.market;
        let oracle = &ctx.accounts.oracle;
        let pool = &ctx.accounts.pool;

        require!(
            position.status == PositionStatus::Open as u8,
            VsolError::PositionNotOpen
        );
        require!(now < market.expiry, VsolError::MarketExpired);
        require!(!oracle.finalized, VsolError::OracleAlreadyFinalized);
        require!(now <= args.quote_expiry, VsolError::QuoteExpired);

        let config_key = ctx.accounts.config.key();
        let pool_key = pool.key();
        let market_key = market.key();
        let position_key = position.key();
        let buyer_key = ctx.accounts.buyer.key();
        let quote_authority_key = pool.quote_authority;
        let message_context = PoolBuybackMessageContext {
            program_id: &crate::ID,
            config: &config_key,
            pool: &pool_key,
            market: &market_key,
            position: &position_key,
            buyer: &buyer_key,
            quote_authority: &quote_authority_key,
        };
        let message = pool_buyback_message(
            &ctx.accounts.config.domain_separator,
            ctx.accounts.config.domain_version,
            &message_context,
            &args,
        );
        verify_preceding_ed25519_instruction(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &quote_authority_key,
            &message,
        )?;

        // HARD INVARIANT: the pool must never pay more to close a position
        // early than its worst-case obligation at expiry (`max_payout`).
        // Regardless of what the pool's quote authority signs, the program
        // itself enforces this bound so early close can never be more
        // expensive to the pool than letting the position run to settlement.
        require!(
            args.buyback_amount <= position.max_payout,
            VsolError::BuybackExceedsMaxPayout
        );
        // The buyer's slippage guard: they will not accept less than this,
        // and it is bound into (and authenticated by) the signed quote above.
        require!(
            args.buyback_amount >= args.min_proceeds,
            VsolError::SlippageExceeded
        );

        // Charge the protocol fee exactly as `settle_pool_position` does, so
        // an early close is economically identical in fee terms to letting
        // the position run to settlement.
        let fee = calculate_fee(position.premium, position.fee_bps)?;
        let expected = position
            .max_payout
            .checked_add(position.premium)
            .ok_or(VsolError::MathOverflow)?;
        let pool_amount = expected
            .checked_sub(args.buyback_amount)
            .and_then(|value| value.checked_sub(fee))
            .ok_or(VsolError::MathOverflow)?;
        require!(
            args.buyback_amount
                .checked_add(pool_amount)
                .and_then(|value| value.checked_add(fee))
                == Some(expected)
                && ctx.accounts.position_vault.amount == expected,
            VsolError::CollateralMismatch
        );

        ctx.accounts.pool.locked_collateral = ctx
            .accounts
            .pool
            .locked_collateral
            .checked_sub(position.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool.open_positions = ctx
            .accounts
            .pool
            .open_positions
            .checked_sub(1)
            .ok_or(VsolError::MathOverflow)?;
        ctx.accounts.pool_market.open_positions =
            ctx.accounts.pool_market.open_positions.checked_decrement()?;
        // `pool_amount` is what actually lands back in `pool_token` below --
        // see `total_assets`'s doc comment on `LiquidityPool`.
        ctx.accounts.pool.total_assets = ctx
            .accounts
            .pool
            .total_assets
            .checked_add(pool_amount)
            .ok_or(VsolError::MathOverflow)?;

        let nonce_record_key = position.nonce_record;
        let position_seeds: &[&[u8]] = &[
            POOL_POSITION_SEED,
            nonce_record_key.as_ref(),
            &[position.bump],
        ];
        if args.buyback_amount > 0 {
            transfer_checked_signed(
                ctx.accounts.token_program.key(),
                ctx.accounts.position_vault.to_account_info(),
                ctx.accounts.buyer_destination.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.position.to_account_info(),
                args.buyback_amount,
                ctx.accounts.settlement_mint.decimals,
                position_seeds,
            )?;
        }
        if fee > 0 {
            transfer_checked_signed(
                ctx.accounts.token_program.key(),
                ctx.accounts.position_vault.to_account_info(),
                ctx.accounts.treasury_destination.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.position.to_account_info(),
                fee,
                ctx.accounts.settlement_mint.decimals,
                position_seeds,
            )?;
        }
        if pool_amount > 0 {
            transfer_checked_signed(
                ctx.accounts.token_program.key(),
                ctx.accounts.position_vault.to_account_info(),
                ctx.accounts.pool_token.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.position.to_account_info(),
                pool_amount,
                ctx.accounts.settlement_mint.decimals,
                position_seeds,
            )?;
        }
        close_token_account(
            ctx.accounts.token_program.key(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.rent_recipient.to_account_info(),
            ctx.accounts.position.to_account_info(),
            position_seeds,
        )?;

        emit!(PoolPositionClosedEarly {
            position: position_key,
            buyer: buyer_key,
            buyback_amount: args.buyback_amount,
            fee,
            pool_amount,
        });
        Ok(())
    }

    /// Reclaims a fully-settled market's rent by closing both the `Market`
    /// and its `SettlementOracle` accounts once nothing can ever reference
    /// either of them again. This is the rolling grid's only cleanup path:
    /// markets and oracles are otherwise never closed, so without this
    /// instruction their rent is permanently consumed as the factory keeps
    /// minting new series.
    ///
    /// Safety argument -- why this cannot strand or double-spend anything:
    ///
    /// 1. `expiry + observation_window_seconds + settlement_grace_seconds` is
    ///    exactly the deadline `refund_pool_position` already uses as "the
    ///    settlement fallback window is closed" (`VsolError::SettlementWindowOpen`).
    ///    NOTE (updated alongside the tier-2 timing fix): `publish_pyth_settlement`
    ///    can still publish for a while past this exact point -- tier 1
    ///    always, tier 2 after a short additional buffer (see
    ///    `SETTLEMENT_REFUND_PRIORITY_SECONDS`) -- but never past
    ///    `deadline + max_settlement_staleness_seconds`, which
    ///    `create_market`'s cross-parameter bound
    ///    (`MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO`) guarantees is always
    ///    `<= deadline + MARKET_CLEANUP_BUFFER_SECONDS` (both
    ///    `max_settlement_staleness_seconds` and `MARKET_CLEANUP_BUFFER_SECONDS`
    ///    are capped at the same 7-day ceiling). So by the time THIS
    ///    instruction's own cutoff below is reached, `publish_pyth_settlement`
    ///    is guaranteed to already be permanently closed and the oracle's
    ///    `finalized`/`price` state frozen forever -- there is no future
    ///    event that could still need this market or oracle to exist.
    ///
    ///    This instruction nonetheless requires a FURTHER
    ///    `MARKET_CLEANUP_BUFFER_SECONDS` on top of that deadline. Freezing
    ///    the oracle is not the same as sweeping the positions: the deadline
    ///    is the instant `refund_unsettled`/`refund_pool_position` first
    ///    become callable, so closing the market at that same instant races
    ///    every in-flight refund with no margin at all. The buffer is what
    ///    makes point 3's off-chain assumption survivable rather than a
    ///    coin-flip against the cleaner.
    /// 2. `fill_pool_quote` hard-requires `now < market.expiry` before
    ///    opening a new position. Since the deadline above is strictly after
    ///    `expiry`, by the time it has elapsed no new pool-backed position
    ///    can ever be opened against this market again, full stop -- this
    ///    holds independently of `market.enabled`/`pool_market.enabled`,
    ///    which are therefore not load-bearing for "no new obligations":
    ///    that is already guaranteed by the expiry check `fill_pool_quote`
    ///    performs itself.
    /// 3. `pool` and `pool_market` are now MANDATORY (no `(None, None)`
    ///    bypass -- see `CloseSettledMarket`'s own doc comment for why an
    ///    earlier version of this instruction wrongly accepted omitting
    ///    them). The caller must supply the authorization record for *this*
    ///    market and pool; the handler requires it to have `enabled ==
    ///    false` AND `pool_market.open_positions == 0` (not the legacy
    ///    `UNKNOWN` sentinel either -- see `OpenPositionCount`'s doc comment
    ///    on `LiquidityPoolMarket`) before closing. This is a HARD
    ///    requirement, not defense-in-depth: `settle_pool_position` and
    ///    `refund_pool_position` both load `market: Box<Account<'info,
    ///    Market>>` via `has_one`/a manual key check, so once `Market` is
    ///    closed neither can ever run again -- any `PoolPosition` still open
    ///    against this market at that point has its escrowed
    ///    `premium + max_payout` stranded forever, unrecoverable by any
    ///    instruction in this program. That is exactly the failure this
    ///    check exists to prevent, which is why it cannot be optional.
    ///    Consequence: a market that was never bound to ANY pool (no
    ///    `LiquidityPoolMarket` was ever created for it) can never be closed
    ///    on chain -- only its own (and its oracle's) rent is permanently
    ///    stuck, never any position's funds, since a market nobody ever
    ///    authorized a pool against can have no `PoolPosition`s either
    ///    (`fill_pool_quote` requires an enabled `pool_market`). Accepted:
    ///    fills go through the pool path exclusively, so every market that
    ///    ever actually traded has a binding to supply here.
    /// 4. RESIDUAL GAP (documented, not fixed here): a market can legally be
    ///    bound to MORE THAN ONE pool over its lifetime -- each binding is
    ///    an independent `[POOL_MARKET_SEED, pool, market]` PDA, so there is
    ///    no bounded on-chain enumeration of "every pool ever authorized
    ///    against this market" (the same unenumerability problem as
    ///    individual positions, one level up). This instruction only checks
    ///    the ONE `(pool, pool_market)` pair the caller supplies: passing a
    ///    binding that is genuinely idle does not prove every OTHER binding
    ///    against this market is also idle, so a market with a second,
    ///    still-open pool binding could in principle be closed, stranding
    ///    that other binding's open positions. The complete fix is a
    ///    market-level open-position counter (on `Market` itself, maintained
    ///    across every pool's fills/settles/refunds) -- not applicable here
    ///    because it would change `Market`'s layout, and live devnet
    ///    accounts must keep deserializing unchanged (see this crate's
    ///    layout-compatibility constraints); it is free to add on a fresh
    ///    mainnet deploy with no live accounts to preserve, and should be
    ///    the mainnet follow-up. Until then, this gap is bounded by two
    ///    things neither of which is enforced by this instruction itself:
    ///    the caller is already privileged (`market.creator` or
    ///    `config.admin`, see point 5 below), and the off-chain cleaner
    ///    (`vsol/scripts/lib/settlement.ts`'s `selectMarketCloseCandidates`,
    ///    called from `vsol/scripts/cranker.ts`) is expected to check every
    ///    pool binding for a market before requesting a close, not just one.
    /// 5. Permission: the caller must be `market.creator` or `config.admin`.
    ///    Rent always returns to `market.creator` (`rent_recipient` is
    ///    address-constrained to it), never to an arbitrary caller-supplied
    ///    account.
    /// 6. Deliberately *not* gated on `config.paused`: this is maintenance
    ///    cleanup, not a trading action, so it must remain callable while
    ///    the protocol is paused (mirrors `close_pool_position`'s guardian
    ///    rationale for staying pause-independent).
    pub fn close_settled_market(ctx: Context<CloseSettledMarket>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let market = &ctx.accounts.market;

        // NOT the bare settlement deadline: that is the same instant
        // `refund_unsettled`/`refund_pool_position` first become callable, so
        // closing there races in-flight refunds with zero margin. See
        // MARKET_CLEANUP_BUFFER_SECONDS.
        let deadline = market
            .expiry
            .checked_add(i64::from(market.observation_window_seconds))
            .and_then(|value| value.checked_add(i64::from(market.settlement_grace_seconds)))
            .ok_or(VsolError::MathOverflow)?;
        let cleanup_deadline = deadline
            .checked_add(MARKET_CLEANUP_BUFFER_SECONDS)
            .ok_or(VsolError::MathOverflow)?;
        require!(now > cleanup_deadline, VsolError::MarketNotCloseable);

        let pool = &ctx.accounts.pool;
        let pool_market = &ctx.accounts.pool_market;
        require_keys_eq!(pool_market.pool, pool.key(), VsolError::InvalidPoolMarket);
        require_keys_eq!(pool_market.market, market.key(), VsolError::InvalidPoolMarket);
        require!(!pool_market.enabled, VsolError::MarketNotCloseable);
        // Direct, robust invariant on top of the `!enabled` check above --
        // see `OpenPositionCount`'s own doc comment on `LiquidityPoolMarket`.
        // A legacy (pre-upgrade) binding reads `UNKNOWN` here forever, which
        // can never equal `ZERO`, so THIS PARTICULAR pool/pool_market pair
        // can never satisfy this check: only its own rent stays stuck if the
        // caller never has another, non-legacy binding to supply instead.
        // That is not a claim that any open position is safe regardless of
        // this check -- see point 3 on this instruction's own doc comment
        // above: once `Market` closes (via whichever binding does satisfy
        // this check), every `PoolPosition` still open against it, under ANY
        // binding, legacy or not, has its escrowed funds stranded for good.
        require!(
            pool_market.open_positions == OpenPositionCount::ZERO,
            VsolError::MarketNotCloseable
        );

        // Reclaim the pool authorization record's rent too, to the same
        // recipient as the market/oracle above, now that it has passed
        // every check above. `pool`/`pool_market` are mandatory (see this
        // instruction's own doc comment, point 3), so there is always
        // something here to close.
        ctx.accounts.pool_market.close(ctx.accounts.rent_recipient.to_account_info())?;

        emit!(MarketClosed {
            market: market.key(),
            creator: market.creator,
        });
        Ok(())
    }

    /// One-time per symbol (e.g. SOL/BTC/ETH): creates the `CustomPriceFeed`
    /// PDA a later `update_custom_price_feed`/`publish_custom_settlement`
    /// call will read. Admin-gated, mirroring every other config-owned
    /// `init` instruction in this file. `published_at` starts at 0, which
    /// deliberately fails `publish_custom_settlement`'s freshness check
    /// forever until a real `update_custom_price_feed` call lands.
    pub fn init_custom_price_feed(
        ctx: Context<InitCustomPriceFeed>,
        symbol: [u8; 16],
        price_scale: u64,
    ) -> Result<()> {
        require!(price_scale > 0, VsolError::InvalidPriceScale);
        let feed = &mut ctx.accounts.feed;
        feed.bump = ctx.bumps.feed;
        feed.symbol = symbol;
        feed.price_scale = price_scale;
        feed.price = 0;
        feed.confidence = 0;
        feed.published_at = 0; // 0 -> always fails the freshness check below until a real update lands
        feed.publisher = Pubkey::default();
        Ok(())
    }

    /// Called every pusher tick to refresh `CustomPriceFeed`. The signer
    /// must equal `config.oracle_authority` -- see that account's doc
    /// comment for the full trust-model disclosure this check is the whole
    /// of.
    pub fn update_custom_price_feed(
        ctx: Context<UpdateCustomPriceFeed>,
        price: u64,
        confidence: u64,
        observed_at: i64,
    ) -> Result<()> {
        require!(price > 0, VsolError::InvalidOraclePrice);
        let clock = Clock::get()?;
        let feed = &mut ctx.accounts.feed;
        require!(observed_at <= clock.unix_timestamp, VsolError::CustomFeedFromFuture);
        require!(clock.unix_timestamp.saturating_sub(observed_at) <= CUSTOM_ORACLE_MAX_STALENESS_SECONDS, VsolError::CustomFeedStale);
        require!(observed_at > feed.published_at, VsolError::CustomFeedTimestampNotIncreasing);
        feed.price = price;
        feed.confidence = confidence;
        feed.published_at = observed_at;
        feed.publisher = ctx.accounts.oracle_authority.key();
        emit!(CustomPriceFeedUpdated {
            feed: feed.key(),
            symbol: feed.symbol,
            price,
            confidence,
            published_at: feed.published_at,
        });
        Ok(())
    }

    pub fn capture_custom_settlement_observation(
        ctx: Context<CaptureCustomSettlementObservation>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let market = &ctx.accounts.market;
        let feed = &ctx.accounts.feed;
        require!(feed.publisher == ctx.accounts.config.oracle_authority, VsolError::Unauthorized);
        require!(feed.symbol == market.symbol, VsolError::InvalidSymbol);
        require!(feed.price_scale == market.price_scale, VsolError::InvalidPriceScale);
        require!(feed.price > 0, VsolError::InvalidOraclePrice);
        require!(feed.published_at <= now, VsolError::CustomFeedFromFuture);
        require!(now.saturating_sub(feed.published_at) <= CUSTOM_OBSERVATION_MAX_CAPTURE_AGE_SECONDS, VsolError::CustomFeedStale);
        let observation_end = market.expiry.checked_add(i64::from(market.observation_window_seconds)).ok_or(VsolError::MathOverflow)?;
        require!(feed.published_at >= market.expiry && feed.published_at <= observation_end, VsolError::InvalidObservationTime);
        require!(now <= observation_end, VsolError::SettlementWindowClosed);
        let confidence_bps = (feed.confidence as u128).checked_mul(BPS_DENOMINATOR as u128).ok_or(VsolError::MathOverflow)?;
        let max_confidence = (feed.price as u128).checked_mul(market.max_confidence_bps as u128).ok_or(VsolError::MathOverflow)?;
        require!(confidence_bps <= max_confidence, VsolError::OracleConfidenceTooWide);

        let observation = &mut ctx.accounts.observation;
        observation.bump = ctx.bumps.observation;
        observation.config = ctx.accounts.config.key();
        observation.symbol = market.symbol;
        observation.expiry = market.expiry;
        observation.observation_window_seconds = market.observation_window_seconds;
        observation.price_scale = market.price_scale;
        observation.price = feed.price;
        observation.confidence = feed.confidence;
        observation.observed_at = feed.published_at;
        observation.captured_at = now;
        observation.feed = feed.key();
        observation.publisher = feed.publisher;
        Ok(())
    }

    /// Mirrors `publish_pyth_settlement`'s shape but reads `CustomPriceFeed`
    /// instead of verifying a Pyth `price_update`. No caller signer is
    /// required: authentication already happened at `update_custom_price_feed`
    /// time -- the same permissionless-relay principle `publish_pyth_settlement`
    /// itself relies on, where the settlement CALLER isn't what's trusted,
    /// the upstream signed write is.
    pub fn publish_custom_settlement(ctx: Context<PublishCustomSettlement>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let market = &ctx.accounts.market;
        let oracle = &mut ctx.accounts.oracle;
        let observation = &ctx.accounts.observation;

        require!(!oracle.finalized, VsolError::OracleAlreadyFinalized);
        require!(now >= market.expiry, VsolError::MarketNotExpired);
        require!(
            observation.price_scale == market.price_scale,
            VsolError::InvalidPriceScale
        );
        require!(observation.symbol == market.symbol && observation.expiry == market.expiry, VsolError::InvalidObservationTime);
        let observation_end = market.expiry.checked_add(i64::from(market.observation_window_seconds)).ok_or(VsolError::MathOverflow)?;
        require!(observation.observed_at >= market.expiry && observation.observed_at <= observation_end && observation.observed_at <= now, VsolError::InvalidObservationTime);
        require!(observation.captured_at >= market.expiry && observation.captured_at <= observation_end && observation.captured_at <= now, VsolError::InvalidObservationTime);
        let confidence_bps = (observation.confidence as u128).checked_mul(BPS_DENOMINATOR as u128).ok_or(VsolError::MathOverflow)?;
        let max_confidence = (observation.price as u128).checked_mul(market.max_confidence_bps as u128).ok_or(VsolError::MathOverflow)?;
        require!(confidence_bps <= max_confidence, VsolError::OracleConfidenceTooWide);

        let final_deadline = final_settlement_deadline(market)?;
        require!(now <= final_deadline, VsolError::SettlementWindowClosed);

        oracle.price = observation.price;
        oracle.confidence = observation.confidence;
        oracle.observed_at = observation.observed_at;
        oracle.published_at = now;
        oracle.price_update = observation.key();
        oracle.feed_id = market.pyth_feed_id;
        oracle.exponent = -6; // informational only; matches this deployment's fixed 1e6 price_scale, never read by payout math
        oracle.finalized = true;
        oracle.settled_from_stale_price = false;

        emit!(CustomSettlementPublished {
            market: market.key(),
            price: oracle.price,
            confidence: oracle.confidence,
            published_at: oracle.published_at,
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitializeConfigArgs {
    pub pause_authority: Pubkey,
    pub oracle_authority: Pubkey,
    pub eligibility_authority: Pubkey,
    pub treasury_owner: Pubkey,
    pub fee_bps: u16,
    pub eligibility_required: bool,
    pub domain_separator: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct UpdateConfigArgs {
    pub pause_authority: Pubkey,
    pub oracle_authority: Pubkey,
    pub eligibility_authority: Pubkey,
    pub treasury_owner: Pubkey,
    pub fee_bps: u16,
    pub eligibility_required: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreateMarketArgs {
    pub market_id: [u8; 32],
    pub underlying_mint: Pubkey,
    pub symbol: [u8; 16],
    pub price_scale: u64,
    pub expiry: i64,
    pub observation_window_seconds: u32,
    pub settlement_grace_seconds: u32,
    pub max_confidence_bps: u16,
    pub pyth_feed_id: [u8; 32],
    pub max_settlement_staleness_seconds: u32,
    // Added for the conditional-token complete-set path (mint_complete_set /
    // burn_complete_set / redeem_winning): the single threshold the market's
    // finalized oracle price is compared against to pick a winner. Part of
    // `expected_market_id`'s hash (see that function) so two markets that
    // differ only in strike are distinct series, not the same PDA. Unrelated
    // to -- and never read by -- the older per-position strike+width spread
    // payoff (`fill_quote`/`fill_pool_quote`/`calculate_payout`), which keeps
    // its own strike on each `Position`/`PoolPosition` instead. See this
    // module's top-level report for why `Market` did not already have a
    // single strike field before this change.
    pub strike: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitializeLiquidityPoolArgs {
    pub pool_id: [u8; 32],
    pub quote_authority: Pubkey,
    pub max_utilization_bps: u16,
    pub max_position_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetLiquidityPoolMarketArgs {
    pub last_trade_at: i64,
    pub enabled: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct UpdateLiquidityPoolArgs {
    pub quote_authority: Pubkey,
    pub max_utilization_bps: u16,
    pub max_position_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolQuoteArgs {
    pub nonce: u64,
    pub direction: u8,
    pub strike: u64,
    pub width: u64,
    pub premium: u64,
    pub max_payout: u64,
    pub quote_expiry: i64,
}

/// A one-shot, pool-`quote_authority`-signed offer to buy back an open pool
/// position before expiry. `buyback_amount` is what the pool pays the buyer;
/// `min_proceeds` is the buyer's slippage guard, bound into the same signed
/// message so it can't be tampered with independently of `buyback_amount`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolBuybackArgs {
    pub buyback_amount: u64,
    pub min_proceeds: u64,
    pub quote_expiry: i64,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub pause_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = pause_authority @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(args: CreateMarketArgs)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = creator, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED, config.key().as_ref(), args.market_id.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = creator, space = 8 + SettlementOracle::INIT_SPACE, seeds = [ORACLE_SEED, market.key().as_ref()], bump)]
    pub oracle: Account<'info, SettlementOracle>,
    pub settlement_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config @ VsolError::InvalidMarket)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct SetEligibility<'info> {
    #[account(mut)]
    pub eligibility_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = eligibility_authority @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = eligibility_authority, space = 8 + Eligibility::INIT_SPACE, seeds = [ELIGIBILITY_SEED, config.key().as_ref(), wallet.as_ref()], bump)]
    pub eligibility: Account<'info, Eligibility>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishPythSettlement<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = oracle @ VsolError::InvalidOracle)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [ORACLE_SEED, market.key().as_ref()], bump = oracle.bump, has_one = market @ VsolError::InvalidOracle)]
    pub oracle: Account<'info, SettlementOracle>,
    /// CHECK: The parser verifies the upgraded Pyth receiver owner, account discriminator,
    /// full guardian verification, exact feed id, and serialized account length.
    pub price_update: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(args: InitializeLiquidityPoolArgs)]
pub struct InitializeLiquidityPool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(init, payer = creator, space = 8 + LiquidityPool::INIT_SPACE, seeds = [POOL_SEED, config.key().as_ref(), settlement_mint.key().as_ref(), args.pool_id.as_ref()], bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(init, payer = creator, token::mint = settlement_mint, token::authority = pool, seeds = [POOL_TOKEN_SEED, pool.key().as_ref()], bump)]
    pub pool_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(args: SetLiquidityPoolMarketArgs)]
pub struct SetLiquidityPoolMarket<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [POOL_SEED, config.key().as_ref(), pool.settlement_mint.as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = manager @ VsolError::Unauthorized)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(has_one = config @ VsolError::InvalidMarket)]
    pub market: Account<'info, Market>,
    /// CHECK: created or loaded BY HAND in the handler, not via Anchor's
    /// `init_if_needed` sugar -- see the handler's own doc comment for why
    /// (that sugar's automatic `space == data_len()` equality check would
    /// hard-reject every pre-existing, legacy 82-byte `LiquidityPoolMarket`
    /// once the struct grew by `OpenPositionCount`'s 4 bytes). `seeds =`/
    /// `bump` here still fully authenticates the address -- an account can
    /// only ever exist at this exact PDA if THIS program created it (via
    /// `invoke_signed` with these same seeds), or it doesn't exist yet
    /// (owned by the System Program) -- the handler checks and handles
    /// both cases explicitly.
    #[account(mut, seeds = [POOL_MARKET_SEED, pool.key().as_ref(), market.key().as_ref()], bump)]
    pub pool_market: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateLiquidityPool<'info> {
    pub manager: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), pool.settlement_mint.as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = manager @ VsolError::Unauthorized)]
    pub pool: Account<'info, LiquidityPool>,
}

/// Same account shape as `UpdateLiquidityPool`: only the pool's own manager
/// may commit or cancel a pending change they proposed.
#[derive(Accounts)]
pub struct ApplyLiquidityPoolUpdate<'info> {
    pub manager: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), pool.settlement_mint.as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = manager @ VsolError::Unauthorized)]
    pub pool: Account<'info, LiquidityPool>,
}

#[derive(Accounts)]
pub struct CancelPendingPoolUpdate<'info> {
    pub manager: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), pool.settlement_mint.as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = manager @ VsolError::Unauthorized)]
    pub pool: Account<'info, LiquidityPool>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), settlement_mint.key().as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = settlement_mint)]
    pub pool: Box<Account<'info, LiquidityPool>>,
    #[account(mut, seeds = [POOL_TOKEN_SEED, pool.key().as_ref()], bump = pool.token_bump, token::mint = settlement_mint, token::authority = pool)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = provider, space = 8 + LiquidityProvider::INIT_SPACE, seeds = [PROVIDER_SEED, pool.key().as_ref(), provider.key().as_ref()], bump)]
    pub provider_position: Box<Account<'info, LiquidityProvider>>,
    #[account(mut, token::mint = settlement_mint, token::authority = provider)]
    pub provider_source: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawLiquidity<'info> {
    pub provider: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), settlement_mint.key().as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = settlement_mint)]
    pub pool: Box<Account<'info, LiquidityPool>>,
    #[account(mut, seeds = [POOL_TOKEN_SEED, pool.key().as_ref()], bump = pool.token_bump, token::mint = settlement_mint, token::authority = pool)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [PROVIDER_SEED, pool.key().as_ref(), provider.key().as_ref()], bump = provider_position.bump, has_one = pool, constraint = provider_position.owner == provider.key() @ VsolError::Unauthorized)]
    pub provider_position: Box<Account<'info, LiquidityProvider>>,
    #[account(mut, token::mint = settlement_mint, token::authority = provider)]
    pub provider_destination: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(quote: PoolQuoteArgs)]
pub struct FillPoolQuote<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Authenticated by the immediately preceding Ed25519 instruction.
    pub quote_authority: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), settlement_mint.key().as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = settlement_mint, constraint = pool.quote_authority == quote_authority.key() @ VsolError::Unauthorized)]
    pub pool: Box<Account<'info, LiquidityPool>>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = settlement_mint @ VsolError::InvalidMarket)]
    pub market: Box<Account<'info, Market>>,
    // `mut`: `fill_pool_quote` increments `open_positions` on this record --
    // see `OpenPositionCount`'s doc comment on `LiquidityPoolMarket`.
    #[account(mut, seeds = [POOL_MARKET_SEED, pool.key().as_ref(), market.key().as_ref()], bump = pool_market.bump, has_one = pool, has_one = market)]
    pub pool_market: Box<Account<'info, LiquidityPoolMarket>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [POOL_TOKEN_SEED, pool.key().as_ref()], bump = pool.token_bump, token::mint = settlement_mint, token::authority = pool)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = settlement_mint, token::authority = buyer)]
    pub buyer_source: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = buyer, space = 8 + PoolQuoteNonce::INIT_SPACE, seeds = [POOL_NONCE_SEED, pool.key().as_ref(), quote_authority.key().as_ref(), quote.nonce.to_le_bytes().as_ref()], bump)]
    pub nonce_record: Box<Account<'info, PoolQuoteNonce>>,
    #[account(init, payer = buyer, space = 8 + PoolPosition::INIT_SPACE, seeds = [POOL_POSITION_SEED, nonce_record.key().as_ref()], bump)]
    pub position: Box<Account<'info, PoolPosition>>,
    #[account(init, payer = buyer, token::mint = settlement_mint, token::authority = position, seeds = [POOL_POSITION_VAULT_SEED, position.key().as_ref()], bump)]
    pub position_vault: Box<Account<'info, TokenAccount>>,
    pub eligibility: Option<Box<Account<'info, Eligibility>>>,
    /// CHECK: Address-constrained to the transaction instructions sysvar.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SettlePoolPosition<'info> {
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), settlement_mint.key().as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = settlement_mint)]
    pub pool: Box<Account<'info, LiquidityPool>>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = oracle @ VsolError::InvalidOracle, has_one = settlement_mint @ VsolError::InvalidMarket)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [ORACLE_SEED, market.key().as_ref()], bump = oracle.bump, has_one = market @ VsolError::InvalidOracle)]
    pub oracle: Box<Account<'info, SettlementOracle>>,
    // `mut`: settlement decrements `open_positions` on this record -- see
    // `OpenPositionCount`'s doc comment on `LiquidityPoolMarket`.
    //
    // No `seeds =`/`bump =`/`has_one =` here (unlike
    // `FillPoolQuote::pool_market`): this instruction's `try_accounts` is
    // right at the BPF stack frame limit, and each of those constraints'
    // codegen was enough to push it over (measured: 120 bytes over with
    // `seeds =`/`bump =`; still 8 bytes over with only `has_one =` left).
    // Verified instead by `require_keys_eq!` first thing in the handler body
    // (a separate function, so it does not count against `try_accounts`'s
    // own frame). Safe for the same reason `has_one` would have been: the
    // only instruction that can ever create an account with this
    // discriminator is `set_liquidity_pool_market`, always at the canonical
    // `[POOL_MARKET_SEED, pool, market]` PDA, so an account that
    // deserializes AND matches `pool`/`market` is necessarily that canonical
    // account for THIS exact (pool, market) pair.
    #[account(mut)]
    pub pool_market: Box<Account<'info, LiquidityPoolMarket>>,
    /// Closed here (rent to `rent_recipient`, i.e. the buyer -- see that
    /// field's own doc comment) rather than left to rot forever. Replay
    /// safety: `fill_pool_quote` only accepts a quote while
    /// `now <= quote.quote_expiry < market.expiry`, and this instruction only
    /// runs once `now >= market.expiry`, so by the time the nonce PDA
    /// disappears the exact ed25519-signed `PoolQuoteArgs` (nonce included)
    /// that created it can never satisfy `fill_pool_quote`'s own expiry check
    /// again -- an attacker cannot forge a fresh `quote_expiry` without
    /// invalidating the signature. Re-submitting the original signed quote
    /// therefore fails closed with `QuoteExpired`, PDA or no PDA. Proven by
    /// `settle_pool_position_closes_nonce_and_original_quote_cannot_replay`.
    /// `close_pool_position` (early close, before expiry) must NOT do this:
    /// the quote can still be unexpired there, so closing the nonce would let
    /// the same signed quote be filled a second time once the PDA is gone.
    #[account(mut, close = rent_recipient, constraint = nonce_record.status == NonceStatus::Filled as u8 @ VsolError::InvalidNonce, constraint = nonce_record.position == position.key() @ VsolError::InvalidNonce, constraint = nonce_record.pool == pool.key() @ VsolError::InvalidNonce)]
    pub nonce_record: Box<Account<'info, PoolQuoteNonce>>,
    #[account(mut, close = rent_recipient, seeds = [POOL_POSITION_SEED, nonce_record.key().as_ref()], bump = position.bump, has_one = pool @ VsolError::InvalidPosition, has_one = market @ VsolError::InvalidPosition, has_one = nonce_record @ VsolError::InvalidNonce, has_one = settlement_mint @ VsolError::InvalidPosition)]
    pub position: Box<Account<'info, PoolPosition>>,
    #[account(mut, seeds = [POOL_POSITION_VAULT_SEED, position.key().as_ref()], bump = position.vault_bump, token::mint = settlement_mint, token::authority = position)]
    pub position_vault: Box<Account<'info, TokenAccount>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = settlement_mint, constraint = buyer_destination.owner == position.buyer @ VsolError::InvalidDestination)]
    pub buyer_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_TOKEN_SEED, pool.key().as_ref()], bump = pool.token_bump, token::mint = settlement_mint, token::authority = pool)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    /// When `config.treasury_owner` is the position's own buyer,
    /// `buyer_destination` and `treasury_destination` are the exact same
    /// token account. Anchor 1.0.2/1.1.2's generated `try_accounts` collects
    /// every `mut` field that (a) is not marked `dup` and (b) serializes on
    /// `exit()` (see `anchor-syn`'s `generate_duplicate_mutable_checks` and
    /// `AccountsExit` impls) into a `HashSet`, erroring
    /// `ConstraintDuplicateMutableAccount` if any two collide -- this exists
    /// to stop the classic double-write bug where two `Account<'info, T>`
    /// views of the same address each independently re-serialize their own
    /// (possibly divergent) copy of the account's data on exit, and the
    /// second write silently clobbers the first.
    /// `dup` here is exactly the intended escape hatch for a case that bug
    /// cannot occur in: `TokenAccount`'s owning program is the SPL Token
    /// program, not this one, so `Account<'info, TokenAccount>::exit()`
    /// (see `exit_with_expected_owner`) is a complete no-op for it --  this
    /// program's mutations to `treasury_destination`'s and
    /// `buyer_destination`'s balances only ever happen via CPI `transfer_checked`,
    /// which writes the real on-chain bytes directly, not through Anchor's
    /// in-memory struct. Two `Account<TokenAccount>` handles aliasing the
    /// same address therefore cannot diverge or clobber each other; `dup`
    /// only tells Anchor's constraint pass that, it changes no runtime
    /// behavior. Validation the duplicate check would otherwise have
    /// provided nothing towards anyway (token-program ownership, correct
    /// mint, correct token owner) is fully carried by `token::mint =` and
    /// the `owner ==` constraint above regardless of aliasing. See
    /// `settle_pool_position`'s handler for the matching transfer logic
    /// (folds into one CPI instead of two when the keys are equal).
    #[account(mut, dup, token::mint = settlement_mint, constraint = treasury_destination.owner == config.treasury_owner @ VsolError::InvalidDestination)]
    pub treasury_destination: Box<Account<'info, TokenAccount>>,
    /// CHECK: Receives rent (this account's own nonce and position rent, plus
    /// -- see `nonce_record`'s doc comment -- the closed nonce's rent too)
    /// and must be the buyer stored in the position.
    #[account(mut, address = position.buyer)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundPoolPosition<'info> {
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), settlement_mint.key().as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = settlement_mint)]
    pub pool: Box<Account<'info, LiquidityPool>>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = oracle @ VsolError::InvalidOracle, has_one = settlement_mint @ VsolError::InvalidMarket)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [ORACLE_SEED, market.key().as_ref()], bump = oracle.bump, has_one = market @ VsolError::InvalidOracle)]
    pub oracle: Box<Account<'info, SettlementOracle>>,
    // `mut`: refund decrements `open_positions` on this record -- see
    // `OpenPositionCount`'s doc comment on `LiquidityPoolMarket`.
    //
    // No `seeds =`/`bump =`/`has_one =` -- see
    // `SettlePoolPosition::pool_market`'s own comment for why the equality
    // check is instead a manual `require_keys_eq!` in the handler body, and
    // why that is both safe and required to stay under the BPF stack frame
    // limit.
    #[account(mut)]
    pub pool_market: Box<Account<'info, LiquidityPoolMarket>>,
    /// Closed here (rent to `rent_recipient`, i.e. the buyer). Replay safety
    /// argument is identical to `SettlePoolPosition::nonce_record`'s own doc
    /// comment: this instruction also only runs once `now >= market.expiry`
    /// (via the settlement-window deadline check below, which is itself
    /// `>= market.expiry`), strictly after `quote.quote_expiry` could ever
    /// again satisfy `fill_pool_quote`'s expiry check, so replaying the
    /// original signed quote fails closed with `QuoteExpired` regardless of
    /// whether this PDA still exists.
    #[account(mut, close = rent_recipient, constraint = nonce_record.status == NonceStatus::Filled as u8 @ VsolError::InvalidNonce, constraint = nonce_record.position == position.key() @ VsolError::InvalidNonce, constraint = nonce_record.pool == pool.key() @ VsolError::InvalidNonce)]
    pub nonce_record: Box<Account<'info, PoolQuoteNonce>>,
    #[account(mut, close = rent_recipient, seeds = [POOL_POSITION_SEED, nonce_record.key().as_ref()], bump = position.bump, has_one = pool @ VsolError::InvalidPosition, has_one = market @ VsolError::InvalidPosition, has_one = nonce_record @ VsolError::InvalidNonce, has_one = settlement_mint @ VsolError::InvalidPosition)]
    pub position: Box<Account<'info, PoolPosition>>,
    #[account(mut, seeds = [POOL_POSITION_VAULT_SEED, position.key().as_ref()], bump = position.vault_bump, token::mint = settlement_mint, token::authority = position)]
    pub position_vault: Box<Account<'info, TokenAccount>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = settlement_mint, constraint = buyer_destination.owner == position.buyer @ VsolError::InvalidDestination)]
    pub buyer_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_TOKEN_SEED, pool.key().as_ref()], bump = pool.token_bump, token::mint = settlement_mint, token::authority = pool)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Receives rent (this account's own nonce and position rent) and
    /// must be the buyer stored in the position.
    #[account(mut, address = position.buyer)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Mirrors `SettlePoolPosition` as closely as possible: same pool/market/
/// oracle/position/vault/settlement-mint/destination shape, minus the
/// `nonce_record` (not needed to authorize an early close: the position's
/// own stored `nonce_record` pubkey is sufficient to re-derive and verify its
/// PDA) and `cranker` (replaced by the buyer, who must sign in person and
/// must equal `position.buyer`), plus `instructions_sysvar` for the Ed25519
/// check that authenticates the pool's signed buyback quote.
///
/// Deliberately never closes the `PoolQuoteNonce`, unlike
/// `SettlePoolPosition`/`RefundPoolPosition` (see their `nonce_record` doc
/// comments): early close can run at any time before `market.expiry`, while
/// the original signed `PoolQuoteArgs` from `fill_pool_quote` may still be
/// within its own `quote.quote_expiry`. Closing the nonce PDA here would
/// free its seeds for reuse while that quote could still pass
/// `fill_pool_quote`'s expiry check, letting the exact same signed quote be
/// filled a second time.
#[derive(Accounts)]
pub struct ClosePoolPosition<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, config.key().as_ref(), settlement_mint.key().as_ref(), pool.pool_id.as_ref()], bump = pool.bump, has_one = config, has_one = settlement_mint)]
    pub pool: Box<Account<'info, LiquidityPool>>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = oracle @ VsolError::InvalidOracle, has_one = settlement_mint @ VsolError::InvalidMarket)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [ORACLE_SEED, market.key().as_ref()], bump = oracle.bump, has_one = market @ VsolError::InvalidOracle)]
    pub oracle: Box<Account<'info, SettlementOracle>>,
    // `mut`: an early close also decrements `open_positions` on this record --
    // see `OpenPositionCount`'s doc comment on `LiquidityPoolMarket`.
    //
    // No `seeds =`/`bump =` -- see `SettlePoolPosition::pool_market`'s own
    // comment for why it is both unnecessary (safety is fully carried by
    // `has_one = pool, has_one = market` given the discriminator argument
    // there) and required to stay under the BPF stack frame limit.
    #[account(mut, has_one = pool, has_one = market)]
    pub pool_market: Box<Account<'info, LiquidityPoolMarket>>,
    #[account(mut, close = rent_recipient, seeds = [POOL_POSITION_SEED, position.nonce_record.as_ref()], bump = position.bump, has_one = pool @ VsolError::InvalidPosition, has_one = market @ VsolError::InvalidPosition, has_one = settlement_mint @ VsolError::InvalidPosition, constraint = position.buyer == buyer.key() @ VsolError::Unauthorized)]
    pub position: Box<Account<'info, PoolPosition>>,
    #[account(mut, seeds = [POOL_POSITION_VAULT_SEED, position.key().as_ref()], bump = position.vault_bump, token::mint = settlement_mint, token::authority = position)]
    pub position_vault: Box<Account<'info, TokenAccount>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = settlement_mint, constraint = buyer_destination.owner == position.buyer @ VsolError::InvalidDestination)]
    pub buyer_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_TOKEN_SEED, pool.key().as_ref()], bump = pool.token_bump, token::mint = settlement_mint, token::authority = pool)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, dup, token::mint = settlement_mint, constraint = treasury_destination.owner == config.treasury_owner @ VsolError::InvalidDestination)]
    pub treasury_destination: Box<Account<'info, TokenAccount>>,
    /// CHECK: Receives rent and must be the buyer stored in the position.
    #[account(mut, address = position.buyer)]
    pub rent_recipient: UncheckedAccount<'info>,
    /// CHECK: Address-constrained to the transaction instructions sysvar.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Accounts for `close_settled_market`. See that instruction's doc comment
/// for the full safety argument.
///
/// `pool`/`pool_market` are MANDATORY (no `Option`, no bypass path): the
/// caller must supply the `[POOL_MARKET_SEED, pool, market]` authorization
/// record for this market and prove (via the handler's checks) that it
/// carries zero open positions before the market can close -- see point 3 of
/// the safety argument. A market that was never bound to any pool therefore
/// cannot be closed on chain (only its own rent stays stuck); point 3 there
/// also explains why that is acceptable (fills go through the pool path
/// exclusively, so every market that ever actually traded has a binding to
/// supply here). Point 4 documents the residual gap this does NOT close: a
/// market may have more than one such binding over its lifetime, and this
/// struct only ever sees the one the caller chose to pass.
#[derive(Accounts)]
pub struct CloseSettledMarket<'info> {
    #[account(
        constraint = (authority.key() == market.creator || authority.key() == config.admin)
            @ VsolError::Unauthorized
    )]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        close = rent_recipient,
        has_one = config @ VsolError::InvalidMarket,
        has_one = oracle @ VsolError::InvalidOracle
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        close = rent_recipient,
        seeds = [ORACLE_SEED, market.key().as_ref()],
        bump = oracle.bump,
        has_one = market @ VsolError::InvalidOracle
    )]
    pub oracle: Box<Account<'info, SettlementOracle>>,
    pub pool: Box<Account<'info, LiquidityPool>>,
    // `mut`: the handler always closes this record (rent to
    // `rent_recipient`) once it has proven `open_positions == 0` -- see
    // `close_settled_market`'s own comment.
    #[account(mut)]
    pub pool_market: Box<Account<'info, LiquidityPoolMarket>>,
    /// CHECK: Receives the market's, oracle's and pool_market's reclaimed
    /// rent. Address-constrained to the market's own creator so rent can
    /// never be redirected to an arbitrary caller-supplied account.
    #[account(mut, address = market.creator)]
    pub rent_recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 16])]
pub struct InitCustomPriceFeed<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + CustomPriceFeed::INIT_SPACE,
        seeds = [CUSTOM_FEED_SEED, symbol.as_ref()],
        bump,
    )]
    pub feed: Account<'info, CustomPriceFeed>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCustomPriceFeed<'info> {
    pub oracle_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = oracle_authority @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CUSTOM_FEED_SEED, feed.symbol.as_ref()], bump = feed.bump)]
    pub feed: Account<'info, CustomPriceFeed>,
}

#[derive(Accounts)]
pub struct CaptureCustomSettlementObservation<'info> {
    #[account(mut)]
    pub oracle_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = oracle_authority @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(has_one = config @ VsolError::InvalidMarket)]
    pub market: Account<'info, Market>,
    #[account(seeds = [CUSTOM_FEED_SEED, market.symbol.as_ref()], bump = feed.bump)]
    pub feed: Account<'info, CustomPriceFeed>,
    #[account(
        init,
        payer = oracle_authority,
        space = 8 + CustomSettlementObservation::INIT_SPACE,
        seeds = [CUSTOM_SETTLEMENT_OBSERVATION_SEED, market.symbol.as_ref(), &market.expiry.to_le_bytes()],
        bump,
    )]
    pub observation: Account<'info, CustomSettlementObservation>,
    pub system_program: Program<'info, System>,
}

/// Mirrors `PublishPythSettlement` exactly, with the Pyth `price_update`
/// `UncheckedAccount` swapped for the typed `feed`. Like
/// `PublishPythSettlement`, this instruction takes no `Signer` at all --
/// settlement publication is permissionless-relay; see
/// `publish_custom_settlement`'s own doc comment.
#[derive(Accounts)]
pub struct PublishCustomSettlement<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = oracle @ VsolError::InvalidOracle)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [ORACLE_SEED, market.key().as_ref()], bump = oracle.bump, has_one = market @ VsolError::InvalidOracle)]
    pub oracle: Account<'info, SettlementOracle>,
    /// Closed here (rent to `rent_recipient`, i.e. `config.oracle_authority`,
    /// the account that paid for it at `capture_custom_settlement_observation`)
    /// once its data has been fully consumed into `oracle` above. Nothing else
    /// in the program ever reads a `CustomSettlementObservation` again after
    /// this point: `settle_pool_position`/`refund_pool_position`/`settle`/
    /// `refund_unsettled` all gate on `oracle.finalized`, never on this
    /// account, and the only two instructions that ever reference this type
    /// are this one and `CaptureCustomSettlementObservation`'s own `init`.
    /// `oracle.price_update` retains this account's now-stale pubkey purely
    /// as an audit-trail pointer -- like `publish_pyth_settlement`'s own
    /// `price_update` field, it is write-only and never dereferenced by any
    /// instruction, so closing the account it points to is harmless.
    #[account(mut, close = rent_recipient, seeds = [CUSTOM_SETTLEMENT_OBSERVATION_SEED, market.symbol.as_ref(), &market.expiry.to_le_bytes()], bump = observation.bump, has_one = config @ VsolError::InvalidOracle)]
    pub observation: Account<'info, CustomSettlementObservation>,
    /// CHECK: Receives the observation's reclaimed rent. Address-constrained
    /// to `config.oracle_authority`, who paid for it originally. Publication
    /// itself stays permissionless: this account is not a `Signer`, only a
    /// payout target, so anyone may still call `publish_custom_settlement`.
    #[account(mut, address = config.oracle_authority)]
    pub rent_recipient: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub bump: u8,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub pause_authority: Pubkey,
    pub oracle_authority: Pubkey,
    pub eligibility_authority: Pubkey,
    pub treasury_owner: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub eligibility_required: bool,
    pub domain_separator: [u8; 32],
    pub domain_version: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub bump: u8,
    pub config: Pubkey,
    pub market_id: [u8; 32],
    pub underlying_mint: Pubkey,
    pub settlement_mint: Pubkey,
    pub oracle: Pubkey,
    pub symbol: [u8; 16],
    pub price_scale: u64,
    pub expiry: i64,
    pub observation_window_seconds: u32,
    pub settlement_grace_seconds: u32,
    pub max_confidence_bps: u16,
    pub pyth_feed_id: [u8; 32],
    pub settlement_decimals: u8,
    pub enabled: bool,
    // Appended after launch: keep at the end so existing byte offsets stay valid.
    pub creator: Pubkey,
    // Appended after launch: keep at the end so existing byte offsets stay
    // valid. Bounds how old a tier-2 last-known price may be relative to
    // `expiry` (see `publish_pyth_settlement`).
    pub max_settlement_staleness_seconds: u32,
    // Appended after launch: keep at the end so existing byte offsets stay
    // valid. The conditional-token winner threshold -- see
    // `CreateMarketArgs::strike` and `redeem_winning`. Unused by, and has no
    // effect on, the older per-position spread-payoff path.
    pub strike: u64,
}

#[account]
#[derive(InitSpace)]
pub struct SettlementOracle {
    pub bump: u8,
    pub market: Pubkey,
    pub price: u64,
    pub confidence: u64,
    pub observed_at: i64,
    pub published_at: i64,
    pub price_update: Pubkey,
    pub feed_id: [u8; 32],
    pub exponent: i32,
    pub finalized: bool,
    // Appended after launch: keep at the end so existing byte offsets stay
    // valid. True when the finalized price came from the tier-2 last-known-
    // price fallback rather than a fresh in-window (tier 1) print.
    pub settled_from_stale_price: bool,
}

/// A centrally-sourced backup/demo settlement price feed, one per `symbol`
/// (seeded off `market.symbol`, not `market.pyth_feed_id`, so it is shared
/// across every expiry/rung of the same underlying and kept in its own
/// namespace independent of Pyth's). It exists so the product can still
/// settle expired markets when Pyth access is unavailable -- see
/// `publish_custom_settlement`.
///
/// Be honest about the tradeoff this is: unlike `SettlementOracle` when
/// populated via `publish_pyth_settlement`, a price written here is NOT
/// cryptographically verified by any independent oracle network. Its entire
/// trust model is the signer check in `update_custom_price_feed` -- whoever
/// holds `config.oracle_authority`'s key can write any price into this
/// account. That is intentional, disclosed centralization -- a deliberate
/// short-term fallback while Pyth access is unavailable, not something this
/// comment is trying to obscure.
#[account]
#[derive(InitSpace)]
pub struct CustomPriceFeed {
    pub bump: u8,
    pub symbol: [u8; 16],
    pub price_scale: u64,
    pub price: u64,
    pub confidence: u64,
    pub published_at: i64,
    pub publisher: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct CustomSettlementObservation {
    pub bump: u8,
    pub config: Pubkey,
    pub symbol: [u8; 16],
    pub expiry: i64,
    pub observation_window_seconds: u32,
    pub price_scale: u64,
    pub price: u64,
    pub confidence: u64,
    pub observed_at: i64,
    pub captured_at: i64,
    pub feed: Pubkey,
    pub publisher: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Eligibility {
    pub bump: u8,
    pub config: Pubkey,
    pub wallet: Pubkey,
    pub can_trade: bool,
    pub expires_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct LiquidityPool {
    pub bump: u8,
    pub token_bump: u8,
    pub config: Pubkey,
    pub settlement_mint: Pubkey,
    pub quote_authority: Pubkey,
    pub pool_id: [u8; 32],
    pub total_shares: u64,
    pub locked_collateral: u64,
    pub open_positions: u64,
    pub cumulative_premium: u64,
    pub cumulative_payout: u64,
    pub max_utilization_bps: u16,
    pub max_position_bps: u16,
    // Appended after launch: keep at the end so existing byte offsets stay valid.
    pub manager: Pubkey,
    // Appended after launch: keep at the end so existing byte offsets stay
    // valid. Pending `update_liquidity_pool` proposal, committed by
    // `apply_liquidity_pool_update` once `pending_effective_at` elapses, or
    // discarded by `cancel_pending_pool_update`. `pending_effective_at == 0`
    // is the sentinel for "no pending change" -- Anchor zero-initializes new
    // pool accounts to exactly this state, and every path that clears a
    // pending change (apply, cancel) resets all four fields back to it.
    pub pending_quote_authority: Pubkey,
    pub pending_max_utilization_bps: u16,
    pub pending_max_position_bps: u16,
    pub pending_effective_at: i64,
    // Appended after launch: keep at the end so existing byte offsets stay
    // valid. The pool's own internal ledger of free (unlocked) settlement
    // tokens it holds -- maintained by deposit_liquidity, withdraw_liquidity,
    // fill_pool_quote, settle_pool_position, close_pool_position, and
    // refund_pool_position, the only six places that ever move tokens into
    // or out of `pool_token`.
    //
    // This exists because `pool_token.amount` (the raw SPL token balance) is
    // NOT safe to use as an accounting value: a token account's owner cannot
    // refuse incoming transfers, so anyone can inflate `pool_token.amount`
    // with a plain `spl-token transfer` that never goes through
    // `deposit_liquidity`. Before this field existed, `deposit_liquidity`
    // and `withdraw_liquidity` used `pool_token.amount` directly as the
    // share-price denominator -- a textbook first-depositor share-inflation
    // attack: deposit a tiny amount for a cheap 1-share position, donate a
    // large amount directly to `pool_token` to inflate the price per share,
    // then let a victim's deposit round down to a share count worth far less
    // than they put in.
    //
    // `total_assets` tracks only what the program itself has moved through
    // those six instructions, so a donation changes `pool_token.amount` but
    // never `total_assets` -- it becomes inert dust, physically present in
    // the vault but never counted by any share-price calculation. In
    // ordinary operation (no donation) `total_assets == pool_token.amount`
    // exactly; with a donation, `pool_token.amount == total_assets +
    // (cumulative donations)`.
    //
    // Belt and braces: `calculate_deposit_shares`/`calculate_withdraw_amount`
    // (see math.rs) additionally apply a virtual-shares offset so that even
    // a correct ledger's very first deposit cannot be leveraged into an
    // exploitable rounding edge. This field is the primary fix; the virtual
    // offset is the secondary one.
    pub total_assets: u64,
}

#[account]
#[derive(InitSpace)]
pub struct LiquidityProvider {
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
}

/// A per-`LiquidityPoolMarket` counter of that binding's own currently-open
/// `PoolPosition`s. `close_settled_market` uses it to refuse closing a
/// market while a pool-backed position against it is still unsettled or
/// unrefunded -- see that instruction's own doc comment for the full
/// argument, and this field's doc comment on `LiquidityPoolMarket` for why
/// it is a legacy-tolerant appended field rather than a plain `u32`.
///
/// Backward-compatible by construction with the pre-existing 82-byte
/// `LiquidityPoolMarket` layout already live on devnet: this type's manual
/// (de)serialization makes the field OPTIONAL on the wire, not fixed-width.
///   * Deserialize: reads 4 little-endian bytes if the buffer still has
///     them; if the buffer is already exhausted (a legacy 82-byte account,
///     which has none), yields the sentinel `UNKNOWN` (`u32::MAX`) instead
///     of erroring.
///   * Serialize: writes NOTHING for `UNKNOWN`, and 4 bytes otherwise.
///
/// A legacy account therefore deserializes to `UNKNOWN` and re-serializes
/// back to exactly its original 82 bytes forever -- Anchor's `exit` writes
/// back only as many bytes as `serialize` produces, never more or less. A
/// newly created binding (`LiquidityPoolMarket::INIT_SPACE` now includes
/// this field's 4-byte `Space` contribution, so `init_if_needed` always
/// allocates 86 bytes for a brand new record) deserializes its
/// zero-initialized trailing bytes as a real `0` and stays a real, tracked
/// counter from then on -- see `set_liquidity_pool_market`'s handler, which
/// deliberately never overwrites this field on an already-existing record.
///
/// `UNKNOWN` is a sentinel, not a valid count. `close_settled_market`
/// requires the count to be exactly zero to close, so a legacy binding
/// (which can only ever read `UNKNOWN`) can never satisfy that check: only
/// ITS rent is permanently stuck, never any position's escrowed funds
/// (those live in independent per-position vaults, always settleable or
/// refundable on their own regardless of whether the market itself is ever
/// closed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenPositionCount(u32);

impl OpenPositionCount {
    pub const ZERO: OpenPositionCount = OpenPositionCount(0);
    pub const UNKNOWN: OpenPositionCount = OpenPositionCount(u32::MAX);

    pub fn is_unknown(self) -> bool {
        self == Self::UNKNOWN
    }

    /// No-op on `UNKNOWN`: a legacy binding never tracks a real count, in
    /// either direction.
    pub fn checked_increment(self) -> Result<Self> {
        if self.is_unknown() {
            return Ok(self);
        }
        let next = self.0.checked_add(1).ok_or(VsolError::MathOverflow)?;
        // Never let a real, growing count collide with the UNKNOWN sentinel.
        require!(next != u32::MAX, VsolError::MathOverflow);
        Ok(OpenPositionCount(next))
    }

    /// No-op on `UNKNOWN`: a legacy binding never tracks a real count, in
    /// either direction.
    pub fn checked_decrement(self) -> Result<Self> {
        if self.is_unknown() {
            return Ok(self);
        }
        let next = self.0.checked_sub(1).ok_or(VsolError::MathOverflow)?;
        Ok(OpenPositionCount(next))
    }
}

impl anchor_lang::Space for OpenPositionCount {
    const INIT_SPACE: usize = 4;
}

impl AnchorSerialize for OpenPositionCount {
    fn serialize<W: borsh::io::Write>(&self, writer: &mut W) -> borsh::io::Result<()> {
        if self.is_unknown() {
            // Write nothing: a legacy 82-byte account must round-trip at
            // exactly 82 bytes forever, never gaining these 4 bytes back.
            Ok(())
        } else {
            writer.write_all(&self.0.to_le_bytes())
        }
    }
}

impl AnchorDeserialize for OpenPositionCount {
    fn deserialize_reader<R: borsh::io::Read>(reader: &mut R) -> borsh::io::Result<Self> {
        let mut buf = [0u8; 4];
        let mut filled = 0usize;
        while filled < 4 {
            let n = reader.read(&mut buf[filled..])?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        match filled {
            // Buffer was already exhausted: a legacy account with no
            // trailing bytes for this field at all.
            0 => Ok(OpenPositionCount::UNKNOWN),
            4 => Ok(OpenPositionCount(u32::from_le_bytes(buf))),
            // Neither "nothing left" nor "a full 4 bytes": not a shape any
            // real account layout (82 or 86 bytes) can produce. Fail closed
            // rather than silently guessing.
            _ => Err(borsh::io::Error::new(
                borsh::io::ErrorKind::UnexpectedEof,
                "OpenPositionCount: truncated trailing bytes",
            )),
        }
    }
}

// Only compiled during `anchor build`'s separate IDL-generation pass (the
// `idl-build` feature). Anchor's `#[account]`/`InitSpace` macros require
// every field type to implement `IdlBuild` under that pass; the default
// (empty) impl would compile but silently drop the field from the
// generated IDL, so a client could never see or decode `open_positions`.
// Representing it as a plain type alias to `u32` is accurate: on the wire
// it either IS a little-endian u32 (present) or entirely absent (a legacy
// account) -- there is no richer shape to describe.
#[cfg(feature = "idl-build")]
impl anchor_lang::idl::build::IdlBuild for OpenPositionCount {
    fn create_type() -> Option<anchor_lang::idl::types::IdlTypeDef> {
        Some(anchor_lang::idl::types::IdlTypeDef {
            name: "OpenPositionCount".to_string(),
            docs: vec![],
            serialization: anchor_lang::idl::types::IdlSerialization::default(),
            repr: None,
            generics: vec![],
            ty: anchor_lang::idl::types::IdlTypeDefTy::Type {
                alias: anchor_lang::idl::types::IdlType::U32,
            },
        })
    }
}

#[account]
#[derive(InitSpace)]
pub struct LiquidityPoolMarket {
    pub bump: u8,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub last_trade_at: i64,
    pub enabled: bool,
    // Appended after launch: keep at the end so existing byte offsets stay
    // valid. See `OpenPositionCount`'s own doc comment for the legacy-
    // tolerant (de)serialization that keeps a pre-existing 82-byte account
    // reading this as `UNKNOWN` and re-serializing at exactly 82 bytes.
    pub open_positions: OpenPositionCount,
}

#[account]
#[derive(InitSpace)]
pub struct PoolQuoteNonce {
    pub bump: u8,
    pub status: u8,
    pub pool: Pubkey,
    pub quote_authority: Pubkey,
    pub nonce: u64,
    pub position: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct PoolPosition {
    pub bump: u8,
    pub vault_bump: u8,
    pub status: u8,
    pub direction: u8,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub nonce_record: Pubkey,
    pub buyer: Pubkey,
    pub quote_authority: Pubkey,
    pub settlement_mint: Pubkey,
    pub nonce: u64,
    pub strike: u64,
    pub width: u64,
    pub premium: u64,
    pub max_payout: u64,
    pub fee_bps: u16,
    pub opened_at: i64,
    pub quote_expiry: i64,
}

#[repr(u8)]
pub enum Direction {
    Up = 0,
    Down = 1,
}

impl TryFrom<u8> for Direction {
    type Error = Error;
    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(Self::Up),
            1 => Ok(Self::Down),
            _ => err!(VsolError::InvalidDirection),
        }
    }
}

#[repr(u8)]
pub enum NonceStatus {
    Filled = 1,
}

#[repr(u8)]
pub enum PositionStatus {
    Open = 1,
}

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub fee_bps: u16,
}
#[event]
pub struct ConfigUpdated {
    pub config: Pubkey,
    pub domain_version: u16,
}
#[event]
pub struct AdminNominated {
    pub pending_admin: Pubkey,
}
#[event]
pub struct AdminAccepted {
    pub admin: Pubkey,
}
#[event]
pub struct PauseUpdated {
    pub paused: bool,
}
#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub market_id: [u8; 32],
    pub expiry: i64,
    pub settlement_mint: Pubkey,
    pub creator: Pubkey,
}
#[event]
pub struct MarketEnabled {
    pub market: Pubkey,
    pub enabled: bool,
}
#[event]
pub struct EligibilityUpdated {
    pub wallet: Pubkey,
    pub can_trade: bool,
    pub expires_at: i64,
}
#[event]
pub struct SettlementPublished {
    pub market: Pubkey,
    pub price: u64,
    pub confidence: u64,
    pub observed_at: i64,
    pub price_update: Pubkey,
    pub feed_id: [u8; 32],
    // True when this settlement used the tier-2 last-known-price fallback
    // (a pre-expiry print accepted only after the primary observation
    // window fully elapsed) rather than a fresh tier-1 print, so indexers
    // and the UI can disclose it honestly.
    pub settled_from_stale_price: bool,
}
#[event]
pub struct CustomPriceFeedUpdated {
    pub feed: Pubkey,
    pub symbol: [u8; 16],
    pub price: u64,
    pub confidence: u64,
    pub published_at: i64,
}
#[event]
pub struct CustomSettlementPublished {
    pub market: Pubkey,
    pub price: u64,
    pub confidence: u64,
    pub published_at: i64,
}
#[event]
pub struct LiquidityPoolInitialized {
    pub pool: Pubkey,
    pub settlement_mint: Pubkey,
    pub quote_authority: Pubkey,
    pub manager: Pubkey,
}

#[event]
pub struct LiquidityPoolUpdated {
    pub pool: Pubkey,
    pub quote_authority: Pubkey,
    pub max_utilization_bps: u16,
    pub max_position_bps: u16,
}

/// Emitted by `update_liquidity_pool` whenever a change is timelocked rather
/// than applied immediately (raising a cap, or rotating `quote_authority`).
/// Carries `effective_at` so LPs and indexers can observe a pending change
/// and its deadline -- the timelock is worthless as a defense if nobody can
/// see it coming. See `POOL_UPDATE_TIMELOCK_SECONDS`.
#[event]
pub struct LiquidityPoolUpdateProposed {
    pub pool: Pubkey,
    pub pending_quote_authority: Pubkey,
    pub pending_max_utilization_bps: u16,
    pub pending_max_position_bps: u16,
    pub effective_at: i64,
}

/// Emitted by `cancel_pending_pool_update` when a manager discards a pending
/// proposal before its timelock elapses.
#[event]
pub struct LiquidityPoolUpdateCancelled {
    pub pool: Pubkey,
}

#[event]
pub struct LiquidityPoolMarketUpdated {
    pub pool: Pubkey,
    pub market: Pubkey,
    pub last_trade_at: i64,
    pub enabled: bool,
}

#[event]
pub struct LiquidityDeposited {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct LiquidityWithdrawn {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct PoolQuoteFilled {
    pub position: Pubkey,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub buyer: Pubkey,
    pub quote_authority: Pubkey,
    pub nonce: u64,
    pub premium: u64,
    pub max_payout: u64,
}

#[event]
pub struct PoolPositionSettled {
    pub position: Pubkey,
    pub pool: Pubkey,
    pub settlement_price: u64,
    pub payout: u64,
    pub pool_amount: u64,
    pub fee: u64,
}

#[event]
pub struct PoolPositionRefunded {
    pub position: Pubkey,
    pub pool: Pubkey,
    pub premium: u64,
    pub collateral: u64,
}

#[event]
pub struct PoolPositionClosedEarly {
    pub position: Pubkey,
    pub buyer: Pubkey,
    pub buyback_amount: u64,
    pub fee: u64,
    pub pool_amount: u64,
}

#[event]
pub struct MarketClosed {
    pub market: Pubkey,
    pub creator: Pubkey,
}

#[error_code]
pub enum VsolError {
    #[msg("The protocol is paused.")]
    ProtocolPaused,
    #[msg("The signer is not authorized.")]
    Unauthorized,
    #[msg("An authority cannot be the default public key.")]
    InvalidAuthority,
    #[msg("The protocol fee is above the configured maximum.")]
    FeeTooHigh,
    #[msg("The market expiry is invalid.")]
    InvalidExpiry,
    #[msg("The observation window is invalid.")]
    InvalidObservationWindow,
    #[msg("The settlement grace period is invalid.")]
    InvalidSettlementGrace,
    #[msg("The maximum settlement staleness is invalid.")]
    InvalidSettlementStaleness,
    #[msg("The confidence threshold is invalid.")]
    InvalidConfidence,
    #[msg("The symbol is empty.")]
    InvalidSymbol,
    #[msg("The market price scale must be positive.")]
    InvalidPriceScale,
    #[msg("The Pyth feed identifier is invalid.")]
    InvalidPythFeed,
    #[msg("The Pyth price update is invalid, stale, or insufficiently verified.")]
    InvalidPythPriceUpdate,
    #[msg("The Pyth exponent cannot be represented safely.")]
    InvalidPythExponent,
    #[msg("The underlying mint cannot be the default public key.")]
    InvalidUnderlyingMint,
    #[msg("The market id does not match the deterministic hash of its parameters.")]
    InvalidMarketId,
    #[msg("The amount must be positive.")]
    InvalidAmount,
    #[msg("The payout width must be positive.")]
    InvalidWidth,
    #[msg("The direction must be up or down.")]
    InvalidDirection,
    #[msg("A checked arithmetic operation failed.")]
    MathOverflow,
    #[msg("The market is disabled.")]
    MarketDisabled,
    #[msg("The market has expired.")]
    MarketExpired,
    #[msg("The market has not expired.")]
    MarketNotExpired,
    #[msg("The maker quote has expired.")]
    QuoteExpired,
    #[msg("The maker signature instruction is missing.")]
    MissingMakerSignature,
    #[msg("The maker signature or signed quote message is invalid.")]
    InvalidMakerSignature,
    #[msg("The writer does not have enough available collateral.")]
    InsufficientWriterLiquidity,
    #[msg("Escrow does not exactly equal premium plus maximum payout.")]
    CollateralMismatch,
    #[msg("An eligibility account is required.")]
    EligibilityRequired,
    #[msg("The eligibility account is invalid.")]
    InvalidEligibility,
    #[msg("The wallet is not eligible to trade.")]
    IneligibleWallet,
    #[msg("The market account is invalid.")]
    InvalidMarket,
    #[msg("The oracle account is invalid.")]
    InvalidOracle,
    #[msg("The settlement oracle is already finalized.")]
    OracleAlreadyFinalized,
    #[msg("The settlement oracle is not finalized.")]
    OracleNotFinalized,
    #[msg("The oracle price is invalid.")]
    InvalidOraclePrice,
    #[msg("The oracle observation timestamp is outside the approved window.")]
    InvalidObservationTime,
    #[msg("The settlement publication window is closed.")]
    SettlementWindowClosed,
    #[msg("The oracle confidence interval is too wide.")]
    OracleConfidenceTooWide,
    #[msg("The settlement fallback window is still open.")]
    SettlementWindowOpen,
    #[msg("The position is invalid.")]
    InvalidPosition,
    #[msg("The position is not open.")]
    PositionNotOpen,
    #[msg("The quote nonce record is invalid.")]
    InvalidNonce,
    #[msg("A settlement destination token account is invalid.")]
    InvalidDestination,
    #[msg("The liquidity pool has active collateral obligations.")]
    PoolHasOpenPositions,
    #[msg("The liquidity pool share amount is invalid.")]
    InvalidPoolShares,
    #[msg("The liquidity pool has no assets backing outstanding shares.")]
    PoolInsolvent,
    #[msg("The deposit or withdrawal is too small after conservative rounding.")]
    DepositTooSmall,
    #[msg("The requested minimum output was not met.")]
    SlippageExceeded,
    #[msg("The transaction deadline has expired.")]
    DeadlineExpired,
    #[msg("The liquidity pool risk limits are invalid.")]
    InvalidPoolRiskLimits,
    #[msg("The liquidity pool is not enabled for this market.")]
    PoolMarketDisabled,
    #[msg("The market's last-trade cutoff is invalid.")]
    InvalidLastTradeCutoff,
    #[msg("The market's last-trade cutoff has been reached.")]
    LastTradeCutoffReached,
    #[msg("The liquidity pool utilization limit would be exceeded.")]
    PoolUtilizationExceeded,
    #[msg("The position exceeds the liquidity pool's per-position risk limit.")]
    PoolPositionLimitExceeded,
    #[msg("The buyback amount cannot exceed the position's maximum payout.")]
    BuybackExceedsMaxPayout,
    #[msg("The market cannot be closed yet: its settlement window has not fully elapsed, or its pool authorization is still enabled.")]
    MarketNotCloseable,
    #[msg("The supplied pool/pool-market pair is invalid or inconsistent.")]
    InvalidPoolMarket,
    #[msg("There is no pending liquidity pool update to apply or cancel.")]
    NoPendingPoolUpdate,
    #[msg("The pending liquidity pool update's timelock has not yet elapsed.")]
    PoolUpdateTimelocked,
    #[msg("The market strike must be positive.")]
    InvalidStrike,
    #[msg("The custom price feed has not yet updated past this market's expiry.")]
    CustomFeedNotYetFresh,
    #[msg("The custom price feed has not updated recently enough to settle with.")]
    CustomFeedStale,
    #[msg("The custom price feed timestamp is in the future.")]
    CustomFeedFromFuture,
    #[msg("The custom price feed timestamp must increase strictly.")]
    CustomFeedTimestampNotIncreasing,
}

/// Deterministic market id: identical series parameters bind to one PDA, so
/// factory creation cannot fragment the same market across duplicate accounts.
///
/// Includes `args.strike`: two markets identical in every other parameter but
/// a different conditional-token strike must be distinct series (distinct
/// PDAs), not the same market re-created twice -- otherwise "will BTC finish
/// above $50k" and "above $60k" at the same expiry/feed would collide onto
/// one account.
fn expected_market_id(args: &CreateMarketArgs, settlement_mint: Pubkey) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        MARKET_ID_DOMAIN,
        &args.pyth_feed_id,
        settlement_mint.as_ref(),
        &args.expiry.to_le_bytes(),
        &args.observation_window_seconds.to_le_bytes(),
        &args.settlement_grace_seconds.to_le_bytes(),
        &args.price_scale.to_le_bytes(),
        &args.max_confidence_bps.to_le_bytes(),
        &args.symbol,
        &args.max_settlement_staleness_seconds.to_le_bytes(),
        &args.strike.to_le_bytes(),
    ])
    .to_bytes()
}

/// The instant no settlement can ever occur again for `market`:
/// `expiry + observation_window_seconds + settlement_grace_seconds +
/// max_settlement_staleness_seconds`. Shared by the two instructions that
/// must agree on it exactly:
///
/// - `publish_pyth_settlement` requires `now <= final_settlement_deadline(market)`
///   to publish (tier 1 the whole way out to this instant; tier 2 after its
///   own additional `tier_two_open_at` gate -- see that function's own doc
///   comment for the full two-tier derivation).
/// - `redeem_unresolved` requires `now > final_settlement_deadline(market)`
///   to open its pro-rata escape hatch (see its own doc comment for why it
///   is this instant specifically, not the earlier `settlement_deadline`
///   `refund_unsettled` uses).
///
/// These two conditions are exact complements of `now <= final_settlement_deadline`,
/// which is what makes `publish_pyth_settlement` and `redeem_unresolved`
/// strictly mutually exclusive: at any given `now`, either the oracle could
/// still possibly finalize, or the escape hatch is open -- never both, never
/// neither. If this function's arithmetic ever diverges from either caller's
/// own understanding of it, that mutual exclusivity breaks: an overlap lets
/// a pro-rata payout be handed out while the oracle can still later finalize
/// with a real winner (see `redeem_unresolved`'s doc comment for the exact
/// insolvency this produces), while a gap freezes the market in a state
/// where neither path is callable. Both callers MUST call this function
/// rather than re-deriving the arithmetic inline.
fn final_settlement_deadline(market: &Market) -> Result<i64> {
    let observation_end = market
        .expiry
        .checked_add(i64::from(market.observation_window_seconds))
        .ok_or(VsolError::MathOverflow)?;
    let settlement_deadline = observation_end
        .checked_add(i64::from(market.settlement_grace_seconds))
        .ok_or(VsolError::MathOverflow)?;
    settlement_deadline
        .checked_add(i64::from(market.max_settlement_staleness_seconds))
        .ok_or(VsolError::MathOverflow.into())
}

fn validate_pool_risk_limits(max_utilization_bps: u16, max_position_bps: u16) -> Result<()> {
    require!(
        max_utilization_bps > 0
            && max_utilization_bps <= MAX_POOL_UTILIZATION_BPS
            && max_position_bps > 0
            && max_position_bps <= max_utilization_bps,
        VsolError::InvalidPoolRiskLimits
    );
    Ok(())
}

fn normalize_pyth_price(price: PythPrice, target_scale: u64) -> Result<(u64, u64)> {
    require!(price.price > 0, VsolError::InvalidOraclePrice);
    require!(target_scale > 0, VsolError::InvalidPriceScale);

    let exponent_abs = price.exponent.unsigned_abs();
    require!(
        exponent_abs <= MAX_PYTH_EXPONENT_ABS,
        VsolError::InvalidPythExponent
    );
    let power = 10_u128
        .checked_pow(exponent_abs)
        .ok_or(VsolError::MathOverflow)?;
    let scale = u128::from(target_scale);
    let normalize = |value: u128, round_up: bool| -> Result<u64> {
        let scaled = if price.exponent >= 0 {
            value
                .checked_mul(scale)
                .and_then(|candidate| candidate.checked_mul(power))
                .ok_or(VsolError::MathOverflow)?
        } else {
            let numerator = value.checked_mul(scale).ok_or(VsolError::MathOverflow)?;
            if round_up && numerator > 0 {
                numerator
                    .checked_add(power.checked_sub(1).ok_or(VsolError::MathOverflow)?)
                    .ok_or(VsolError::MathOverflow)?
                    .checked_div(power)
                    .ok_or(VsolError::MathOverflow)?
            } else {
                numerator
                    .checked_div(power)
                    .ok_or(VsolError::MathOverflow)?
            }
        };
        u64::try_from(scaled).map_err(|_| error!(VsolError::MathOverflow))
    };

    Ok((
        normalize(price.price as u128, false)?,
        normalize(price.conf as u128, true)?,
    ))
}

fn transfer_checked<'info>(
    token_program: Pubkey,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new(
            token_program,
            TransferChecked {
                from,
                mint,
                to,
                authority,
            },
        ),
        amount,
        decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn transfer_checked_signed<'info>(
    token_program: Pubkey,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from,
                mint,
                to,
                authority,
            },
            &[signer_seeds],
        ),
        amount,
        decimals,
    )
}

fn close_token_account<'info>(
    token_program: Pubkey,
    account: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account,
            destination,
            authority,
        },
        &[signer_seeds],
    ))
}

#[cfg(test)]
mod oracle_tests {
    use super::*;

    fn price(price: i64, conf: u64, exponent: i32) -> PythPrice {
        PythPrice {
            price,
            conf,
            exponent,
            publish_time: 1_700_000_000,
        }
    }

    #[test]
    fn normalizes_negative_pyth_exponent_to_market_scale() {
        let (value, confidence) =
            normalize_pyth_price(price(20_405_953, 10_209, -5), 1_000_000).unwrap();
        assert_eq!(value, 204_059_530);
        assert_eq!(confidence, 102_090);
    }

    #[test]
    fn confidence_rounds_up_when_market_scale_is_coarser() {
        let (normalized_price, normalized_confidence) =
            normalize_pyth_price(price(12_345, 1, -4), 100).unwrap();
        assert_eq!(normalized_price, 123);
        assert_eq!(normalized_confidence, 1);
    }

    #[test]
    fn normalizes_positive_pyth_exponent() {
        let (value, confidence) = normalize_pyth_price(price(123, 2, 2), 1_000).unwrap();
        assert_eq!(value, 12_300_000);
        assert_eq!(confidence, 200_000);
    }

    #[test]
    fn rejects_non_positive_and_unbounded_values() {
        assert!(normalize_pyth_price(price(0, 1, -5), 1_000_000).is_err());
        assert!(normalize_pyth_price(price(1, 1, -19), 1_000_000).is_err());
        assert!(normalize_pyth_price(price(i64::MAX, 1, 18), u64::MAX).is_err());
    }
}

#[cfg(test)]
mod factory_tests {
    use super::*;

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
    }

    fn fixture_symbol() -> [u8; 16] {
        let mut symbol = [0u8; 16];
        symbol[..4].copy_from_slice(b"NVDA");
        symbol
    }

    fn fixture_args(market_id: [u8; 32]) -> CreateMarketArgs {
        CreateMarketArgs {
            market_id,
            underlying_mint: Pubkey::new_from_array([0x33; 32]),
            symbol: fixture_symbol(),
            price_scale: 1_000_000,
            expiry: 1_800_000_000,
            observation_window_seconds: 30,
            settlement_grace_seconds: 900,
            max_confidence_bps: 100,
            pyth_feed_id: [0x11; 32],
            max_settlement_staleness_seconds: 86_400,
            strike: 100_000_000,
        }
    }

    fn fixture_settlement_mint() -> Pubkey {
        Pubkey::new_from_array([0x22; 32])
    }

    #[test]
    fn market_id_hash_matches_the_pinned_known_answer_vector() {
        let args = fixture_args([0u8; 32]);
        let id = expected_market_id(&args, fixture_settlement_mint());
        assert_eq!(
            to_hex(&id),
            "305841fbbb6aaefcf048870bda425066777d12e82d8b74f358f13d43caf66adf"
        );
    }

    #[test]
    fn market_id_hash_binds_every_parameter() {
        let base = fixture_args([0u8; 32]);
        let mint = fixture_settlement_mint();
        let base_id = expected_market_id(&base, mint);

        let mut different_expiry = base;
        different_expiry.expiry += 1;
        assert_ne!(expected_market_id(&different_expiry, mint), base_id);

        let mut different_window = base;
        different_window.observation_window_seconds += 1;
        assert_ne!(expected_market_id(&different_window, mint), base_id);

        let mut different_grace = base;
        different_grace.settlement_grace_seconds += 1;
        assert_ne!(expected_market_id(&different_grace, mint), base_id);

        let mut different_scale = base;
        different_scale.price_scale += 1;
        assert_ne!(expected_market_id(&different_scale, mint), base_id);

        let mut different_confidence = base;
        different_confidence.max_confidence_bps += 1;
        assert_ne!(expected_market_id(&different_confidence, mint), base_id);

        let mut different_symbol = base;
        different_symbol.symbol[15] = 1;
        assert_ne!(expected_market_id(&different_symbol, mint), base_id);

        let mut different_feed = base;
        different_feed.pyth_feed_id[0] ^= 0xff;
        assert_ne!(expected_market_id(&different_feed, mint), base_id);

        let mut different_staleness = base;
        different_staleness.max_settlement_staleness_seconds += 1;
        assert_ne!(expected_market_id(&different_staleness, mint), base_id);

        let mut different_strike = base;
        different_strike.strike += 1;
        assert_ne!(expected_market_id(&different_strike, mint), base_id);

        let different_mint = Pubkey::new_from_array([0x44; 32]);
        assert_ne!(expected_market_id(&base, different_mint), base_id);
    }

    #[test]
    fn a_wrong_market_id_fails_the_equality_check() {
        let mint = fixture_settlement_mint();
        let correct_id = expected_market_id(&fixture_args([0u8; 32]), mint);
        let args_with_wrong_id = fixture_args([0xffu8; 32]);
        assert_ne!(args_with_wrong_id.market_id, correct_id);

        let args_with_correct_id = fixture_args(correct_id);
        assert_eq!(args_with_correct_id.market_id, correct_id);
    }
}
