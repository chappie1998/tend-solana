//! Thin `Instruction` builders for every vsol program instruction exercised
//! by the test suite. Account lists are ordered to match each `#[derive(Accounts)]`
//! struct declaration in `src/lib.rs` exactly (Solana matches accounts by
//! position, not name) — this module intentionally does not re-derive that
//! ordering from anywhere else, so any drift must be caught by the tests
//! failing, not silently miscompiling.

use super::*;

/// Mirrors the private on-chain `expected_market_id` hash byte-for-byte (see
/// `src/lib.rs`), the same way `sdk/index.ts::deriveMarketId` mirrors it for
/// the TypeScript client. The function is intentionally not `pub` on-chain,
/// so any off-chain caller — including this test suite — must reproduce it.
pub fn expected_market_id(args: &vsol::CreateMarketArgs, settlement_mint: Pubkey) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        vsol::MARKET_ID_DOMAIN,
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

pub fn symbol_bytes(label: &str) -> [u8; 16] {
    let mut symbol = [0u8; 16];
    let bytes = label.as_bytes();
    symbol[..bytes.len()].copy_from_slice(bytes);
    symbol
}

// --- Config administration ---

pub fn initialize_config_ix(admin: &Pubkey, config: &Pubkey, args: vsol::InitializeConfigArgs) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new(*config, false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data: vsol::instruction::InitializeConfig { args }.data(),
    }
}

pub fn update_config_ix(admin: &Pubkey, config: &Pubkey, args: vsol::UpdateConfigArgs) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new(*config, false),
        ],
        data: vsol::instruction::UpdateConfig { args }.data(),
    }
}

pub fn nominate_admin_ix(admin: &Pubkey, config: &Pubkey, pending_admin: Pubkey) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new(*config, false),
        ],
        data: vsol::instruction::NominateAdmin { pending_admin }.data(),
    }
}

pub fn accept_admin_ix(pending_admin: &Pubkey, config: &Pubkey) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*pending_admin, true),
            AccountMeta::new(*config, false),
        ],
        data: vsol::instruction::AcceptAdmin.data(),
    }
}

pub fn set_pause_ix(pause_authority: &Pubkey, config: &Pubkey, paused: bool) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*pause_authority, true),
            AccountMeta::new(*config, false),
        ],
        data: vsol::instruction::SetPause { paused }.data(),
    }
}

// --- Markets ---

pub fn create_market_ix(
    creator: &Pubkey,
    config: &Pubkey,
    market: &Pubkey,
    oracle: &Pubkey,
    settlement_mint: &Pubkey,
    args: vsol::CreateMarketArgs,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(*creator, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*market, false),
            AccountMeta::new(*oracle, false),
            AccountMeta::new_readonly(*settlement_mint, false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data: vsol::instruction::CreateMarket { args }.data(),
    }
}

/// Admin per-market kill switch. Needed here (rather than only via
/// scripts/bootstrap.ts, which already covers it against devnet) so
/// `mint_complete_set_rejects_disabled_market` can exercise the
/// `market.enabled` gate this task added to `mint_complete_set`.
pub fn set_market_enabled_ix(admin: &Pubkey, config: &Pubkey, market: &Pubkey, enabled: bool) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*market, false),
        ],
        data: vsol::instruction::SetMarketEnabled { enabled }.data(),
    }
}

/// `publish_pyth_settlement` takes no signer at all (it's a permissionless
/// crank): `config`/`market` are read-only, `oracle` is the only mutable
/// account, and `price_update` is an `UncheckedAccount` whose entire
/// validation happens inside the program via `parse_fully_verified_price_update`.
pub fn publish_pyth_settlement_ix(
    config: &Pubkey,
    market: &Pubkey,
    oracle: &Pubkey,
    price_update: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(*oracle, false),
            AccountMeta::new_readonly(*price_update, false),
        ],
        data: vsol::instruction::PublishPythSettlement.data(),
    }
}

