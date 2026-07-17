# Tend

Defined-risk markets for tokenized assets on Robinhood Chain.

Tend gives traders an UP/DOWN interface while exposing the option economics that matter: premium, implied volatility, target price, maximum loss, and potential payout. Market makers compete through signed RFQs and lock the maximum possible payout before a position opens.

> Preview status: the product runs end to end with server-generated RFQs and durable position records, but it intentionally sends no wallet transactions. The Solidity contracts are unaudited and undeployed. Do not use with real funds.

## Why Robinhood Chain first

- Canonical stock tokens and their users already live there.
- It is EVM-compatible, so Tend uses standard Solidity tooling.
- Robinhood publishes the canonical token contract registry.
- Chainlink is the documented oracle partner.
- The protocol remains portable to Monad because the core contract has no chain-specific opcodes.

Network configuration:

| Network | Chain ID | RPC |
| --- | ---: | --- |
| Robinhood Chain | 4663 | `https://rpc.mainnet.chain.robinhood.com` |
| Robinhood Chain Testnet | 46630 | `https://rpc.testnet.chain.robinhood.com` |

## Product surface

- Simple UP/DOWN trade builder with 2×, 5×, and 10× capped payoff profiles
- Session-aware 15-minute, 1-hour, market-close, 7-day, and 30-day expiries
- TradingView Lightweight Charts with 1m, 5m, 15m, 1h, and daily candles
- Licensed Massive market-data adapter with explicit live, delayed, error, and demo states
- Competitive three-maker RFQs generated and stored by the server, with 30-second expiry and single-use execution
- Transparent maximum loss, IV, premium, and payout
- Durable D1-backed portfolio records, replay protection, and CSV export
- Writer desk with locked collateral, obligations, utilization, and stress P&L
- Injected-wallet connection and Robinhood Chain testnet switching
- Responsive mobile navigation and keyboard-accessible controls
- Canonical NVDA, TSLA, QQQ, and SPCX token addresses

Intraday expiries are restricted to the US reference session and are unavailable for SPCX. Every short-duration quote carries a no-trade buffer before expiry and an explicit post-expiry oracle observation window. The chart is display-only and is never a settlement oracle.

Without `MASSIVE_API_KEY`, Tend deliberately renders deterministic candles under a prominent **DEMO DATA** watermark. It never substitutes simulated values while claiming that a feed is live. Even with the licensed feed configured, the UI exposes its source, timestamp, and freshness state.

The application never trusts quote economics supplied by the browser. A preview position can only consume a live, server-owned RFQ, and the quote ID is unique so retries cannot create duplicate fills.

## Contract prototype

[`contracts/TendMarket.sol`](contracts/TendMarket.sol) implements:

- EIP-712 maker-signed quotes
- maker, oracle, underlying-token, and collateral-token allowlists
- optional per-market eligibility checks
- quote deadlines, maker nonces, cancellation, and replay protection
- exact maximum-payout collateral locking
- capped linear UP/DOWN settlement
- separate owner and emergency pause authority
- settlement while new fills are paused
- conservative ERC-20 transfer handling and reentrancy protection
- exact-balance collateral checks that reject fee-on-transfer or underfunded deposits
- signed per-position observation windows and pre-expiry trade locks
- settlement rejection unless the oracle finalizes the complete requested window

The settlement oracle is an adapter interface, not a chart or client-provided price. A production adapter must finalize the exact signed expiry observation window, reject stale/deviating data, and handle corporate-action adjustments.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

To enable licensed public-equity display data, set `MASSIVE_API_KEY`. SPCX remains indicative until an approved issuer/oracle feed is integrated.

Verification:

```bash
npm run lint
npm run test
npm run build
npm run test:contracts
```

The test suite covers the product surface, server-owned RFQs, D1 persistence, quote replay protection, contract safety gates, deterministic UP/DOWN payouts, and 256 fuzz runs asserting that payouts cannot exceed locked collateral.

## Preview architecture

1. The browser loads display candles from `/api/market-data`, which surfaces source and freshness and falls back to clearly marked demo data.
2. The browser submits a validated trade intent and expiry code to `/api/quotes`.
3. The server enforces market-session eligibility, calculates, and persists three normalized RFQs.
4. The user selects a live quote and reviews the economics, trade lock, and settlement window.
5. `/api/positions` reads the quote from D1, atomically records the position, and consumes the quote.
6. The Portfolio screen reloads the owner-scoped record from D1.

State-changing preview requests are same-origin checked. Production reads and writes are scoped to the private-site identity forwarded by the hosting runtime; localhost uses an explicit development fallback.

## Before testnet deployment

Tend still needs:

1. A throwaway Robinhood Chain testnet deployer funded with test ETH.
2. Testnet USDG/mock collateral and settlement-oracle adapter addresses.
3. The exact first-market settlement window and corporate-action policy.
4. At least two committed market-maker test wallets.
5. Jurisdiction and eligibility rules reviewed by qualified counsel.
6. A licensed market-data plan and production-grade market-calendar service for holiday and halt handling.

Before mainnet, require an independent contract audit, multisig ownership, timelocked parameter changes, adversarial oracle tests, transfer-restriction tests, and a documented incident response plan.

## Official references

- [Robinhood Chain overview](https://docs.robinhood.com/chain/)
- [Network configuration](https://docs.robinhood.com/chain/connecting/)
- [Canonical token contracts](https://docs.robinhood.com/chain/contracts/)
- [Contract deployment guide](https://docs.robinhood.com/chain/deploy-smart-contracts/)
