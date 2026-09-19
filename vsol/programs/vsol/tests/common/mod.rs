//! Shared fixture helpers for the in-process instruction test suite.
//!
//! Harness choice: `litesvm` (in-process SVM). It loads the already-built
//! `target/deploy/vsol.so` and executes real transactions against it,
//! including genuine Ed25519 precompile verification, so these tests exercise
//! the exact bytecode that ships to devnet/mainnet rather than a mock.
//!
//! The `vsol` program crate is added to `[dev-dependencies]` with the
//! `no-entrypoint` feature purely so this test binary can reuse the
//! program's own Anchor-generated `instruction::*` argument types, account
//! structs, PDA seed constants, and error enum. No production logic is
//! duplicated here.

use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use anchor_spl::token::spl_token;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata, TransactionResult};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::error::InstructionError;
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;
use solana_message::Message;
use solana_sdk_ids::{system_program, sysvar::rent};
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use vsol::{
    COMPLETE_SET_TOKEN_SEED, COMPLETE_SET_VAULT_SEED, DOWN_MINT_SEED, ELIGIBILITY_SEED,
    CUSTOM_FEED_SEED, CUSTOM_SETTLEMENT_OBSERVATION_SEED, MARKET_SEED, NONCE_SEED, ORACLE_SEED, POOL_MARKET_SEED, POOL_NONCE_SEED, POOL_POSITION_SEED,
    POOL_POSITION_VAULT_SEED, POOL_SEED, POOL_TOKEN_SEED, POSITION_SEED, POSITION_VAULT_SEED,
    PROVIDER_SEED, UP_MINT_SEED, WRITER_SEED, WRITER_TOKEN_SEED,
};

pub use anchor_lang::prelude::Pubkey;
pub use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
pub use anchor_lang::InstructionData;
pub use solana_keypair::Keypair;
pub use solana_signer::Signer;

pub mod quote_signing;

pub mod instructions;
pub use instructions::*;

pub const SETTLEMENT_DECIMALS: u8 = 6;
pub const ONE_TOKEN: u64 = 1_000_000;
pub const SOL: u64 = 1_000_000_000;

/// Wraps a `LiteSVM` instance with the vsol program already loaded.
pub struct Harness {
    pub svm: LiteSVM,
}