/// Builds the raw bytes of a `PriceUpdateV2` account exactly as the upgraded
/// Pyth receiver program would leave them after a fully-verified guardian
/// update, mirroring the private wire format `pyth::parse_fully_verified_price_update`
/// parses (see `src/pyth.rs`: discriminator, verification-level variant,
/// feed id, price, confidence, exponent, publish time). Duplicated here for
/// the same reason `expected_market_id` above is: the parser and its offsets
/// are intentionally private, so an off-chain (or test) caller must
/// reproduce the layout rather than import it. Setting an account with this
/// data and owner `vsol::PYTH_RECEIVER_PROGRAM_ID` reproduces the exact
/// trust boundary `publish_pyth_settlement` relies on: the guardian/Wormhole
/// verification itself is the receiver program's responsibility (out of
/// scope here, exactly as it is for `src/pyth.rs`'s own unit tests), and
/// vsol only ever checks owner + discriminator + verification level + feed id.
pub fn fake_full_pyth_price_update(
    feed_id: [u8; 32],
    price: i64,
    confidence: u64,
    exponent: i32,
    publish_time: i64,
) -> Vec<u8> {
    const DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
    const FULL_VERIFICATION_VARIANT: u8 = 1;
    const MIN_LEN: usize = 133;
    const VERIFICATION_OFFSET: usize = 40;
    const FEED_ID_OFFSET: usize = 41;
    const PRICE_OFFSET: usize = 73;
    const CONFIDENCE_OFFSET: usize = 81;
    const EXPONENT_OFFSET: usize = 89;
    const PUBLISH_TIME_OFFSET: usize = 93;

    let mut data = vec![0_u8; MIN_LEN];
    data[..8].copy_from_slice(&DISCRIMINATOR);
    data[VERIFICATION_OFFSET] = FULL_VERIFICATION_VARIANT;
    data[FEED_ID_OFFSET..FEED_ID_OFFSET + 32].copy_from_slice(&feed_id);
    data[PRICE_OFFSET..PRICE_OFFSET + 8].copy_from_slice(&price.to_le_bytes());
    data[CONFIDENCE_OFFSET..CONFIDENCE_OFFSET + 8].copy_from_slice(&confidence.to_le_bytes());
    data[EXPONENT_OFFSET..EXPONENT_OFFSET + 4].copy_from_slice(&exponent.to_le_bytes());
    data[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8].copy_from_slice(&publish_time.to_le_bytes());
    data
}

// --- Eligibility ---

pub fn set_eligibility_ix(
    eligibility_authority: &Pubkey,
    config: &Pubkey,
    eligibility: &Pubkey,
    wallet: Pubkey,
    can_trade: bool,
    expires_at: i64,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(*eligibility_authority, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*eligibility, false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data: vsol::instruction::SetEligibility {
            wallet,
            can_trade,
            expires_at,
        }
        .data(),
    }
}

// --- Writer vaults ---

pub fn initialize_writer_vault_ix(
    maker: &Pubkey,
    config: &Pubkey,
    settlement_mint: &Pubkey,
    writer_vault: &Pubkey,
    writer_token: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(*maker, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new_readonly(*settlement_mint, false),
            AccountMeta::new(*writer_vault, false),
            AccountMeta::new(*writer_token, false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data: vsol::instruction::InitializeWriterVault.data(),
    }
}

pub fn deposit_writer_ix(
    config: &Pubkey,
    maker: &Pubkey,
    settlement_mint: &Pubkey,
    writer_vault: &Pubkey,
    writer_token: &Pubkey,
    maker_source: &Pubkey,
    amount: u64,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*maker, true),
            AccountMeta::new_readonly(*settlement_mint, false),
            AccountMeta::new_readonly(*writer_vault, false),
            AccountMeta::new(*writer_token, false),
            AccountMeta::new(*maker_source, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::DepositWriter { amount }.data(),
    }
}

pub fn withdraw_writer_ix(
    config: &Pubkey,
    maker: &Pubkey,
    settlement_mint: &Pubkey,
    writer_vault: &Pubkey,
    writer_token: &Pubkey,
    maker_destination: &Pubkey,
    amount: u64,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new_readonly(*maker, true),
            AccountMeta::new_readonly(*settlement_mint, false),
            AccountMeta::new_readonly(*writer_vault, false),
            AccountMeta::new(*writer_token, false),
            AccountMeta::new(*maker_destination, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::WithdrawWriter { amount }.data(),
    }
}

// --- Nonces / quotes ---

