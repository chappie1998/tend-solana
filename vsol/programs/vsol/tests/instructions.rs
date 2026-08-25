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
const MAX_SETTLEMENT_STALENESS: u32 = 86_400;
// The conditional-token winner threshold every fixture market is created
// with by default. Irrelevant to the older per-position spread-payoff tests
// (they carry their own strike+width on the quote), but every market now
// requires one regardless of which path it's used for.
const DEFAULT_STRIKE: u64 = 100 * ONE_TOKEN;

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
    observation_window_seconds: u32,
    settlement_grace_seconds: u32,
    max_settlement_staleness_seconds: u32,
    strike: u64,
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
    setup_market_with_terms(
        harness,
        fixture,
        creator,
        settlement_mint,
        feed_salt,
        OBSERVATION_WINDOW,
        SETTLEMENT_GRACE,
        MAX_SETTLEMENT_STALENESS,
    )
}

/// Full-control market setup: lets `publish_pyth_settlement` tier tests pick
/// short observation/grace windows so a test can warp past
/// `observation_end` quickly, alongside an independent staleness bound.
#[allow(clippy::too_many_arguments)]
fn setup_market_with_terms(
    harness: &mut Harness,
    fixture: &ConfigFixture,
    creator: &Keypair,
    settlement_mint: Pubkey,
    feed_salt: u8,
    observation_window_seconds: u32,
    settlement_grace_seconds: u32,
    max_settlement_staleness_seconds: u32,
) -> MarketFixture {
    let now = harness.now();
    let expiry = now + MARKET_LEAD_SECONDS + 3600;
    let mut args = vsol::CreateMarketArgs {
        market_id: [0u8; 32],
        underlying_mint: Pubkey::new_unique(),
        symbol: symbol_bytes("NVDA"),
        price_scale: 1_000_000,
        expiry,
        observation_window_seconds,
        settlement_grace_seconds,
        max_confidence_bps: 100,
        pyth_feed_id: [feed_salt; 32],
        max_settlement_staleness_seconds,
        strike: DEFAULT_STRIKE,
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
        observation_window_seconds,
        settlement_grace_seconds,
        max_settlement_staleness_seconds,
        strike: args.strike,
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
        strike: DEFAULT_STRIKE,
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
        strike: DEFAULT_STRIKE,
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

// =====================================================================
// update_liquidity_pool / apply_liquidity_pool_update / cancel_pending_pool_update
//
// A pool's `manager` is an untrusted, permissionless role: anyone can create
// a pool and attract LP deposits. Before the timelock below existed, a
// manager could raise `max_utilization_bps` to 100% and rotate
// `quote_authority` to a key they control in one instruction with zero LP
// notice, then immediately self-sign a `fill_pool_quote` for (almost) the
// whole pool. These tests exercise both halves of the fix:
//   - MAX_POOL_UTILIZATION_BPS: no pool can ever be configured above 80%
//     utilization, so a single fill cannot drain the whole pool.
//   - The propose/apply/cancel timelock: raising a cap, or rotating
//     `quote_authority` at all, cannot take effect before
//     POOL_UPDATE_TIMELOCK_SECONDS has elapsed and `apply_liquidity_pool_update`
//     is called. Lowering a cap with the authority unchanged remains
//     immediate, since that can only make LPs safer.
// =====================================================================

#[test]
fn update_liquidity_pool_rejects_utilization_above_the_protocol_ceiling() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);

    // Even though this is otherwise a valid-looking request (quote_authority
    // unchanged), 100% utilization is never representable: the pool cannot
    // be configured to back positions with its entire balance.
    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: pool.quote_authority.pubkey(),
        max_utilization_bps: 10_000,
        max_position_bps: 10_000,
    };
    let ix = update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args);
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidPoolRiskLimits);

    let unchanged: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(unchanged.max_utilization_bps, 8_000);
    assert_eq!(unchanged.pending_effective_at, 0);
}

#[test]
fn update_liquidity_pool_lowering_caps_with_unchanged_authority_applies_immediately() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture); // starts at 8_000 / 2_000

    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: pool.quote_authority.pubkey(),
        max_utilization_bps: 5_000,
        max_position_bps: 1_000,
    };
    harness.send_ok(
        &pool.manager,
        &[update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args)],
        &[],
    );

    // Applied immediately: no pending change was ever recorded.
    let updated: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(updated.quote_authority, pool.quote_authority.pubkey());
    assert_eq!(updated.max_utilization_bps, 5_000);
    assert_eq!(updated.max_position_bps, 1_000);
    assert_eq!(updated.pending_effective_at, 0);
    assert_eq!(updated.pending_quote_authority, Pubkey::default());
}

#[test]
fn update_liquidity_pool_raising_a_cap_is_timelocked_not_applied_immediately() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture); // starts at 8_000 / 2_000

    // Lower max_utilization_bps first so there's room to raise max_position_bps
    // while keeping max_utilization_bps at the protocol ceiling.
    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: pool.quote_authority.pubkey(),
        max_utilization_bps: 8_000,
        max_position_bps: 3_000, // raised from 2_000
    };
    let before = harness.now();
    harness.send_ok(
        &pool.manager,
        &[update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args)],
        &[],
    );

    // The live config must NOT have changed yet.
    let after_propose: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(after_propose.max_position_bps, 2_000);
    assert_eq!(after_propose.quote_authority, pool.quote_authority.pubkey());
    assert_eq!(after_propose.pending_max_position_bps, 3_000);
    assert_eq!(after_propose.pending_max_utilization_bps, 8_000);
    assert_eq!(after_propose.pending_quote_authority, pool.quote_authority.pubkey());
    assert_eq!(
        after_propose.pending_effective_at,
        before + vsol::POOL_UPDATE_TIMELOCK_SECONDS
    );
}

#[test]
fn update_liquidity_pool_rotating_quote_authority_is_timelocked() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let new_quote_authority = Pubkey::new_unique();

    // Even lowering both caps does not make an authority rotation immediate.
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

    let after_propose: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(after_propose.quote_authority, pool.quote_authority.pubkey());
    assert_eq!(after_propose.max_utilization_bps, 8_000);
    assert_eq!(after_propose.max_position_bps, 2_000);
    assert_eq!(after_propose.pending_quote_authority, new_quote_authority);
    assert!(after_propose.pending_effective_at > 0);
}

#[test]
fn apply_liquidity_pool_update_rejects_before_timelock_elapses() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let new_quote_authority = Pubkey::new_unique();

    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: new_quote_authority,
        max_utilization_bps: 6_000,
        max_position_bps: 1_500,
    };
    harness.send_ok(
        &pool.manager,
        &[update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args)],
        &[],
    );

    // Warp forward, but not all the way to the timelock deadline.
    harness.warp_to_timestamp(harness.now() + vsol::POOL_UPDATE_TIMELOCK_SECONDS - 1);

    let ix = apply_liquidity_pool_update_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool);
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::PoolUpdateTimelocked);
}

#[test]
fn apply_liquidity_pool_update_succeeds_at_or_after_timelock() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let new_quote_authority = Pubkey::new_unique();

    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: new_quote_authority,
        max_utilization_bps: 6_000,
        max_position_bps: 1_500,
    };
    harness.send_ok(
        &pool.manager,
        &[update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args)],
        &[],
    );
    let pending: vsol::LiquidityPool = harness.read_account(&pool.pool);

    harness.warp_to_timestamp(pending.pending_effective_at);
    harness.send_ok(
        &pool.manager,
        &[apply_liquidity_pool_update_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool)],
        &[],
    );

    let applied: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(applied.quote_authority, new_quote_authority);
    assert_eq!(applied.max_utilization_bps, 6_000);
    assert_eq!(applied.max_position_bps, 1_500);
    // Pending fields reset back to the "nothing pending" sentinel.
    assert_eq!(applied.pending_quote_authority, Pubkey::default());
    assert_eq!(applied.pending_max_utilization_bps, 0);
    assert_eq!(applied.pending_max_position_bps, 0);
    assert_eq!(applied.pending_effective_at, 0);
}

#[test]
fn apply_liquidity_pool_update_rejects_when_nothing_is_pending() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);

    let ix = apply_liquidity_pool_update_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool);
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::NoPendingPoolUpdate);
}

#[test]
fn cancel_pending_pool_update_clears_the_pending_change() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let new_quote_authority = Pubkey::new_unique();

    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: new_quote_authority,
        max_utilization_bps: 6_000,
        max_position_bps: 1_500,
    };
    harness.send_ok(
        &pool.manager,
        &[update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args)],
        &[],
    );

    harness.send_ok(
        &pool.manager,
        &[cancel_pending_pool_update_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool)],
        &[],
    );

    let cancelled: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(cancelled.pending_quote_authority, Pubkey::default());
    assert_eq!(cancelled.pending_max_utilization_bps, 0);
    assert_eq!(cancelled.pending_max_position_bps, 0);
    assert_eq!(cancelled.pending_effective_at, 0);
    // Live config never moved.
    assert_eq!(cancelled.quote_authority, pool.quote_authority.pubkey());
    assert_eq!(cancelled.max_utilization_bps, 8_000);

    // Applying now (even after warping past what would have been the
    // deadline) fails: cancel really did discard the proposal, not just
    // hide it.
    harness.warp_to_timestamp(harness.now() + vsol::POOL_UPDATE_TIMELOCK_SECONDS + 1);
    let ix = apply_liquidity_pool_update_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool);
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::NoPendingPoolUpdate);
}

#[test]
fn cancel_pending_pool_update_rejects_non_manager_signer() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let impostor = harness.funded_keypair();

    let args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: Pubkey::new_unique(),
        max_utilization_bps: 6_000,
        max_position_bps: 1_500,
    };
    harness.send_ok(
        &pool.manager,
        &[update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, args)],
        &[],
    );

    let ix = cancel_pending_pool_update_ix(&impostor.pubkey(), &fixture.config, &pool.pool);
    let failed = harness.send_err(&impostor, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);
}

/// The end-to-end regression test: this is the exact attack from the
/// vulnerability report, replayed against the fixed program. A pool manager
/// (an untrusted, permissionless role) proposes a hostile config change --
/// rotating `quote_authority` to a key only they control -- and then, in the
/// very next instruction, tries to self-sign a `fill_pool_quote` for the
/// entire pool balance using that new authority. Before this fix, both steps
/// could be one transaction with `max_utilization_bps` at 100%. Now: the
/// rotation is still pending (the timelock has not elapsed), so the pool's
/// live `quote_authority` is still the old one, and the fill is rejected.
#[test]
fn hostile_manager_cannot_immediately_self_fill_after_proposing_a_rotated_quote_authority() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market = setup_market(&mut harness, &fixture, &pool.manager, pool.settlement_mint);

    // LPs deposit real capital into the pool.
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

    // The manager authorizes the market for trading (additive, always
    // allowed) and proposes a hostile config change: rotate quote_authority
    // to a key they alone hold, and raise max_utilization_bps to the highest
    // value the protocol will ever allow (MAX_POOL_UTILIZATION_BPS).
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

    let attacker_authority = harness.funded_keypair();
    let hostile_args = vsol::UpdateLiquidityPoolArgs {
        quote_authority: attacker_authority.pubkey(),
        max_utilization_bps: vsol::MAX_POOL_UTILIZATION_BPS,
        max_position_bps: vsol::MAX_POOL_UTILIZATION_BPS,
    };
    harness.send_ok(
        &pool.manager,
        &[update_liquidity_pool_ix(&pool.manager.pubkey(), &fixture.config, &pool.pool, hostile_args)],
        &[],
    );

    // The proposal is recorded, but the live pool is untouched.
    let after_propose: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(after_propose.quote_authority, pool.quote_authority.pubkey());
    assert_eq!(after_propose.pending_quote_authority, attacker_authority.pubkey());
    assert!(after_propose.pending_effective_at > harness.now());

    // The manager (wearing the buyer hat too, exactly as the original
    // vulnerability describes) immediately tries to self-fill against the
    // whole pool, signing with the not-yet-live attacker authority.
    let buyer_source = harness.create_token_account(&pool.manager, &market.settlement_mint, &pool.manager.pubkey());
    harness.mint_to(&pool.manager, &market.settlement_mint, &pool.manager, &buyer_source, 10 * ONE_TOKEN);

    let quote = vsol::PoolQuoteArgs {
        nonce: 1,
        direction: 0,
        strike: 100,
        width: 10,
        premium: 1,
        max_payout: 100 * ONE_TOKEN, // the entire pool balance
        quote_expiry: harness.now() + 30,
    };
    let pool_nonce_record = pool_nonce_pda(&pool.pool, &attacker_authority.pubkey(), quote.nonce);
    let pool_position = pool_position_pda(&pool_nonce_record);
    let pool_position_vault = pool_position_vault_pda(&pool_position);
    let fill_accounts = FillPoolQuoteAccounts {
        buyer: pool.manager.pubkey(),
        quote_authority: attacker_authority.pubkey(),
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
    let ixs = fill_pool_quote_ixs(&attacker_authority, &fill_accounts, &fixture.domain_separator, 1, quote);
    let failed = harness.send_err(&pool.manager, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);

    // The pool never lost a cent: it still has every LP-deposited token.
    assert_eq!(harness.token_balance(&pool.pool_token), 100 * ONE_TOKEN);
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
// set_liquidity_pool_market: the `PoolHasOpenPositions` guard is only
// unconditional for mutating an *existing* authorization. Authorizing a
// brand-new series for the first time is additive -- it cannot change the
// risk of a position that already exists, since collateral is fixed at
// fill time and utilization/per-position caps are enforced then too -- so
// it must be allowed while the pool is busy. That's the mint-on-demand
// case: a first buyer creating and trading a rung in one transaction.
// =====================================================================

/// Deposits liquidity into `pool`, authorizes `market` for trading (a
/// first-time enable, done while the pool is still idle so it's guaranteed
/// to succeed regardless of what's under test), and fills one quote against
/// it so the pool ends up with exactly one open position and non-zero
/// locked collateral. Returns `market`'s `pool_market` PDA so callers can
/// exercise further authorization changes against an authorization that is
/// known to already exist.
fn open_pool_position(
    harness: &mut Harness,
    fixture: &ConfigFixture,
    pool: &PoolFixture,
    market: &MarketFixture,
    quote_nonce: u64,
) -> Pubkey {
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
    let quote = default_pool_quote(quote_nonce, harness.now() + 30);
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
    assert!(pool_after_fill.locked_collateral > 0);

    pool_market
}

#[test]
fn set_liquidity_pool_market_allows_new_series_while_pool_has_open_position() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market_a = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x11);
    open_pool_position(&mut harness, &fixture, &pool, &market_a, 1);

    // The broken-today case: authorizing a second, brand-new series while
    // the pool already has an open position (and locked collateral) from
    // market_a must succeed -- this is a first-time enable, so it does not
    // touch the `PoolHasOpenPositions` guard at all.
    let market_b = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x22);
    let pool_market_b = pool_market_pda(&pool.pool, &market_b.market);
    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market_b.market,
            &pool_market_b,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market_b.expiry - 30,
                enabled: true,
            },
        )],
        &[],
    );

    let authorized: vsol::LiquidityPoolMarket = harness.read_account(&pool_market_b);
    assert!(authorized.enabled);
    assert_eq!(authorized.pool, pool.pool);
    assert_eq!(authorized.market, market_b.market);
}

