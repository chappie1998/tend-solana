use anchor_lang::prelude::*;
use solana_instructions_sysvar as instructions;

use crate::{
    PoolBuybackArgs, PoolQuoteArgs, QuoteArgs, VsolError, POOL_BUYBACK_DOMAIN, POOL_QUOTE_DOMAIN, QUOTE_DOMAIN,
};

const ED25519_HEADER_LEN: usize = solana_ed25519_program::DATA_START;
const CURRENT_INSTRUCTION: u16 = u16::MAX;

pub struct QuoteMessageContext<'a> {
    pub program_id: &'a Pubkey,
    pub config: &'a Pubkey,
    pub market: &'a Pubkey,
    pub buyer: &'a Pubkey,
    pub maker: &'a Pubkey,
}

pub struct PoolQuoteMessageContext<'a> {
    pub program_id: &'a Pubkey,
    pub config: &'a Pubkey,
    pub pool: &'a Pubkey,
    pub market: &'a Pubkey,
    pub buyer: &'a Pubkey,
    pub quote_authority: &'a Pubkey,
}

pub fn quote_message(
    domain_separator: &[u8; 32],
    domain_version: u16,
    context: &QuoteMessageContext<'_>,
    quote: &QuoteArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(251);
    message.extend_from_slice(QUOTE_DOMAIN);
    message.extend_from_slice(domain_separator);
    message.extend_from_slice(&domain_version.to_le_bytes());
    message.extend_from_slice(context.program_id.as_ref());
    message.extend_from_slice(context.config.as_ref());
    message.extend_from_slice(context.market.as_ref());
    message.extend_from_slice(context.buyer.as_ref());
    message.extend_from_slice(context.maker.as_ref());
    message.extend_from_slice(&quote.nonce.to_le_bytes());
    message.push(quote.direction);
    message.extend_from_slice(&quote.strike.to_le_bytes());
    message.extend_from_slice(&quote.width.to_le_bytes());
    message.extend_from_slice(&quote.premium.to_le_bytes());
    message.extend_from_slice(&quote.max_payout.to_le_bytes());
    message.extend_from_slice(&quote.quote_expiry.to_le_bytes());
    message
}

pub fn pool_quote_message(
    domain_separator: &[u8; 32],
    domain_version: u16,
    context: &PoolQuoteMessageContext<'_>,
    quote: &PoolQuoteArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(283);
    message.extend_from_slice(POOL_QUOTE_DOMAIN);
    message.extend_from_slice(domain_separator);
    message.extend_from_slice(&domain_version.to_le_bytes());
    message.extend_from_slice(context.program_id.as_ref());
    message.extend_from_slice(context.config.as_ref());
    message.extend_from_slice(context.pool.as_ref());
    message.extend_from_slice(context.market.as_ref());
    message.extend_from_slice(context.buyer.as_ref());
    message.extend_from_slice(context.quote_authority.as_ref());
    message.extend_from_slice(&quote.nonce.to_le_bytes());
    message.push(quote.direction);
    message.extend_from_slice(&quote.strike.to_le_bytes());
    message.extend_from_slice(&quote.width.to_le_bytes());
    message.extend_from_slice(&quote.premium.to_le_bytes());
    message.extend_from_slice(&quote.max_payout.to_le_bytes());
    message.extend_from_slice(&quote.quote_expiry.to_le_bytes());
    message
}

/// Context for a signed early-close buyback quote (see `close_pool_position`).
/// Binds the exact `position` pubkey (as well as `pool` and `quote_authority`)
/// so a signature for one position can never be replayed against another,
/// even though closing a position also consumes its account outright.
pub struct PoolBuybackMessageContext<'a> {
    pub program_id: &'a Pubkey,
    pub config: &'a Pubkey,
    pub pool: &'a Pubkey,
    pub market: &'a Pubkey,
    pub position: &'a Pubkey,
    pub buyer: &'a Pubkey,
    pub quote_authority: &'a Pubkey,
}