pub fn cancel_nonce_ix(maker: &Pubkey, config: &Pubkey, nonce_record: &Pubkey, nonce: u64) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(*maker, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*nonce_record, false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data: vsol::instruction::CancelNonce { nonce }.data(),
    }
}

#[allow(clippy::too_many_arguments)]
pub struct FillQuoteAccounts {
    pub buyer: Pubkey,
    pub maker: Pubkey,
    pub config: Pubkey,
    pub market: Pubkey,
    pub settlement_mint: Pubkey,
    pub writer_vault: Pubkey,
    pub writer_token: Pubkey,
    pub buyer_source: Pubkey,
    pub nonce_record: Pubkey,
    pub position: Pubkey,
    pub position_vault: Pubkey,
    pub eligibility: Option<Pubkey>,
}

/// Builds the two-instruction transaction body `fill_quote` requires: an
/// Ed25519 precompile instruction carrying the maker's signature over the
/// quote message, immediately followed by `fill_quote` itself. See
/// `src/signature.rs::verify_preceding_ed25519_instruction`.
pub fn fill_quote_ixs(
    maker: &Keypair,
    accounts: &FillQuoteAccounts,
    domain_separator: &[u8; 32],
    domain_version: u16,
    quote: vsol::QuoteArgs,
) -> Vec<Instruction> {
    let context = quote_signing::QuoteMessageContext {
        program_id: &vsol::ID,
        config: &accounts.config,
        market: &accounts.market,
        buyer: &accounts.buyer,
        maker: &accounts.maker,
    };
    let message = quote_signing::quote_message(domain_separator, domain_version, &context, &quote);
    let signature_ix = ed25519_ix_for(maker, &message);

    let fill_ix = Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(accounts.buyer, true),
            AccountMeta::new_readonly(accounts.maker, false),
            AccountMeta::new_readonly(accounts.config, false),
            AccountMeta::new_readonly(accounts.market, false),
            AccountMeta::new_readonly(accounts.settlement_mint, false),
            AccountMeta::new_readonly(accounts.writer_vault, false),
            AccountMeta::new(accounts.writer_token, false),
            AccountMeta::new(accounts.buyer_source, false),
            AccountMeta::new(accounts.nonce_record, false),
            AccountMeta::new(accounts.position, false),
            AccountMeta::new(accounts.position_vault, false),
            AccountMeta::new_readonly(accounts.eligibility.unwrap_or_else(no_eligibility), false),
            AccountMeta::new_readonly(instructions_sysvar_id(), false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data: vsol::instruction::FillQuote { quote }.data(),
    };
    vec![signature_ix, fill_ix]
}

pub struct SettleAccounts {
    pub cranker: Pubkey,
    pub config: Pubkey,
    pub market: Pubkey,
    pub oracle: Pubkey,
    pub nonce_record: Pubkey,
    pub position: Pubkey,
    pub position_vault: Pubkey,
    pub settlement_mint: Pubkey,
    pub buyer_destination: Pubkey,
    pub maker_destination: Pubkey,
    pub treasury_destination: Pubkey,
    pub rent_recipient: Pubkey,
}

pub fn settle_ix(a: &SettleAccounts) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(a.cranker, true),
            AccountMeta::new_readonly(a.config, false),
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(a.oracle, false),
            AccountMeta::new_readonly(a.nonce_record, false),
            AccountMeta::new(a.position, false),
            AccountMeta::new(a.position_vault, false),
            AccountMeta::new_readonly(a.settlement_mint, false),
            AccountMeta::new(a.buyer_destination, false),
            AccountMeta::new(a.maker_destination, false),
            AccountMeta::new(a.treasury_destination, false),
            AccountMeta::new(a.rent_recipient, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::Settle.data(),
    }
}

pub struct RefundUnsettledAccounts {
    pub cranker: Pubkey,
    pub market: Pubkey,
    pub oracle: Pubkey,
    pub nonce_record: Pubkey,
    pub position: Pubkey,
    pub position_vault: Pubkey,
    pub settlement_mint: Pubkey,
    pub buyer_destination: Pubkey,
    pub maker_destination: Pubkey,
    pub rent_recipient: Pubkey,
}