#[test]
fn set_liquidity_pool_market_rejects_disabling_existing_authorization_with_open_position() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market_a = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x11);
    let pool_market_a = open_pool_position(&mut harness, &fixture, &pool, &market_a, 1);

    // market_a's authorization already exists (it's the one the open
    // position depends on), so disabling it while the pool is busy must
    // stay gated, unlike a first-time enable.
    let ix = set_liquidity_pool_market_ix(
        &pool.manager.pubkey(),
        &fixture.config,
        &pool.pool,
        &market_a.market,
        &pool_market_a,
        vsol::SetLiquidityPoolMarketArgs {
            last_trade_at: market_a.expiry - 30,
            enabled: false,
        },
    );
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::PoolHasOpenPositions);
}

#[test]
fn set_liquidity_pool_market_rejects_last_trade_at_change_on_existing_authorization_with_open_position() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market_a = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x11);
    let pool_market_a = open_pool_position(&mut harness, &fixture, &pool, &market_a, 1);

    // Same authorization, still enabled, just a different trade cutoff:
    // this mutates an existing record and must stay gated.
    let ix = set_liquidity_pool_market_ix(
        &pool.manager.pubkey(),
        &fixture.config,
        &pool.pool,
        &market_a.market,
        &pool_market_a,
        vsol::SetLiquidityPoolMarketArgs {
            last_trade_at: market_a.expiry - 60,
            enabled: true,
        },
    );
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::PoolHasOpenPositions);
}

#[test]
fn set_liquidity_pool_market_rejects_reenabling_existing_authorization_with_open_position() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market_a = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x11);
    let market_b = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x22);

    // Authorize market_b, then disable it again, both while the pool is
    // still idle -- this establishes a real (non-default) pool_market
    // account for market_b before any position exists.
    let pool_market_b = pool_market_pda(&pool.pool, &market_b.market);
    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market_b.market,
            &pool_market_b,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market_b.expiry - 30,
                enabled: true,
            },
        )],
        &[],
    );
    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market_b.market,
            &pool_market_b,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market_b.expiry - 30,
                enabled: false,
            },
        )],
        &[],
    );

    open_pool_position(&mut harness, &fixture, &pool, &market_a, 1);

    // Re-enabling market_b now touches an already-existing pool_market
    // account (not a first-time enable), so it must stay gated even though
    // the request itself sets `enabled: true`.
    let ix = set_liquidity_pool_market_ix(
        &pool.manager.pubkey(),
        &fixture.config,
        &pool.pool,
        &market_b.market,
        &pool_market_b,
        vsol::SetLiquidityPoolMarketArgs {
            last_trade_at: market_b.expiry - 30,
            enabled: true,
        },
    );
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::PoolHasOpenPositions);
}

#[test]
fn set_liquidity_pool_market_first_time_disable_still_requires_idle_pool() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market_a = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x11);
    open_pool_position(&mut harness, &fixture, &pool, &market_a, 1);

    // First-time creation of market_b's pool_market, but with
    // `enabled: false`: this is not an enable at all, so it does not
    // qualify for the first-time-enable carve-out and must still be
    // rejected while the pool is busy.
    let market_b = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x22);
    let pool_market_b = pool_market_pda(&pool.pool, &market_b.market);
    let ix = set_liquidity_pool_market_ix(
        &pool.manager.pubkey(),
        &fixture.config,
        &pool.pool,
        &market_b.market,
        &pool_market_b,
        vsol::SetLiquidityPoolMarketArgs {
            last_trade_at: market_b.expiry - 30,
            enabled: false,
        },
    );
    let failed = harness.send_err(&pool.manager, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::PoolHasOpenPositions);
}

#[test]
fn set_liquidity_pool_market_all_transitions_succeed_while_pool_idle() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let market = setup_market(&mut harness, &fixture, &pool.manager, pool.settlement_mint);
    let pool_market = pool_market_pda(&pool.pool, &market.market);

    // No open positions or locked collateral at any point in this test:
    // every transition below must behave exactly as it did before this
    // change (the quiet case is unaffected by the carve-out).
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
    let after_enable: vsol::LiquidityPoolMarket = harness.read_account(&pool_market);
    assert!(after_enable.enabled);
    assert_eq!(after_enable.last_trade_at, market.expiry - 30);

    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market.market,
            &pool_market,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market.expiry - 60,
                enabled: true,
            },
        )],
        &[],
    );
    let after_change: vsol::LiquidityPoolMarket = harness.read_account(&pool_market);
    assert_eq!(after_change.last_trade_at, market.expiry - 60);

    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market.market,
            &pool_market,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market.expiry - 60,
                enabled: false,
            },
        )],
        &[],
    );
    let after_disable: vsol::LiquidityPoolMarket = harness.read_account(&pool_market);
    assert!(!after_disable.enabled);

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
    let after_reenable: vsol::LiquidityPoolMarket = harness.read_account(&pool_market);
    assert!(after_reenable.enabled);
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

// =====================================================================
// LiquidityPool::total_assets: the pool's own internal ledger of free
// (unlocked) settlement tokens, immune to donations. Before this field
// existed, deposit_liquidity/withdraw_liquidity used `pool_token.amount`
// (the raw SPL balance) directly as the share-price denominator -- and a
// token account's owner cannot refuse incoming transfers, so anyone could
// donate tokens straight into `pool_token` to skew that price. This is the
// classic first-depositor share-inflation attack.
//
// These tests exercise the fix:
//   - `liquidity_pool_account_size_...`: the account grew by exactly the
//     appended u64, verified against the real compiled size.
//   - `donation_attack_cannot_extract_value_from_the_pool`: the exact
//     4-step attack reproduced end to end -- it must no longer profit.
//   - `pool_total_assets_ledger_...`: across a full deposit/fill/settle/
//     fill/refund/withdraw lifecycle, the ledger tracks the physical
//     balance exactly, and a mid-lifecycle donation becomes permanently
//     inert dust (balance == ledger + donated) rather than corrupting any
//     later calculation.
//   - `donation_does_not_change_...`: a donation between two deposits must
//     not move the second depositor's share price at all.
// =====================================================================

#[test]
fn liquidity_pool_account_size_is_8_plus_init_space_after_appending_total_assets() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);

    // The real, compiled account size -- not just arithmetic -- is the
    // source of truth every off-chain decoder (app/lib/vsol-server.ts's
    // decodePoolAccount does an EXACT length check) must match precisely.
    let account = harness.get_account(&pool.pool);
    assert_eq!(
        account.data.len(),
        8 + <vsol::LiquidityPool as anchor_lang::Space>::INIT_SPACE
    );
    assert_eq!(account.data.len(), 266);
}

