//! Instruction-level integration tests for the vsol Anchor program, run
//! in-process against the real compiled program via `litesvm`. See
//! `tests/common/mod.rs` for the harness/PDA helpers and
//! `tests/common/instructions.rs` for the per-instruction builders.
//!
//! Scope: the 8 instructions bootstrap.ts cannot safely exercise against the
//! live devnet deployment (admin transfer, pause, config mutation, and
//! eligibility/nonce/withdrawal/pool-config edge cases), plus one end-to-end
//! pooled-market smoke test. The remaining 16 instructions are already
//! covered by `scripts/bootstrap.ts` against devnet and are out of scope here.

mod common;

use common::*;

const MARKET_LEAD_SECONDS: i64 = 60;
const OBSERVATION_WINDOW: u32 = 30;
const SETTLEMENT_GRACE: u32 = 900;

/// A config plus every keypair that controls it, wired up in one call so
/// individual tests can read straight past setup to the behavior under test.
struct ConfigFixture {
    config: Pubkey,
    admin: Keypair,
    pause_authority: Keypair,
    oracle_authority: Keypair,
    eligibility_authority: Keypair,
    treasury_owner: Pubkey,
    domain_separator: [u8; 32],
}

fn setup_config(harness: &mut Harness) -> ConfigFixture {
    let admin = harness.funded_keypair();
    let pause_authority = harness.funded_keypair();
    let oracle_authority = harness.funded_keypair();
    let eligibility_authority = harness.funded_keypair();
    let treasury_owner = Pubkey::new_unique();
    let domain_separator = [0x42u8; 32];

    let config = config_pda();
    let args = vsol::InitializeConfigArgs {
        pause_authority: pause_authority.pubkey(),
        oracle_authority: oracle_authority.pubkey(),
        eligibility_authority: eligibility_authority.pubkey(),
        treasury_owner,
        fee_bps: 50,
        eligibility_required: false,
        domain_separator,
    };
    let ix = initialize_config_ix(&admin.pubkey(), &config, args);
    harness.send_ok(&admin, &[ix], &[]);

    ConfigFixture {
        config,
        admin,
        pause_authority,
        oracle_authority,
        eligibility_authority,
        treasury_owner,
        domain_separator,
    }
}

fn read_config(harness: &Harness, config: &Pubkey) -> vsol::Config {
    harness.read_account(config)
}

/// A market, created under `fixture`'s config against a caller-supplied
/// settlement mint (callers that pair a market with a liquidity pool must
/// use the pool's own mint — `set_liquidity_pool_market` requires the two to
/// match).
struct MarketFixture {
    market: Pubkey,
    oracle: Pubkey,
    settlement_mint: Pubkey,
    expiry: i64,
}

fn setup_market(harness: &mut Harness, fixture: &ConfigFixture, creator: &Keypair, settlement_mint: Pubkey) -> MarketFixture {
    setup_market_variant(harness, fixture, creator, settlement_mint, 0x11)
}

/// Like `setup_market`, but lets the caller distinguish otherwise-identical
/// markets (same mint/config/timing) via the Pyth feed id byte, so a single
/// test can stand up more than one market under one config without their
/// deterministic `market_id`s colliding.
fn setup_market_variant(
    harness: &mut Harness,
    fixture: &ConfigFixture,
    creator: &Keypair,
    settlement_mint: Pubkey,
    feed_salt: u8,
) -> MarketFixture {
    let now = harness.now();
    let expiry = now + MARKET_LEAD_SECONDS + 3600;
    let mut args = vsol::CreateMarketArgs {
        market_id: [0u8; 32],
        underlying_mint: Pubkey::new_unique(),
        symbol: symbol_bytes("NVDA"),
        price_scale: 1_000_000,
        expiry,
        observation_window_seconds: OBSERVATION_WINDOW,
        settlement_grace_seconds: SETTLEMENT_GRACE,
        max_confidence_bps: 100,
        pyth_feed_id: [feed_salt; 32],
    };
    args.market_id = expected_market_id(&args, settlement_mint);

    let market = market_pda(&fixture.config, &args.market_id);
    let oracle = oracle_pda(&market);
    let ix = create_market_ix(&creator.pubkey(), &fixture.config, &market, &oracle, &settlement_mint, args);
    harness.send_ok(creator, &[ix], &[]);

    MarketFixture {
        market,
        oracle,
        settlement_mint,
        expiry,
    }
}

/// Directly marks the settlement oracle finalized with `price`, bypassing
/// `publish_pyth_settlement`. Standing up a genuine, fully-verified Pyth
/// price-update account is out of scope for these instruction-level tests
/// (none of the 8 target instructions are the oracle publication path);
/// what `settle`/`settle_pool_position` need from the oracle is just a
/// finalized price, so we seed that directly via the same Anchor
/// (de)serialization the program itself uses.
fn finalize_oracle(harness: &mut Harness, market: &MarketFixture, price: u64) {
    let mut oracle: vsol::SettlementOracle = harness.read_account(&market.oracle);
    oracle.price = price;
    oracle.confidence = 0;
    oracle.observed_at = market.expiry;
    oracle.published_at = market.expiry;
    oracle.exponent = 0;
    oracle.finalized = true;
    harness.write_account(market.oracle, &oracle);
}

fn default_quote(nonce: u64, quote_expiry: i64) -> vsol::QuoteArgs {
    vsol::QuoteArgs {
        nonce,
        direction: 0, // Up
        strike: 100 * ONE_TOKEN,
        width: 20 * ONE_TOKEN,
        premium: ONE_TOKEN,
        max_payout: 5 * ONE_TOKEN,
        quote_expiry,
    }
}