pub fn refund_unsettled_ix(a: &RefundUnsettledAccounts) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(a.cranker, true),
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(a.oracle, false),
            AccountMeta::new_readonly(a.nonce_record, false),
            AccountMeta::new(a.position, false),
            AccountMeta::new(a.position_vault, false),
            AccountMeta::new_readonly(a.settlement_mint, false),
            AccountMeta::new(a.buyer_destination, false),
            AccountMeta::new(a.maker_destination, false),
            AccountMeta::new(a.rent_recipient, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::RefundUnsettled.data(),
    }
}

// --- Liquidity pools ---

pub fn initialize_liquidity_pool_ix(
    creator: &Pubkey,
    config: &Pubkey,
    settlement_mint: &Pubkey,
    pool: &Pubkey,
    pool_token: &Pubkey,
    args: vsol::InitializeLiquidityPoolArgs,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(*creator, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new_readonly(*settlement_mint, false),
            AccountMeta::new(*pool, false),
            AccountMeta::new(*pool_token, false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data: vsol::instruction::InitializeLiquidityPool { args }.data(),
    }
}

pub fn set_liquidity_pool_market_ix(
    manager: &Pubkey,
    config: &Pubkey,
    pool: &Pubkey,
    market: &Pubkey,
    pool_market: &Pubkey,
    args: vsol::SetLiquidityPoolMarketArgs,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(*manager, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new_readonly(*pool, false),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(*pool_market, false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data: vsol::instruction::SetLiquidityPoolMarket { args }.data(),
    }
}

pub fn update_liquidity_pool_ix(
    manager: &Pubkey,
    config: &Pubkey,
    pool: &Pubkey,
    args: vsol::UpdateLiquidityPoolArgs,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*manager, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*pool, false),
        ],
        data: vsol::instruction::UpdateLiquidityPool { args }.data(),
    }
}

/// Same account shape as `update_liquidity_pool_ix`: `apply_liquidity_pool_update`
/// commits a pending proposal once its timelock has elapsed.
pub fn apply_liquidity_pool_update_ix(manager: &Pubkey, config: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*manager, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*pool, false),
        ],
        data: vsol::instruction::ApplyLiquidityPoolUpdate.data(),
    }
}

