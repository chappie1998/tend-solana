use anchor_lang::prelude::*;

use crate::VsolError;

// Upgraded Pyth Solana Receiver deployment documented for all Solana clusters.
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    12, 183, 250, 187, 82, 247, 166, 72, 187, 91, 49, 125, 154, 1, 139, 144, 87, 203, 2, 71, 116,
    250, 254, 1, 230, 196, 223, 152, 204, 56, 88, 129,
]);

// sha256("account:PriceUpdateV2")[0..8].
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
const FULL_VERIFICATION_VARIANT: u8 = 1;
const FULL_UPDATE_MINIMUM_LENGTH: usize = 133;
const VERIFICATION_OFFSET: usize = 40;
const FEED_ID_OFFSET: usize = 41;
const PRICE_OFFSET: usize = 73;
const CONFIDENCE_OFFSET: usize = 81;
const EXPONENT_OFFSET: usize = 89;
const PUBLISH_TIME_OFFSET: usize = 93;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythPrice {
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

fn bytes<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    data.get(offset..offset + N)
        .ok_or_else(|| error!(VsolError::InvalidPythPriceUpdate))?
        .try_into()
        .map_err(|_| error!(VsolError::InvalidPythPriceUpdate))
}

pub fn parse_fully_verified_price_update(
    account: &AccountInfo<'_>,
    expected_feed_id: [u8; 32],
) -> Result<PythPrice> {
    require_keys_eq!(
        *account.owner,
        PYTH_RECEIVER_PROGRAM_ID,
        VsolError::InvalidPythPriceUpdate
    );
    let data = account
        .try_borrow_data()
        .map_err(|_| error!(VsolError::InvalidPythPriceUpdate))?;
    require!(
        data.len() >= FULL_UPDATE_MINIMUM_LENGTH,
        VsolError::InvalidPythPriceUpdate
    );
    require!(
        data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        VsolError::InvalidPythPriceUpdate
    );
    // Borsh encodes VerificationLevel::Full as variant byte 1 with no payload.
    // Partial updates have variant byte 0 followed by num_signatures and therefore
    // a different field offset. Rejecting them also makes offset parsing unambiguous.
    require!(
        data[VERIFICATION_OFFSET] == FULL_VERIFICATION_VARIANT,
        VsolError::InvalidPythPriceUpdate
    );
    let feed_id = bytes::<32>(&data, FEED_ID_OFFSET)?;
    require!(
        feed_id == expected_feed_id,
        VsolError::InvalidPythPriceUpdate
    );

    Ok(PythPrice {
        price: i64::from_le_bytes(bytes::<8>(&data, PRICE_OFFSET)?),
        conf: u64::from_le_bytes(bytes::<8>(&data, CONFIDENCE_OFFSET)?),
        exponent: i32::from_le_bytes(bytes::<4>(&data, EXPONENT_OFFSET)?),
        publish_time: i64::from_le_bytes(bytes::<8>(&data, PUBLISH_TIME_OFFSET)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_data(feed_id: [u8; 32], verification_variant: u8) -> Vec<u8> {
        let mut data = vec![0_u8; FULL_UPDATE_MINIMUM_LENGTH];
        data[..8].copy_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        data[VERIFICATION_OFFSET] = verification_variant;
        if verification_variant == FULL_VERIFICATION_VARIANT {
            data[FEED_ID_OFFSET..FEED_ID_OFFSET + 32].copy_from_slice(&feed_id);
            data[PRICE_OFFSET..PRICE_OFFSET + 8].copy_from_slice(&20_405_953_i64.to_le_bytes());
            data[CONFIDENCE_OFFSET..CONFIDENCE_OFFSET + 8]
                .copy_from_slice(&10_209_u64.to_le_bytes());
            data[EXPONENT_OFFSET..EXPONENT_OFFSET + 4].copy_from_slice(&(-5_i32).to_le_bytes());
            data[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8]
                .copy_from_slice(&1_784_311_626_i64.to_le_bytes());
        }
        data
    }

    #[test]
    fn parses_only_full_receiver_owned_update_for_expected_feed() {
        let feed_id = [7_u8; 32];
        let mut lamports = 0;
        let mut data = account_data(feed_id, FULL_VERIFICATION_VARIANT);
        let key = Pubkey::new_unique();
        let account = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &PYTH_RECEIVER_PROGRAM_ID,
            false,
        );
        let parsed = parse_fully_verified_price_update(&account, feed_id).unwrap();
        assert_eq!(parsed.price, 20_405_953);
        assert_eq!(parsed.conf, 10_209);
        assert_eq!(parsed.exponent, -5);
        assert_eq!(parsed.publish_time, 1_784_311_626);
        assert!(parse_fully_verified_price_update(&account, [8_u8; 32]).is_err());
    }

    #[test]
    fn rejects_partial_and_wrong_owner_updates() {
        let feed_id = [7_u8; 32];
        let key = Pubkey::new_unique();
        let mut lamports = 0;
        let mut partial_data = account_data(feed_id, 0);
        let partial = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut partial_data,
            &PYTH_RECEIVER_PROGRAM_ID,
            false,
        );
        assert!(parse_fully_verified_price_update(&partial, feed_id).is_err());

        let wrong_owner = Pubkey::new_unique();
        let mut other_lamports = 0;
        let mut full_data = account_data(feed_id, FULL_VERIFICATION_VARIANT);
        let full = AccountInfo::new(
            &key,
            false,
            false,
            &mut other_lamports,
            &mut full_data,
            &wrong_owner,
            false,
        );
        assert!(parse_fully_verified_price_update(&full, feed_id).is_err());
    }
}