fn default_pool_quote(nonce: u64, quote_expiry: i64) -> vsol::PoolQuoteArgs {
    vsol::PoolQuoteArgs {
        nonce,
        direction: 0,
        strike: 100 * ONE_TOKEN,
        width: 20 * ONE_TOKEN,
        premium: ONE_TOKEN,
        max_payout: 5 * ONE_TOKEN,
        quote_expiry,
    }
}

// =====================================================================
// nominate_admin / accept_admin
// =====================================================================

#[test]
fn nominate_admin_then_accept_admin_transfers_control() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let successor = harness.funded_keypair();

    let nominate_ix = nominate_admin_ix(&fixture.admin.pubkey(), &fixture.config, successor.pubkey());
    harness.send_ok(&fixture.admin, &[nominate_ix], &[]);

    let config_after_nomination = read_config(&harness, &fixture.config);
    assert_eq!(config_after_nomination.admin, fixture.admin.pubkey());
    assert_eq!(config_after_nomination.pending_admin, successor.pubkey());

    let accept_ix = accept_admin_ix(&successor.pubkey(), &fixture.config);
    harness.send_ok(&successor, &[accept_ix], &[]);

    let config_after_accept = read_config(&harness, &fixture.config);
    assert_eq!(config_after_accept.admin, successor.pubkey());
    assert_eq!(config_after_accept.pending_admin, Pubkey::default());
}

#[test]
fn nominate_admin_rejects_non_admin_signer() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let impostor = harness.funded_keypair();
    let successor = Pubkey::new_unique();

    let ix = nominate_admin_ix(&impostor.pubkey(), &fixture.config, successor);
    let failed = harness.send_err(&impostor, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);

    // Nothing changed: no pending admin was set by the rejected transaction.
    let config = read_config(&harness, &fixture.config);
    assert_eq!(config.pending_admin, Pubkey::default());
}

#[test]
fn accept_admin_rejects_signer_that_is_not_pending_admin() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let successor = harness.funded_keypair();
    let bystander = harness.funded_keypair();

    let nominate_ix = nominate_admin_ix(&fixture.admin.pubkey(), &fixture.config, successor.pubkey());
    harness.send_ok(&fixture.admin, &[nominate_ix], &[]);

    let accept_ix = accept_admin_ix(&bystander.pubkey(), &fixture.config);
    let failed = harness.send_err(&bystander, &[accept_ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);

    let config = read_config(&harness, &fixture.config);
    assert_eq!(config.admin, fixture.admin.pubkey());
    assert_eq!(config.pending_admin, successor.pubkey());
}

// =====================================================================
// set_pause, and the guardian invariant it exists to enforce
// =====================================================================

#[test]
fn set_pause_toggles_paused_flag() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);

    let pause_ix = set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, true);
    harness.send_ok(&fixture.pause_authority, &[pause_ix], &[]);
    assert!(read_config(&harness, &fixture.config).paused);

    let unpause_ix = set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, false);
    harness.send_ok(&fixture.pause_authority, &[unpause_ix], &[]);
    assert!(!read_config(&harness, &fixture.config).paused);
}

#[test]
fn set_pause_rejects_unauthorized_signer() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let impostor = harness.funded_keypair();

    let ix = set_pause_ix(&impostor.pubkey(), &fixture.config, true);
    let failed = harness.send_err(&impostor, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);
    assert!(!read_config(&harness, &fixture.config).paused);
}