/// Same account shape again: `cancel_pending_pool_update` discards a pending
/// proposal before its timelock elapses.
pub fn cancel_pending_pool_update_ix(manager: &Pubkey, config: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*manager, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*pool, false),
        ],
        data: vsol::instruction::CancelPendingPoolUpdate.data(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn deposit_liquidity_ix(
    provider: &Pubkey,
    config: &Pubkey,
    settlement_mint: &Pubkey,
    pool: &Pubkey,
    pool_token: &Pubkey,
    provider_position: &Pubkey,
    provider_source: &Pubkey,
    amount: u64,
    min_shares_out: u64,
    deadline: i64,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(*provider, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new_readonly(*settlement_mint, false),
            AccountMeta::new(*pool, false),
            AccountMeta::new(*pool_token, false),
            AccountMeta::new(*provider_position, false),
            AccountMeta::new(*provider_source, false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data: vsol::instruction::DepositLiquidity {
            amount,
            min_shares_out,
            deadline,
        }
        .data(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn withdraw_liquidity_ix(
    provider: &Pubkey,
    config: &Pubkey,
    settlement_mint: &Pubkey,
    pool: &Pubkey,
    pool_token: &Pubkey,
    provider_position: &Pubkey,
    provider_destination: &Pubkey,
    shares: u64,
    min_amount_out: u64,
    deadline: i64,
) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(*provider, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new_readonly(*settlement_mint, false),
            AccountMeta::new(*pool, false),
            AccountMeta::new(*pool_token, false),
            AccountMeta::new(*provider_position, false),
            AccountMeta::new(*provider_destination, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::WithdrawLiquidity {
            shares,
            min_amount_out,
            deadline,
        }
        .data(),
    }
}

pub struct FillPoolQuoteAccounts {
    pub buyer: Pubkey,
    pub quote_authority: Pubkey,
    pub config: Pubkey,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub pool_market: Pubkey,
    pub settlement_mint: Pubkey,
    pub pool_token: Pubkey,
    pub buyer_source: Pubkey,
    pub nonce_record: Pubkey,
    pub position: Pubkey,
    pub position_vault: Pubkey,
    pub eligibility: Option<Pubkey>,
}

pub fn fill_pool_quote_ixs(
    quote_authority: &Keypair,
    accounts: &FillPoolQuoteAccounts,
    domain_separator: &[u8; 32],
    domain_version: u16,
    quote: vsol::PoolQuoteArgs,
) -> Vec<Instruction> {
    let context = quote_signing::PoolQuoteMessageContext {
        program_id: &vsol::ID,
        config: &accounts.config,
        pool: &accounts.pool,
        market: &accounts.market,
        buyer: &accounts.buyer,
        quote_authority: &accounts.quote_authority,
    };
    let message = quote_signing::pool_quote_message(domain_separator, domain_version, &context, &quote);
    let signature_ix = ed25519_ix_for(quote_authority, &message);

    let fill_ix = Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(accounts.buyer, true),
            AccountMeta::new_readonly(accounts.quote_authority, false),
            AccountMeta::new_readonly(accounts.config, false),
            AccountMeta::new(accounts.pool, false),
            AccountMeta::new_readonly(accounts.market, false),
            AccountMeta::new_readonly(accounts.pool_market, false),
            AccountMeta::new_readonly(accounts.settlement_mint, false),
            AccountMeta::new(accounts.pool_token, false),
            AccountMeta::new(accounts.buyer_source, false),
            AccountMeta::new(accounts.nonce_record, false),
            AccountMeta::new(accounts.position, false),
            AccountMeta::new(accounts.position_vault, false),
            AccountMeta::new_readonly(accounts.eligibility.unwrap_or_else(no_eligibility), false),
            AccountMeta::new_readonly(instructions_sysvar_id(), false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data: vsol::instruction::FillPoolQuote { quote }.data(),
    };
    vec![signature_ix, fill_ix]
}

pub struct SettlePoolPositionAccounts {
    pub cranker: Pubkey,
    pub config: Pubkey,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub oracle: Pubkey,
    pub nonce_record: Pubkey,
    pub position: Pubkey,
    pub position_vault: Pubkey,
    pub settlement_mint: Pubkey,
    pub buyer_destination: Pubkey,
    pub pool_token: Pubkey,
    pub treasury_destination: Pubkey,
    pub rent_recipient: Pubkey,
}

pub fn settle_pool_position_ix(a: &SettlePoolPositionAccounts) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(a.cranker, true),
            AccountMeta::new_readonly(a.config, false),
            AccountMeta::new(a.pool, false),
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(a.oracle, false),
            AccountMeta::new_readonly(a.nonce_record, false),
            AccountMeta::new(a.position, false),
            AccountMeta::new(a.position_vault, false),
            AccountMeta::new_readonly(a.settlement_mint, false),
            AccountMeta::new(a.buyer_destination, false),
            AccountMeta::new(a.pool_token, false),
            AccountMeta::new(a.treasury_destination, false),
            AccountMeta::new(a.rent_recipient, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::SettlePoolPosition.data(),
    }
}

pub struct RefundPoolPositionAccounts {
    pub cranker: Pubkey,
    pub config: Pubkey,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub oracle: Pubkey,
    pub nonce_record: Pubkey,
    pub position: Pubkey,
    pub position_vault: Pubkey,
    pub settlement_mint: Pubkey,
    pub buyer_destination: Pubkey,
    pub pool_token: Pubkey,
    pub rent_recipient: Pubkey,
}

pub fn refund_pool_position_ix(a: &RefundPoolPositionAccounts) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(a.cranker, true),
            AccountMeta::new_readonly(a.config, false),
            AccountMeta::new(a.pool, false),
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(a.oracle, false),
            AccountMeta::new_readonly(a.nonce_record, false),
            AccountMeta::new(a.position, false),
            AccountMeta::new(a.position_vault, false),
            AccountMeta::new_readonly(a.settlement_mint, false),
            AccountMeta::new(a.buyer_destination, false),
            AccountMeta::new(a.pool_token, false),
            AccountMeta::new(a.rent_recipient, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::RefundPoolPosition.data(),
    }
}

pub struct ClosePoolPositionAccounts {
    pub buyer: Pubkey,
    pub config: Pubkey,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub oracle: Pubkey,
    pub position: Pubkey,
    pub position_vault: Pubkey,
    pub settlement_mint: Pubkey,
    pub buyer_destination: Pubkey,
    pub pool_token: Pubkey,
    pub treasury_destination: Pubkey,
    pub rent_recipient: Pubkey,
}

/// Builds the two-instruction transaction body `close_pool_position` requires:
/// an Ed25519 precompile instruction carrying the pool's `quote_authority`
/// signature over the buyback message, immediately followed by
/// `close_pool_position` itself. Mirrors `fill_pool_quote_ixs` above (see
/// `src/signature.rs::verify_preceding_ed25519_instruction`).
pub fn close_pool_position_ixs(
    quote_authority: &Keypair,
    accounts: &ClosePoolPositionAccounts,
    domain_separator: &[u8; 32],
    domain_version: u16,
    args: vsol::PoolBuybackArgs,
) -> Vec<Instruction> {
    let context = quote_signing::PoolBuybackMessageContext {
        program_id: &vsol::ID,
        config: &accounts.config,
        pool: &accounts.pool,
        market: &accounts.market,
        position: &accounts.position,
        buyer: &accounts.buyer,
        quote_authority: &quote_authority.pubkey(),
    };
    let message = quote_signing::pool_buyback_message(domain_separator, domain_version, &context, &args);
    let signature_ix = ed25519_ix_for(quote_authority, &message);

    let close_ix = Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.buyer, true),
            AccountMeta::new_readonly(accounts.config, false),
            AccountMeta::new(accounts.pool, false),
            AccountMeta::new_readonly(accounts.market, false),
            AccountMeta::new_readonly(accounts.oracle, false),
            AccountMeta::new(accounts.position, false),
            AccountMeta::new(accounts.position_vault, false),
            AccountMeta::new_readonly(accounts.settlement_mint, false),
            AccountMeta::new(accounts.buyer_destination, false),
            AccountMeta::new(accounts.pool_token, false),
            AccountMeta::new(accounts.treasury_destination, false),
            AccountMeta::new(accounts.rent_recipient, false),
            AccountMeta::new_readonly(instructions_sysvar_id(), false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::ClosePoolPosition { args }.data(),
    };
    vec![signature_ix, close_ix]
}

pub struct CloseSettledMarketAccounts {
    pub authority: Pubkey,
    pub config: Pubkey,
    pub market: Pubkey,
    pub oracle: Pubkey,
    /// The market's complete-set collateral vault PDA (`COMPLETE_SET_VAULT_SEED`,
    /// keyed by `market.key()`). Always required -- see
    /// `CloseSettledMarket::collateral_vault`'s doc comment in `src/lib.rs`:
    /// the handler treats an account with no data as "no complete set was
    /// ever minted here" (fine), and otherwise requires `amount == 0`.
    pub collateral_vault: Pubkey,
    /// `Some` only when demonstrating that a specific pool's authorization
    /// for this market has been disabled; `None` when no pool ever traded
    /// this market (or the caller relies solely on the elapsed-window
    /// argument -- see `CloseSettledMarket`'s doc comment in `src/lib.rs`).
    pub pool: Option<Pubkey>,
    pub pool_market: Option<Pubkey>,
    pub rent_recipient: Pubkey,
}

pub fn close_settled_market_ix(a: &CloseSettledMarketAccounts) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(a.authority, true),
            AccountMeta::new_readonly(a.config, false),
            AccountMeta::new(a.market, false),
            AccountMeta::new(a.oracle, false),
            AccountMeta::new_readonly(a.collateral_vault, false),
            AccountMeta::new_readonly(a.pool.unwrap_or_else(no_pool), false),
            AccountMeta::new_readonly(a.pool_market.unwrap_or_else(no_pool_market), false),
            AccountMeta::new(a.rent_recipient, false),
        ],
        data: vsol::instruction::CloseSettledMarket.data(),
    }
}

