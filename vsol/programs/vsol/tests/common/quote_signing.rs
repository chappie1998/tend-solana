//! Mirrors `programs/vsol/src/signature.rs` byte-for-byte so this test suite
//! can construct the exact message a maker/quote-authority must sign.
//!
//! The on-chain `quote_message`/`pool_quote_message` helpers and their
//! context structs are private to the `vsol` crate (`mod signature;`, not
//! `pub mod`), the same way `scripts/bootstrap.ts` and `sdk/index.ts` mirror
//! them in TypeScript for the exact same reason: an off-chain signer needs to
//! reproduce the identical bytes the program hashes against the Ed25519
//! precompile's message field. This is a test-only duplication of a *layout*,
//! not a reimplementation of any validation logic.

use super::Pubkey;

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
    quote: &vsol::QuoteArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(251);
    message.extend_from_slice(vsol::QUOTE_DOMAIN);
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
    quote: &vsol::PoolQuoteArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(283);
    message.extend_from_slice(vsol::POOL_QUOTE_DOMAIN);
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
    args: &vsol::PoolBuybackArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(290);
    message.extend_from_slice(vsol::POOL_BUYBACK_DOMAIN);
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
