use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

mod math;
mod signature;

use math::{calculate_fee, calculate_payout};
use signature::{quote_message, verify_preceding_ed25519_instruction};

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
pub const QUOTE_DOMAIN: &[u8; 8] = b"VSOLRFQ1";
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_FEE_BPS: u16 = 1_000;
pub const MIN_MARKET_LEAD_SECONDS: i64 = 15;
pub const MAX_OBSERVATION_WINDOW_SECONDS: u32 = 3_600;
pub const MAX_SETTLEMENT_GRACE_SECONDS: u32 = 604_800;

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
            args.max_confidence_bps > 0 && args.max_confidence_bps <= 2_000,
            VsolError::InvalidConfidence
        );
        require!(
            args.symbol.iter().any(|byte| *byte != 0),
            VsolError::InvalidSymbol
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
        market.settlement_decimals = ctx.accounts.settlement_mint.decimals;
        market.enabled = true;

        let oracle = &mut ctx.accounts.oracle;
        oracle.bump = ctx.bumps.oracle;
        oracle.market = market.key();
        oracle.price = 0;
        oracle.confidence = 0;
        oracle.observed_at = 0;
        oracle.published_at = 0;
        oracle.finalized = false;

        emit!(MarketCreated {
            market: market.key(),
            market_id: market.market_id,
            expiry: market.expiry,
            settlement_mint: market.settlement_mint,
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

        let message = quote_message(
            &crate::ID,
            &config.domain_separator,
            config.domain_version,
            &config.key(),
            &market.key(),
            &ctx.accounts.buyer.key(),
            &ctx.accounts.maker.key(),
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

    pub fn publish_settlement(
        ctx: Context<PublishSettlement>,
        price: u64,
        confidence: u64,
        observed_at: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let market = &ctx.accounts.market;
        let oracle = &mut ctx.accounts.oracle;
        require!(!oracle.finalized, VsolError::OracleAlreadyFinalized);
        require!(price > 0, VsolError::InvalidOraclePrice);
        require!(now >= market.expiry, VsolError::MarketNotExpired);

        let observation_end = market
            .expiry
            .checked_add(i64::from(market.observation_window_seconds))
            .ok_or(VsolError::MathOverflow)?;
        let settlement_deadline = observation_end
            .checked_add(i64::from(market.settlement_grace_seconds))
            .ok_or(VsolError::MathOverflow)?;
        require!(
            observed_at >= market.expiry && observed_at <= observation_end && observed_at <= now,
            VsolError::InvalidObservationTime
        );
        require!(
            now <= settlement_deadline,
            VsolError::SettlementWindowClosed
        );

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
        oracle.observed_at = observed_at;
        oracle.published_at = now;
        oracle.finalized = true;
        emit!(SettlementPublished {
            market: market.key(),
            price,
            confidence,
            observed_at
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
        let fee = calculate_fee(position.premium, ctx.accounts.config.fee_bps)?;
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
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED, config.key().as_ref(), args.market_id.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = admin, space = 8 + SettlementOracle::INIT_SPACE, seeds = [ORACLE_SEED, market.key().as_ref()], bump)]
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
pub struct PublishSettlement<'info> {
    pub oracle_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = oracle_authority @ VsolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(has_one = config @ VsolError::InvalidMarket, has_one = oracle @ VsolError::InvalidOracle)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [ORACLE_SEED, market.key().as_ref()], bump = oracle.bump, has_one = market @ VsolError::InvalidOracle)]
    pub oracle: Account<'info, SettlementOracle>,
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
    pub settlement_decimals: u8,
    pub enabled: bool,
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
    pub finalized: bool,
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
    #[msg("The confidence threshold is invalid.")]
    InvalidConfidence,
    #[msg("The symbol is empty.")]
    InvalidSymbol,
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
