# VSOL protocol

Anchor program and SDK for fully collateralized, cash-settled UP/DOWN positions on Solana.

The Pyth-integrated binary is deployed on devnet at `2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v`. The checked-in manifest contains five session-aligned NVDA markets, a funded passive-liquidity pool, and independent evidence for direct-maker and pooled fills, nonce-replay rejection, Pyth settlement, account closure, timeout refund, pool accounting conservation, and complete LP withdrawal.

This is a devnet system, not a mainnet release. Executable quotes fail closed whenever the deployment flag, session, cutoff, oracle configuration, data freshness, pool authorization, collateral limits, or server-side signing configuration is invalid.

## Layout

- `programs/vsol`: on-chain program
- `sdk`: quote codecs, share math, payout helpers, and PDA derivations
- `scripts/bootstrap.ts`: idempotent market/pool setup plus adversarial direct and pooled smoke lifecycles
- `scripts/verify-deployment.ts`: batched independent account and transaction verifier
- `deployments/devnet.json`: public deployment evidence
- `target/idl` and `target/types`: generated client interface tracked for the web build

## Execution paths

The original direct-maker RFQ path remains layout-compatible. A maker owns a fully collateralized writer vault and signs a one-use quote for a buyer.

The additive pooled path separates three roles:

- Liquidity providers deposit settlement tokens and receive internal, pro-rata shares.
- A pool quote authority prices risk but cannot withdraw provider capital.
- Any buyer can fill a signed one-use pool quote for an authorized market, subject to the pool's utilization and per-position caps.

Pool deposits and withdrawals are allowed only when the pool has no open obligations. Settlement and timeout refunds return escrow to the exact pool PDA vault. The deployed devnet pool has 20,000 mock tUSDC and authorizes the full five-market NVDA catalog.

## Rolling market catalog

`bootstrap.ts` builds `15M`, `1H`, `EOD`, `7D`, and `30D` expiries on weekday US reference sessions. Intraday duration means at least 15 or 60 real minutes; it is never silently shortened to the next close. Every market uses a 30-second Pyth observation window, a trade cutoff before expiry, and a 15-minute settlement grace period. The former midnight-expiry NVDA market is disabled.

The scheduler is timezone- and weekend-aware, but it does not yet include an authoritative exchange holiday or early-close calendar. Do not use the generated schedule on mainnet without that calendar and an automated series keeper.

## Commands

```bash
npm run check
npm run devnet:bootstrap
npm run devnet:verify
```

The bootstrap script creates only mock assets and local ignored test signers. It posts a fully verified Pyth price update through the official receiver, publishes permissionless settlement, verifies successful settlement and timeout refund, then writes the deployment-ready flag. Never commit `.devnet`, deployment keypairs, upgrade authorities, or funded wallets.

`devnet:verify` reads the deployment in two batched RPC operations: one account batch and one transaction-history batch. Run it against the configured Helius endpoint in deployment CI to avoid public-devnet rate limits.