// --- Conditional tokens ("complete sets") ---

#[allow(clippy::too_many_arguments)]
pub struct MintCompleteSetAccounts {
    pub minter: Pubkey,
    pub config: Pubkey,
    pub market: Pubkey,
    pub settlement_mint: Pubkey,
    pub up_mint: Pubkey,
    pub down_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub minter_source: Pubkey,
    pub minter_up_token: Pubkey,
    pub minter_down_token: Pubkey,
}

pub fn mint_complete_set_ix(a: &MintCompleteSetAccounts, amount: u64) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new(a.minter, true),
            AccountMeta::new_readonly(a.config, false),
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(a.settlement_mint, false),
            AccountMeta::new(a.up_mint, false),
            AccountMeta::new(a.down_mint, false),
            AccountMeta::new(a.collateral_vault, false),
            AccountMeta::new(a.minter_source, false),
            AccountMeta::new(a.minter_up_token, false),
            AccountMeta::new(a.minter_down_token, false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data: vsol::instruction::MintCompleteSet { amount }.data(),
    }
}

pub struct BurnCompleteSetAccounts {
    pub burner: Pubkey,
    pub config: Pubkey,
    pub market: Pubkey,
    pub settlement_mint: Pubkey,
    pub up_mint: Pubkey,
    pub down_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub burner_up_token: Pubkey,
    pub burner_down_token: Pubkey,
    pub burner_destination: Pubkey,
}