pub fn pool_buyback_message(
    domain_separator: &[u8; 32],
    domain_version: u16,
    context: &PoolBuybackMessageContext<'_>,
    args: &PoolBuybackArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(290);
    message.extend_from_slice(POOL_BUYBACK_DOMAIN);
    message.extend_from_slice(domain_separator);
    message.extend_from_slice(&domain_version.to_le_bytes());
    message.extend_from_slice(context.program_id.as_ref());
    message.extend_from_slice(context.config.as_ref());
    message.extend_from_slice(context.pool.as_ref());
    message.extend_from_slice(context.market.as_ref());
    message.extend_from_slice(context.position.as_ref());
    message.extend_from_slice(context.buyer.as_ref());
    message.extend_from_slice(context.quote_authority.as_ref());
    message.extend_from_slice(&args.buyback_amount.to_le_bytes());
    message.extend_from_slice(&args.min_proceeds.to_le_bytes());
    message.extend_from_slice(&args.quote_expiry.to_le_bytes());
    message
}

pub fn verify_preceding_ed25519_instruction(
    instructions_sysvar: &AccountInfo<'_>,
    maker: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = instructions::load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(VsolError::InvalidMakerSignature))?;
    require!(current_index > 0, VsolError::MissingMakerSignature);

    let ix = instructions::load_instruction_at_checked(
        usize::from(current_index - 1),
        instructions_sysvar,
    )
    .map_err(|_| error!(VsolError::InvalidMakerSignature))?;

    require_keys_eq!(
        ix.program_id,
        solana_sdk_ids::ed25519_program::ID,
        VsolError::InvalidMakerSignature
    );
    require!(ix.accounts.is_empty(), VsolError::InvalidMakerSignature);
    require!(
        ix.data.len() >= ED25519_HEADER_LEN,
        VsolError::InvalidMakerSignature
    );
    require!(
        ix.data[0] == 1 && ix.data[1] == 0,
        VsolError::InvalidMakerSignature
    );

    let read_u16 = |offset: usize| -> Result<u16> {
        let bytes: [u8; 2] = ix
            .data
            .get(offset..offset + 2)
            .ok_or(VsolError::InvalidMakerSignature)?
            .try_into()
            .map_err(|_| error!(VsolError::InvalidMakerSignature))?;
        Ok(u16::from_le_bytes(bytes))
    };

    let signature_offset = usize::from(read_u16(2)?);
    let signature_instruction_index = read_u16(4)?;
    let public_key_offset = usize::from(read_u16(6)?);
    let public_key_instruction_index = read_u16(8)?;
    let message_offset = usize::from(read_u16(10)?);
    let message_size = usize::from(read_u16(12)?);
    let message_instruction_index = read_u16(14)?;

    require!(
        signature_instruction_index == CURRENT_INSTRUCTION
            && public_key_instruction_index == CURRENT_INSTRUCTION
            && message_instruction_index == CURRENT_INSTRUCTION,
        VsolError::InvalidMakerSignature
    );
    require!(
        message_size == expected_message.len(),
        VsolError::InvalidMakerSignature
    );

    let signature_end = signature_offset
        .checked_add(solana_ed25519_program::SIGNATURE_SERIALIZED_SIZE)
        .ok_or(VsolError::InvalidMakerSignature)?;
    let public_key_end = public_key_offset
        .checked_add(solana_ed25519_program::PUBKEY_SERIALIZED_SIZE)
        .ok_or(VsolError::InvalidMakerSignature)?;
    let message_end = message_offset
        .checked_add(message_size)
        .ok_or(VsolError::InvalidMakerSignature)?;
    require!(
        signature_end <= ix.data.len()
            && public_key_end <= ix.data.len()
            && message_end <= ix.data.len(),
        VsolError::InvalidMakerSignature
    );

    require!(
        ix.data[public_key_offset..public_key_end] == maker.to_bytes(),
        VsolError::InvalidMakerSignature
    );
    require!(
        ix.data[message_offset..message_end] == *expected_message,
        VsolError::InvalidMakerSignature
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_message_is_domain_separated_and_fixed_length() {
        let quote = QuoteArgs {
            nonce: 7,
            direction: 0,
            strike: 100_000_000,
            width: 20_000_000,
            premium: 1_000_000,
            max_payout: 5_000_000,
            quote_expiry: 1_900_000_000,
        };
        let context = QuoteMessageContext {
            program_id: &crate::ID,
            config: &Pubkey::new_unique(),
            market: &Pubkey::new_unique(),
            buyer: &Pubkey::new_unique(),
            maker: &Pubkey::new_unique(),
        };
        let message = quote_message(&[9u8; 32], 1, &context, &quote);
        assert_eq!(&message[..QUOTE_DOMAIN.len()], QUOTE_DOMAIN);
        assert_eq!(message.len(), 251);
    }

    #[test]
    fn pool_quote_binds_pool_and_authority() {
        let quote = PoolQuoteArgs {
            nonce: 8,
            direction: 1,
            strike: 100_000_000,
            width: 20_000_000,
            premium: 1_000_000,
            max_payout: 5_000_000,
            quote_expiry: 1_900_000_000,
        };
        let context = PoolQuoteMessageContext {
            program_id: &crate::ID,
            config: &Pubkey::new_unique(),
            pool: &Pubkey::new_unique(),
            market: &Pubkey::new_unique(),
            buyer: &Pubkey::new_unique(),
            quote_authority: &Pubkey::new_unique(),
        };
        let message = pool_quote_message(&[3u8; 32], 2, &context, &quote);
        assert_eq!(&message[..POOL_QUOTE_DOMAIN.len()], POOL_QUOTE_DOMAIN);
        assert_eq!(message.len(), 283);
    }

    #[test]
    fn pool_buyback_message_is_domain_separated_and_binds_the_exact_position() {
        let args = PoolBuybackArgs {
            buyback_amount: 4_000_000,
            min_proceeds: 3_900_000,
            quote_expiry: 1_900_000_000,
        };
        let context = PoolBuybackMessageContext {
            program_id: &crate::ID,
            config: &Pubkey::new_unique(),
            pool: &Pubkey::new_unique(),
            market: &Pubkey::new_unique(),
            position: &Pubkey::new_unique(),
            buyer: &Pubkey::new_unique(),
            quote_authority: &Pubkey::new_unique(),
        };
        let message = pool_buyback_message(&[7u8; 32], 3, &context, &args);
        assert_eq!(&message[..POOL_BUYBACK_DOMAIN.len()], POOL_BUYBACK_DOMAIN);
        assert_eq!(message.len(), 290);

        let mut different_position_context = PoolBuybackMessageContext {
            position: &Pubkey::new_unique(),
            ..context
        };
        let different_message = pool_buyback_message(&[7u8; 32], 3, &different_position_context, &args);
        assert_ne!(message, different_message);
        different_position_context.position = context.position;
        assert_eq!(
            message,
            pool_buyback_message(&[7u8; 32], 3, &different_position_context, &args)
        );
    }

    /// Known-answer vector shared with `vsol/tests/sdk.test.ts` (the
    /// TypeScript SDK's `poolBuybackMessage`), the same way `expected_market_id`
    /// and `deriveMarketId` share one. Byte-for-byte parity between the two
    /// implementations is what lets an off-chain server sign a quote the
    /// on-chain program will accept.
    #[test]
    fn pool_buyback_message_matches_the_pinned_known_answer_vector() {
        let args = PoolBuybackArgs {
            buyback_amount: 1_234_567,
            min_proceeds: 1_000_000,
            quote_expiry: 1_800_000_000,
        };
        let config = Pubkey::new_from_array([0x01u8; 32]);
        let pool = Pubkey::new_from_array([0x02u8; 32]);
        let market = Pubkey::new_from_array([0x03u8; 32]);
        let position = Pubkey::new_from_array([0x04u8; 32]);
        let buyer = Pubkey::new_from_array([0x05u8; 32]);
        let quote_authority = Pubkey::new_from_array([0x06u8; 32]);
        let context = PoolBuybackMessageContext {
            program_id: &crate::ID,
            config: &config,
            pool: &pool,
            market: &market,
            position: &position,
            buyer: &buyer,
            quote_authority: &quote_authority,
        };
        let message = pool_buyback_message(&[0x07u8; 32], 5, &context, &args);
        let hex: String = message.iter().map(|byte| format!("{:02x}", byte)).collect();
        assert_eq!(
            hex,
            "56534f4c434c5331070707070707070707070707070707070707070707070707070707070707070705001570683178d1dc41d13a545d59af13f8577f6e7511f2f103b1f718085a25a0d901010101010101010101010101010101010101010101010101010101010101010202020202020202020202020202020202020202020202020202020202020202030303030303030303030303030303030303030303030303030303030303030304040404040404040404040404040404040404040404040404040404040404040505050505050505050505050505050505050505050505050505050505050505060606060606060606060606060606060606060606060606060606060606060687d612000000000040420f000000000000d2496b00000000"
        );
    }
}