/// The central guarantee the whole pause design rests on: pausing blocks new
/// exposure (`fill_quote`/`fill_pool_quote`) but must never trap funds that
/// are already at risk. `settle` and `refund_unsettled` (and their pool
/// counterparts) must keep working while paused.
#[test]
fn set_pause_blocks_fills_but_never_settlement() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let buyer = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &maker, settlement_mint);
    // A second, independent market (own oracle) used below to prove
    // `refund_unsettled` also succeeds while paused — `settle` and
    // `refund_unsettled` are mutually exclusive per market (one requires a
    // finalized oracle, the other requires it stay unfinalized), so covering
    // both needs two markets.
    let refund_market = setup_market_variant(&mut harness, &fixture, &maker, settlement_mint, 0x22);

    // Stand up a writer vault with enough collateral to fill one quote.
    let writer_vault = writer_vault_pda(&fixture.config, &maker.pubkey(), &market.settlement_mint);
    let writer_token = writer_token_pda(&writer_vault);
    harness.send_ok(
        &maker,
        &[initialize_writer_vault_ix(
            &maker.pubkey(),
            &fixture.config,
            &market.settlement_mint,
            &writer_vault,
            &writer_token,
        )],
        &[],
    );
    let maker_source = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &maker_source, 100 * ONE_TOKEN);
    harness.send_ok(
        &maker,
        &[deposit_writer_ix(
            &fixture.config,
            &maker.pubkey(),
            &market.settlement_mint,
            &writer_vault,
            &writer_token,
            &maker_source,
            50 * ONE_TOKEN,
        )],
        &[],
    );

    // Pause the protocol *before* attempting to fill.
    harness.send_ok(
        &fixture.pause_authority,
        &[set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, true)],
        &[],
    );

    let buyer_source = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &buyer_source, 10 * ONE_TOKEN);

    let quote = default_quote(1, harness.now() + 30);
    let nonce_record = nonce_pda(&fixture.config, &maker.pubkey(), quote.nonce);
    let position = position_pda(&nonce_record);
    let position_vault = position_vault_pda(&position);
    let fill_accounts = FillQuoteAccounts {
        buyer: buyer.pubkey(),
        maker: maker.pubkey(),
        config: fixture.config,
        market: market.market,
        settlement_mint: market.settlement_mint,
        writer_vault,
        writer_token,
        buyer_source,
        nonce_record,
        position,
        position_vault,
        eligibility: None,
    };
    let ixs = fill_quote_ixs(&maker, &fill_accounts, &fixture.domain_separator, 1, quote);
    let failed = harness.send_err(&buyer, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::ProtocolPaused);

    // Unpause, fill for real, then re-pause before settling: settle/refund
    // must not care that the protocol is paused.
    harness.send_ok(
        &fixture.pause_authority,
        &[set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, false)],
        &[],
    );
    let quote = default_quote(2, harness.now() + 30);
    let nonce_record = nonce_pda(&fixture.config, &maker.pubkey(), quote.nonce);
    let position = position_pda(&nonce_record);
    let position_vault = position_vault_pda(&position);
    let fill_accounts = FillQuoteAccounts {
        nonce_record,
        position,
        position_vault,
        ..fill_accounts
    };
    let ixs = fill_quote_ixs(&maker, &fill_accounts, &fixture.domain_separator, 1, quote);
    harness.send_ok(&buyer, &ixs, &[]);

    // Also fill a quote on the refund market, still in the unpaused window;
    // this position will be left unsettled and refunded further down.
    let refund_quote = default_quote(3, harness.now() + 30);
    let refund_nonce_record = nonce_pda(&fixture.config, &maker.pubkey(), refund_quote.nonce);
    let refund_position = position_pda(&refund_nonce_record);
    let refund_position_vault = position_vault_pda(&refund_position);
    let refund_fill_accounts = FillQuoteAccounts {
        market: refund_market.market,
        settlement_mint: refund_market.settlement_mint,
        nonce_record: refund_nonce_record,
        position: refund_position,
        position_vault: refund_position_vault,
        ..fill_accounts
    };
    let refund_ixs = fill_quote_ixs(&maker, &refund_fill_accounts, &fixture.domain_separator, 1, refund_quote);
    harness.send_ok(&buyer, &refund_ixs, &[]);

    harness.send_ok(
        &fixture.pause_authority,
        &[set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, true)],
        &[],
    );
    assert!(read_config(&harness, &fixture.config).paused);

    harness.warp_to_timestamp(market.expiry);
    finalize_oracle(&mut harness, &market, 100 * ONE_TOKEN);

    let buyer_destination = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    let maker_destination = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    let treasury_destination =
        harness.create_token_account(&maker, &market.settlement_mint, &fixture.treasury_owner);

    let settle_accounts = SettleAccounts {
        cranker: maker.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        nonce_record,
        position,
        position_vault,
        settlement_mint: market.settlement_mint,
        buyer_destination,
        maker_destination,
        treasury_destination,
        rent_recipient: buyer.pubkey(),
    };
    // Still paused. `settle` must succeed anyway.
    harness.send_ok(&maker, &[settle_ix(&settle_accounts)], &[]);
    assert!(read_config(&harness, &fixture.config).paused);

    // Let the refund market's settlement window close entirely without ever
    // finalizing its oracle, then refund while still paused.
    let refund_deadline = refund_market.expiry
        + i64::from(OBSERVATION_WINDOW)
        + i64::from(SETTLEMENT_GRACE)
        + 1;
    harness.warp_to_timestamp(refund_deadline);
    let refund_buyer_destination =
        harness.create_token_account(&buyer, &refund_market.settlement_mint, &buyer.pubkey());
    let refund_maker_destination =
        harness.create_token_account(&maker, &refund_market.settlement_mint, &maker.pubkey());
    let refund_accounts = RefundUnsettledAccounts {
        cranker: maker.pubkey(),
        market: refund_market.market,
        oracle: refund_market.oracle,
        nonce_record: refund_nonce_record,
        position: refund_position,
        position_vault: refund_position_vault,
        settlement_mint: refund_market.settlement_mint,
        buyer_destination: refund_buyer_destination,
        maker_destination: refund_maker_destination,
        rent_recipient: buyer.pubkey(),
    };
    // Still paused. `refund_unsettled` must succeed anyway.
    harness.send_ok(&maker, &[refund_unsettled_ix(&refund_accounts)], &[]);
    assert!(read_config(&harness, &fixture.config).paused);
    assert_eq!(harness.token_balance(&refund_buyer_destination), refund_quote.premium);
    assert_eq!(harness.token_balance(&refund_maker_destination), refund_quote.max_payout);
}

// =====================================================================
// update_config
// =====================================================================

#[test]
fn update_config_bumps_domain_version_and_applies_new_authorities() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let before = read_config(&harness, &fixture.config);

    let new_treasury = Pubkey::new_unique();
    let new_pause_authority = Pubkey::new_unique();
    let new_oracle_authority = Pubkey::new_unique();
    let new_eligibility_authority = Pubkey::new_unique();
    let args = vsol::UpdateConfigArgs {
        pause_authority: new_pause_authority,
        oracle_authority: new_oracle_authority,
        eligibility_authority: new_eligibility_authority,
        treasury_owner: new_treasury,
        fee_bps: 75,
        eligibility_required: true,
    };
    harness.send_ok(
        &fixture.admin,
        &[update_config_ix(&fixture.admin.pubkey(), &fixture.config, args)],
        &[],
    );

    let after = read_config(&harness, &fixture.config);
    assert_eq!(after.domain_version, before.domain_version + 1);
    assert_eq!(after.pause_authority, new_pause_authority);
    assert_eq!(after.oracle_authority, new_oracle_authority);
    assert_eq!(after.eligibility_authority, new_eligibility_authority);
    assert_eq!(after.treasury_owner, new_treasury);
    assert_eq!(after.fee_bps, 75);
    assert!(after.eligibility_required);
}

#[test]
fn update_config_rejects_fee_above_max_bps() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let mut args = valid_update_config_args();
    args.fee_bps = 1_001; // MAX_FEE_BPS is 1_000.

    let ix = update_config_ix(&fixture.admin.pubkey(), &fixture.config, args);
    let failed = harness.send_err(&fixture.admin, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::FeeTooHigh);
}