#[test]
fn donation_attack_cannot_extract_value_from_the_pool() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);

    let attacker = harness.funded_keypair();
    let attacker_position = provider_position_pda(&pool.pool, &attacker.pubkey());
    let attacker_source = harness.create_token_account(&attacker, &pool.settlement_mint, &attacker.pubkey());
    harness.mint_to(&pool.manager, &pool.settlement_mint, &pool.manager, &attacker_source, 10_000_000);

    // Step 1: attacker deposits 1 base unit -- the smallest possible first
    // deposit, for the cheapest possible first share.
    harness.send_ok(
        &attacker,
        &[deposit_liquidity_ix(
            &attacker.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &attacker_position,
            &attacker_source,
            1,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    let attacker_after_deposit: vsol::LiquidityProvider = harness.read_account(&attacker_position);
    assert_eq!(attacker_after_deposit.shares, 1);
    let pool_after_deposit: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(pool_after_deposit.total_assets, 1);

    // Step 2: attacker donates 1_000_000 directly into pool_token via a raw
    // SPL transfer -- never touching deposit_liquidity. Before the ledger
    // fix, this alone would make the *next* depositor's shares computed
    // against a balance of 1_000_001, not the true 1.
    harness.transfer_tokens(&attacker, &attacker_source, &pool.pool_token, 1_000_000);
    assert_eq!(harness.token_balance(&pool.pool_token), 1_000_001);
    let pool_after_donation: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(
        pool_after_donation.total_assets, 1,
        "the ledger must be completely untouched by a donation that bypasses deposit_liquidity"
    );

    // Step 3: victim deposits 2_000_000. Under the vulnerable code this
    // rounded down to 1 share (calculate_deposit_shares(2_000_000, 1,
    // 1_000_001)); with the fix it is computed against total_assets == 1,
    // never the donation-inflated raw balance.
    let victim = harness.funded_keypair();
    let victim_position = provider_position_pda(&pool.pool, &victim.pubkey());
    let victim_source = harness.create_token_account(&victim, &pool.settlement_mint, &victim.pubkey());
    harness.mint_to(&pool.manager, &pool.settlement_mint, &pool.manager, &victim_source, 2_000_000);
    harness.send_ok(
        &victim,
        &[deposit_liquidity_ix(
            &victim.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &victim_position,
            &victim_source,
            2_000_000,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    let victim_after_deposit: vsol::LiquidityProvider = harness.read_account(&victim_position);
    assert_eq!(
        victim_after_deposit.shares, 2_000_000,
        "the victim's shares must be computed against the ledger, not the donation-inflated balance"
    );

    // Step 4: attacker withdraws their 1 share. The vulnerable code paid out
    // 1_500_000 here (calculate_withdraw_amount(1, 2, 3_000_001)) -- a
    // +499_999 profit funded entirely by diluting the victim. The fix must
    // return only what the attacker actually put into the ledger: 1.
    let attacker_destination = harness.create_token_account(&attacker, &pool.settlement_mint, &attacker.pubkey());
    harness.send_ok(
        &attacker,
        &[withdraw_liquidity_ix(
            &attacker.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &attacker_position,
            &attacker_destination,
            1,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    let attacker_withdrawn = harness.token_balance(&attacker_destination);
    assert_eq!(
        attacker_withdrawn, 1,
        "attacker must not profit from a donation they made themselves, got {attacker_withdrawn}"
    );

    // The victim must not be diluted: withdrawing every share they hold
    // recovers their full deposit.
    let victim_destination = harness.create_token_account(&victim, &pool.settlement_mint, &victim.pubkey());
    harness.send_ok(
        &victim,
        &[withdraw_liquidity_ix(
            &victim.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &victim_position,
            &victim_destination,
            victim_after_deposit.shares,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    let victim_withdrawn = harness.token_balance(&victim_destination);
    assert_eq!(
        victim_withdrawn, 2_000_000,
        "victim must recover their full deposit, undiluted by the attacker's donation"
    );

    // The donation is now inert dust: physically present in pool_token
    // forever, but never counted by the ledger.
    let pool_final: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(pool_final.total_assets, 0);
    assert_eq!(harness.token_balance(&pool.pool_token), 1_000_000);
}

/// Asserts the ledger-vs-balance invariant that must hold whenever no
/// donation has (yet) landed in `pool_token`.
fn assert_pool_ledger_matches_balance(harness: &Harness, pool: &Pubkey, pool_token: &Pubkey, label: &str) {
    let state: vsol::LiquidityPool = harness.read_account(pool);
    assert_eq!(
        state.total_assets,
        harness.token_balance(pool_token),
        "ledger != token balance at: {label}"
    );
}

/// Asserts the weaker invariant that must hold once a donation of `donated`
/// has landed in `pool_token`: the physical balance forever runs exactly
/// `donated` ahead of the ledger, no matter what legitimate activity
/// happens around it.
fn assert_pool_ledger_offset_by(harness: &Harness, pool: &Pubkey, pool_token: &Pubkey, donated: u64, label: &str) {
    let state: vsol::LiquidityPool = harness.read_account(pool);
    assert_eq!(
        harness.token_balance(pool_token),
        state.total_assets + donated,
        "token balance != ledger + donated at: {label}"
    );
}

#[test]
fn pool_total_assets_ledger_matches_token_balance_across_a_full_lifecycle_and_survives_a_donation() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);

    // --- deposit, deposit ---
    let provider1 = harness.funded_keypair();
    let provider1_position = provider_position_pda(&pool.pool, &provider1.pubkey());
    let provider1_source = harness.create_token_account(&provider1, &pool.settlement_mint, &provider1.pubkey());
    harness.mint_to(&pool.manager, &pool.settlement_mint, &pool.manager, &provider1_source, 300 * ONE_TOKEN);
    harness.send_ok(
        &provider1,
        &[deposit_liquidity_ix(
            &provider1.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &provider1_position,
            &provider1_source,
            300 * ONE_TOKEN,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    assert_pool_ledger_matches_balance(&harness, &pool.pool, &pool.pool_token, "after first deposit");

    let provider2 = harness.funded_keypair();
    let provider2_position = provider_position_pda(&pool.pool, &provider2.pubkey());
    let provider2_source = harness.create_token_account(&provider2, &pool.settlement_mint, &provider2.pubkey());
    harness.mint_to(&pool.manager, &pool.settlement_mint, &pool.manager, &provider2_source, 200 * ONE_TOKEN);
    harness.send_ok(
        &provider2,
        &[deposit_liquidity_ix(
            &provider2.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &provider2_position,
            &provider2_source,
            200 * ONE_TOKEN,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    assert_pool_ledger_matches_balance(&harness, &pool.pool, &pool.pool_token, "after second deposit");

    // --- fill (position A) ---
    let market_settle = setup_market(&mut harness, &fixture, &pool.manager, pool.settlement_mint);
    let pool_market_settle = pool_market_pda(&pool.pool, &market_settle.market);
    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market_settle.market,
            &pool_market_settle,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market_settle.expiry - 30,
                enabled: true,
            },
        )],
        &[],
    );
    let buyer1 = harness.funded_keypair();
    let buyer1_source = harness.create_token_account(&buyer1, &market_settle.settlement_mint, &buyer1.pubkey());
    harness.mint_to(&pool.manager, &market_settle.settlement_mint, &pool.manager, &buyer1_source, 10 * ONE_TOKEN);
    let quote_a = default_pool_quote(1, harness.now() + 30);
    let nonce_record_a = pool_nonce_pda(&pool.pool, &pool.quote_authority.pubkey(), quote_a.nonce);
    let position_a = pool_position_pda(&nonce_record_a);
    let position_vault_a = pool_position_vault_pda(&position_a);
    let fill_a_accounts = FillPoolQuoteAccounts {
        buyer: buyer1.pubkey(),
        quote_authority: pool.quote_authority.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market_settle.market,
        pool_market: pool_market_settle,
        settlement_mint: market_settle.settlement_mint,
        pool_token: pool.pool_token,
        buyer_source: buyer1_source,
        nonce_record: nonce_record_a,
        position: position_a,
        position_vault: position_vault_a,
        eligibility: None,
    };
    harness.send_ok(
        &buyer1,
        &fill_pool_quote_ixs(&pool.quote_authority, &fill_a_accounts, &fixture.domain_separator, 1, quote_a),
        &[],
    );
    assert_pool_ledger_matches_balance(&harness, &pool.pool, &pool.pool_token, "after fill A");

    // --- settle (position A) ---
    harness.warp_to_timestamp(market_settle.expiry);
    finalize_oracle(&mut harness, &market_settle, 200 * ONE_TOKEN);
    let buyer1_destination = harness.create_token_account(&buyer1, &market_settle.settlement_mint, &buyer1.pubkey());
    let treasury_destination =
        harness.create_token_account(&pool.manager, &market_settle.settlement_mint, &fixture.treasury_owner);
    let settle_accounts = SettlePoolPositionAccounts {
        cranker: buyer1.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market_settle.market,
        oracle: market_settle.oracle,
        nonce_record: nonce_record_a,
        position: position_a,
        position_vault: position_vault_a,
        settlement_mint: market_settle.settlement_mint,
        buyer_destination: buyer1_destination,
        pool_token: pool.pool_token,
        treasury_destination,
        rent_recipient: buyer1.pubkey(),
    };
    harness.send_ok(&buyer1, &[settle_pool_position_ix(&settle_accounts)], &[]);
    assert_pool_ledger_matches_balance(&harness, &pool.pool, &pool.pool_token, "after settle A");

    // --- donation ---
    // An attacker donates directly into pool_token, bypassing
    // deposit_liquidity entirely. From here on the ledger and the raw token
    // balance must diverge by exactly this amount, forever (there is no
    // instruction that sweeps this dust) -- that is the whole point of
    // tracking a ledger instead of the raw balance.
    let donated = 777_777u64;
    let donor = harness.funded_keypair();
    let donor_source = harness.create_token_account(&donor, &pool.settlement_mint, &donor.pubkey());
    harness.mint_to(&pool.manager, &pool.settlement_mint, &pool.manager, &donor_source, donated);
    harness.transfer_tokens(&donor, &donor_source, &pool.pool_token, donated);
    assert_pool_ledger_offset_by(&harness, &pool.pool, &pool.pool_token, donated, "immediately after donation");

    // --- fill (position B) ---
    let market_refund = setup_market_variant(&mut harness, &fixture, &pool.manager, pool.settlement_mint, 0x22);
    let pool_market_refund = pool_market_pda(&pool.pool, &market_refund.market);
    harness.send_ok(
        &pool.manager,
        &[set_liquidity_pool_market_ix(
            &pool.manager.pubkey(),
            &fixture.config,
            &pool.pool,
            &market_refund.market,
            &pool_market_refund,
            vsol::SetLiquidityPoolMarketArgs {
                last_trade_at: market_refund.expiry - 30,
                enabled: true,
            },
        )],
        &[],
    );
    let buyer2 = harness.funded_keypair();
    let buyer2_source = harness.create_token_account(&buyer2, &market_refund.settlement_mint, &buyer2.pubkey());
    harness.mint_to(&pool.manager, &market_refund.settlement_mint, &pool.manager, &buyer2_source, 10 * ONE_TOKEN);
    let quote_b = default_pool_quote(2, harness.now() + 30);
    let nonce_record_b = pool_nonce_pda(&pool.pool, &pool.quote_authority.pubkey(), quote_b.nonce);
    let position_b = pool_position_pda(&nonce_record_b);
    let position_vault_b = pool_position_vault_pda(&position_b);
    let fill_b_accounts = FillPoolQuoteAccounts {
        buyer: buyer2.pubkey(),
        quote_authority: pool.quote_authority.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market_refund.market,
        pool_market: pool_market_refund,
        settlement_mint: market_refund.settlement_mint,
        pool_token: pool.pool_token,
        buyer_source: buyer2_source,
        nonce_record: nonce_record_b,
        position: position_b,
        position_vault: position_vault_b,
        eligibility: None,
    };
    harness.send_ok(
        &buyer2,
        &fill_pool_quote_ixs(&pool.quote_authority, &fill_b_accounts, &fixture.domain_separator, 1, quote_b),
        &[],
    );
    assert_pool_ledger_offset_by(&harness, &pool.pool, &pool.pool_token, donated, "after fill B");

    // --- refund (position B) ---
    let refund_deadline = market_refund.expiry
        + i64::from(market_refund.observation_window_seconds)
        + i64::from(market_refund.settlement_grace_seconds)
        + 1;
    harness.warp_to_timestamp(refund_deadline);
    let buyer2_destination = harness.create_token_account(&buyer2, &market_refund.settlement_mint, &buyer2.pubkey());
    let refund_accounts = RefundPoolPositionAccounts {
        cranker: buyer2.pubkey(),
        config: fixture.config,
        pool: pool.pool,
        market: market_refund.market,
        oracle: market_refund.oracle,
        nonce_record: nonce_record_b,
        position: position_b,
        position_vault: position_vault_b,
        settlement_mint: market_refund.settlement_mint,
        buyer_destination: buyer2_destination,
        pool_token: pool.pool_token,
        rent_recipient: buyer2.pubkey(),
    };
    harness.send_ok(&buyer2, &[refund_pool_position_ix(&refund_accounts)], &[]);
    assert_pool_ledger_offset_by(&harness, &pool.pool, &pool.pool_token, donated, "after refund B");

    // --- withdraw ---
    let pool_before_withdrawals: vsol::LiquidityPool = harness.read_account(&pool.pool);
    assert_eq!(pool_before_withdrawals.open_positions, 0);
    assert_eq!(pool_before_withdrawals.locked_collateral, 0);

    let provider1_state: vsol::LiquidityProvider = harness.read_account(&provider1_position);
    let provider1_destination = harness.create_token_account(&provider1, &pool.settlement_mint, &provider1.pubkey());
    harness.send_ok(
        &provider1,
        &[withdraw_liquidity_ix(
            &provider1.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &provider1_position,
            &provider1_destination,
            provider1_state.shares,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    assert_pool_ledger_offset_by(&harness, &pool.pool, &pool.pool_token, donated, "after first withdrawal");

    let provider2_state: vsol::LiquidityProvider = harness.read_account(&provider2_position);
    let provider2_destination = harness.create_token_account(&provider2, &pool.settlement_mint, &provider2.pubkey());
    harness.send_ok(
        &provider2,
        &[withdraw_liquidity_ix(
            &provider2.pubkey(),
            &fixture.config,
            &pool.settlement_mint,
            &pool.pool,
            &pool.pool_token,
            &provider2_position,
            &provider2_destination,
            provider2_state.shares,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    assert_pool_ledger_offset_by(&harness, &pool.pool, &pool.pool_token, donated, "after second withdrawal");
}

#[test]
fn donation_does_not_change_a_later_depositors_share_price() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);

    let first_deposit = 50 * ONE_TOKEN;
    let second_deposit = 30 * ONE_TOKEN;
    let donation = 1_000 * ONE_TOKEN;

    // Scenario A: no donation.
    let pool_a = setup_pool(&mut harness, &fixture);
    let depositor_a1 = harness.funded_keypair();
    let position_a1 = provider_position_pda(&pool_a.pool, &depositor_a1.pubkey());
    let source_a1 = harness.create_token_account(&depositor_a1, &pool_a.settlement_mint, &depositor_a1.pubkey());
    harness.mint_to(&pool_a.manager, &pool_a.settlement_mint, &pool_a.manager, &source_a1, first_deposit);
    harness.send_ok(
        &depositor_a1,
        &[deposit_liquidity_ix(
            &depositor_a1.pubkey(),
            &fixture.config,
            &pool_a.settlement_mint,
            &pool_a.pool,
            &pool_a.pool_token,
            &position_a1,
            &source_a1,
            first_deposit,
            0,
            harness.now() + 3600,
        )],
        &[],
    );

    let depositor_a2 = harness.funded_keypair();
    let position_a2 = provider_position_pda(&pool_a.pool, &depositor_a2.pubkey());
    let source_a2 = harness.create_token_account(&depositor_a2, &pool_a.settlement_mint, &depositor_a2.pubkey());
    harness.mint_to(&pool_a.manager, &pool_a.settlement_mint, &pool_a.manager, &source_a2, second_deposit);
    harness.send_ok(
        &depositor_a2,
        &[deposit_liquidity_ix(
            &depositor_a2.pubkey(),
            &fixture.config,
            &pool_a.settlement_mint,
            &pool_a.pool,
            &pool_a.pool_token,
            &position_a2,
            &source_a2,
            second_deposit,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    let shares_a2: vsol::LiquidityProvider = harness.read_account(&position_a2);

    // Scenario B: identical, except a large donation lands between the two
    // deposits.
    let pool_b = setup_pool(&mut harness, &fixture);
    let depositor_b1 = harness.funded_keypair();
    let position_b1 = provider_position_pda(&pool_b.pool, &depositor_b1.pubkey());
    let source_b1 = harness.create_token_account(&depositor_b1, &pool_b.settlement_mint, &depositor_b1.pubkey());
    harness.mint_to(&pool_b.manager, &pool_b.settlement_mint, &pool_b.manager, &source_b1, first_deposit + donation);
    harness.send_ok(
        &depositor_b1,
        &[deposit_liquidity_ix(
            &depositor_b1.pubkey(),
            &fixture.config,
            &pool_b.settlement_mint,
            &pool_b.pool,
            &pool_b.pool_token,
            &position_b1,
            &source_b1,
            first_deposit,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    // The donation: a raw SPL transfer from the first depositor's own
    // (already-funded) source account into pool_token, bypassing
    // deposit_liquidity entirely.
    harness.transfer_tokens(&depositor_b1, &source_b1, &pool_b.pool_token, donation);
    assert_eq!(harness.token_balance(&pool_b.pool_token), first_deposit + donation);

    let depositor_b2 = harness.funded_keypair();
    let position_b2 = provider_position_pda(&pool_b.pool, &depositor_b2.pubkey());
    let source_b2 = harness.create_token_account(&depositor_b2, &pool_b.settlement_mint, &depositor_b2.pubkey());
    harness.mint_to(&pool_b.manager, &pool_b.settlement_mint, &pool_b.manager, &source_b2, second_deposit);
    harness.send_ok(
        &depositor_b2,
        &[deposit_liquidity_ix(
            &depositor_b2.pubkey(),
            &fixture.config,
            &pool_b.settlement_mint,
            &pool_b.pool,
            &pool_b.pool_token,
            &position_b2,
            &source_b2,
            second_deposit,
            0,
            harness.now() + 3600,
        )],
        &[],
    );
    let shares_b2: vsol::LiquidityProvider = harness.read_account(&position_b2);

    assert_eq!(
        shares_a2.shares, shares_b2.shares,
        "a donation between the two deposits must not change the second depositor's share price"
    );
}

// =====================================================================
// close_pool_position: early exit for a pool-backed buyer, before expiry.
// The counterparty is the pool itself, and the pool's `quote_authority`
// signs a one-shot buyback quote exactly like it signs fills -- same
// Ed25519-precompile trust model, no new authority introduced.
// =====================================================================

/// An open pool position plus everything needed to close it early: the pool
/// and market it was opened against, the buyer who holds it, the exact quote
/// used to open it, and its derived PDAs.
struct OpenPoolPositionFixture {
    pool: PoolFixture,
    market: MarketFixture,
    buyer: Keypair,
    quote: vsol::PoolQuoteArgs,
    position: Pubkey,
    position_vault: Pubkey,
}

/// Stands up a pool, a market enabled for it, provider liquidity, and one
/// filled pool position (nonce `nonce`) against buyer-funded collateral --
/// the common precondition for every `close_pool_position` test below.
fn setup_open_pool_position(harness: &mut Harness, fixture: &ConfigFixture, nonce: u64) -> OpenPoolPositionFixture {
    let pool = setup_pool(harness, fixture);
    let market = setup_market(harness, fixture, &pool.manager, pool.settlement_mint);

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
    let quote = default_pool_quote(nonce, harness.now() + 30);
    let pool_nonce_record = pool_nonce_pda(&pool.pool, &pool.quote_authority.pubkey(), quote.nonce);
    let position = pool_position_pda(&pool_nonce_record);
    let position_vault = pool_position_vault_pda(&position);
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
        position,
        position_vault,
        eligibility: None,
    };
    let ixs = fill_pool_quote_ixs(&pool.quote_authority, &fill_accounts, &fixture.domain_separator, 1, quote);
    harness.send_ok(&buyer, &ixs, &[]);

    OpenPoolPositionFixture {
        pool,
        market,
        buyer,
        quote,
        position,
        position_vault,
    }
}

fn default_buyback_args(quote_expiry: i64, buyback_amount: u64, min_proceeds: u64) -> vsol::PoolBuybackArgs {
    vsol::PoolBuybackArgs {
        buyback_amount,
        min_proceeds,
        quote_expiry,
    }
}

fn close_accounts_for(
    fixture: &ConfigFixture,
    opened: &OpenPoolPositionFixture,
    buyer_destination: Pubkey,
    treasury_destination: Pubkey,
) -> ClosePoolPositionAccounts {
    ClosePoolPositionAccounts {
        buyer: opened.buyer.pubkey(),
        config: fixture.config,
        pool: opened.pool.pool,
        market: opened.market.market,
        oracle: opened.market.oracle,
        position: opened.position,
        position_vault: opened.position_vault,
        settlement_mint: opened.market.settlement_mint,
        buyer_destination,
        pool_token: opened.pool.pool_token,
        treasury_destination,
        rent_recipient: opened.buyer.pubkey(),
    }
}

#[test]
fn close_pool_position_happy_path_conserves_escrow_and_returns_rent() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);

    // fee_bps = 50 (0.5%) on a 1-token premium divides evenly: no rounding.
    let expected_fee = 5_000u64;
    let buyback_amount = 3_000_000u64;
    let expected_escrow = opened.quote.premium + opened.quote.max_payout;
    let expected_pool_amount = expected_escrow - buyback_amount - expected_fee;

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);
    let pool_token_balance_before = harness.token_balance(&opened.pool.pool_token);

    let close_accounts = close_accounts_for(&fixture, &opened, buyer_destination, treasury_destination);
    let args = default_buyback_args(harness.now() + 20, buyback_amount, 2_900_000);
    let ixs = close_pool_position_ixs(&opened.pool.quote_authority, &close_accounts, &fixture.domain_separator, 1, args);
    harness.send_ok(&opened.buyer, &ixs, &[]);

    // Buyer receives exactly `buyback_amount`.
    assert_eq!(harness.token_balance(&buyer_destination), buyback_amount);
    // Treasury receives exactly the fee.
    assert_eq!(harness.token_balance(&treasury_destination), expected_fee);
    // Pool vault receives exactly the residual.
    assert_eq!(
        harness.token_balance(&opened.pool.pool_token),
        pool_token_balance_before + expected_pool_amount
    );
    // Total token movement conserves max_payout + premium.
    assert_eq!(buyback_amount + expected_pool_amount + expected_fee, expected_escrow);

    // Pool accounting returns to zero exposure.
    let pool_after: vsol::LiquidityPool = harness.read_account(&opened.pool.pool);
    assert_eq!(pool_after.open_positions, 0);
    assert_eq!(pool_after.locked_collateral, 0);

    // Position and its vault are closed (rent returned, no longer live accounts).
    let position_account = harness.svm.get_account(&opened.position);
    assert_eq!(position_account.map(|a| a.lamports).unwrap_or(0), 0);
    let vault_account = harness.svm.get_account(&opened.position_vault);
    assert_eq!(vault_account.map(|a| a.lamports).unwrap_or(0), 0);
}

#[test]
fn close_pool_position_rejects_buyback_amount_above_max_payout() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);
    let close_accounts = close_accounts_for(&fixture, &opened, buyer_destination, treasury_destination);

    // One unit above `max_payout` -- the hard invariant must reject this
    // regardless of what the quote authority signed.
    let args = default_buyback_args(harness.now() + 20, opened.quote.max_payout + 1, 0);
    let ixs = close_pool_position_ixs(&opened.pool.quote_authority, &close_accounts, &fixture.domain_separator, 1, args);
    let failed = harness.send_err(&opened.buyer, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::BuybackExceedsMaxPayout);
}

#[test]
fn close_pool_position_rejects_signature_from_a_key_other_than_quote_authority() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);
    let impostor = harness.funded_keypair();

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);
    let close_accounts = close_accounts_for(&fixture, &opened, buyer_destination, treasury_destination);

    let args = default_buyback_args(harness.now() + 20, 3_000_000, 0);
    // Signed by an unrelated keypair, not the pool's `quote_authority`.
    let ixs = close_pool_position_ixs(&impostor, &close_accounts, &fixture.domain_separator, 1, args);
    let failed = harness.send_err(&opened.buyer, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidMakerSignature);
}

#[test]
fn close_pool_position_rejects_a_quote_signed_for_a_different_position() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);
    // A second, unrelated open position under the same pool/quote_authority.
    let other = setup_open_pool_position(&mut harness, &fixture, 2);

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);

    let args = default_buyback_args(harness.now() + 20, 3_000_000, 0);
    // The signed message binds `other.position`, not `opened.position`, but
    // the instruction accounts point at `opened`'s position/vault -- a
    // signature valid for one position must never apply to another.
    let message_context = quote_signing::PoolBuybackMessageContext {
        program_id: &vsol::ID,
        config: &fixture.config,
        pool: &opened.pool.pool,
        market: &opened.market.market,
        position: &other.position,
        buyer: &opened.buyer.pubkey(),
        quote_authority: &opened.pool.quote_authority.pubkey(),
    };
    let message = quote_signing::pool_buyback_message(&fixture.domain_separator, 1, &message_context, &args);
    let signature_ix = ed25519_ix_for(&opened.pool.quote_authority, &message);
    let close_ix = Instruction {
        program_id: vsol::ID,
        accounts: vec![
            AccountMeta::new_readonly(opened.buyer.pubkey(), true),
            AccountMeta::new_readonly(fixture.config, false),
            AccountMeta::new(opened.pool.pool, false),
            AccountMeta::new_readonly(opened.market.market, false),
            AccountMeta::new_readonly(opened.market.oracle, false),
            AccountMeta::new(opened.position, false),
            AccountMeta::new(opened.position_vault, false),
            AccountMeta::new_readonly(opened.market.settlement_mint, false),
            AccountMeta::new(buyer_destination, false),
            AccountMeta::new(opened.pool.pool_token, false),
            AccountMeta::new(treasury_destination, false),
            AccountMeta::new(opened.buyer.pubkey(), false),
            AccountMeta::new_readonly(instructions_sysvar_id(), false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vsol::instruction::ClosePoolPosition { args }.data(),
    };
    let failed = harness.send_err(&opened.buyer, &[signature_ix, close_ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidMakerSignature);
}

#[test]
fn close_pool_position_rejects_expired_quote() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);
    let close_accounts = close_accounts_for(&fixture, &opened, buyer_destination, treasury_destination);

    let quote_expiry = harness.now() + 10;
    let args = default_buyback_args(quote_expiry, 3_000_000, 0);
    let ixs = close_pool_position_ixs(&opened.pool.quote_authority, &close_accounts, &fixture.domain_separator, 1, args);

    harness.warp_to_timestamp(quote_expiry + 1);
    let failed = harness.send_err(&opened.buyer, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::QuoteExpired);
}

#[test]
fn close_pool_position_rejects_buyback_amount_below_min_proceeds() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);
    let close_accounts = close_accounts_for(&fixture, &opened, buyer_destination, treasury_destination);

    // min_proceeds above buyback_amount: the buyer's own slippage guard rejects it.
    let args = default_buyback_args(harness.now() + 20, 3_000_000, 3_000_001);
    let ixs = close_pool_position_ixs(&opened.pool.quote_authority, &close_accounts, &fixture.domain_separator, 1, args);
    let failed = harness.send_err(&opened.buyer, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::SlippageExceeded);
}

#[test]
fn close_pool_position_rejects_caller_who_is_not_the_buyer() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);
    let impostor = harness.funded_keypair();

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);
    // Accounts still reference the real position, but the transaction is
    // signed and submitted with `buyer` set to an impostor.
    let mut close_accounts = close_accounts_for(&fixture, &opened, buyer_destination, treasury_destination);
    close_accounts.buyer = impostor.pubkey();

    let args = default_buyback_args(harness.now() + 20, 3_000_000, 0);
    let ixs = close_pool_position_ixs(&opened.pool.quote_authority, &close_accounts, &fixture.domain_separator, 1, args);
    let failed = harness.send_err(&impostor, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);
}

#[test]
fn close_pool_position_rejects_after_market_expiry() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);
    let close_accounts = close_accounts_for(&fixture, &opened, buyer_destination, treasury_destination);

    let args = default_buyback_args(opened.market.expiry + 3_600, 3_000_000, 0);
    let ixs = close_pool_position_ixs(&opened.pool.quote_authority, &close_accounts, &fixture.domain_separator, 1, args);

    // Past expiry, the buyer's only path is `settle_pool_position`.
    harness.warp_to_timestamp(opened.market.expiry);
    let failed = harness.send_err(&opened.buyer, &ixs, &[]);
    assert_vsol_error(&failed, vsol::VsolError::MarketExpired);
}

#[test]
fn close_pool_position_succeeds_while_protocol_is_paused() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let opened = setup_open_pool_position(&mut harness, &fixture, 1);

    harness.send_ok(
        &fixture.pause_authority,
        &[set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, true)],
        &[],
    );
    assert!(read_config(&harness, &fixture.config).paused);

    let buyer_destination = harness.create_token_account(&opened.buyer, &opened.market.settlement_mint, &opened.buyer.pubkey());
    let treasury_destination =
        harness.create_token_account(&opened.pool.manager, &opened.market.settlement_mint, &fixture.treasury_owner);
    let close_accounts = close_accounts_for(&fixture, &opened, buyer_destination, treasury_destination);

    let args = default_buyback_args(harness.now() + 20, 3_000_000, 0);
    let ixs = close_pool_position_ixs(&opened.pool.quote_authority, &close_accounts, &fixture.domain_separator, 1, args);
    // Buyer exits must never be blocked by the guardian pause.
    harness.send_ok(&opened.buyer, &ixs, &[]);

    let pool_after: vsol::LiquidityPool = harness.read_account(&opened.pool.pool);
    assert_eq!(pool_after.open_positions, 0);
    assert_eq!(pool_after.locked_collateral, 0);
}

// =====================================================================
// publish_pyth_settlement: two-tier settlement.
//
// Tier 1 (unchanged): a fresh print inside [expiry, observation_end]
// settles exactly as before, and remains valid at any time afterward (there
// is no upper bound on `now` for tier 1 beyond the instruction's own hard
// close). Tier 2 (last-resort fallback -- FIXED, see `SETTLEMENT_REFUND_PRIORITY_SECONDS`
// and `MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO` in lib.rs): a last-known
// price at or before `expiry`, no staler than `max_settlement_staleness_seconds`,
// is accepted ONLY once `now` is past the FULL settlement deadline
// (`expiry + observation_window_seconds + settlement_grace_seconds`) PLUS a
// small additional tie-break buffer against `refund_unsettled` --
// `observation_end` alone (the pre-fix gate) is not enough: it made tier 2
// reachable moments after every single expiry rather than a genuine
// fallback for feeds that have gone dark overnight or on weekends, letting
// a settler cherry-pick any acceptable historical price for the entire
// `settlement_grace_seconds` window (and beyond). See
// `publish_pyth_settlement_rejects_tier_two_print_immediately_after_observation_window`
// below for the regression this fix closes.
// =====================================================================

const TIER_TEST_OBSERVATION_WINDOW: u32 = 30;
const TIER_TEST_SETTLEMENT_GRACE: u32 = 60;
const TIER_TEST_MAX_STALENESS: u32 = 3_600;
const TIER_TEST_FEED_SALT: u8 = 0x77;

/// A market with a short observation/grace window (so tests can warp past
/// `observation_end` quickly) and an explicit, moderate staleness bound.
fn setup_tier_test_market(
    harness: &mut Harness,
    fixture: &ConfigFixture,
    creator: &Keypair,
    settlement_mint: Pubkey,
) -> MarketFixture {
    setup_market_with_terms(
        harness,
        fixture,
        creator,
        settlement_mint,
        TIER_TEST_FEED_SALT,
        TIER_TEST_OBSERVATION_WINDOW,
        TIER_TEST_SETTLEMENT_GRACE,
        TIER_TEST_MAX_STALENESS,
    )
}

/// Plants a fake, fully-verified Pyth `PriceUpdateV2` account (see
/// `fake_full_pyth_price_update`) for `TIER_TEST_FEED_SALT`, priced at
/// exactly $100 (matching `default_quote`'s 100-token strike) so settlement
/// price equals strike and the payout math is trivial to assert on.
fn plant_price_update(harness: &mut Harness, publish_time: i64) -> Pubkey {
    let price_update = Pubkey::new_unique();
    let data = fake_full_pyth_price_update([TIER_TEST_FEED_SALT; 32], 100_000_000, 100, -6, publish_time);
    harness.set_raw_account(price_update, vsol::PYTH_RECEIVER_PROGRAM_ID, data);
    price_update
}

#[test]
fn publish_pyth_settlement_tier_one_settles_with_a_fresh_in_window_print() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_tier_test_market(&mut harness, &fixture, &creator, settlement_mint);

    let observation_end = market.expiry + i64::from(market.observation_window_seconds);
    let publish_time = market.expiry + 5;
    assert!(publish_time <= observation_end);
    let price_update = plant_price_update(&mut harness, publish_time);

    harness.warp_to_timestamp(publish_time + 1);
    let ix = publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &price_update);
    harness.send_ok(&creator, &[ix], &[]);

    let oracle: vsol::SettlementOracle = harness.read_account(&market.oracle);
    assert!(oracle.finalized);
    assert!(!oracle.settled_from_stale_price);
    assert_eq!(oracle.price, 100 * ONE_TOKEN);
    assert_eq!(oracle.observed_at, publish_time);
}

