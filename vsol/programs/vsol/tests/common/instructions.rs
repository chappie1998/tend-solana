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