impl Harness {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new().with_precompiles();
        let so_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/vsol.so");
        svm.add_program_from_file(vsol::ID, so_path)
            .expect("load target/deploy/vsol.so; run `anchor build` first");
        Harness { svm }
    }

    pub fn funded_keypair(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 100 * SOL).unwrap();
        kp
    }

    /// Sends a transaction paid for and signed by `payer`, plus any
    /// additional required signers.
    // `litesvm`'s own `Cargo.toml` allows this same lint crate-wide for the
    // identical reason: `FailedTransactionMetadata` carries full transaction
    // logs and is necessarily large; boxing it would just move the
    // allocation rather than avoid it, for test-only code that never
    // propagates this error through a wider API.
    #[allow(clippy::result_large_err)]
    pub fn send(
        &mut self,
        payer: &Keypair,
        ixs: &[Instruction],
        extra_signers: &[&Keypair],
    ) -> TransactionResult {
        // Force a fresh blockhash per send: several tests submit two
        // transactions with identical instructions/signers back to back
        // (e.g. pause, then pause again later), which would otherwise
        // produce an identical signature and be rejected as `AlreadyProcessed`.
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra_signers);
        let message = Message::new(ixs, Some(&payer.pubkey()));
        let tx = Transaction::new(&signers, message, blockhash);
        self.svm.send_transaction(tx)
    }

    pub fn send_ok(
        &mut self,
        payer: &Keypair,
        ixs: &[Instruction],
        extra_signers: &[&Keypair],
    ) -> TransactionMetadata {
        match self.send(payer, ixs, extra_signers) {
            Ok(meta) => meta,
            Err(failed) => panic!("expected transaction to succeed, got {failed:?}"),
        }
    }

    pub fn send_err(
        &mut self,
        payer: &Keypair,
        ixs: &[Instruction],
        extra_signers: &[&Keypair],
    ) -> FailedTransactionMetadata {
        match self.send(payer, ixs, extra_signers) {
            Ok(meta) => panic!("expected transaction to fail, got success: {meta:?}"),
            Err(failed) => failed,
        }
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn warp_to_timestamp(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar::<Clock>(&clock);
    }

    pub fn get_account(&self, pubkey: &Pubkey) -> Account {
        self.svm
            .get_account(pubkey)
            .unwrap_or_else(|| panic!("account {pubkey} does not exist"))
    }

    /// Deserializes an Anchor `#[account]` type, bypassing instruction
    /// handlers entirely. Used to seed the settlement oracle directly for
    /// tests that only need a *finalized* oracle (settlement/pool-settlement
    /// paths) without standing up genuine Pyth price-update infrastructure,
    /// which is out of scope for these instruction-level tests.
    pub fn read_account<T: AccountDeserialize>(&self, pubkey: &Pubkey) -> T {
        let account = self.get_account(pubkey);
        T::try_deserialize(&mut account.data.as_slice()).expect("deserialize account")
    }

    pub fn write_account<T: AccountSerialize>(&mut self, pubkey: Pubkey, value: &T) {
        let mut account = self.get_account(&pubkey);
        let mut data = Vec::new();
        value.try_serialize(&mut data).expect("serialize account");
        account.data = data;
        self.svm.set_account(pubkey, account).expect("set_account");
    }

    /// Directly plants an account owned by `owner` with raw `data`, bypassing
    /// every instruction handler. Used to fabricate a Pyth `PriceUpdateV2`
    /// fixture account (see `fake_full_pyth_price_update` in
    /// `tests/common/instructions.rs`) without standing up the real Pyth
    /// receiver program and Wormhole guardian verification, which is out of
    /// scope for these instruction-level tests.
    pub fn set_raw_account(&mut self, pubkey: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        let account = Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(pubkey, account).expect("set_account");
    }

    pub fn token_balance(&self, token_account: &Pubkey) -> u64 {
        let account = self.get_account(token_account);
        spl_token::state::Account::unpack(&account.data)
            .expect("unpack token account")
            .amount
    }

    /// Reads an SPL mint's total supply directly, bypassing every
    /// instruction handler -- used by the conditional-token ("complete set")
    /// tests to check `up_mint`/`down_mint` supply against the collateral
    /// vault balance.
    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let account = self.get_account(mint);
        spl_token::state::Mint::unpack(&account.data)
            .expect("unpack mint")
            .supply
    }

    pub fn create_mint(&mut self, payer: &Keypair, authority: &Pubkey, decimals: u8) -> Pubkey {
        let mint_kp = Keypair::new();
        let space = spl_token::state::Mint::LEN;
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let create_ix = solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &mint_kp.pubkey(),
            lamports,
            space as u64,
            &spl_token::ID,
        );
        let init_ix =
            spl_token::instruction::initialize_mint2(&spl_token::ID, &mint_kp.pubkey(), authority, None, decimals)
                .unwrap();
        self.send_ok(payer, &[create_ix, init_ix], &[&mint_kp]);
        mint_kp.pubkey()
    }

    /// Creates a plain (non-associated) SPL token account owned by `owner`,
    /// mirroring the raw token accounts the vsol program itself expects.
    pub fn create_token_account(&mut self, payer: &Keypair, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
        let account_kp = Keypair::new();
        let space = spl_token::state::Account::LEN;
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let create_ix = solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &account_kp.pubkey(),
            lamports,
            space as u64,
            &spl_token::ID,
        );
        let init_ix =
            spl_token::instruction::initialize_account3(&spl_token::ID, &account_kp.pubkey(), mint, owner).unwrap();
        self.send_ok(payer, &[create_ix, init_ix], &[&account_kp]);
        account_kp.pubkey()
    }

    pub fn mint_to(&mut self, payer: &Keypair, mint: &Pubkey, mint_authority: &Keypair, destination: &Pubkey, amount: u64) {
        let ix = spl_token::instruction::mint_to(
            &spl_token::ID,
            mint,
            destination,
            &mint_authority.pubkey(),
            &[],
            amount,
        )
        .unwrap();
        self.send_ok(payer, &[ix], &[mint_authority]);
    }

    /// A raw SPL Token `transfer` from `source` (owned by `owner`) straight
    /// to `destination`, bypassing every vsol instruction. Used to simulate
    /// a "donation attack": a token account's owner cannot refuse incoming
    /// transfers, so anyone holding tokens can push them into e.g. a pool's
    /// `pool_token` vault without ever calling `deposit_liquidity`. Tests use
    /// this to prove `LiquidityPool::total_assets` (the program's internal
    /// ledger) is immune to exactly this -- see its doc comment in
    /// `vsol/programs/vsol/src/lib.rs`.
    pub fn transfer_tokens(&mut self, owner: &Keypair, source: &Pubkey, destination: &Pubkey, amount: u64) {
        let ix = spl_token::instruction::transfer(
            &spl_token::ID,
            source,
            destination,
            &owner.pubkey(),
            &[],
            amount,
        )
        .unwrap();
        self.send_ok(owner, &[ix], &[]);
    }
}

/// Extracts the Anchor custom error code (e.g. `u32::from(VsolError::X)`)
/// from a failed transaction, panicking with a descriptive message if the
/// failure was not a custom program error.
pub fn anchor_error_code(failed: &FailedTransactionMetadata) -> u32 {
    match failed.err {
        TransactionError::InstructionError(_, ref instruction_error) => {
            match instruction_error {
                InstructionError::Custom(code) => *code,
                other => panic!("expected a custom program error, got {other:?}"),
            }
        }
        ref other => panic!("expected an instruction error, got {other:?}"),
    }
}

pub fn assert_vsol_error(failed: &FailedTransactionMetadata, expected: vsol::VsolError) {
    assert_eq!(
        anchor_error_code(failed),
        u32::from(expected),
        "unexpected error, logs: {:#?}",
        failed.meta.logs
    );
}