#[test]
fn publish_pyth_settlement_rejects_tier_two_price_before_observation_window_elapses() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_tier_test_market(&mut harness, &fixture, &creator, settlement_mint);

    // A pre-expiry print, comfortably within the staleness bound...
    let publish_time = market.expiry - 100;
    let price_update = plant_price_update(&mut harness, publish_time);

    // ...but `now` is still inside the primary observation window, so tier 2
    // must not be allowed to short-circuit it: a fresh post-expiry print
    // could still arrive before the window closes.
    let observation_end = market.expiry + i64::from(market.observation_window_seconds);
    let now = market.expiry + 10;
    assert!(now <= observation_end);
    harness.warp_to_timestamp(now);

    let ix = publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &price_update);
    let failed = harness.send_err(&creator, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidObservationTime);
}

/// THE regression that matters: reproduces the audit's exact scenario. At an
/// instant just past `observation_end` (the pre-fix tier-2 gate --
/// `now > observation_end`, without the fix in this commit), a stale
/// pre-expiry print must now be REJECTED, while a genuinely fresh tier-1
/// print published within [expiry, observation_end] is still accepted at
/// that exact same instant.
///
/// Pre-fix, the first assertion below fails: `now > observation_end` was
/// tier 2's entire gate, so with the SDK's real 30-second observation
/// window this is the steady state starting 30 seconds after every single
/// expiry, not a rare fallback -- the stale print would have settled
/// immediately. Gating tier 2 on the FULL settlement deadline (see
/// `SETTLEMENT_REFUND_PRIORITY_SECONDS`) closes that: the same stale print,
/// at the same instant, is now rejected, while a real print continues to
/// settle exactly as before -- gating tier 2 never takes anything away from
/// a settler who actually has a fresh print.
#[test]
fn publish_pyth_settlement_rejects_tier_two_print_immediately_after_observation_window() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_tier_test_market(&mut harness, &fixture, &creator, settlement_mint);

    let observation_end = market.expiry + i64::from(market.observation_window_seconds);
    let now = observation_end + 1;
    harness.warp_to_timestamp(now);

    // A stale, pre-expiry print, comfortably within the staleness bound --
    // exactly the kind of print the original vulnerability let a settler
    // cherry-pick moments after expiry.
    let stale_publish_time = market.expiry - 1_800;
    assert!(market.expiry - stale_publish_time <= i64::from(market.max_settlement_staleness_seconds));
    let stale_price_update = plant_price_update(&mut harness, stale_publish_time);
    let stale_ix =
        publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &stale_price_update);
    let failed = harness.send_err(&creator, &[stale_ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidObservationTime);

    // A fresh, in-window tier-1 print at the exact same instant settles
    // without any friction from this fix -- the oracle is still
    // unfinalized (the attempt above failed), so this is the same market.
    let fresh_publish_time = market.expiry + 5;
    assert!(fresh_publish_time <= observation_end && fresh_publish_time <= now);
    let fresh_price_update = plant_price_update(&mut harness, fresh_publish_time);
    let fresh_ix =
        publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &fresh_price_update);
    harness.send_ok(&creator, &[fresh_ix], &[]);

    let oracle: vsol::SettlementOracle = harness.read_account(&market.oracle);
    assert!(oracle.finalized);
    assert!(!oracle.settled_from_stale_price);
    assert_eq!(oracle.observed_at, fresh_publish_time);
}

#[test]
fn publish_pyth_settlement_tier_two_succeeds_after_window_elapses_and_pays_out() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let buyer = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_tier_test_market(&mut harness, &fixture, &maker, settlement_mint);

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
    harness.send_ok(&buyer, &ixs, &[]);

    // The only price ever available is a print from 30 minutes before
    // expiry -- comfortably inside the 1-hour staleness bound -- exactly
    // what happens when an equities feed goes dark overnight.
    let publish_time = market.expiry - 1_800;
    assert!(market.expiry - publish_time <= i64::from(market.max_settlement_staleness_seconds));
    let price_update = plant_price_update(&mut harness, publish_time);

    // Warp all the way past the FULL settlement deadline (expiry +
    // observation window + settlement grace) AND the additional
    // `SETTLEMENT_REFUND_PRIORITY_SECONDS` tie-break buffer against
    // `refund_unsettled` -- tier 2 is not reachable any earlier than this
    // (see `publish_pyth_settlement_rejects_tier_two_print_immediately_after_observation_window`
    // for the regression proving it is rejected before this instant).
    let observation_end = market.expiry + i64::from(market.observation_window_seconds);
    let settlement_deadline = observation_end + i64::from(market.settlement_grace_seconds);
    let tier_two_open_at = settlement_deadline + vsol::SETTLEMENT_REFUND_PRIORITY_SECONDS;
    let publish_now = tier_two_open_at + 1;
    assert!(publish_now <= settlement_deadline + i64::from(market.max_settlement_staleness_seconds));
    harness.warp_to_timestamp(publish_now);

    let publish_ix = publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &price_update);
    harness.send_ok(&buyer, &[publish_ix], &[]);

    let oracle: vsol::SettlementOracle = harness.read_account(&market.oracle);
    assert!(oracle.finalized);
    assert!(oracle.settled_from_stale_price);
    assert_eq!(oracle.price, 100 * ONE_TOKEN);
    assert_eq!(oracle.observed_at, publish_time);

    let buyer_destination = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    let maker_destination = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    let treasury_destination =
        harness.create_token_account(&maker, &market.settlement_mint, &fixture.treasury_owner);
    let settle_accounts = SettleAccounts {
        cranker: buyer.pubkey(),
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
    harness.send_ok(&buyer, &[settle_ix(&settle_accounts)], &[]);

    // `default_quote` is direction Up, strike 100 * ONE_TOKEN; the tier-2
    // price settles exactly at strike, so the buyer's payout is zero and
    // the maker keeps the full collateral plus premium (minus fee).
    assert_eq!(harness.token_balance(&buyer_destination), 0);
    assert!(harness.token_balance(&maker_destination) > 0);
}

