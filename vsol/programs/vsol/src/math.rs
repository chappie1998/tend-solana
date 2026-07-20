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
pub fn calculate_fee(premium: u64, fee_bps: u16) -> Result<u64> {
    if premium == 0 || fee_bps == 0 {
        return Ok(0);
    }

    let numerator = (premium as u128)
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
pub fn calculate_deposit_shares(amount: u64, total_shares: u64, total_assets: u64) -> Result<u64> {
    require!(amount > 0, VsolError::InvalidAmount);
    if total_shares == 0 {
        return Ok(amount);
    }
    require!(total_assets > 0, VsolError::PoolInsolvent);
    let shares = (amount as u128)
        .checked_mul(total_shares as u128)
        .ok_or(VsolError::MathOverflow)?
        .checked_div(total_assets as u128)
        .ok_or(VsolError::MathOverflow)?;
    let shares = u64::try_from(shares).map_err(|_| error!(VsolError::MathOverflow))?;
    require!(shares > 0, VsolError::DepositTooSmall);
    Ok(shares)
}

/// Returns underlying assets conservatively. Withdrawals round down and leave
/// any division dust in the pool for remaining providers.
pub fn calculate_withdraw_amount(shares: u64, total_shares: u64, total_assets: u64) -> Result<u64> {
    require!(shares > 0, VsolError::InvalidAmount);
    require!(total_shares > 0, VsolError::InvalidPoolShares);
    require!(shares <= total_shares, VsolError::InvalidPoolShares);
    let amount = (shares as u128)
        .checked_mul(total_assets as u128)
        .ok_or(VsolError::MathOverflow)?
        .checked_div(total_shares as u128)
        .ok_or(VsolError::MathOverflow)?;
    let amount = u64::try_from(amount).map_err(|_| error!(VsolError::MathOverflow))?;
    require!(amount > 0, VsolError::DepositTooSmall);
    Ok(amount)
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
    fn pool_share_math_rounds_against_value_extraction() {
        assert_eq!(calculate_deposit_shares(1_000, 0, 0).unwrap(), 1_000);
        assert_eq!(calculate_deposit_shares(333, 1_000, 3_000).unwrap(), 111);
        assert_eq!(calculate_withdraw_amount(111, 1_000, 3_001).unwrap(), 333);
        assert!(calculate_deposit_shares(1, 1, u64::MAX).is_err());
        assert!(calculate_deposit_shares(1, 1, 0).is_err());
        assert_eq!(calculate_bps_limit(10_000, 7_500).unwrap(), 7_500);
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