#[test]
fn update_config_rejects_default_authority() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let mut args = valid_update_config_args();
    args.oracle_authority = Pubkey::default();

    let ix = update_config_ix(&fixture.admin.pubkey(), &fixture.config, args);
    let failed = harness.send_err(&fixture.admin, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidAuthority);
}

#[test]
fn update_config_rejects_non_admin_signer() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let impostor = harness.funded_keypair();
    let args = valid_update_config_args();

    let ix = update_config_ix(&impostor.pubkey(), &fixture.config, args);
    let failed = harness.send_err(&impostor, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);
}

fn valid_update_config_args() -> vsol::UpdateConfigArgs {
    vsol::UpdateConfigArgs {
        pause_authority: Pubkey::new_unique(),
        oracle_authority: Pubkey::new_unique(),
        eligibility_authority: Pubkey::new_unique(),
        treasury_owner: Pubkey::new_unique(),
        fee_bps: 50,
        eligibility_required: false,
    }
}

// =====================================================================
// set_eligibility
// =====================================================================

#[test]
fn set_eligibility_rejects_unauthorized_signer() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let impostor = harness.funded_keypair();
    let wallet = Pubkey::new_unique();
    let eligibility = eligibility_pda(&fixture.config, &wallet);

    let ix = set_eligibility_ix(
        &impostor.pubkey(),
        &fixture.config,
        &eligibility,
        wallet,
        true,
        harness.now() + 3600,
    );
    let failed = harness.send_err(&impostor, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);
}

/// With `eligibility_required` on, an ineligible buyer's fill is rejected and
/// an eligible buyer's fill succeeds — exercised end to end through
/// `fill_quote` so the check is proven where it actually matters.
#[test]
fn set_eligibility_gates_fill_quote_when_required() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);

    // Turn eligibility_required on via update_config (bumps domain_version,
    // which fill_quote's signed message binds to — tracked below).
    let mut config_args = valid_update_config_args();
    config_args.eligibility_required = true;
    config_args.pause_authority = fixture.pause_authority.pubkey();
    config_args.oracle_authority = fixture.oracle_authority.pubkey();
    config_args.eligibility_authority = fixture.eligibility_authority.pubkey();
    config_args.treasury_owner = fixture.treasury_owner;
    harness.send_ok(
        &fixture.admin,
        &[update_config_ix(&fixture.admin.pubkey(), &fixture.config, config_args)],
        &[],
    );
    let domain_version = read_config(&harness, &fixture.config).domain_version;

    let maker = harness.funded_keypair();
    let ineligible_buyer = harness.funded_keypair();
    let eligible_buyer = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &maker, settlement_mint);

    let writer_vault = writer_vault_pda(&fixture.config, &maker.pubkey(), &market.settlement_mint);
    let writer_token = writer_token_pda(&writer_vault);
    harness.send_ok(
        &maker,
        &[initialize_writer_vault_ix(
            &maker.pubkey(),
            &fixture.config,
            &market.settlement_mint,
            &writer_vault,
            &writer_token,
        )],
        &[],
    );
    let maker_source = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &maker_source, 100 * ONE_TOKEN);
    harness.send_ok(
        &maker,
        &[deposit_writer_ix(
            &fixture.config,
            &maker.pubkey(),
            &market.settlement_mint,
            &writer_vault,
            &writer_token,
            &maker_source,
            50 * ONE_TOKEN,
        )],
        &[],
    );

    // Only the eligible buyer gets an eligibility record.
    let eligibility = eligibility_pda(&fixture.config, &eligible_buyer.pubkey());
    harness.send_ok(
        &fixture.eligibility_authority,
        &[set_eligibility_ix(
            &fixture.eligibility_authority.pubkey(),
            &fixture.config,
            &eligibility,
            eligible_buyer.pubkey(),
            true,
            harness.now() + 3600,
        )],
        &[],
    );

    // Ineligible buyer: no eligibility account at all.
    let ineligible_source =
        harness.create_token_account(&ineligible_buyer, &market.settlement_mint, &ineligible_buyer.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &ineligible_source, 10 * ONE_TOKEN);
    let quote = default_quote(10, harness.now() + 30);
    let nonce_record = nonce_pda(&fixture.config, &maker.pubkey(), quote.nonce);
    let position = position_pda(&nonce_record);
    let position_vault = position_vault_pda(&position);
    let ineligible_accounts = FillQuoteAccounts {
        buyer: ineligible_buyer.pubkey(),
        maker: maker.pubkey(),
        config: fixture.config,
        market: market.market,
        settlement_mint: market.settlement_mint,
        writer_vault,
        writer_token,
        buyer_source: ineligible_source,
        nonce_record,
        position,
        position_vault,
        eligibility: None,
    };
    let ixs = fill_quote_ixs(&maker, &ineligible_accounts, &fixture.domain_separator, domain_version, quote);
    let failed = harness.send_err(&ineligible_buyer, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::EligibilityRequired);

    // Eligible buyer: same flow, succeeds.
    let eligible_source =
        harness.create_token_account(&eligible_buyer, &market.settlement_mint, &eligible_buyer.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &eligible_source, 10 * ONE_TOKEN);
    let quote = default_quote(11, harness.now() + 30);
    let nonce_record = nonce_pda(&fixture.config, &maker.pubkey(), quote.nonce);
    let position = position_pda(&nonce_record);
    let position_vault = position_vault_pda(&position);
    let eligible_accounts = FillQuoteAccounts {
        buyer: eligible_buyer.pubkey(),
        buyer_source: eligible_source,
        nonce_record,
        position,
        position_vault,
        eligibility: Some(eligibility),
        ..ineligible_accounts
    };
    let ixs = fill_quote_ixs(&maker, &eligible_accounts, &fixture.domain_separator, domain_version, quote);
    harness.send_ok(&eligible_buyer, &ixs, &[]);
}