#[test]
fn publish_pyth_settlement_rejects_pre_expiry_price_older_than_staleness_bound() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_tier_test_market(&mut harness, &fixture, &creator, settlement_mint);

    // One second older than `max_settlement_staleness_seconds` allows.
    let publish_time = market.expiry - i64::from(market.max_settlement_staleness_seconds) - 1;
    let price_update = plant_price_update(&mut harness, publish_time);

    // Warp to when tier 2 is actually open (past the full deadline AND the
    // `SETTLEMENT_REFUND_PRIORITY_SECONDS` tie-break buffer), so this test
    // isolates the staleness check itself -- rejection here can only be
    // about the print's age, not about tier 2 not having opened yet (that
    // case is covered separately by
    // `publish_pyth_settlement_rejects_tier_two_print_immediately_after_observation_window`).
    let observation_end = market.expiry + i64::from(market.observation_window_seconds);
    let settlement_deadline = observation_end + i64::from(market.settlement_grace_seconds);
    let tier_two_open_at = settlement_deadline + vsol::SETTLEMENT_REFUND_PRIORITY_SECONDS;
    harness.warp_to_timestamp(tier_two_open_at + 1);

    let ix = publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &price_update);
    let failed = harness.send_err(&creator, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidObservationTime);
}

/// Ties the staleness-bound rejection above to the existing timeout-refund
/// path: when even the tier-2 fallback has nothing acceptable to offer,
/// `refund_unsettled` remains the buyer and maker's recourse once the
/// settlement deadline fully elapses.
#[test]
fn refund_unsettled_still_works_when_no_acceptable_settlement_price_exists() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let buyer = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_tier_test_market(&mut harness, &fixture, &maker, settlement_mint);

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
    harness.send_ok(&buyer, &ixs, &[]);

    // A price too stale even for tier 2 is attempted first and rejected...
    let publish_time = market.expiry - i64::from(market.max_settlement_staleness_seconds) - 1;
    let price_update = plant_price_update(&mut harness, publish_time);
    let observation_end = market.expiry + i64::from(market.observation_window_seconds);
    let settlement_deadline = observation_end + i64::from(market.settlement_grace_seconds);
    harness.warp_to_timestamp(observation_end + 1);
    let publish_failed = harness.send_err(
        &buyer,
        &[publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &price_update)],
        &[],
    );
    assert_vsol_error(&publish_failed, vsol::VsolError::InvalidObservationTime);

    // ...so once the settlement deadline fully elapses, `refund_unsettled`
    // is the only remaining path, exactly as when no oracle print ever
    // arrives at all.
    harness.warp_to_timestamp(settlement_deadline + 1);
    let buyer_destination = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    let maker_destination = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    let refund_accounts = RefundUnsettledAccounts {
        cranker: buyer.pubkey(),
        market: market.market,
        oracle: market.oracle,
        nonce_record,
        position,
        position_vault,
        settlement_mint: market.settlement_mint,
        buyer_destination,
        maker_destination,
        rent_recipient: buyer.pubkey(),
    };
    harness.send_ok(&buyer, &[refund_unsettled_ix(&refund_accounts)], &[]);
    assert_eq!(harness.token_balance(&buyer_destination), quote.premium);
    assert_eq!(harness.token_balance(&maker_destination), quote.max_payout);
}

/// Pins the settle/refund race decision documented on
/// `SETTLEMENT_REFUND_PRIORITY_SECONDS`: `refund_unsettled` opens exactly AT
/// the full settlement deadline (unchanged), while tier 2 does not open
/// until `SETTLEMENT_REFUND_PRIORITY_SECONDS` after that same deadline --
/// refund deliberately wins the tie. This is not a "nothing is available"
/// scenario: a perfectly valid tier-2 print exists the entire time, and
/// `publish_pyth_settlement` still rejects it at the instant refund already
/// succeeds.
#[test]
fn refund_unsettled_wins_the_tie_against_tier_two_at_the_settlement_deadline() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let maker = harness.funded_keypair();
    let buyer = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&maker, &maker.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_tier_test_market(&mut harness, &fixture, &maker, settlement_mint);

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
    harness.send_ok(&buyer, &ixs, &[]);

    // A perfectly valid tier-2 print -- well within the staleness bound --
    // is available the entire time. If tier 2 opened at the same instant as
    // refund (the pre-tiebreak behavior), this settlement could race the
    // refund below on identical timing.
    let publish_time = market.expiry - 1_800;
    assert!(market.expiry - publish_time <= i64::from(market.max_settlement_staleness_seconds));
    let price_update = plant_price_update(&mut harness, publish_time);

    let observation_end = market.expiry + i64::from(market.observation_window_seconds);
    let settlement_deadline = observation_end + i64::from(market.settlement_grace_seconds);
    let tier_two_open_at = settlement_deadline + vsol::SETTLEMENT_REFUND_PRIORITY_SECONDS;
    assert!(settlement_deadline < tier_two_open_at);

    // Land exactly where refund_unsettled is callable but tier 2 is not.
    harness.warp_to_timestamp(settlement_deadline + 1);

    // Tier 2 is still gated: the same, otherwise-perfectly-valid print is
    // rejected here.
    let publish_ix = publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &price_update);
    let publish_failed = harness.send_err(&buyer, &[publish_ix], &[]);
    assert_vsol_error(&publish_failed, vsol::VsolError::InvalidObservationTime);

    // Refund succeeds at this exact instant: refund wins the tie.
    let buyer_destination = harness.create_token_account(&buyer, &market.settlement_mint, &buyer.pubkey());
    let maker_destination = harness.create_token_account(&maker, &market.settlement_mint, &maker.pubkey());
    let refund_accounts = RefundUnsettledAccounts {
        cranker: buyer.pubkey(),
        market: market.market,
        oracle: market.oracle,
        nonce_record,
        position,
        position_vault,
        settlement_mint: market.settlement_mint,
        buyer_destination,
        maker_destination,
        rent_recipient: buyer.pubkey(),
    };
    harness.send_ok(&buyer, &[refund_unsettled_ix(&refund_accounts)], &[]);
    assert_eq!(harness.token_balance(&buyer_destination), quote.premium);
    assert_eq!(harness.token_balance(&maker_destination), quote.max_payout);

    // The refunded position is gone, but the market-wide oracle is
    // untouched by that refund -- once tier 2's own gate opens, the same
    // print can still finalize the oracle for the market as a whole (e.g.
    // for other positions that did not race to refund). Refund winning the
    // tie for one position never permanently disables tier 2 for the
    // market.
    harness.warp_to_timestamp(tier_two_open_at + 1);
    let late_publish_ix = publish_pyth_settlement_ix(&fixture.config, &market.market, &market.oracle, &price_update);
    harness.send_ok(&buyer, &[late_publish_ix], &[]);
    let oracle: vsol::SettlementOracle = harness.read_account(&market.oracle);
    assert!(oracle.finalized);
    assert!(oracle.settled_from_stale_price);
}

// =====================================================================
// create_market: cross-parameter bound on `max_settlement_staleness_seconds`
// relative to `observation_window_seconds + settlement_grace_seconds`. See
// `MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO` in lib.rs.
// =====================================================================

#[allow(clippy::too_many_arguments)]
fn create_market_args_with_terms(
    settlement_mint: Pubkey,
    expiry: i64,
    feed_salt: u8,
    observation_window_seconds: u32,
    settlement_grace_seconds: u32,
    max_settlement_staleness_seconds: u32,
) -> vsol::CreateMarketArgs {
    let mut args = vsol::CreateMarketArgs {
        market_id: [0u8; 32],
        underlying_mint: Pubkey::new_unique(),
        symbol: symbol_bytes("NVDA"),
        price_scale: 1_000_000,
        expiry,
        observation_window_seconds,
        settlement_grace_seconds,
        max_confidence_bps: 100,
        pyth_feed_id: [feed_salt; 32],
        max_settlement_staleness_seconds,
        strike: DEFAULT_STRIKE,
    };
    args.market_id = expected_market_id(&args, settlement_mint);
    args
}

/// The audit's exact pathological example: a tiny observation window and
/// grace period (so the full settlement deadline arrives almost
/// immediately) paired with the maximum legal absolute staleness allowance.
/// Before this bound existed, this market would open tier 2 with a full
/// week of historical prices to choose from roughly a minute after expiry
/// -- the amplifier on top of the timing fix (see
/// `MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO`'s doc comment).
#[test]
fn create_market_rejects_disproportionate_settlement_staleness() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);

    let expiry = harness.now() + MARKET_LEAD_SECONDS + 3600;
    let args = create_market_args_with_terms(settlement_mint, expiry, 0x51, 1, 1, 604_800);
    let market = market_pda(&fixture.config, &args.market_id);
    let oracle = oracle_pda(&market);
    let ix = create_market_ix(&creator.pubkey(), &fixture.config, &market, &oracle, &settlement_mint, args);
    let failed = harness.send_err(&creator, &[ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidSettlementStaleness);
}

/// The real configuration this program ships with (30s observation window,
/// 900s grace, 86_400s staleness -- ratio ~93) must remain legal under the
/// new bound.
#[test]
fn create_market_accepts_the_sdk_configured_staleness_ratio() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);

    let expiry = harness.now() + MARKET_LEAD_SECONDS + 3600;
    let args = create_market_args_with_terms(
        settlement_mint,
        expiry,
        0x52,
        OBSERVATION_WINDOW,
        SETTLEMENT_GRACE,
        MAX_SETTLEMENT_STALENESS,
    );
    let market = market_pda(&fixture.config, &args.market_id);
    let oracle = oracle_pda(&market);
    let ix = create_market_ix(&creator.pubkey(), &fixture.config, &market, &oracle, &settlement_mint, args);
    harness.send_ok(&creator, &[ix], &[]);

    let market_account: vsol::Market = harness.read_account(&market);
    assert_eq!(
        market_account.max_settlement_staleness_seconds,
        MAX_SETTLEMENT_STALENESS
    );
}

/// Exercises the exact boundary of the 100x ratio: `window(10) + grace(10) =
/// 20`, so `2_000` is the last legal staleness value and `2_001` is the
/// first illegal one.
#[test]
fn create_market_ratio_bound_is_exact_at_its_boundary() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let expiry = harness.now() + MARKET_LEAD_SECONDS + 3600;

    let ok_args = create_market_args_with_terms(settlement_mint, expiry, 0x53, 10, 10, 2_000);
    let ok_market = market_pda(&fixture.config, &ok_args.market_id);
    let ok_oracle = oracle_pda(&ok_market);
    let ok_ix =
        create_market_ix(&creator.pubkey(), &fixture.config, &ok_market, &ok_oracle, &settlement_mint, ok_args);
    harness.send_ok(&creator, &[ok_ix], &[]);

    let bad_args = create_market_args_with_terms(settlement_mint, expiry, 0x54, 10, 10, 2_001);
    let bad_market = market_pda(&fixture.config, &bad_args.market_id);
    let bad_oracle = oracle_pda(&bad_market);
    let bad_ix =
        create_market_ix(&creator.pubkey(), &fixture.config, &bad_market, &bad_oracle, &settlement_mint, bad_args);
    let failed = harness.send_err(&creator, &[bad_ix], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidSettlementStaleness);
}

// =====================================================================
// close_settled_market
// =====================================================================

/// The exact deadline `refund_unsettled`/`refund_pool_position` require `now`
/// to be strictly greater than: the entire two-tier settlement window, counted
/// from `expiry`. This is when a stranded position first becomes refundable.
fn full_settlement_deadline(market: &MarketFixture) -> i64 {
    market.expiry
        + i64::from(market.observation_window_seconds)
        + i64::from(market.settlement_grace_seconds)
}

/// The deadline `close_settled_market` requires: the settlement deadline plus
/// `MARKET_CLEANUP_BUFFER_SECONDS`. Deliberately LATER than
/// `full_settlement_deadline` so cleanup can never race an in-flight refund —
/// see `close_settled_market_cannot_close_at_the_refund_deadline`.
fn market_cleanup_deadline(market: &MarketFixture) -> i64 {
    full_settlement_deadline(market) + vsol::MARKET_CLEANUP_BUFFER_SECONDS
}

/// Mirrors the on-chain `final_settlement_deadline` (lib.rs) byte-for-byte:
/// `full_settlement_deadline` plus `max_settlement_staleness_seconds`. This
/// is the exact instant `publish_pyth_settlement` can no longer ever succeed
/// again, and therefore the exact instant `redeem_unresolved`'s escape hatch
/// opens (`now > final_settlement_deadline`) -- see that instruction's doc
/// comment for why the two are deliberately the same boundary.
fn final_settlement_deadline(market: &MarketFixture) -> i64 {
    full_settlement_deadline(market) + i64::from(market.max_settlement_staleness_seconds)
}

#[test]
fn close_settled_market_closes_market_and_oracle_and_returns_rent_to_creator() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();

    // Stand up a pool authorization for this market and then disable it, so
    // this test exercises the "pool_market passed and disabled" branch, not
    // just the "no pool ever involved" branch. `set_liquidity_pool_market`
    // requires the pool and market to share a settlement mint, so the
    // market is created under the pool's own mint.
    let pool = setup_pool(&mut harness, &fixture);
    let market = setup_market(&mut harness, &fixture, &creator, pool.settlement_mint);
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
                enabled: false,
            },
        )],
        &[],
    );

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    let creator_lamports_before = harness.get_account(&creator.pubkey()).lamports;
    let market_lamports = harness.get_account(&market.market).lamports;
    let oracle_lamports = harness.get_account(&market.oracle).lamports;

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: Some(pool.pool),
        pool_market: Some(pool_market),
        rent_recipient: creator.pubkey(),
    };
    harness.send_ok(&creator, &[close_settled_market_ix(&close_accounts)], &[]);

    // Both accounts are gone (zero lamports / no longer live).
    assert_eq!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0), 0);
    assert_eq!(harness.svm.get_account(&market.oracle).map(|a| a.lamports).unwrap_or(0), 0);

    // The creator received exactly both accounts' rent (minus the tx fee,
    // which `send_ok` already paid from this same account as the payer --
    // so just assert the balance grew, rather than pin an exact fee-adjusted
    // amount).
    let creator_lamports_after = harness.get_account(&creator.pubkey()).lamports;
    assert!(creator_lamports_after > creator_lamports_before);
    assert!(creator_lamports_after >= creator_lamports_before + market_lamports + oracle_lamports - 10_000);
}