pub fn burn_complete_set_ix(a: &BurnCompleteSetAccounts, amount: u64) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(a.burner, true),
            AccountMeta::new_readonly(a.config, false),
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(a.settlement_mint, false),
            AccountMeta::new(a.up_mint, false),
            AccountMeta::new(a.down_mint, false),
            AccountMeta::new(a.collateral_vault, false),
            AccountMeta::new(a.burner_up_token, false),
            AccountMeta::new(a.burner_down_token, false),
            AccountMeta::new(a.burner_destination, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::BurnCompleteSet { amount }.data(),
    }
}

pub struct RedeemWinningAccounts {
    pub redeemer: Pubkey,
    pub config: Pubkey,
    pub market: Pubkey,
    pub oracle: Pubkey,
    pub settlement_mint: Pubkey,
    pub up_mint: Pubkey,
    pub down_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub redeemer_token: Pubkey,
    pub redeemer_destination: Pubkey,
}

pub fn redeem_winning_ix(a: &RedeemWinningAccounts, amount: u64) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(a.redeemer, true),
            AccountMeta::new_readonly(a.config, false),
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(a.oracle, false),
            AccountMeta::new_readonly(a.settlement_mint, false),
            AccountMeta::new(a.up_mint, false),
            AccountMeta::new(a.down_mint, false),
            AccountMeta::new(a.collateral_vault, false),
            AccountMeta::new(a.redeemer_token, false),
            AccountMeta::new(a.redeemer_destination, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::RedeemWinning { amount }.data(),
    }
}

pub struct RedeemUnresolvedAccounts {
    pub redeemer: Pubkey,
    pub config: Pubkey,
    pub market: Pubkey,
    pub oracle: Pubkey,
    pub settlement_mint: Pubkey,
    pub up_mint: Pubkey,
    pub down_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub redeemer_token: Pubkey,
    pub redeemer_destination: Pubkey,
}

pub fn redeem_unresolved_ix(a: &RedeemUnresolvedAccounts, amount: u64) -> Instruction {
    Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(a.redeemer, true),
            AccountMeta::new_readonly(a.config, false),
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(a.oracle, false),
            AccountMeta::new_readonly(a.settlement_mint, false),
            AccountMeta::new(a.up_mint, false),
            AccountMeta::new(a.down_mint, false),
            AccountMeta::new(a.collateral_vault, false),
            AccountMeta::new(a.redeemer_token, false),
            AccountMeta::new(a.redeemer_destination, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::RedeemUnresolved { amount }.data(),
    }
}

/// Builds the Ed25519 precompile instruction carrying `signer`'s signature
/// over `message`, in the exact layout `verify_preceding_ed25519_instruction`
/// requires (offsets pointing at the current instruction).
pub fn ed25519_ix_for(signer: &Keypair, message: &[u8]) -> Instruction {
    let signature = signer.sign_message(message);
    let signature_bytes: [u8; 64] = signature.as_ref().try_into().expect("64-byte signature");
    solana_ed25519_program::new_ed25519_instruction_with_signature(
        message,
        &signature_bytes,
        &signer.pubkey().to_bytes(),
    )
}
