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
    pool_buyback_message, pool_quote_message, quote_message, verify_preceding_ed25519_instruction,
    PoolBuybackMessageContext, PoolQuoteMessageContext, QuoteMessageContext,
};

declare_id!("2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MARKET_SEED: &[u8] = b"market";
pub const ORACLE_SEED: &[u8] = b"oracle";
pub const WRITER_SEED: &[u8] = b"writer";
pub const WRITER_TOKEN_SEED: &[u8] = b"writer-token";
pub const NONCE_SEED: &[u8] = b"nonce";
pub const POSITION_SEED: &[u8] = b"position";
pub const POSITION_VAULT_SEED: &[u8] = b"position-vault";
pub const ELIGIBILITY_SEED: &[u8] = b"eligibility";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_TOKEN_SEED: &[u8] = b"pool-token";
pub const PROVIDER_SEED: &[u8] = b"provider";
pub const POOL_MARKET_SEED: &[u8] = b"pool-market";
pub const POOL_NONCE_SEED: &[u8] = b"pool-nonce";
pub const POOL_POSITION_SEED: &[u8] = b"pool-position";
pub const POOL_POSITION_VAULT_SEED: &[u8] = b"pool-position-vault";
pub const QUOTE_DOMAIN: &[u8; 8] = b"VSOLRFQ1";
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

    pub fn initialize_writer_vault(ctx: Context<InitializeWriterVault>) -> Result<()> {
        require!(!ctx.accounts.config.paused, VsolError::ProtocolPaused);
        let writer_vault = &mut ctx.accounts.writer_vault;
        writer_vault.bump = ctx.bumps.writer_vault;
        writer_vault.token_bump = ctx.bumps.writer_token;
        writer_vault.config = ctx.accounts.config.key();
        writer_vault.maker = ctx.accounts.maker.key();
        writer_vault.settlement_mint = ctx.accounts.settlement_mint.key();
        emit!(WriterVaultInitialized {
            writer_vault: writer_vault.key(),
            maker: writer_vault.maker,
            settlement_mint: writer_vault.settlement_mint,
        });
        Ok(())
    }

    pub fn deposit_writer(ctx: Context<DepositWriter>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, VsolError::ProtocolPaused);
        require!(amount > 0, VsolError::InvalidAmount);
        transfer_checked(
            ctx.accounts.token_program.key(),
            ctx.accounts.maker_source.to_account_info(),
            ctx.accounts.writer_token.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.maker.to_account_info(),
            amount,
            ctx.accounts.settlement_mint.decimals,
        )?;
        emit!(WriterDeposited {
            writer_vault: ctx.accounts.writer_vault.key(),
            amount
        });
        Ok(())
    }

    pub fn withdraw_writer(ctx: Context<WithdrawWriter>, amount: u64) -> Result<()> {
        require!(amount > 0, VsolError::InvalidAmount);
        require!(
            ctx.accounts.writer_token.amount >= amount,
            VsolError::InsufficientWriterLiquidity
        );
        let config_key = ctx.accounts.config.key();
        let maker_key = ctx.accounts.maker.key();
        let settlement_mint_key = ctx.accounts.settlement_mint.key();
        let signer_seeds: &[&[u8]] = &[
            WRITER_SEED,
            config_key.as_ref(),
            maker_key.as_ref(),
            settlement_mint_key.as_ref(),
            &[ctx.accounts.writer_vault.bump],
        ];
        transfer_checked_signed(
            ctx.accounts.token_program.key(),
            ctx.accounts.writer_token.to_account_info(),
            ctx.accounts.maker_destination.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.writer_vault.to_account_info(),
            amount,
            ctx.accounts.settlement_mint.decimals,
            signer_seeds,
        )?;
        emit!(WriterWithdrawn {
            writer_vault: ctx.accounts.writer_vault.key(),
            amount
        });
        Ok(())
    }

    pub fn cancel_nonce(ctx: Context<CancelNonce>, nonce: u64) -> Result<()> {
        let record = &mut ctx.accounts.nonce_record;
        record.bump = ctx.bumps.nonce_record;
        record.status = NonceStatus::Cancelled as u8;
        record.config = ctx.accounts.config.key();
        record.maker = ctx.accounts.maker.key();
        record.nonce = nonce;
        record.position = Pubkey::default();
        emit!(NonceCancelled {
            maker: record.maker,
            nonce
        });
        Ok(())
    }

    pub fn fill_quote(ctx: Context<FillQuote>, quote: QuoteArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let market = &ctx.accounts.market;
        require!(!config.paused, VsolError::ProtocolPaused);
        require!(market.enabled, VsolError::MarketDisabled);
        require!(now < market.expiry, VsolError::MarketExpired);
        require!(
            now <= quote.quote_expiry && quote.quote_expiry < market.expiry,
            VsolError::QuoteExpired
        );
        require!(
            quote.premium > 0 && quote.max_payout > 0,
            VsolError::InvalidAmount
        );
        require!(quote.strike > 0 && quote.width > 0, VsolError::InvalidWidth);
        Direction::try_from(quote.direction)?;

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
        let market_key = market.key();
        let buyer_key = ctx.accounts.buyer.key();
        let maker_key = ctx.accounts.maker.key();
        let quote_context = QuoteMessageContext {
            program_id: &crate::ID,
            config: &config_key,
            market: &market_key,
            buyer: &buyer_key,
            maker: &maker_key,
        };
        let message = quote_message(
            &config.domain_separator,
            config.domain_version,
            &quote_context,
            &quote,
        );
        verify_preceding_ed25519_instruction(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &ctx.accounts.maker.key(),
            &message,
        )?;

        require!(
            ctx.accounts.writer_token.amount >= quote.max_payout,
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

        let config_key = config.key();
        let maker_key = ctx.accounts.maker.key();
        let settlement_mint_key = ctx.accounts.settlement_mint.key();
        let writer_seeds: &[&[u8]] = &[
            WRITER_SEED,
            config_key.as_ref(),
            maker_key.as_ref(),
            settlement_mint_key.as_ref(),
            &[ctx.accounts.writer_vault.bump],
        ];
        transfer_checked_signed(
            ctx.accounts.token_program.key(),
            ctx.accounts.writer_token.to_account_info(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.writer_vault.to_account_info(),
            quote.max_payout,
            ctx.accounts.settlement_mint.decimals,
            writer_seeds,
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
        record.config = config.key();
        record.maker = ctx.accounts.maker.key();
        record.nonce = quote.nonce;
        record.position = ctx.accounts.position.key();

        let position = &mut ctx.accounts.position;
        position.bump = ctx.bumps.position;
        position.vault_bump = ctx.bumps.position_vault;
        position.status = PositionStatus::Open as u8;
        position.direction = quote.direction;
        position.market = market.key();
        position.nonce_record = record.key();
        position.buyer = ctx.accounts.buyer.key();
        position.maker = ctx.accounts.maker.key();
        position.settlement_mint = ctx.accounts.settlement_mint.key();
        position.nonce = quote.nonce;
        position.strike = quote.strike;
        position.width = quote.width;
        position.premium = quote.premium;
        position.max_payout = quote.max_payout;
        position.fee_bps = config.fee_bps;
        position.opened_at = now;
        position.quote_expiry = quote.quote_expiry;

        emit!(QuoteFilled {
            position: position.key(),
            market: market.key(),
            buyer: position.buyer,
            maker: position.maker,
            nonce: position.nonce,
            premium: position.premium,
            max_payout: position.max_payout,
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
        let final_deadline = settlement_deadline
            .checked_add(i64::from(market.max_settlement_staleness_seconds))
            .ok_or(VsolError::MathOverflow)?;
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

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let position = &ctx.accounts.position;
        let market = &ctx.accounts.market;
        let oracle = &ctx.accounts.oracle;
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
        // A filled quote must not become more expensive if governance updates
        // the protocol fee before expiry.
        let fee = calculate_fee(position.premium, position.fee_bps)?;
        let maker_amount = position
            .max_payout
            .checked_sub(payout)
            .and_then(|value| value.checked_add(position.premium))
            .and_then(|value| value.checked_sub(fee))
            .ok_or(VsolError::MathOverflow)?;
        let total = payout
            .checked_add(maker_amount)
            .and_then(|value| value.checked_add(fee))
            .ok_or(VsolError::MathOverflow)?;
        let expected = position
            .premium
            .checked_add(position.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        require!(
            total == expected && ctx.accounts.position_vault.amount == expected,
            VsolError::CollateralMismatch
        );

        let nonce_record_key = ctx.accounts.nonce_record.key();
        let position_seeds: &[&[u8]] =
            &[POSITION_SEED, nonce_record_key.as_ref(), &[position.bump]];
        if payout > 0 {
            transfer_checked_signed(
                ctx.accounts.token_program.key(),
                ctx.accounts.position_vault.to_account_info(),
                ctx.accounts.buyer_destination.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.position.to_account_info(),
                payout,
                ctx.accounts.settlement_mint.decimals,
                position_seeds,
            )?;
        }
        if maker_amount > 0 {
            transfer_checked_signed(
                ctx.accounts.token_program.key(),
                ctx.accounts.position_vault.to_account_info(),
                ctx.accounts.maker_destination.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.position.to_account_info(),
                maker_amount,
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
        close_token_account(
            ctx.accounts.token_program.key(),
            ctx.accounts.position_vault.to_account_info(),
            ctx.accounts.rent_recipient.to_account_info(),
            ctx.accounts.position.to_account_info(),
            position_seeds,
        )?;

        emit!(PositionSettled {
            position: position.key(),
            settlement_price: oracle.price,
            payout,
            maker_amount,
            fee,
        });
        Ok(())
    }

    pub fn refund_unsettled(ctx: Context<RefundUnsettled>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let position = &ctx.accounts.position;
        let market = &ctx.accounts.market;
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
        let nonce_record_key = ctx.accounts.nonce_record.key();
        let position_seeds: &[&[u8]] =
            &[POSITION_SEED, nonce_record_key.as_ref(), &[position.bump]];
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
            ctx.accounts.maker_destination.to_account_info(),
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
        emit!(PositionRefunded {
            position: position.key(),
            premium: position.premium,
            collateral: position.max_payout,
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

        // `pool_market` is `init_if_needed`: this call either creates a brand
        // new authorization record or mutates one that already exists.
        // Anchor zero-initializes an account on creation, and `pool` is only
        // ever written to a non-default value right below in this same
        // instruction (it is never left at `Pubkey::default()` once set), so
        // "pool_market.pool is still the zero pubkey" is a sound signal that
        // this account did not exist before this instruction ran. We check
        // it before making any writes. We deliberately do not use
        // `last_trade_at == 0` for this: `enabled == false` is a legitimate,
        // reachable state for `last_trade_at` to be left at (or reset to)
        // zero, so that field can't distinguish "never created" from
        // "created and since disabled".
        let is_first_time_enable =
            ctx.accounts.pool_market.pool == Pubkey::default() && args.enabled;

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

        let pool_market = &mut ctx.accounts.pool_market;
        pool_market.bump = ctx.bumps.pool_market;
        pool_market.pool = ctx.accounts.pool.key();
        pool_market.market = ctx.accounts.market.key();
        pool_market.last_trade_at = args.last_trade_at;
        pool_market.enabled = args.enabled;
        emit!(LiquidityPoolMarketUpdated {
            pool: pool_market.pool,
            market: pool_market.market,
            last_trade_at: pool_market.last_trade_at,
            enabled: pool_market.enabled,
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
        let fee = calculate_fee(position.premium, position.fee_bps)?;
        let pool_amount = position
            .max_payout
            .checked_sub(payout)
            .and_then(|value| value.checked_add(position.premium))
            .and_then(|value| value.checked_sub(fee))
            .ok_or(VsolError::MathOverflow)?;
        let expected = position
            .premium
            .checked_add(position.max_payout)
            .ok_or(VsolError::MathOverflow)?;
        require!(
            payout
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
        if payout > 0 {
            transfer_checked_signed(
                ctx.accounts.token_program.key(),
                ctx.accounts.position_vault.to_account_info(),
                ctx.accounts.buyer_destination.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.position.to_account_info(),
                payout,
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
    /// 2. `fill_quote` and `fill_pool_quote` both hard-require
    ///    `now < market.expiry` before opening a new position. Since the
    ///    deadline above is strictly after `expiry`, by the time it has
    ///    elapsed no new writer- or pool-backed position can ever be opened
    ///    against this market again, full stop -- this holds independently
    ///    of `market.enabled`/`pool_market.enabled`, which are therefore not
    ///    load-bearing for "no new obligations": that is already guaranteed
    ///    by the expiry check those two instructions perform themselves.
    /// 3. The one obligation this instruction *cannot* cheaply verify
    ///    on-chain is "no already-open `Position`/`PoolPosition` still
    ///    references this market". Those are independent PDAs keyed by
    ///    nonce record (not by market), so there is no bounded on-chain
    ///    enumeration of "every position that ever referenced this market"
    ///    -- unlike the pool-authorization case below, which is a single
    ///    fixed-address PDA per (pool, market) pair. If an open position
    ///    were left unsettled/unrefunded, closing the market would strand it
    ///    forever: `settle`, `settle_pool_position`, `refund_unsettled`, and
    ///    `refund_pool_position` all load the `Market` account via `has_one`
    ///    and would simply fail once that account no longer exists, with no
    ///    way to ever recover the position's escrowed funds.
    ///    ==> OFF-CHAIN ASSUMPTION (required, not enforced by this
    ///    instruction): the caller -- the off-chain cleaner -- must confirm
    ///    every `Position` and `PoolPosition` that ever referenced this
    ///    market has already been settled or refunded (its vault closed)
    ///    before calling `close_settled_market`. This is the documented gap
    ///    the task that added this instruction explicitly flagged and
    ///    accepted, given positions are not cheaply enumerable on-chain.
    ///    `MARKET_CLEANUP_BUFFER_SECONDS` bounds the damage when that
    ///    assumption is violated (a stranded position stays refundable for a
    ///    week after settlement closes) but does NOT discharge it: a caller
    ///    that closes a market with an open position still strands it
    ///    permanently. Enumerating positions on-chain -- e.g. an
    ///    `open_position_count` on `Market`, maintained by fill/settle/refund
    ///    -- is the only way to actually enforce this, and remains the right
    ///    fix before real money.
    /// 4. As a cheap, *additional* on-chain check (defense-in-depth, not the
    ///    primary safety argument above, which already holds regardless): if
    ///    the caller passes a `pool`/`pool_market` pair, it must be the
    ///    authorization record for *this* market and pool, and it must have
    ///    `enabled == false`. Passing `None` for both is accepted (an
    ///    omitted pair is not proof no pool was ever authorized, but no
    ///    cheaper on-chain check exists -- see point 3).
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

        match (ctx.accounts.pool.as_ref(), ctx.accounts.pool_market.as_ref()) {
            (Some(pool), Some(pool_market)) => {
                require_keys_eq!(pool_market.pool, pool.key(), VsolError::InvalidPoolMarket);
                require_keys_eq!(pool_market.market, market.key(), VsolError::InvalidPoolMarket);
                require!(!pool_market.enabled, VsolError::MarketNotCloseable);
            }
            (None, None) => {}
            _ => return err!(VsolError::InvalidPoolMarket),
        }

        emit!(MarketClosed {
            market: market.key(),
            creator: market.creator,
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
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuoteArgs {
    pub nonce: u64,
    pub direction: u8,
    pub strike: u64,
    pub width: u64,
    pub premium: u64,
    pub max_payout: u64,
    pub quote_expiry: i64,
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
pub struct InitializeWriterVault<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(init, payer = maker, space = 8 + WriterVault::INIT_SPACE, seeds = [WRITER_SEED, config.key().as_ref(), maker.key().as_ref(), settlement_mint.key().as_ref()], bump)]
    pub writer_vault: Account<'info, WriterVault>,
    #[account(init, payer = maker, token::mint = settlement_mint, token::authority = writer_vault, seeds = [WRITER_TOKEN_SEED, writer_vault.key().as_ref()], bump)]
    pub writer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositWriter<'info> {
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub maker: Signer<'info>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(seeds = [WRITER_SEED, config.key().as_ref(), maker.key().as_ref(), settlement_mint.key().as_ref()], bump = writer_vault.bump, has_one = config, has_one = maker, has_one = settlement_mint)]
    pub writer_vault: Account<'info, WriterVault>,
    #[account(mut, seeds = [WRITER_TOKEN_SEED, writer_vault.key().as_ref()], bump = writer_vault.token_bump, token::mint = settlement_mint, token::authority = writer_vault)]
    pub writer_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = settlement_mint, token::authority = maker)]
    pub maker_source: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawWriter<'info> {
    pub config: Account<'info, Config>,
    pub maker: Signer<'info>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(seeds = [WRITER_SEED, config.key().as_ref(), maker.key().as_ref(), settlement_mint.key().as_ref()], bump = writer_vault.bump, has_one = config, has_one = maker, has_one = settlement_mint)]
    pub writer_vault: Account<'info, WriterVault>,
    #[account(mut, seeds = [WRITER_TOKEN_SEED, writer_vault.key().as_ref()], bump = writer_vault.token_bump, token::mint = settlement_mint, token::authority = writer_vault)]
    pub writer_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = settlement_mint, token::authority = maker)]
    pub maker_destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CancelNonce<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = maker, space = 8 + QuoteNonce::INIT_SPACE, seeds = [NONCE_SEED, config.key().as_ref(), maker.key().as_ref(), nonce.to_le_bytes().as_ref()], bump)]
    pub nonce_record: Account<'info, QuoteNonce>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(quote: QuoteArgs)]
pub struct FillQuote<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: The maker is authenticated by the immediately preceding Ed25519 instruction.
    pub maker: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = settlement_mint @ VsolError::InvalidMarket)]
    pub market: Box<Account<'info, Market>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(seeds = [WRITER_SEED, config.key().as_ref(), maker.key().as_ref(), settlement_mint.key().as_ref()], bump = writer_vault.bump, has_one = config, has_one = settlement_mint, constraint = writer_vault.maker == maker.key() @ VsolError::InvalidWriterVault)]
    pub writer_vault: Box<Account<'info, WriterVault>>,
    #[account(mut, seeds = [WRITER_TOKEN_SEED, writer_vault.key().as_ref()], bump = writer_vault.token_bump, token::mint = settlement_mint, token::authority = writer_vault)]
    pub writer_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = settlement_mint, token::authority = buyer)]
    pub buyer_source: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = buyer, space = 8 + QuoteNonce::INIT_SPACE, seeds = [NONCE_SEED, config.key().as_ref(), maker.key().as_ref(), quote.nonce.to_le_bytes().as_ref()], bump)]
    pub nonce_record: Box<Account<'info, QuoteNonce>>,
    #[account(init, payer = buyer, space = 8 + Position::INIT_SPACE, seeds = [POSITION_SEED, nonce_record.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(init, payer = buyer, token::mint = settlement_mint, token::authority = position, seeds = [POSITION_VAULT_SEED, position.key().as_ref()], bump)]
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
pub struct Settle<'info> {
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = oracle @ VsolError::InvalidOracle, has_one = settlement_mint @ VsolError::InvalidMarket)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [ORACLE_SEED, market.key().as_ref()], bump = oracle.bump, has_one = market @ VsolError::InvalidOracle)]
    pub oracle: Box<Account<'info, SettlementOracle>>,
    #[account(constraint = nonce_record.status == NonceStatus::Filled as u8 @ VsolError::InvalidNonce, constraint = nonce_record.position == position.key() @ VsolError::InvalidNonce)]
    pub nonce_record: Box<Account<'info, QuoteNonce>>,
    #[account(mut, close = rent_recipient, seeds = [POSITION_SEED, nonce_record.key().as_ref()], bump = position.bump, has_one = market @ VsolError::InvalidPosition, has_one = nonce_record @ VsolError::InvalidNonce, has_one = settlement_mint @ VsolError::InvalidPosition)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [POSITION_VAULT_SEED, position.key().as_ref()], bump = position.vault_bump, token::mint = settlement_mint, token::authority = position)]
    pub position_vault: Box<Account<'info, TokenAccount>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = settlement_mint, constraint = buyer_destination.owner == position.buyer @ VsolError::InvalidDestination)]
    pub buyer_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = settlement_mint, constraint = maker_destination.owner == position.maker @ VsolError::InvalidDestination)]
    pub maker_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = settlement_mint, constraint = treasury_destination.owner == config.treasury_owner @ VsolError::InvalidDestination)]
    pub treasury_destination: Box<Account<'info, TokenAccount>>,
    /// CHECK: Receives rent and must be the buyer stored in the position.
    #[account(mut, address = position.buyer)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundUnsettled<'info> {
    pub cranker: Signer<'info>,
    #[account(has_one = oracle @ VsolError::InvalidOracle, has_one = settlement_mint @ VsolError::InvalidMarket)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [ORACLE_SEED, market.key().as_ref()], bump = oracle.bump, has_one = market @ VsolError::InvalidOracle)]
    pub oracle: Box<Account<'info, SettlementOracle>>,
    #[account(constraint = nonce_record.status == NonceStatus::Filled as u8 @ VsolError::InvalidNonce, constraint = nonce_record.position == position.key() @ VsolError::InvalidNonce)]
    pub nonce_record: Box<Account<'info, QuoteNonce>>,
    #[account(mut, close = rent_recipient, seeds = [POSITION_SEED, nonce_record.key().as_ref()], bump = position.bump, has_one = market @ VsolError::InvalidPosition, has_one = nonce_record @ VsolError::InvalidNonce, has_one = settlement_mint @ VsolError::InvalidPosition)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [POSITION_VAULT_SEED, position.key().as_ref()], bump = position.vault_bump, token::mint = settlement_mint, token::authority = position)]
    pub position_vault: Box<Account<'info, TokenAccount>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = settlement_mint, constraint = buyer_destination.owner == position.buyer @ VsolError::InvalidDestination)]
    pub buyer_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = settlement_mint, constraint = maker_destination.owner == position.maker @ VsolError::InvalidDestination)]
    pub maker_destination: Box<Account<'info, TokenAccount>>,
    /// CHECK: Receives rent and must be the buyer stored in the position.
    #[account(mut, address = position.buyer)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
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
    #[account(init_if_needed, payer = manager, space = 8 + LiquidityPoolMarket::INIT_SPACE, seeds = [POOL_MARKET_SEED, pool.key().as_ref(), market.key().as_ref()], bump)]
    pub pool_market: Account<'info, LiquidityPoolMarket>,
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
    #[account(seeds = [POOL_MARKET_SEED, pool.key().as_ref(), market.key().as_ref()], bump = pool_market.bump, has_one = pool, has_one = market)]
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
    #[account(constraint = nonce_record.status == NonceStatus::Filled as u8 @ VsolError::InvalidNonce, constraint = nonce_record.position == position.key() @ VsolError::InvalidNonce, constraint = nonce_record.pool == pool.key() @ VsolError::InvalidNonce)]
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
    #[account(mut, token::mint = settlement_mint, constraint = treasury_destination.owner == config.treasury_owner @ VsolError::InvalidDestination)]
    pub treasury_destination: Box<Account<'info, TokenAccount>>,
    /// CHECK: Receives rent and must be the buyer stored in the position.
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
    #[account(constraint = nonce_record.status == NonceStatus::Filled as u8 @ VsolError::InvalidNonce, constraint = nonce_record.position == position.key() @ VsolError::InvalidNonce, constraint = nonce_record.pool == pool.key() @ VsolError::InvalidNonce)]
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
    /// CHECK: Receives rent and must be the buyer stored in the position.
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
    #[account(mut, close = rent_recipient, seeds = [POOL_POSITION_SEED, position.nonce_record.as_ref()], bump = position.bump, has_one = pool @ VsolError::InvalidPosition, has_one = market @ VsolError::InvalidPosition, has_one = settlement_mint @ VsolError::InvalidPosition, constraint = position.buyer == buyer.key() @ VsolError::Unauthorized)]
    pub position: Box<Account<'info, PoolPosition>>,
    #[account(mut, seeds = [POOL_POSITION_VAULT_SEED, position.key().as_ref()], bump = position.vault_bump, token::mint = settlement_mint, token::authority = position)]
    pub position_vault: Box<Account<'info, TokenAccount>>,
    pub settlement_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = settlement_mint, constraint = buyer_destination.owner == position.buyer @ VsolError::InvalidDestination)]
    pub buyer_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_TOKEN_SEED, pool.key().as_ref()], bump = pool.token_bump, token::mint = settlement_mint, token::authority = pool)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = settlement_mint, constraint = treasury_destination.owner == config.treasury_owner @ VsolError::InvalidDestination)]
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
/// `pool`/`pool_market` are optional and must be supplied together (both
/// `Some` or both `None`): they let the caller demonstrate that a specific
/// pool authorization for this market has been disabled, but omitting them
/// is accepted too (see point 3/4 of the safety argument -- this cannot be
/// made a hard on-chain requirement because positions/authorizations are not
/// cheaply enumerable from the market alone).
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
    pub pool: Option<Box<Account<'info, LiquidityPool>>>,
    pub pool_market: Option<Box<Account<'info, LiquidityPoolMarket>>>,
    /// CHECK: Receives the market's and oracle's reclaimed rent. Address-
    /// constrained to the market's own creator so rent can never be
    /// redirected to an arbitrary caller-supplied account.
    #[account(mut, address = market.creator)]
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