#[test]
fn close_settled_market_succeeds_with_no_pool_ever_authorized() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    harness.send_ok(&creator, &[close_settled_market_ix(&close_accounts)], &[]);

    assert_eq!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0), 0);
    assert_eq!(harness.svm.get_account(&market.oracle).map(|a| a.lamports).unwrap_or(0), 0);
}

#[test]
fn close_settled_market_rejects_before_settlement_window_fully_elapses() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    // Exactly at the deadline is still "not yet fully elapsed": the
    // instruction requires `now > deadline`, strictly.
    harness.warp_to_timestamp(full_settlement_deadline(&market));

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    let failed = harness.send_err(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::MarketNotCloseable);

    // Nothing was closed.
    assert!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0) > 0);
    assert!(harness.svm.get_account(&market.oracle).map(|a| a.lamports).unwrap_or(0) > 0);
}

/// REGRESSION: `close_settled_market` used to share the settlement deadline
/// exactly, with no buffer — the same instant `refund_unsettled` first becomes
/// callable. An automated cleaner (scripts/cranker.ts) racing a late-but-valid
/// refund could therefore close the market first and strand that position's
/// escrowed `premium + max_payout` forever, with no attacker and no bug in
/// either caller.
///
/// This test pins the buffer: for the entire week between the refund deadline
/// and the cleanup deadline, closing is refused. Against the pre-fix contract
/// the first `send_err` below would have SUCCEEDED, so this fails loudly if
/// the buffer is ever removed or reduced to zero.
#[test]
fn close_settled_market_cannot_close_at_the_refund_deadline() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };

    // The instant a stranded position first becomes refundable. Pre-fix this
    // was ALSO the instant the market became closeable — the race.
    harness.warp_to_timestamp(full_settlement_deadline(&market) + 1);
    let failed = harness.send_err(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::MarketNotCloseable);

    // Still refused one second before the cleanup deadline elapses.
    harness.warp_to_timestamp(market_cleanup_deadline(&market));
    let failed = harness.send_err(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::MarketNotCloseable);

    // The market and oracle survived the whole refund window, so any position
    // stranded by an over-eager cleaner stayed recoverable throughout.
    assert!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0) > 0);
    assert!(harness.svm.get_account(&market.oracle).map(|a| a.lamports).unwrap_or(0) > 0);

    // Past the buffer, cleanup proceeds as before.
    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);
    harness.send_ok(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0) == 0);
}

#[test]
fn close_settled_market_rejects_while_pool_market_still_enabled() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let pool = setup_pool(&mut harness, &fixture);
    let creator = harness.funded_keypair();
    let market = setup_market(&mut harness, &fixture, &creator, pool.settlement_mint);

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

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: Some(pool.pool),
        pool_market: Some(pool_market),
        rent_recipient: creator.pubkey(),
    };
    let failed = harness.send_err(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::MarketNotCloseable);
}

#[test]
fn close_settled_market_rejects_signer_that_is_neither_creator_nor_admin() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let impostor = harness.funded_keypair();

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    let close_accounts = CloseSettledMarketAccounts {
        authority: impostor.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    let failed = harness.send_err(&impostor, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::Unauthorized);
}

#[test]
fn close_settled_market_allows_admin_as_well_as_creator() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    // The admin did not create this market, but is still permitted to close
    // it; rent still returns to the market's own creator, not the admin.
    let close_accounts = CloseSettledMarketAccounts {
        authority: fixture.admin.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    harness.send_ok(&fixture.admin, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_eq!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0), 0);
}

#[test]
fn close_settled_market_rejects_rent_recipient_other_than_creator() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let outsider = harness.funded_keypair();

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: None,
        pool_market: None,
        rent_recipient: outsider.pubkey(),
    };
    let failed = harness.send_err(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    // `rent_recipient` is address-constrained to `market.creator` by Anchor's
    // own `address = market.creator` check, not a custom `VsolError` variant.
    assert_eq!(
        anchor_error_code(&failed),
        u32::from(anchor_lang::error::ErrorCode::ConstraintAddress)
    );
}

#[test]
fn close_settled_market_is_maintenance_and_succeeds_while_protocol_paused() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);
    harness.send_ok(
        &fixture.pause_authority,
        &[set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, true)],
        &[],
    );
    let config_after_pause = read_config(&harness, &fixture.config);
    assert!(config_after_pause.paused);

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: complete_set_vault_pda(&market.market),
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    // Cleanup is maintenance, not trading: it must work even while paused.
    harness.send_ok(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_eq!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0), 0);
}

/// Verifies the reinit-after-close property the rolling grid's safety
/// depends on: if a *future* grid rung ever happened to hash to the exact
/// same `market_id` as a market that was previously closed via
/// `close_settled_market`, `create_market`'s `init` must still succeed at
/// that now-empty PDA rather than refusing to reinitialize it.
///
/// This test has to reconcile two constraints that are normally in tension:
/// `close_settled_market` only succeeds once `now` is well *past* `expiry`
/// (the full settlement window has elapsed), while `create_market` only
/// succeeds while `expiry` is still *in the future* relative to `now`. Since
/// `market_id` is a hash that includes `expiry` itself, reproducing the
/// identical `market_id` inherently means reproducing the identical
/// `expiry` -- so the only way to legitimately observe both instructions
/// succeed against that same `expiry` is to move the clock back down below
/// it in between, which `warp_to_timestamp` allows (it is a plain sysvar
/// overwrite in this in-process harness, not a real ledger). This isolates
/// the mechanical question this test exists to answer -- can Anchor's
/// `init` reinitialize a previously-`close`d account? -- from the unrelated,
/// separately-argued fact (see the test below and the report this task
/// produced) that under a real, forward-only clock this exact scenario can
/// never actually arise.
#[test]
fn closed_market_pda_can_be_reinitialized_by_create_market() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);

    let creation_time = harness.now();
    let mut args = vsol::CreateMarketArgs {
        market_id: [0u8; 32],
        underlying_mint: Pubkey::new_unique(),
        symbol: symbol_bytes("NVDA"),
        price_scale: 1_000_000,
        expiry: creation_time + MARKET_LEAD_SECONDS + 3_600,
        observation_window_seconds: OBSERVATION_WINDOW,
        settlement_grace_seconds: SETTLEMENT_GRACE,
        max_confidence_bps: 100,
        pyth_feed_id: [0x77u8; 32],
        max_settlement_staleness_seconds: MAX_SETTLEMENT_STALENESS,
        strike: DEFAULT_STRIKE,
    };
    args.market_id = expected_market_id(&args, settlement_mint);
    let market = market_pda(&fixture.config, &args.market_id);
    let oracle = oracle_pda(&market);

    let create_ix = || create_market_ix(&creator.pubkey(), &fixture.config, &market, &oracle, &settlement_mint, args);
    harness.send_ok(&creator, &[create_ix()], &[]);

    // Closing also requires MARKET_CLEANUP_BUFFER_SECONDS past the settlement
    // deadline (see close_settled_market_cannot_close_at_the_refund_deadline).
    let deadline = args.expiry
        + i64::from(args.observation_window_seconds)
        + i64::from(args.settlement_grace_seconds)
        + vsol::MARKET_CLEANUP_BUFFER_SECONDS;
    harness.warp_to_timestamp(deadline + 1);
    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market,
        oracle,
        collateral_vault: complete_set_vault_pda(&market),
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    harness.send_ok(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_eq!(harness.svm.get_account(&market).map(|a| a.lamports).unwrap_or(0), 0);
    assert_eq!(harness.svm.get_account(&oracle).map(|a| a.lamports).unwrap_or(0), 0);

    // Rewind the clock so the identical `args` (same `market_id`, hence the
    // same PDA) are valid for `create_market` again -- see the doc comment
    // above for why this step is necessary to isolate the mechanic under
    // test.
    harness.warp_to_timestamp(creation_time);
    harness.send_ok(&creator, &[create_ix()], &[]);

    let recreated_market: vsol::Market = harness.read_account(&market);
    assert!(recreated_market.enabled);
    assert_eq!(recreated_market.creator, creator.pubkey());
    assert_eq!(recreated_market.expiry, args.expiry);
    let recreated_oracle: vsol::SettlementOracle = harness.read_account(&oracle);
    assert!(!recreated_oracle.finalized);
    assert_eq!(recreated_oracle.price, 0);
}

/// FINDING 1 regression: `close_settled_market` used to close the `Market`
/// account with no regard at all for the conditional-token collateral vault.
/// `burn_complete_set`/`redeem_winning` both load `market: Box<Account<'info,
/// Market>>`, so once the market is gone neither can ever execute again --
/// any balance still in the vault at that point is permanently stranded.
/// This test pins the fix: closing is refused, loudly, while the vault still
/// holds collateral, even though every other close precondition (the
/// deadline, the pool authorization) is satisfied.
#[test]
fn close_settled_market_blocked_while_vault_has_outstanding_collateral() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let vault = complete_set_vault_pda(&market.market);

    let minter = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&minter.keypair, &[mint_complete_set_ix_for(&fixture, &market, &minter, 100 * ONE_TOKEN)], &[]);
    assert_eq!(harness.token_balance(&vault), 100 * ONE_TOKEN);

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: vault,
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    let failed = harness.send_err(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::MarketHasOutstandingCollateral);

    // Nothing was closed -- the market, oracle, and vault all survive.
    assert!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0) > 0);
    assert_eq!(harness.token_balance(&vault), 100 * ONE_TOKEN);
}

/// The mirror image: once the vault is fully drained (via any mix of
/// `burn_complete_set`/`redeem_winning`), `close_settled_market` succeeds.
#[test]
fn close_settled_market_succeeds_once_the_vault_is_drained() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let vault = complete_set_vault_pda(&market.market);

    let minter = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&minter.keypair, &[mint_complete_set_ix_for(&fixture, &market, &minter, 100 * ONE_TOKEN)], &[]);
    harness.send_ok(
        &minter.keypair,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            minter.keypair.pubkey(),
            minter.up_token,
            minter.down_token,
            minter.destination,
            100 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&vault), 0);

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: vault,
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    harness.send_ok(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_eq!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0), 0);
}

/// A market nobody ever called `mint_complete_set` against: the vault PDA
/// was never created, so `collateral_vault.data_is_empty()` is true and the
/// handler treats that as "nothing was ever minted here, nothing to check" --
/// closing proceeds exactly as it did before this fix existed.
#[test]
fn close_settled_market_succeeds_for_a_market_that_never_minted_a_complete_set() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let vault = complete_set_vault_pda(&market.market);
    assert!(harness.svm.get_account(&vault).is_none(), "the vault PDA must not exist yet");

    harness.warp_to_timestamp(market_cleanup_deadline(&market) + 1);

    let close_accounts = CloseSettledMarketAccounts {
        authority: creator.pubkey(),
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        collateral_vault: vault,
        pool: None,
        pool_market: None,
        rent_recipient: creator.pubkey(),
    };
    harness.send_ok(&creator, &[close_settled_market_ix(&close_accounts)], &[]);
    assert_eq!(harness.svm.get_account(&market.market).map(|a| a.lamports).unwrap_or(0), 0);
}

// =====================================================================
// Conditional tokens ("complete sets"): mint_complete_set /
// burn_complete_set / redeem_winning
// =====================================================================

/// A participant who calls `mint_complete_set` themselves: a settlement-
/// token source/destination (pre-created and pre-funded like every other
/// `*_source` in this file) plus the deterministic `COMPLETE_SET_TOKEN_SEED`
/// PDAs `mint_complete_set` auto-creates on their first call -- see that
/// constant's doc comment in src/lib.rs for why a *minter's own* UP/DOWN
/// accounts must be seeded rather than a plain caller-supplied account (a
/// bootstrap problem `burn_complete_set`/`redeem_winning` do not share,
/// since burning/redeeming requires already holding a balance somewhere;
/// several tests below deliberately use plain, non-seeded accounts for those
/// two instead, to prove that flexibility).
struct CompleteSetMinter {
    keypair: Keypair,
    source: Pubkey,
    destination: Pubkey,
    up_token: Pubkey,
    down_token: Pubkey,
}

fn setup_complete_set_minter(
    harness: &mut Harness,
    market: &MarketFixture,
    mint_authority: &Keypair,
    funding: u64,
) -> CompleteSetMinter {
    let keypair = harness.funded_keypair();
    let source = harness.create_token_account(&keypair, &market.settlement_mint, &keypair.pubkey());
    if funding > 0 {
        harness.mint_to(mint_authority, &market.settlement_mint, mint_authority, &source, funding);
    }
    let destination = harness.create_token_account(&keypair, &market.settlement_mint, &keypair.pubkey());
    let owner = keypair.pubkey();
    let up_mint = up_mint_pda(&market.market);
    let down_mint = down_mint_pda(&market.market);
    CompleteSetMinter {
        keypair,
        source,
        destination,
        up_token: complete_set_token_pda(&up_mint, &owner),
        down_token: complete_set_token_pda(&down_mint, &owner),
    }
}

fn mint_complete_set_ix_for(
    fixture: &ConfigFixture,
    market: &MarketFixture,
    minter: &CompleteSetMinter,
    amount: u64,
) -> Instruction {
    let accounts = MintCompleteSetAccounts {
        minter: minter.keypair.pubkey(),
        config: fixture.config,
        market: market.market,
        settlement_mint: market.settlement_mint,
        up_mint: up_mint_pda(&market.market),
        down_mint: down_mint_pda(&market.market),
        collateral_vault: complete_set_vault_pda(&market.market),
        minter_source: minter.source,
        minter_up_token: minter.up_token,
        minter_down_token: minter.down_token,
    };
    mint_complete_set_ix(&accounts, amount)
}

#[allow(clippy::too_many_arguments)]
fn burn_complete_set_ix_for(
    fixture: &ConfigFixture,
    market: &MarketFixture,
    burner: Pubkey,
    up_token: Pubkey,
    down_token: Pubkey,
    destination: Pubkey,
    amount: u64,
) -> Instruction {
    let accounts = BurnCompleteSetAccounts {
        burner,
        config: fixture.config,
        market: market.market,
        settlement_mint: market.settlement_mint,
        up_mint: up_mint_pda(&market.market),
        down_mint: down_mint_pda(&market.market),
        collateral_vault: complete_set_vault_pda(&market.market),
        burner_up_token: up_token,
        burner_down_token: down_token,
        burner_destination: destination,
    };
    burn_complete_set_ix(&accounts, amount)
}

fn redeem_winning_ix_for(
    fixture: &ConfigFixture,
    market: &MarketFixture,
    redeemer: Pubkey,
    redeemer_token: Pubkey,
    destination: Pubkey,
    amount: u64,
) -> Instruction {
    let accounts = RedeemWinningAccounts {
        redeemer,
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        settlement_mint: market.settlement_mint,
        up_mint: up_mint_pda(&market.market),
        down_mint: down_mint_pda(&market.market),
        collateral_vault: complete_set_vault_pda(&market.market),
        redeemer_token,
        redeemer_destination: destination,
    };
    redeem_winning_ix(&accounts, amount)
}