// =====================================================================
// cancel_nonce
// =====================================================================

#[test]
fn cancel_nonce_makes_the_nonce_unusable_for_a_later_fill() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let buyer = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &maker, settlement_mint);

    let writer_vault = writer_vault_pda(&fixture.config, &maker.pubkey(), &market.settlement_mint);
    let writer_token = writer_token_pda(&writer_vault);
    harness.send_ok(
        &maker,
        &[initialize_writer_vault_ix(
            &maker.pubkey(),
            &fixture.config,
            &market.settlement_mint,
            &writer_vault,
            &writer_token,
        )],
        &[],
    );
    let maker_source = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &maker_source, 100 * ONE_TOKEN);
    harness.send_ok(
        &maker,
        &[deposit_writer_ix(
            &fixture.config,
            &maker.pubkey(),
            &market.settlement_mint,
            &writer_vault,
            &writer_token,
            &maker_source,
            50 * ONE_TOKEN,
        )],
        &[],
    );

    let nonce = 42;
    let nonce_record = nonce_pda(&fixture.config, &maker.pubkey(), nonce);
    harness.send_ok(
        &maker,
        &[cancel_nonce_ix(&maker.pubkey(), &fixture.config, &nonce_record, nonce)],
        &[],
    );
    let record: vsol::QuoteNonce = harness.read_account(&nonce_record);
    assert_eq!(record.status, 2 /* NonceStatus::Cancelled */);
    assert_eq!(record.maker, maker.pubkey());

    // A fill against the now-cancelled nonce must fail: the nonce record PDA
    // already exists, so `fill_quote`'s `init` constraint on it cannot
    // succeed a second time. One-shot semantics, proven end to end.
    let buyer_source = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &buyer_source, 10 * ONE_TOKEN);
    let quote = default_quote(nonce, harness.now() + 30);
    let position = position_pda(&nonce_record);
    let position_vault = position_vault_pda(&position);
    let fill_accounts = FillQuoteAccounts {
        buyer: buyer.pubkey(),
        maker: maker.pubkey(),
        config: fixture.config,
        market: market.market,
        settlement_mint: market.settlement_mint,
        writer_vault,
        writer_token,
        buyer_source,
        nonce_record,
        position,
        position_vault,
        eligibility: None,
    };
    let ixs = fill_quote_ixs(&maker, &fill_accounts, &fixture.domain_separator, 1, quote);
    let failed = harness.send_err(&buyer, &ixs, &[]);
    // The nonce record PDA already exists (as `Cancelled`), so `fill_quote`'s
    // `init` constraint on it fails before any vsol-specific `require!` runs:
    // the System Program CPI rejects re-creating an already-owned account
    // with `SystemError::AccountAlreadyInUse` (numeric value 0), surfaced
    // here as a custom instruction error. This is a framework-level error
    // rather than a `VsolError`, but it is the exact one-shot guarantee
    // `cancel_nonce` exists to provide.
    assert_eq!(anchor_error_code(&failed), 0, "expected SystemError::AccountAlreadyInUse");
}

#[test]
fn cancel_nonce_rejects_cancelling_someone_elses_nonce() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let impostor = harness.funded_keypair();

    let nonce = 7;
    // The nonce record PDA is seeded by `maker`, so an impostor signing the
    // transaction derives (and can only ever derive) a *different* PDA for
    // themselves; passing the real maker's nonce-record address forces a
    // seeds mismatch, which Anchor rejects as a constraint violation.
    let real_nonce_record = nonce_pda(&fixture.config, &maker.pubkey(), nonce);
    let ix = cancel_nonce_ix(&impostor.pubkey(), &fixture.config, &real_nonce_record, nonce);
    let failed = harness.send_err(&impostor, &[ix], &[]);
    assert_ne!(anchor_error_code(&failed), 0);

    // The real maker can still cancel their own nonce afterwards.
    harness.send_ok(
        &maker,
        &[cancel_nonce_ix(&maker.pubkey(), &fixture.config, &real_nonce_record, nonce)],
        &[],
    );
}

// =====================================================================
// withdraw_writer
// =====================================================================

fn setup_writer_vault(harness: &mut Harness, fixture: &ConfigFixture, maker: &Keypair, mint: &Pubkey) -> (Pubkey, Pubkey) {
    let writer_vault = writer_vault_pda(&fixture.config, &maker.pubkey(), mint);
    let writer_token = writer_token_pda(&writer_vault);
    harness.send_ok(
        maker,
        &[initialize_writer_vault_ix(&maker.pubkey(), &fixture.config, mint, &writer_vault, &writer_token)],
        &[],
    );
    (writer_vault, writer_token)
}

#[test]
fn withdraw_writer_returns_free_collateral() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let (writer_vault, writer_token) = setup_writer_vault(&mut harness, &fixture, &maker, &mint);

    let maker_source = harness.create_token_account(&maker, &mint, &maker.pubkey());
    harness.mint_to(&maker, &mint, &maker, &maker_source, 100 * ONE_TOKEN);
    harness.send_ok(
        &maker,
        &[deposit_writer_ix(&fixture.config, &maker.pubkey(), &mint, &writer_vault, &writer_token, &maker_source, 60 * ONE_TOKEN)],
        &[],
    );

    let maker_destination = harness.create_token_account(&maker, &mint, &maker.pubkey());
    harness.send_ok(
        &maker,
        &[withdraw_writer_ix(&fixture.config, &maker.pubkey(), &mint, &writer_vault, &writer_token, &maker_destination, 25 * ONE_TOKEN)],
        &[],
    );

    assert_eq!(harness.token_balance(&writer_token), 35 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&maker_destination), 25 * ONE_TOKEN);
}