// --- PDA derivation helpers, matching the seeds declared in lib.rs. ---

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[vsol::CONFIG_SEED], &vsol::ID).0
}

pub fn market_pda(config: &Pubkey, market_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[MARKET_SEED, config.as_ref(), market_id.as_ref()], &vsol::ID).0
}

pub fn oracle_pda(market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ORACLE_SEED, market.as_ref()], &vsol::ID).0
}

pub fn custom_feed_pda(symbol: &[u8; 16]) -> Pubkey {
    Pubkey::find_program_address(&[CUSTOM_FEED_SEED, symbol], &vsol::ID).0
}

pub fn custom_observation_pda(symbol: &[u8; 16], expiry: i64) -> Pubkey {
    Pubkey::find_program_address(&[CUSTOM_SETTLEMENT_OBSERVATION_SEED, symbol, &expiry.to_le_bytes()], &vsol::ID).0
}

pub fn writer_vault_pda(config: &Pubkey, maker: &Pubkey, settlement_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[WRITER_SEED, config.as_ref(), maker.as_ref(), settlement_mint.as_ref()],
        &vsol::ID,
    )
    .0
}

pub fn writer_token_pda(writer_vault: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[WRITER_TOKEN_SEED, writer_vault.as_ref()], &vsol::ID).0
}

pub fn nonce_pda(config: &Pubkey, maker: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[NONCE_SEED, config.as_ref(), maker.as_ref(), nonce.to_le_bytes().as_ref()],
        &vsol::ID,
    )
    .0
}

pub fn position_pda(nonce_record: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POSITION_SEED, nonce_record.as_ref()], &vsol::ID).0
}

pub fn position_vault_pda(position: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POSITION_VAULT_SEED, position.as_ref()], &vsol::ID).0
}

pub fn eligibility_pda(config: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ELIGIBILITY_SEED, config.as_ref(), wallet.as_ref()], &vsol::ID).0
}

pub fn pool_pda(config: &Pubkey, settlement_mint: &Pubkey, pool_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[POOL_SEED, config.as_ref(), settlement_mint.as_ref(), pool_id.as_ref()],
        &vsol::ID,
    )
    .0
}

pub fn pool_token_pda(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POOL_TOKEN_SEED, pool.as_ref()], &vsol::ID).0
}

pub fn provider_position_pda(pool: &Pubkey, provider: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PROVIDER_SEED, pool.as_ref(), provider.as_ref()], &vsol::ID).0
}

pub fn pool_market_pda(pool: &Pubkey, market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POOL_MARKET_SEED, pool.as_ref(), market.as_ref()], &vsol::ID).0
}

pub fn pool_nonce_pda(pool: &Pubkey, quote_authority: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            POOL_NONCE_SEED,
            pool.as_ref(),
            quote_authority.as_ref(),
            nonce.to_le_bytes().as_ref(),
        ],
        &vsol::ID,
    )
    .0
}

pub fn pool_position_pda(nonce_record: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POOL_POSITION_SEED, nonce_record.as_ref()], &vsol::ID).0
}

pub fn pool_position_vault_pda(position: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POOL_POSITION_VAULT_SEED, position.as_ref()], &vsol::ID).0
}

// --- Conditional-token ("complete set") PDAs ---

pub fn up_mint_pda(market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[UP_MINT_SEED, market.as_ref()], &vsol::ID).0
}

pub fn down_mint_pda(market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[DOWN_MINT_SEED, market.as_ref()], &vsol::ID).0
}

pub fn complete_set_vault_pda(market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[COMPLETE_SET_VAULT_SEED, market.as_ref()], &vsol::ID).0
}

/// The deterministic address `mint_complete_set` mints into (see
/// `COMPLETE_SET_TOKEN_SEED`'s doc comment in src/lib.rs). `burn_complete_set`
/// and `redeem_winning` accept this OR any other token account the caller
/// holds a balance in -- it is not the only valid source for those two.
pub fn complete_set_token_pda(mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[COMPLETE_SET_TOKEN_SEED, mint.as_ref(), owner.as_ref()], &vsol::ID).0
}

pub fn system_program_id() -> Pubkey {
    system_program::ID
}

pub fn rent_sysvar_id() -> Pubkey {
    rent::ID
}

pub fn token_program_id() -> Pubkey {
    spl_token::ID
}

pub fn instructions_sysvar_id() -> Pubkey {
    INSTRUCTIONS_SYSVAR_ID
}

/// Sentinel used for `Option<Account<..>>` fields left as `None`: Anchor's
/// `Accounts` impl for `Option<T>` treats a supplied account key equal to the
/// program id as "not provided".
pub fn no_eligibility() -> Pubkey {
    vsol::ID
}

/// Same "program id means not provided" sentinel as `no_eligibility`, for
/// `close_settled_market`'s optional `pool` account.
pub fn no_pool() -> Pubkey {
    vsol::ID
}

/// Same sentinel as `no_pool`, for `close_settled_market`'s optional
/// `pool_market` account.
pub fn no_pool_market() -> Pubkey {
    vsol::ID
}