fn redeem_unresolved_ix_for(
    fixture: &ConfigFixture,
    market: &MarketFixture,
    redeemer: Pubkey,
    redeemer_token: Pubkey,
    destination: Pubkey,
    amount: u64,
) -> Instruction {
    let accounts = RedeemUnresolvedAccounts {
        redeemer,
        config: fixture.config,
        market: market.market,
        oracle: market.oracle,
        settlement_mint: market.settlement_mint,
        up_mint: up_mint_pda(&market.market),
        down_mint: down_mint_pda(&market.market),
        collateral_vault: complete_set_vault_pda(&market.market),
        redeemer_token,
        redeemer_destination: destination,
    };
    redeem_unresolved_ix(&accounts, amount)
}

#[test]
fn mint_complete_set_creates_matching_up_and_down_supply_backed_by_the_vault() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let up_mint = up_mint_pda(&market.market);
    let down_mint = down_mint_pda(&market.market);
    let vault = complete_set_vault_pda(&market.market);

    let minter = setup_complete_set_minter(&mut harness, &market, &creator, 1_000 * ONE_TOKEN);
    harness.send_ok(&minter.keypair, &[mint_complete_set_ix_for(&fixture, &market, &minter, 100 * ONE_TOKEN)], &[]);

    assert_eq!(harness.token_balance(&vault), 100 * ONE_TOKEN);
    assert_eq!(harness.mint_supply(&up_mint), 100 * ONE_TOKEN);
    assert_eq!(harness.mint_supply(&down_mint), 100 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&minter.up_token), 100 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&minter.down_token), 100 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&minter.source), 900 * ONE_TOKEN);

    // A second mint from a DIFFERENT minter adds to (rather than
    // reinitializes) the same up/down mints and vault -- `init_if_needed`
    // must be idempotent across every caller, not just repeat calls by one.
    let second_minter = setup_complete_set_minter(&mut harness, &market, &creator, 1_000 * ONE_TOKEN);
    harness.send_ok(
        &second_minter.keypair,
        &[mint_complete_set_ix_for(&fixture, &market, &second_minter, 25 * ONE_TOKEN)],
        &[],
    );
    assert_eq!(harness.token_balance(&vault), 125 * ONE_TOKEN);
    assert_eq!(harness.mint_supply(&up_mint), 125 * ONE_TOKEN);
    assert_eq!(harness.mint_supply(&down_mint), 125 * ONE_TOKEN);
}

#[test]
fn mint_complete_set_rejects_zero_amount() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let minter = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);

    let failed = harness.send_err(&minter.keypair, &[mint_complete_set_ix_for(&fixture, &market, &minter, 0)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::InvalidAmount);
}

/// `mint_complete_set` creates new exposure, exactly like `fill_quote`/
/// `fill_pool_quote` -- so it must respect the same per-market admin kill
/// switch those two already do (`set_market_enabled`), not just the global
/// pause. `burn_complete_set`/`redeem_winning` deliberately do NOT check
/// this (see `mint_complete_set`'s doc comment in src/lib.rs) -- exit paths
/// stay open regardless of whether the market is enabled, mirroring how
/// `settle`/`refund_unsettled` already ignore `market.enabled` today.
#[test]
fn mint_complete_set_rejects_disabled_market() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let minter = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);

    harness.send_ok(
        &fixture.admin,
        &[set_market_enabled_ix(&fixture.admin.pubkey(), &fixture.config, &market.market, false)],
        &[],
    );

    let failed = harness.send_err(&minter.keypair, &[mint_complete_set_ix_for(&fixture, &market, &minter, 10 * ONE_TOKEN)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::MarketDisabled);

    // Re-enabling restores minting; burn would have worked even while
    // disabled had she already minted (not exercised here since minting
    // itself was blocked, so there is nothing yet to burn).
    harness.send_ok(
        &fixture.admin,
        &[set_market_enabled_ix(&fixture.admin.pubkey(), &fixture.config, &market.market, true)],
        &[],
    );
    harness.send_ok(&minter.keypair, &[mint_complete_set_ix_for(&fixture, &market, &minter, 10 * ONE_TOKEN)], &[]);
}

#[test]
fn mint_then_burn_round_trip_returns_exactly_the_collateral() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let up_mint = up_mint_pda(&market.market);
    let down_mint = down_mint_pda(&market.market);
    let vault = complete_set_vault_pda(&market.market);

    let minter = setup_complete_set_minter(&mut harness, &market, &creator, 1_000 * ONE_TOKEN);
    harness.send_ok(&minter.keypair, &[mint_complete_set_ix_for(&fixture, &market, &minter, 100 * ONE_TOKEN)], &[]);

    // Burn in two steps to prove partial burns work identically to a single
    // full burn.
    harness.send_ok(
        &minter.keypair,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            minter.keypair.pubkey(),
            minter.up_token,
            minter.down_token,
            minter.destination,
            40 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&vault), 60 * ONE_TOKEN);
    assert_eq!(harness.mint_supply(&up_mint), 60 * ONE_TOKEN);
    assert_eq!(harness.mint_supply(&down_mint), 60 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&minter.destination), 40 * ONE_TOKEN);

    harness.send_ok(
        &minter.keypair,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            minter.keypair.pubkey(),
            minter.up_token,
            minter.down_token,
            minter.destination,
            60 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&vault), 0);
    assert_eq!(harness.mint_supply(&up_mint), 0);
    assert_eq!(harness.mint_supply(&down_mint), 0);
    assert_eq!(harness.token_balance(&minter.up_token), 0);
    assert_eq!(harness.token_balance(&minter.down_token), 0);

    // Exactly the original funding is back, split across the untouched
    // source (900) and the destination that received both burns (100) --
    // nothing created, nothing destroyed.
    assert_eq!(
        harness.token_balance(&minter.source) + harness.token_balance(&minter.destination),
        1_000 * ONE_TOKEN
    );
}

#[test]
fn mint_then_settle_up_winner_redeems_1_to_1_and_loser_gets_nothing() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let up_mint = up_mint_pda(&market.market);
    let down_mint = down_mint_pda(&market.market);
    let vault = complete_set_vault_pda(&market.market);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 200 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    // Bob never mints -- he only ever receives DOWN tokens via a raw
    // transfer, exactly like a buyer on the AMM the design calls for. His
    // token account is a plain (non-seeded) SPL account, proving
    // `redeem_winning` works from any account the caller owns, not just the
    // seeded one `mint_complete_set` creates for minters.
    let bob = harness.funded_keypair();
    let bob_down_token = harness.create_token_account(&bob, &down_mint, &bob.pubkey());
    let bob_destination = harness.create_token_account(&bob, &settlement_mint, &bob.pubkey());
    harness.transfer_tokens(&alice.keypair, &alice.down_token, &bob_down_token, 100 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&alice.down_token), 0);
    assert_eq!(harness.token_balance(&bob_down_token), 100 * ONE_TOKEN);

    harness.warp_to_timestamp(market.expiry);
    finalize_oracle(&mut harness, &market, market.strike + 1); // strictly above strike -> UP wins

    harness.send_ok(
        &alice.keypair,
        &[redeem_winning_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            100 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 100 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&alice.up_token), 0);
    assert_eq!(harness.token_balance(&vault), 0);
    assert_eq!(harness.mint_supply(&up_mint), 0);
    // The losing side's supply is frozen, not zeroed -- redemption never
    // touches it.
    assert_eq!(harness.mint_supply(&down_mint), 100 * ONE_TOKEN);

    let failed = harness.send_err(
        &bob,
        &[redeem_winning_ix_for(&fixture, &market, bob.pubkey(), bob_down_token, bob_destination, 100 * ONE_TOKEN)],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::LosingSideNotRedeemable);
    assert_eq!(harness.token_balance(&bob_down_token), 100 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&bob_destination), 0);
}

#[test]
fn mint_then_settle_down_mirrors_the_up_case() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let up_mint = up_mint_pda(&market.market);
    let down_mint = down_mint_pda(&market.market);
    let vault = complete_set_vault_pda(&market.market);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 200 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    let bob = harness.funded_keypair();
    let bob_up_token = harness.create_token_account(&bob, &up_mint, &bob.pubkey());
    let bob_destination = harness.create_token_account(&bob, &settlement_mint, &bob.pubkey());
    harness.transfer_tokens(&alice.keypair, &alice.up_token, &bob_up_token, 100 * ONE_TOKEN);

    harness.warp_to_timestamp(market.expiry);
    // Also covers the exact-tie case: a price equal to the strike resolves
    // DOWN, not UP (see `math::up_wins`'s doc comment).
    finalize_oracle(&mut harness, &market, market.strike);

    harness.send_ok(
        &alice.keypair,
        &[redeem_winning_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.down_token,
            alice.destination,
            100 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 100 * ONE_TOKEN);
    assert_eq!(harness.mint_supply(&down_mint), 0);
    assert_eq!(harness.mint_supply(&up_mint), 100 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&vault), 0);

    let failed = harness.send_err(
        &bob,
        &[redeem_winning_ix_for(&fixture, &market, bob.pubkey(), bob_up_token, bob_destination, 100 * ONE_TOKEN)],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::LosingSideNotRedeemable);
}

#[test]
fn redeem_winning_rejects_before_oracle_finalizes() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    harness.warp_to_timestamp(market.expiry);
    let failed = harness.send_err(
        &alice.keypair,
        &[redeem_winning_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            10 * ONE_TOKEN,
        )],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::OracleNotFinalized);
}

#[test]
fn burn_complete_set_still_works_after_settlement() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    harness.warp_to_timestamp(market.expiry);
    finalize_oracle(&mut harness, &market, market.strike + 1);

    // She kept both sides -- burn_complete_set is still available even
    // though the market has already settled.
    harness.send_ok(
        &alice.keypair,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.down_token,
            alice.destination,
            100 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 100 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&complete_set_vault_pda(&market.market)), 0);
}

/// Mirrors `set_pause_blocks_fills_but_never_settlement`'s guardian
/// invariant for the conditional-token path: pausing blocks NEW exposure
/// (`mint_complete_set`) but must never trap funds already at risk
/// (`burn_complete_set`, `redeem_winning`).
#[test]
fn mint_complete_set_blocked_while_paused_but_burn_and_redeem_are_not() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 200 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    harness.send_ok(
        &fixture.pause_authority,
        &[set_pause_ix(&fixture.pause_authority.pubkey(), &fixture.config, true)],
        &[],
    );

    let failed = harness.send_err(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 10 * ONE_TOKEN)], &[]);
    assert_vsol_error(&failed, vsol::VsolError::ProtocolPaused);

    harness.send_ok(
        &alice.keypair,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.down_token,
            alice.destination,
            40 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 40 * ONE_TOKEN);

    harness.warp_to_timestamp(market.expiry);
    finalize_oracle(&mut harness, &market, market.strike + 1);
    assert!(read_config(&harness, &fixture.config).paused);
    harness.send_ok(
        &alice.keypair,
        &[redeem_winning_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            60 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 100 * ONE_TOKEN);
}

#[test]
fn create_market_rejects_zero_strike() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let now = harness.now();
    let mut args = vsol::CreateMarketArgs {
        market_id: [0u8; 32],
        underlying_mint: Pubkey::new_unique(),
        symbol: symbol_bytes("NVDA"),
        price_scale: 1_000_000,
        expiry: now + MARKET_LEAD_SECONDS + 3600,
        observation_window_seconds: OBSERVATION_WINDOW,
        settlement_grace_seconds: SETTLEMENT_GRACE,
        max_confidence_bps: 100,
        pyth_feed_id: [0x99u8; 32],
        max_settlement_staleness_seconds: MAX_SETTLEMENT_STALENESS,
        strike: 0,
    };
    args.market_id = expected_market_id(&args, settlement_mint);
    let market = market_pda(&fixture.config, &args.market_id);
    let oracle = oracle_pda(&market);
    let failed = harness.send_err(
        &creator,
        &[create_market_ix(&creator.pubkey(), &fixture.config, &market, &oracle, &settlement_mint, args)],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::InvalidStrike);
}

/// Decision record for "the oracle never finalizes" (see this task's
/// report): a holder of only ONE side is NOT permanently stuck. Before
/// `redeem_unresolved` existed, `redeem_winning` required `oracle.finalized`
/// unconditionally forever and `burn_complete_set` required holding BOTH
/// sides, so a single-sided holder in a dead market had no recovery path at
/// all short of reassembling a complete set from the open market. Now, once
/// `final_settlement_deadline` has passed (so `publish_pyth_settlement` can
/// never finalize the oracle out from under this redemption -- see
/// `redeem_unresolved`'s doc comment), she can redeem her single side
/// directly for a pro-rata share of the vault.
#[test]
fn single_side_holder_recovers_pro_rata_via_redeem_unresolved_when_oracle_never_finalizes() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let down_mint = down_mint_pda(&market.market);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 50 * ONE_TOKEN)], &[]);

    // Alice gives away her entire DOWN side, leaving her holding UP only.
    let bob = harness.funded_keypair();
    let bob_down_token = harness.create_token_account(&bob, &down_mint, &bob.pubkey());
    let bob_destination = harness.create_token_account(&bob, &settlement_mint, &bob.pubkey());
    harness.transfer_tokens(&alice.keypair, &alice.down_token, &bob_down_token, 50 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&alice.down_token), 0);

    // Warp well past every settlement deadline -- the oracle is simply
    // never published, simulating a genuinely dead feed.
    let deadline = final_settlement_deadline(&market);
    harness.warp_to_timestamp(deadline + 10_000);

    // No automatic winner, so redeem_winning is (and stays) impossible.
    let failed = harness.send_err(
        &alice.keypair,
        &[redeem_winning_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            50 * ONE_TOKEN,
        )],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::OracleNotFinalized);

    // Nor can she burn a complete set: she only holds UP now. This fails at
    // the SPL token program (insufficient DOWN balance), not with a vsol
    // error -- there is no vsol-level bailout to reject in the first place.
    harness.send_err(
        &alice.keypair,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.down_token,
            alice.destination,
            50 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 0);

    // But she CAN now redeem her single UP side directly via the escape
    // hatch, for exactly half (vault == total_supply / 2 pre-redemption, so
    // the pro-rata formula reduces to amount / 2).
    harness.send_ok(
        &alice.keypair,
        &[redeem_unresolved_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            50 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 25 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&alice.up_token), 0);

    // Bob, holding the other 50 DOWN, recovers the rest -- he is the "final
    // redeemer" (up_mint's supply already fully drained by Alice's redeem),
    // so his payout exactly drains the vault, no dust left behind.
    harness.send_ok(
        &bob,
        &[redeem_unresolved_ix_for(&fixture, &market, bob.pubkey(), bob_down_token, bob_destination, 50 * ONE_TOKEN)],
        &[],
    );
    assert_eq!(harness.token_balance(&bob_destination), 25 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&complete_set_vault_pda(&market.market)), 0);
}