#[test]
fn withdraw_writer_rejects_amount_above_free_balance() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let (writer_vault, writer_token) = setup_writer_vault(&mut harness, &fixture, &maker, &mint);

    let maker_source = harness.create_token_account(&maker, &mint, &maker.pubkey());
    harness.mint_to(&maker, &mint, &maker, &maker_source, 100 * ONE_TOKEN);
    harness.send_ok(
        &maker,
        &[deposit_writer_ix(&fixture.config, &maker.pubkey(), &mint, &writer_vault, &writer_token, &maker_source, 10 * ONE_TOKEN)],
        &[],
    );

    let maker_destination = harness.create_token_account(&maker, &mint, &maker.pubkey());
    let ix = withdraw_writer_ix(&fixture.config, &maker.pubkey(), &mint, &writer_vault, &writer_token, &maker_destination, 11 * ONE_TOKEN);
    let failed = harness.send_err(&maker, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InsufficientWriterLiquidity);
}

/// Collateral committed to an open position is escrowed away from the
/// writer's own token account into the position vault, so `withdraw_writer`
/// naturally cannot touch it — proven by filling a quote against nearly all
/// deposited collateral and confirming only the untouched remainder can be
/// withdrawn.
#[test]
fn withdraw_writer_cannot_reach_collateral_committed_to_an_open_position() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let buyer = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &maker, settlement_mint);
    let (writer_vault, writer_token) = setup_writer_vault(&mut harness, &fixture, &maker, &market.settlement_mint);

    let maker_source = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &maker_source, 100 * ONE_TOKEN);
    harness.send_ok(
        &maker,
        &[deposit_writer_ix(
            &fixture.config,
            &maker.pubkey(),
            &market.settlement_mint,
            &writer_vault,
            &writer_token,
            &maker_source,
            10 * ONE_TOKEN,
        )],
        &[],
    );

    // Fill a quote whose max_payout consumes all 10 tokens of collateral.
    let buyer_source = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    harness.mint_to(&maker, &market.settlement_mint, &maker, &buyer_source, 10 * ONE_TOKEN);
    let mut quote = default_quote(1, harness.now() + 30);
    quote.max_payout = 10 * ONE_TOKEN;
    let nonce_record = nonce_pda(&fixture.config, &maker.pubkey(), quote.nonce);
    let position = position_pda(&nonce_record);
    let position_vault = position_vault_pda(&position);
    let fill_accounts = FillQuoteAccounts {
        buyer: buyer.pubkey(),
        maker: maker.pubkey(),
        config: fixture.config,
        market: market.market,
        settlement_mint: market.settlement_mint,
        writer_vault,
        writer_token,
        buyer_source,
        nonce_record,
        position,
        position_vault,
        eligibility: None,
    };
    let ixs = fill_quote_ixs(&maker, &fill_accounts, &fixture.domain_separator, 1, quote);
    harness.send_ok(&buyer, &ixs, &[]);

    // The writer's free collateral is now zero; any withdrawal fails.
    assert_eq!(harness.token_balance(&writer_token), 0);
    let maker_destination = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    let ix = withdraw_writer_ix(
        &fixture.config,
        &maker.pubkey(),
        &market.settlement_mint,
        &writer_vault,
        &writer_token,
        &maker_destination,
        1,
    );
    let failed = harness.send_err(&maker, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InsufficientWriterLiquidity);
}

// =====================================================================
// update_liquidity_pool
// =====================================================================

struct PoolFixture {
    pool: Pubkey,
    pool_token: Pubkey,
    manager: Keypair,
    settlement_mint: Pubkey,
    quote_authority: Keypair,
}

fn setup_pool(harness: &mut Harness, fixture: &ConfigFixture) -> PoolFixture {
    let manager = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&manager, &manager.pubkey(), SETTLEMENT_DECIMALS);
    let quote_authority = harness.funded_keypair();
    let pool_id = [0x55u8; 32];
    let pool = pool_pda(&fixture.config, &settlement_mint, &pool_id);
    let pool_token = pool_token_pda(&pool);
    let args = vsol::InitializeLiquidityPoolArgs {
        pool_id,
        quote_authority: quote_authority.pubkey(),
        max_utilization_bps: 8_000,
        max_position_bps: 2_000,
    };
    harness.send_ok(
        &manager,
        &[initialize_liquidity_pool_ix(
            &manager.pubkey(),
            &fixture.config,
            &settlement_mint,
            &pool,
            &pool_token,
            args,
        )],
        &[],
    );
    PoolFixture {
        pool,
        pool_token,
        manager,
        settlement_mint,
        quote_authority,
    }
}

#[test]
fn update_liquidity_pool_applies_new_authority_and_limits() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);

    let new_quote_authority = Pubkey::new_unique();
    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: new_quote_authority,
        max_utilization_bps: 5_000,
        max_position_bps: 1_000,
    };
    harness.send_ok(
        &pool.manager,
        &[update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args)],
        &[],
    );

    let updated: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(updated.quote_authority, new_quote_authority);
    assert_eq!(updated.max_utilization_bps, 5_000);
    assert_eq!(updated.max_position_bps, 1_000);
}

#[test]
fn update_liquidity_pool_rejects_non_manager_signer() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let impostor = harness.funded_keypair();

    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: Pubkey::new_unique(),
        max_utilization_bps: 5_000,
        max_position_bps: 1_000,
    };
    let ix = update_liquidity_pool_ix(&impostor.pubkey(), &fixture.config, &pool.pool, args);
    let failed = harness.send_err(&impostor, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);
}

#[test]
fn update_liquidity_pool_rejects_invalid_risk_limits() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);

    // max_position_bps must not exceed max_utilization_bps.
    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: Pubkey::new_unique(),
        max_utilization_bps: 1_000,
        max_position_bps: 2_000,
    };
    let ix = update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args);
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidPoolRiskLimits);
}

