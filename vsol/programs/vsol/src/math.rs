use anchor_lang::prelude::*;

use crate::{Direction, VsolError, BPS_DENOMINATOR};

/// Returns the buyer payout, rounded down. The writer receives all residual dust.
pub fn calculate_payout(
    direction: u8,
    strike: u64,
    width: u64,
    settlement_price: u64,
    max_payout: u64,
) -> Result<u64> {
    require!(width > 0, VsolError::InvalidWidth);
    require!(max_payout > 0, VsolError::InvalidAmount);

    let delta = match Direction::try_from(direction)? {
        Direction::Up => settlement_price.saturating_sub(strike),
        Direction::Down => strike.saturating_sub(settlement_price),
    }
    .min(width);

    let payout = (max_payout as u128)
        .checked_mul(delta as u128)
        .ok_or(VsolError::MathOverflow)?
        .checked_div(width as u128)
        .ok_or(VsolError::MathOverflow)?;

    u64::try_from(payout).map_err(|_| error!(VsolError::MathOverflow))
}

/// Protocol fees round up so a positive fee rate cannot be bypassed with dust quotes.
///
/// `amount` is whatever the fee is charged ON -- deliberately not named
/// `premium` any more: `settle_pool_position` charges it against the WINNING
/// PAYOUT (so a loser pays nothing), while the legacy `settle` and the
/// early-close buyback still charge it against the premium.
pub fn calculate_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    if amount == 0 || fee_bps == 0 {
        return Ok(0);
    }

    let numerator = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(VsolError::MathOverflow)?
        .checked_add((BPS_DENOMINATOR - 1) as u128)
        .ok_or(VsolError::MathOverflow)?;
    let fee = numerator
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(VsolError::MathOverflow)?;

    u64::try_from(fee).map_err(|_| error!(VsolError::MathOverflow))
}

/// Mints pool shares conservatively. Deposits round down so a depositor cannot
/// dilute existing liquidity providers through integer division.
///
/// Both `calculate_deposit_shares` and `calculate_withdraw_amount` add a
/// virtual offset of 1 share and 1 asset to every conversion (OpenZeppelin
/// ERC-4626's `_decimalsOffset() == 0` convention: `shares = assets *
/// (totalSupply + 1) / (totalAssets + 1)`, and the inverse for withdrawals).
/// This is belt-and-braces on top of `LiquidityPool::total_assets` (the
/// internal ledger callers now pass as `total_assets`, never the raw SPL
/// token balance -- see `deposit_liquidity`/`withdraw_liquidity` in lib.rs):
/// the ledger is what stops a donated-token balance from ever being used as
/// the share-price denominator in the first place; the virtual offset is a
/// second, independent bound that keeps the *very first* depositor from
/// obtaining a cheap 1-share position that a later attacker could exploit
/// through rounding even if the ledger were somehow wrong or bypassed. A
/// phantom "1 share : 1 asset" position that nobody holds and nobody can
/// withdraw is folded into every conversion, which costs real depositors a
/// negligible amount of rounding dust and in exchange makes the classic
/// first-depositor inflation attack unprofitable at any donation size.
pub fn calculate_deposit_shares(amount: u64, total_shares: u64, total_assets: u64) -> Result<u64> {
    require!(amount > 0, VsolError::InvalidAmount);
    // total_shares == 0 no longer needs a special-cased early return: with
    // the virtual offset, shares = amount * 1 / 1 = amount when both are
    // zero, identical to the old first-deposit behavior. What still needs
    // guarding is genuine insolvency -- shares outstanding against zero
    // ledger assets -- which is a distinct, real error state, not "pool not
    // yet seeded".
    require!(total_assets > 0 || total_shares == 0, VsolError::PoolInsolvent);
    let shares = (amount as u128)
        .checked_mul((total_shares as u128) + 1)
        .ok_or(VsolError::MathOverflow)?
        .checked_div((total_assets as u128) + 1)
        .ok_or(VsolError::MathOverflow)?;
    let shares = u64::try_from(shares).map_err(|_| error!(VsolError::MathOverflow))?;
    require!(shares > 0, VsolError::DepositTooSmall);
    Ok(shares)
}