/// The conservation property the pool path's proptests check for
/// (`math::tests::settlement_conserves_escrow`/`payout_never_exceeds_collateral`),
/// mirrored here for the conditional-token path via a deterministic,
/// multi-actor, multi-instruction scenario rather than a property test:
/// this is a LiteSVM integration test (real token balances, real CPIs), not
/// a pure function of `(direction, strike, width, price, max_payout)`, so
/// there is no small closed-form input space to randomize over the way
/// `math.rs` has for the payout formula -- see this task's report for why
/// `up_wins` (the only new pure function this path introduces) gets its own
/// proptests in math.rs instead.
///
/// Interleaves mint, burn (pre- AND post-settlement), peer-to-peer transfers
/// that split complete sets across holders who never minted anything
/// themselves, and redemption across three independent actors, checking
/// after EVERY step that vault collateral exactly equals outstanding supply
/// (both sides pre-settlement; the winning side only, post-settlement -- see
/// `assert_invariant` below and this task's report for the derivation of
/// why the losing side's supply is merely `>=` the vault post-settlement,
/// not `==`). Finishes by proving total collateral ever recovered (via any
/// mix of burns and redemptions) exactly equals total collateral ever
/// minted -- nothing created, nothing destroyed, and no sequence drains more
/// than was deposited.
#[test]
fn complete_set_conservation_holds_across_interleaved_mint_burn_redeem() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let up_mint = up_mint_pda(&market.market);
    let down_mint = down_mint_pda(&market.market);
    let vault = complete_set_vault_pda(&market.market);

    let assert_invariant = |harness: &Harness, settled_up: Option<bool>| {
        let vault_balance = harness.token_balance(&vault);
        let up_supply = harness.mint_supply(&up_mint);
        let down_supply = harness.mint_supply(&down_mint);
        match settled_up {
            None => {
                assert_eq!(vault_balance, up_supply, "pre-settlement: vault must equal UP supply");
                assert_eq!(vault_balance, down_supply, "pre-settlement: vault must equal DOWN supply");
            }
            Some(up_won) => {
                let (winning_supply, losing_supply) =
                    if up_won { (up_supply, down_supply) } else { (down_supply, up_supply) };
                assert_eq!(vault_balance, winning_supply, "post-settlement: vault must equal the winning supply");
                assert!(losing_supply >= vault_balance, "the losing supply can only ever be >= the vault");
            }
        }
    };

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 1_000 * ONE_TOKEN);
    let bob = setup_complete_set_minter(&mut harness, &market, &creator, 1_000 * ONE_TOKEN);

    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);
    assert_invariant(&harness, None);
    harness.send_ok(&bob.keypair, &[mint_complete_set_ix_for(&fixture, &market, &bob, 50 * ONE_TOKEN)], &[]);
    assert_invariant(&harness, None);

    harness.send_ok(
        &alice.keypair,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.down_token,
            alice.destination,
            30 * ONE_TOKEN,
        )],
        &[],
    );
    assert_invariant(&harness, None);

    // A third holder who never mints anything -- she only ever receives a
    // partial UP and a partial DOWN balance via raw transfers.
    let carol = harness.funded_keypair();
    let carol_up_token = harness.create_token_account(&carol, &up_mint, &carol.pubkey());
    let carol_down_token = harness.create_token_account(&carol, &down_mint, &carol.pubkey());
    let carol_destination = harness.create_token_account(&carol, &settlement_mint, &carol.pubkey());
    harness.transfer_tokens(&alice.keypair, &alice.up_token, &carol_up_token, 40 * ONE_TOKEN);
    harness.transfer_tokens(&bob.keypair, &bob.down_token, &carol_down_token, 20 * ONE_TOKEN);
    assert_invariant(&harness, None); // peer-to-peer transfers never touch supply or the vault

    // Carol burns the complete set she can assemble from her split holdings.
    harness.send_ok(
        &carol,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            carol.pubkey(),
            carol_up_token,
            carol_down_token,
            carol_destination,
            20 * ONE_TOKEN,
        )],
        &[],
    );
    assert_invariant(&harness, None);

    // Balances now: Alice 30 up / 70 down, Bob 50 up / 30 down, Carol 20 up / 0 down.
    assert_eq!(harness.token_balance(&alice.up_token), 30 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&alice.down_token), 70 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&bob.up_token), 50 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&bob.down_token), 30 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&carol_up_token), 20 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&carol_down_token), 0);
    assert_eq!(harness.mint_supply(&up_mint), 100 * ONE_TOKEN);
    assert_eq!(harness.mint_supply(&down_mint), 100 * ONE_TOKEN);

    harness.warp_to_timestamp(market.expiry);
    finalize_oracle(&mut harness, &market, market.strike + 1); // UP wins
    assert_invariant(&harness, Some(true));

    harness.send_ok(
        &alice.keypair,
        &[redeem_winning_ix_for(&fixture, &market, alice.keypair.pubkey(), alice.up_token, alice.destination, 30 * ONE_TOKEN)],
        &[],
    );
    assert_invariant(&harness, Some(true));
    harness.send_ok(
        &bob.keypair,
        &[redeem_winning_ix_for(&fixture, &market, bob.keypair.pubkey(), bob.up_token, bob.destination, 50 * ONE_TOKEN)],
        &[],
    );
    assert_invariant(&harness, Some(true));
    harness.send_ok(
        &carol,
        &[redeem_winning_ix_for(&fixture, &market, carol.pubkey(), carol_up_token, carol_destination, 20 * ONE_TOKEN)],
        &[],
    );
    assert_invariant(&harness, Some(true));

    assert_eq!(harness.token_balance(&vault), 0);
    assert_eq!(harness.mint_supply(&up_mint), 0);
    // The losing (DOWN) side's supply is untouched by redemption -- frozen
    // exactly where the last burn left it.
    assert_eq!(harness.mint_supply(&down_mint), 100 * ONE_TOKEN);

    // No further redemption is possible: Alice already redeemed every UP
    // token she held. This fails at the SPL token program (insufficient
    // balance), which is the actual backstop preventing any sequence from
    // ever draining more than was deposited.
    harness.send_err(
        &alice.keypair,
        &[redeem_winning_ix_for(&fixture, &market, alice.keypair.pubkey(), alice.up_token, alice.destination, 1)],
        &[],
    );

    // Conservation: total ever minted (100 + 50 = 150) exactly equals total
    // ever recovered via any mix of burns (30 + 20 = 50) and redemptions
    // (30 + 50 + 20 = 100). Nothing was created, nothing was destroyed, and
    // no sequence of mint/burn/redeem drained more than was deposited.
    let total_minted = 150 * ONE_TOKEN;
    let total_recovered =
        harness.token_balance(&alice.destination) + harness.token_balance(&bob.destination) + harness.token_balance(&carol_destination);
    assert_eq!(total_recovered, total_minted);
}

// =====================================================================
// redeem_unresolved (FINDING 2: the escape hatch for an oracle that never
// finalizes)
// =====================================================================

#[test]
fn redeem_unresolved_rejects_before_the_final_settlement_deadline() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    // Well before expiry.
    let failed = harness.send_err(
        &alice.keypair,
        &[redeem_unresolved_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            10 * ONE_TOKEN,
        )],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::SettlementWindowOpen);

    // Exactly AT the deadline is still refused -- the on-chain check is
    // strict `now > final_settlement_deadline`, the exact complement of
    // `publish_pyth_settlement`'s own `now <= final_deadline` boundary (see
    // `final_settlement_deadline`'s doc comment in lib.rs for why the two
    // MUST be exact complements, not merely close).
    harness.warp_to_timestamp(final_settlement_deadline(&market));
    let failed = harness.send_err(
        &alice.keypair,
        &[redeem_unresolved_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            10 * ONE_TOKEN,
        )],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::SettlementWindowOpen);

    // One second later, the hatch opens.
    harness.warp_to_timestamp(final_settlement_deadline(&market) + 1);
    harness.send_ok(
        &alice.keypair,
        &[redeem_unresolved_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            10 * ONE_TOKEN,
        )],
        &[],
    );
}

/// The two payout paths must be strictly mutually exclusive: once the oracle
/// finalizes (by any means, at any time), `redeem_unresolved` is refused
/// even though the timing gate alone would otherwise be satisfied.
/// `redeem_winning` continues to work normally.
#[test]
fn redeem_unresolved_rejects_once_the_oracle_is_finalized() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    harness.warp_to_timestamp(final_settlement_deadline(&market) + 1);
    finalize_oracle(&mut harness, &market, market.strike + 1); // UP wins

    let failed = harness.send_err(
        &alice.keypair,
        &[redeem_unresolved_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            10 * ONE_TOKEN,
        )],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::OracleAlreadyFinalized);

    // The real winner path still works exactly as normal.
    harness.send_ok(
        &alice.keypair,
        &[redeem_winning_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            10 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 10 * ONE_TOKEN);
}

/// At the moment the hatch first opens (no prior redemptions), `vault ==
/// total_supply / 2` always holds, so the pro-rata formula reduces to
/// exactly `amount / 2` for both sides -- the standard "unresolvable market
/// resolves 50/50" convention.
#[test]
fn redeem_unresolved_splits_exactly_in_half_for_both_sides_at_the_moment_the_hatch_opens() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let down_mint = down_mint_pda(&market.market);
    let vault = complete_set_vault_pda(&market.market);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    // Bob holds the entire DOWN side, Alice the entire UP side.
    let bob = harness.funded_keypair();
    let bob_down_token = harness.create_token_account(&bob, &down_mint, &bob.pubkey());
    let bob_destination = harness.create_token_account(&bob, &settlement_mint, &bob.pubkey());
    harness.transfer_tokens(&alice.keypair, &alice.down_token, &bob_down_token, 100 * ONE_TOKEN);

    harness.warp_to_timestamp(final_settlement_deadline(&market) + 1);

    harness.send_ok(
        &alice.keypair,
        &[redeem_unresolved_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            100 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 50 * ONE_TOKEN);

    harness.send_ok(
        &bob,
        &[redeem_unresolved_ix_for(&fixture, &market, bob.pubkey(), bob_down_token, bob_destination, 100 * ONE_TOKEN)],
        &[],
    );
    assert_eq!(harness.token_balance(&bob_destination), 50 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&vault), 0);
}

/// Uses an ODD outstanding supply (S = 101) so `amount * vault / total`
/// genuinely does not divide evenly -- Alice's redemption floors down and
/// leaves one atom of dust in the vault. Bob, the FINAL redeemer (UP supply
/// already fully drained by Alice), still drains the vault to EXACTLY zero:
/// his `amount` equals the entire remaining `total_supply`, so his payout is
/// `amount * vault / amount == vault` exactly, dust and all.
#[test]
fn redeem_unresolved_final_redeemer_drains_the_vault_to_exactly_zero_with_an_odd_supply() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let down_mint = down_mint_pda(&market.market);
    let vault = complete_set_vault_pda(&market.market);

    let s: u64 = 101;
    let alice = setup_complete_set_minter(&mut harness, &market, &creator, s);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, s)], &[]);

    let bob = harness.funded_keypair();
    let bob_down_token = harness.create_token_account(&bob, &down_mint, &bob.pubkey());
    let bob_destination = harness.create_token_account(&bob, &settlement_mint, &bob.pubkey());
    harness.transfer_tokens(&alice.keypair, &alice.down_token, &bob_down_token, s);

    harness.warp_to_timestamp(final_settlement_deadline(&market) + 1);

    // 101 * 101 / 202 = 50.5 -> floors to 50 (see
    // math::calculate_pro_rata_redemption's own tests for the pinned
    // closed-form check).
    harness.send_ok(
        &alice.keypair,
        &[redeem_unresolved_ix_for(&fixture, &market, alice.keypair.pubkey(), alice.up_token, alice.destination, s)],
        &[],
    );
    assert_eq!(harness.token_balance(&alice.destination), 50);
    assert_eq!(harness.token_balance(&vault), 51); // 101 - 50: one atom of dust left behind.

    harness.send_ok(
        &bob,
        &[redeem_unresolved_ix_for(&fixture, &market, bob.pubkey(), bob_down_token, bob_destination, s)],
        &[],
    );
    assert_eq!(harness.token_balance(&bob_destination), 51);
    assert_eq!(harness.token_balance(&vault), 0, "the final redeemer must drain the vault to exactly zero");

    // Conservation: nothing created, nothing destroyed -- 50 + 51 == S.
    assert_eq!(harness.token_balance(&alice.destination) + harness.token_balance(&bob_destination), s);
}

/// Burning (unlike redeeming) moves the vault and BOTH mint supplies by the
/// identical amount, so it preserves `vault / total_supply == 1/2` exactly.
/// This test mints, burns part of the position, THEN opens the hatch and
/// redeems -- proving the intervening burn does not skew the pro-rata split
/// away from the standard 50/50 the un-burned case gets.
#[test]
fn redeem_unresolved_pro_rata_is_unchanged_by_an_intervening_burn_complete_set() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);
    let down_mint = down_mint_pda(&market.market);
    let vault = complete_set_vault_pda(&market.market);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    // Burns 40 of her own complete set before giving away her DOWN side.
    harness.send_ok(
        &alice.keypair,
        &[burn_complete_set_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.down_token,
            alice.destination,
            40 * ONE_TOKEN,
        )],
        &[],
    );
    assert_eq!(harness.token_balance(&vault), 60 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&alice.destination), 40 * ONE_TOKEN);

    let bob = harness.funded_keypair();
    let bob_down_token = harness.create_token_account(&bob, &down_mint, &bob.pubkey());
    harness.transfer_tokens(&alice.keypair, &alice.down_token, &bob_down_token, 60 * ONE_TOKEN);

    harness.warp_to_timestamp(final_settlement_deadline(&market) + 1);

    // Still the FIRST redemption against this market -- vault (60) ==
    // total_supply (120) / 2 still holds despite the earlier burn, so this
    // is still exactly half of her 60 UP, not skewed by it.
    harness.send_ok(
        &alice.keypair,
        &[redeem_unresolved_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.up_token,
            alice.destination,
            60 * ONE_TOKEN,
        )],
        &[],
    );
    // 40 (from the earlier burn) + 30 (half of 60, from redeem_unresolved).
    assert_eq!(harness.token_balance(&alice.destination), 70 * ONE_TOKEN);
    assert_eq!(harness.token_balance(&vault), 30 * ONE_TOKEN);
}

/// `redeemer_token` may be EITHER conditional-token mint, but nothing else --
/// the handler rejects a token account belonging to any other mint (here,
/// the settlement mint itself) with a dedicated error rather than silently
/// misbehaving or failing at the SPL token program with a confusing message.
#[test]
fn redeem_unresolved_rejects_a_token_account_belonging_to_neither_mint() {
    let mut harness = Harness::new();
    let fixture = setup_config(&mut harness);
    let creator = harness.funded_keypair();
    let settlement_mint = harness.create_mint(&creator, &creator.pubkey(), SETTLEMENT_DECIMALS);
    let market = setup_market(&mut harness, &fixture, &creator, settlement_mint);

    let alice = setup_complete_set_minter(&mut harness, &market, &creator, 100 * ONE_TOKEN);
    harness.send_ok(&alice.keypair, &[mint_complete_set_ix_for(&fixture, &market, &alice, 100 * ONE_TOKEN)], &[]);

    harness.warp_to_timestamp(final_settlement_deadline(&market) + 1);

    let failed = harness.send_err(
        &alice.keypair,
        &[redeem_unresolved_ix_for(
            &fixture,
            &market,
            alice.keypair.pubkey(),
            alice.source, // a settlement-mint account -- neither UP nor DOWN
            alice.destination,
            ONE_TOKEN,
        )],
        &[],
    );
    assert_vsol_error(&failed, vsol::VsolError::InvalidConditionalTokenMint);
}