#[test]
fn update_liquidity_pool_rejects_while_pool_has_open_positions_or_locked_collateral() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market = setup_market(&mut harness, &fixture, &pool.manager, pool.settlement_mint);

    // Fund the pool and open a position against it via fill_pool_quote.
    let provider = harness.funded_keypair();
    let provider_position = provider_position_pda(&pool.pool, &provider.pubkey());
    let provider_source = harness.create_token_account(&provider, &pool.settlement_mint, &provider.pubkey());
    harness.mint_to(&pool.manager, &pool.settlement_mint, &pool.manager, &provider_source, 100 * ONE_TOKEN);
    harness.send_ok(
        &provider,
        &[deposit_liquidity_ix(
            &provider.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &provider_position,
            &provider_source,
            100 * ONE_TOKEN,
            0,
            harness.now() + 3600,
        )],
        &[],
    );

    let pool_market = pool_market_pda(&pool.pool, &market.market);
    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market.market,
            &pool_market,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market.expiry - 30,
                enabled: true,
            },
        )],
        &[],
    );

    let buyer = harness.funded_keypair();
    let buyer_source = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    harness.mint_to(&pool.manager, &market.settlement_mint, &pool.manager, &buyer_source, 10 * ONE_TOKEN);
    let quote = default_pool_quote(1, harness.now() + 30);
    let pool_nonce_record = pool_nonce_pda(&pool.pool, &pool.quote_authority.pubkey(), quote.nonce);
    let pool_position = pool_position_pda(&pool_nonce_record);
    let pool_position_vault = pool_position_vault_pda(&pool_position);
    let fill_accounts = FillPoolQuoteAccounts {
        buyer: buyer.pubkey(),
        quote_authority: pool.quote_authority.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market.market,
        pool_market,
        settlement_mint: market.settlement_mint,
        pool_token: pool.pool_token,
        buyer_source,
        nonce_record: pool_nonce_record,
        position: pool_position,
        position_vault: pool_position_vault,
        eligibility: None,
    };
    let ixs = fill_pool_quote_ixs(&pool.quote_authority, &fill_accounts, &fixture.domain_separator, 1, quote);
    harness.send_ok(&buyer, &ixs, &[]);

    // Now the pool has an open position and locked collateral: updates must
    // be rejected until it settles back down to zero exposure.
    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: Pubkey::new_unique(),
        max_utilization_bps: 5_000,
        max_position_bps: 1_000,
    };
    let ix = update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args);
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::PoolHasOpenPositions);
}

// =====================================================================
// Pooled lifecycle smoke test: create_market -> initialize_liquidity_pool
// -> set_liquidity_pool_market -> deposit_liquidity -> fill_pool_quote ->
// settle_pool_position.
// =====================================================================

#[test]
fn pooled_lifecycle_smoke_create_market_through_settle_pool_position() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market = setup_market(&mut harness, &fixture, &pool.manager, pool.settlement_mint);

    let provider = harness.funded_keypair();
    let provider_position = provider_position_pda(&pool.pool, &provider.pubkey());
    let provider_source = harness.create_token_account(&provider, &pool.settlement_mint, &provider.pubkey());
    harness.mint_to(&pool.manager, &pool.settlement_mint, &pool.manager, &provider_source, 200 * ONE_TOKEN);
    harness.send_ok(
        &provider,
        &[deposit_liquidity_ix(
            &provider.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &provider_position,
            &provider_source,
            200 * ONE_TOKEN,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&pool.pool_token), 200 * ONE_TOKEN);

    let pool_market = pool_market_pda(&pool.pool, &market.market);
    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market.market,
            &pool_market,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market.expiry - 30,
                enabled: true,
            },
        )],
        &[],
    );

    let buyer = harness.funded_keypair();
    let buyer_source = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    harness.mint_to(&pool.manager, &market.settlement_mint, &pool.manager, &buyer_source, 10 * ONE_TOKEN);
    let quote = default_pool_quote(1, harness.now() + 30);
    let pool_nonce_record = pool_nonce_pda(&pool.pool, &pool.quote_authority.pubkey(), quote.nonce);
    let pool_position = pool_position_pda(&pool_nonce_record);
    let pool_position_vault = pool_position_vault_pda(&pool_position);
    let fill_accounts = FillPoolQuoteAccounts {
        buyer: buyer.pubkey(),
        quote_authority: pool.quote_authority.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market.market,
        pool_market,
        settlement_mint: market.settlement_mint,
        pool_token: pool.pool_token,
        buyer_source,
        nonce_record: pool_nonce_record,
        position: pool_position,
        position_vault: pool_position_vault,
        eligibility: None,
    };
    let ixs = fill_pool_quote_ixs(&pool.quote_authority, &fill_accounts, &fixture.domain_separator, 1, quote);
    harness.send_ok(&buyer, &ixs, &[]);

    let pool_after_fill: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(pool_after_fill.open_positions, 1);
    assert_eq!(pool_after_fill.locked_collateral, quote.max_payout);

    harness.warp_to_timestamp(market.expiry);
    // Settlement price above strike + width: buyer receives the full max_payout.
    finalize_oracle(&mut harness, &market, 200 * ONE_TOKEN);

    let buyer_destination = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&pool.manager, &market.settlement_mint, &fixture.treasury_owner);
    let settle_accounts = SettlePoolPositionAccounts {
        cranker: buyer.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market.market,
        oracle: market.oracle,
        nonce_record: pool_nonce_record,
        position: pool_position,
        position_vault: pool_position_vault,
        settlement_mint: market.settlement_mint,
        buyer_destination,
        pool_token: pool.pool_token,
        treasury_destination,
        rent_recipient: buyer.pubkey(),
    };
    harness.send_ok(&buyer, &[settle_pool_position_ix(&settle_accounts)], &[]);

    let pool_after_settle: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(pool_after_settle.open_positions, 0);
    assert_eq!(pool_after_settle.locked_collateral, 0);
    assert_eq!(harness.token_balance(&buyer_destination), quote.max_payout);

    // Round out the lifecycle: with the pool back to zero exposure, the sole
    // provider can withdraw all their shares for the pool's entire remaining
    // balance. The settlement above was fully in the money for the buyer
    // (price 200 vs. strike+width 120), so the pool paid out its full
    // max_payout and is left holding less than it started with — the
    // provider absorbs that loss, net of the premium and fee.
    let provider_position_after: vsol::LiquidityProvider = harness.read_account(&provider_position);
    let pool_balance_before_withdrawal = harness.token_balance(&pool.pool_token);
    assert!(pool_balance_before_withdrawal < 200 * ONE_TOKEN);
    let provider_destination =
        harness.create_token_account(&provider, &pool.settlement_mint, &provider.pubkey());
    harness.send_ok(
        &provider,
        &[withdraw_liquidity_ix(
            &provider.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &provider_position,
            &provider_destination,
            provider_position_after.shares,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&pool.pool_token), 0);
    assert_eq!(harness.token_balance(&provider_destination), pool_balance_before_withdrawal);
}