/// Returns underlying assets conservatively. Withdrawals round down and leave
/// any division dust in the pool for remaining providers. See
/// `calculate_deposit_shares` for what the virtual offset (+1 share, +1
/// asset) is doing here and why it's separate from the `total_assets` ledger
/// fix.
pub fn calculate_withdraw_amount(shares: u64, total_shares: u64, total_assets: u64) -> Result<u64> {
    require!(shares > 0, VsolError::InvalidAmount);
    require!(total_shares > 0, VsolError::InvalidPoolShares);
    require!(shares <= total_shares, VsolError::InvalidPoolShares);
    let amount = (shares as u128)
        .checked_mul((total_assets as u128) + 1)
        .ok_or(VsolError::MathOverflow)?
        .checked_div((total_shares as u128) + 1)
        .ok_or(VsolError::MathOverflow)?;
    let amount = u64::try_from(amount).map_err(|_| error!(VsolError::MathOverflow))?;
    require!(amount > 0, VsolError::DepositTooSmall);
    Ok(amount)
}

/// The conditional-token winner rule: a market settles UP if the finalized
/// price is *strictly* above the market's strike, DOWN otherwise (an exact
/// tie goes to DOWN). Centralized here so `redeem_winning` (lib.rs) and its
/// tests share one definition instead of re-deriving the inequality inline.
///
/// Deliberately NOT built on `calculate_payout`: that function is a linear
/// spread ramp over `[strike, strike + width]` for the older per-position
/// payoff, not a binary threshold, and setting `width = 1` to approximate a
/// binary would make an exact tie (`price == strike`) pay neither side --
/// silently stranding collateral -- instead of resolving to DOWN as the
/// design requires.
pub fn up_wins(settlement_price: u64, strike: u64) -> bool {
    settlement_price > strike
}

/// The `redeem_unresolved` payout: a pro-rata share of the collateral vault,
/// `amount * vault_balance / total_supply`, computed in `u128` and checked
/// back down to `u64`. `total_supply` is `up_mint.supply + down_mint.supply`
/// -- the caller does that `checked_add` itself (in `u128`, since two `u64`
/// supplies can together exceed `u64::MAX`) before calling this function.
///
/// Why pro-rata rather than a hardcoded `amount / 2` -- see
/// `redeem_unresolved`'s doc comment in lib.rs for the full rationale, which
/// this function's own tests below pin:
/// - At the moment the hatch first opens (no redemptions yet), `vault_balance
///   == total_supply / 2` always holds (`mint_complete_set`/`burn_complete_set`
///   move all three by the identical amount every time), so this reduces to
///   exactly `amount / 2` -- the standard "unresolvable market resolves
///   50/50" convention.
/// - It stays exact under ANY redemption order: floor division leaves dust
///   in the vault after most redemptions, but whenever `amount ==
///   total_supply` (the last redemption once the other side has fully
///   drained), the payout is `amount * vault_balance / amount ==
///   vault_balance` exactly -- no residual dust, regardless of how much
///   floor-rounding dust accumulated in earlier redemptions.
///
/// `total_supply == 0` is rejected rather than silently dividing by zero --
/// see `VsolError::NothingToRedeem`.
pub fn calculate_pro_rata_redemption(amount: u64, vault_balance: u64, total_supply: u128) -> Result<u64> {
    require!(amount > 0, VsolError::InvalidAmount);
    require!(total_supply > 0, VsolError::NothingToRedeem);
    let payout = (amount as u128)
        .checked_mul(vault_balance as u128)
        .ok_or(VsolError::MathOverflow)?
        .checked_div(total_supply)
        .ok_or(VsolError::MathOverflow)?;
    u64::try_from(payout).map_err(|_| error!(VsolError::MathOverflow))
}