#[account]
#[derive(InitSpace)]
pub struct WriterVault {
    pub bump: u8,
    pub token_bump: u8,
    pub config: Pubkey,
    pub maker: Pubkey,
    pub settlement_mint: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct QuoteNonce {
    pub bump: u8,
    pub status: u8,
    pub config: Pubkey,
    pub maker: Pubkey,
    pub nonce: u64,
    pub position: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub bump: u8,
    pub vault_bump: u8,
    pub status: u8,
    pub direction: u8,
    pub market: Pubkey,
    pub nonce_record: Pubkey,
    pub buyer: Pubkey,
    pub maker: Pubkey,
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

#[account]
#[derive(InitSpace)]
pub struct LiquidityPoolMarket {
    pub bump: u8,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub last_trade_at: i64,
    pub enabled: bool,
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
    Cancelled = 2,
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
pub struct WriterVaultInitialized {
    pub writer_vault: Pubkey,
    pub maker: Pubkey,
    pub settlement_mint: Pubkey,
}
#[event]
pub struct WriterDeposited {
    pub writer_vault: Pubkey,
    pub amount: u64,
}
#[event]
pub struct WriterWithdrawn {
    pub writer_vault: Pubkey,
    pub amount: u64,
}
#[event]
pub struct NonceCancelled {
    pub maker: Pubkey,
    pub nonce: u64,
}
#[event]
pub struct QuoteFilled {
    pub position: Pubkey,
    pub market: Pubkey,
    pub buyer: Pubkey,
    pub maker: Pubkey,
    pub nonce: u64,
    pub premium: u64,
    pub max_payout: u64,
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
pub struct PositionSettled {
    pub position: Pubkey,
    pub settlement_price: u64,
    pub payout: u64,
    pub maker_amount: u64,
    pub fee: u64,
}
#[event]
pub struct PositionRefunded {
    pub position: Pubkey,
    pub premium: u64,
    pub collateral: u64,
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
    #[msg("The writer vault is invalid.")]
    InvalidWriterVault,
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
}

/// Deterministic market id: identical series parameters bind to one PDA, so
/// factory creation cannot fragment the same market across duplicate accounts.
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
    ])
    .to_bytes()
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
            "37cb5a119ad74934cd1d9254aef808898eefa3240e1862b9ce89df67dcb86c86"
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