/// The pool-side counterpart of `refund_unsettled`: if a pool position's
/// market never gets a finalized settlement price before the observation
/// window plus grace period elapses, the pool must be able to reclaim its
/// locked collateral (and the buyer their premium) via `refund_pool_position`.
#[test]
fn refund_pool_position_returns_funds_when_settlement_window_closes_unfinalized() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market = setup_market(&mut harness, &fixture, &pool.manager, pool.settlement_mint);

    let provider = harness.funded_keypair();
    let provider_position = provider_position_pda(&pool.pool, &provider.pubkey());
    let provider_source = harness.create_token_account(&provider, &pool.settlement_mint, &provider.pubkey());
    harness.mint_to(&pool.manager, &pool.settlement_mint, &pool.manager, &provider_source, 100 * ONE_TOKEN);
    harness.send_ok(
        &provider,
        &[deposit_liquidity_ix(
            &provider.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &provider_position,
            &provider_source,
            100 * ONE_TOKEN,
            0,
            harness.now() + 3600,
        )],
        &[],
    );

    let pool_market = pool_market_pda(&pool.pool, &market.market);
    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market.market,
            &pool_market,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market.expiry - 30,
                enabled: true,
            },
        )],
        &[],
    );

    let buyer = harness.funded_keypair();
    let buyer_source = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    harness.mint_to(&pool.manager, &market.settlement_mint, &pool.manager, &buyer_source, 10 * ONE_TOKEN);
    let quote = default_pool_quote(1, harness.now() + 30);
    let pool_nonce_record = pool_nonce_pda(&pool.pool, &pool.quote_authority.pubkey(), quote.nonce);
    let pool_position = pool_position_pda(&pool_nonce_record);
    let pool_position_vault = pool_position_vault_pda(&pool_position);
    let fill_accounts = FillPoolQuoteAccounts {
        buyer: buyer.pubkey(),
        quote_authority: pool.quote_authority.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market.market,
        pool_market,
        settlement_mint: market.settlement_mint,
        pool_token: pool.pool_token,
        buyer_source,
        nonce_record: pool_nonce_record,
        position: pool_position,
        position_vault: pool_position_vault,
        eligibility: None,
    };
    let ixs = fill_pool_quote_ixs(&pool.quote_authority, &fill_accounts, &fixture.domain_separator, 1, quote);
    harness.send_ok(&buyer, &ixs, &[]);

    // Fill blocked while paused, exercised alongside the refund below so
    // this test also covers the pool half of the pause guardian invariant.
    harness.send_ok(
        &fixture.pause_authority,
        &[set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, true)],
        &[],
    );
    let blocked_quote = default_pool_quote(2, harness.now() + 30);
    let blocked_nonce_record = pool_nonce_pda(&pool.pool, &pool.quote_authority.pubkey(), blocked_quote.nonce);
    let blocked_position = pool_position_pda(&blocked_nonce_record);
    let blocked_position_vault = pool_position_vault_pda(&blocked_position);
    let blocked_accounts = FillPoolQuoteAccounts {
        nonce_record: blocked_nonce_record,
        position: blocked_position,
        position_vault: blocked_position_vault,
        ..fill_accounts
    };
    let blocked_ixs = fill_pool_quote_ixs(
        &pool.quote_authority,
        &blocked_accounts,
        &fixture.domain_separator,
        1,
        blocked_quote,
    );
    let failed = harness.send_err(&buyer, &blocked_ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::ProtocolPaused);

    // Never finalize the oracle; let the whole settlement window elapse.
    let deadline = market.expiry + i64::from(OBSERVATION_WINDOW) + i64::from(SETTLEMENT_GRACE) + 1;
    harness.warp_to_timestamp(deadline);

    let buyer_destination = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    let refund_accounts = RefundPoolPositionAccounts {
        cranker: buyer.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market.market,
        oracle: market.oracle,
        nonce_record: pool_nonce_record,
        position: pool_position,
        position_vault: pool_position_vault,
        settlement_mint: market.settlement_mint,
        buyer_destination,
        pool_token: pool.pool_token,
        rent_recipient: buyer.pubkey(),
    };
    // Still paused. `refund_pool_position` must succeed anyway.
    harness.send_ok(&buyer, &[refund_pool_position_ix(&refund_accounts)], &[]);
    assert!(read_config(&harness, &fixture.config).paused);

    let pool_after_refund: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(pool_after_refund.open_positions, 0);
    assert_eq!(pool_after_refund.locked_collateral, 0);
    assert_eq!(harness.token_balance(&buyer_destination), quote.premium);
    assert_eq!(harness.token_balance(&pool.pool_token), 100 * ONE_TOKEN);
}