pub fn calculate_bps_limit(amount: u64, bps: u16) -> Result<u64> {
    let limit = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(VsolError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(VsolError::MathOverflow)?;
    u64::try_from(limit).map_err(|_| error!(VsolError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// The settlement split `settle_pool_position` performs once the fee is
    /// charged against the WINNING PAYOUT rather than the premium. Conservation
    /// must hold exactly -- the vault holds `premium + max_payout` and every
    /// atom of it has to leave -- and a LOSER must pay no fee at all.
    #[test]
    fn win_fee_splits_the_vault_exactly_and_never_taxes_a_loss() {
        let premium: u64 = 100_000_000; // $100
        let max_payout: u64 = 500_000_000; // $500
        let expected = premium + max_payout;
        let fee_bps: u16 = 500; // 5%

        for payout in [0u64, 1, 250_000_000, max_payout] {
            let fee = calculate_fee(payout, fee_bps).unwrap();
            let buyer = payout.checked_sub(fee).expect("fee can never exceed the payout");
            let pool = max_payout - payout + premium;
            assert_eq!(buyer + pool + fee, expected, "vault must split exactly at payout {payout}");
            if payout == 0 {
                assert_eq!(fee, 0, "a losing position must pay no protocol fee");
                assert_eq!(buyer, 0);
                assert_eq!(pool, expected, "the pool keeps the whole premium on a loss");
            } else {
                assert!(fee > 0, "a winning position must pay a fee at 5%");
            }
        }

        // A full win: the buyer keeps 95%, the treasury takes 5%, and the pool
        // still recovers exactly the premium it was paid.
        let fee = calculate_fee(max_payout, fee_bps).unwrap();
        assert_eq!(fee, 25_000_000, "5% of $500 is $25");
        assert_eq!(max_payout - fee, 475_000_000, "the winner nets $475");
        assert_eq!(max_payout - max_payout + premium, premium);
    }

    /// `fee_bps` is capped at MAX_FEE_BPS (10%), so the fee can never exceed the
    /// payout and `payout - fee` can never underflow -- the property the
    /// settlement path relies on.
    #[test]
    fn win_fee_never_exceeds_the_payout_at_any_allowed_rate() {
        for payout in [1u64, 7, 1_000, 999_999_999] {
            for bps in [1u16, 25, 500, 1_000] {
                let fee = calculate_fee(payout, bps).unwrap();
                assert!(fee <= payout, "fee {fee} exceeded payout {payout} at {bps} bps");
            }
        }
    }

    #[test]
    fn payout_is_linear_and_capped() {
        assert_eq!(calculate_payout(0, 100, 20, 90, 1_000).unwrap(), 0);
        assert_eq!(calculate_payout(0, 100, 20, 110, 1_000).unwrap(), 500);
        assert_eq!(calculate_payout(0, 100, 20, 150, 1_000).unwrap(), 1_000);
        assert_eq!(calculate_payout(1, 100, 20, 90, 1_000).unwrap(), 500);
        assert_eq!(calculate_payout(1, 100, 20, 50, 1_000).unwrap(), 1_000);
    }

    #[test]
    fn fees_round_up() {
        assert_eq!(calculate_fee(1, 25).unwrap(), 1);
        assert_eq!(calculate_fee(10_000, 25).unwrap(), 25);
        assert_eq!(calculate_fee(10_000, 0).unwrap(), 0);
    }

    #[test]
    fn up_wins_ties_go_to_down() {
        assert!(!up_wins(100, 100)); // exact tie -> DOWN
        assert!(up_wins(101, 100)); // strictly above -> UP
        assert!(!up_wins(99, 100)); // strictly below -> DOWN
        assert!(!up_wins(0, 0)); // tie at zero -> DOWN
        assert!(up_wins(1, 0));
    }

    #[test]
    fn pool_share_math_rounds_against_value_extraction() {
        assert_eq!(calculate_deposit_shares(1_000, 0, 0).unwrap(), 1_000);
        assert_eq!(calculate_deposit_shares(333, 1_000, 3_000).unwrap(), 111);
        // Pre-virtual-offset this was 333 (111 * 3_001 / 1_000, exact). With
        // the +1/+1 virtual offset the conversion is
        // 111 * (3_001 + 1) / (1_000 + 1) = 333_222 / 1_001 = 332 (floor) --
        // one unit of extra rounding dust left behind in the pool, which is
        // the deliberate cost of closing the first-depositor inflation
        // attack (see calculate_deposit_shares's doc comment).
        assert_eq!(calculate_withdraw_amount(111, 1_000, 3_001).unwrap(), 332);
        assert!(calculate_deposit_shares(1, 1, u64::MAX).is_err());
        assert!(calculate_deposit_shares(1, 1, 0).is_err());
        assert_eq!(calculate_bps_limit(10_000, 7_500).unwrap(), 7_500);
    }

    #[test]
    fn pro_rata_redemption_halves_exactly_at_the_moment_the_hatch_opens() {
        // vault == total_supply / 2 (S = 100 on each side, vault = 100,
        // total = 200) -- the invariant that always holds pre-redemption.
        // Redeeming 40 of one side is owed exactly 20, not a rounded
        // approximation.
        assert_eq!(calculate_pro_rata_redemption(40, 100, 200).unwrap(), 20);
        assert_eq!(calculate_pro_rata_redemption(100, 100, 200).unwrap(), 50);
    }

    #[test]
    fn pro_rata_redemption_drains_the_vault_exactly_when_amount_equals_total_supply() {
        // The "final redeemer" case: whatever is left of the vault is paid
        // out in full, with no dust, because the numerator is trivially
        // divisible by the denominator when they share the same value.
        assert_eq!(calculate_pro_rata_redemption(51, 51, 51).unwrap(), 51);
        assert_eq!(calculate_pro_rata_redemption(1, 999_999, 1).unwrap(), 999_999);
    }

    #[test]
    fn pro_rata_redemption_floors_and_leaves_dust_for_a_non_exact_split() {
        // 101 * 101 / 202 = 50.5 -> floors to 50, not 51 -- the dust that a
        // later, exact-final redemption picks up (see the drain test above).
        assert_eq!(calculate_pro_rata_redemption(101, 101, 202).unwrap(), 50);
    }

    #[test]
    fn pro_rata_redemption_rejects_zero_amount_and_zero_total_supply() {
        assert!(calculate_pro_rata_redemption(0, 100, 200).is_err());
        assert!(calculate_pro_rata_redemption(50, 0, 0).is_err());
    }

    proptest! {
        #[test]
        fn payout_never_exceeds_collateral(
            direction in 0u8..=1,
            strike in any::<u64>(),
            width in 1u64..=u64::MAX,
            price in any::<u64>(),
            max_payout in 1u64..=u64::MAX,
        ) {
            let payout = calculate_payout(direction, strike, width, price, max_payout).unwrap();
            prop_assert!(payout <= max_payout);
        }

        #[test]
        fn pro_rata_redemption_never_exceeds_the_vault(
            amount in 1u64..=u64::MAX,
            vault_balance in any::<u64>(),
            total_supply in 1u128..=(2 * u64::MAX as u128),
        ) {
            // amount can legally exceed total_supply here (this function does
            // not itself enforce amount <= total_supply -- the caller's own
            // mint-supply `checked_sub` after the burn is what would catch
            // that), so the payout can round up to more than vault_balance in
            // that out-of-range case. Restrict to the in-range case this
            // function is actually called under: amount <= total_supply.
            prop_assume!(u128::from(amount) <= total_supply);
            let payout = calculate_pro_rata_redemption(amount, vault_balance, total_supply).unwrap();
            prop_assert!(payout <= vault_balance);
        }

        #[test]
        fn up_wins_is_monotonic_in_price(
            strike in any::<u64>(),
            price in 0u64..u64::MAX,
        ) {
            // If `price` already wins for a given strike, every strictly
            // larger price must also win -- the winner rule never flips back
            // from UP to DOWN as the settlement price rises.
            if up_wins(price, strike) {
                prop_assert!(up_wins(price + 1, strike));
            }
        }

        #[test]
        fn up_wins_is_antitonic_in_strike(
            price in any::<u64>(),
            strike in 0u64..u64::MAX,
        ) {
            // Raising the strike can only ever make UP harder to win, never
            // easier.
            if !up_wins(price, strike) {
                prop_assert!(!up_wins(price, strike + 1));
            }
        }

        #[test]
        fn settlement_conserves_escrow(
            direction in 0u8..=1,
            strike in any::<u64>(),
            width in 1u64..=u64::MAX,
            price in any::<u64>(),
            max_payout in 1u64..=u64::MAX,
            premium in 1u64..=u64::MAX,
            fee_bps in 0u16..=1_000,
        ) {
            // Quotes whose total escrow exceeds u64 are rejected by fill_quote.
            prop_assume!(premium <= u64::MAX - max_payout);
            let payout = calculate_payout(direction, strike, width, price, max_payout).unwrap();
            let fee = calculate_fee(premium, fee_bps).unwrap();
            let maker = max_payout.checked_sub(payout).unwrap()
                .checked_add(premium).unwrap()
                .checked_sub(fee).unwrap();
            let distributed = (payout as u128) + (maker as u128) + (fee as u128);
            let escrowed = (max_payout as u128) + (premium as u128);
            prop_assert_eq!(distributed, escrowed);
        }
    }
}
