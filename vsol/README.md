# VSOL protocol

Anchor program and SDK for fully collateralized, cash-settled UP/DOWN positions on Solana.

The Pyth-integrated binary is deployed on devnet at `2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v`. The checked-in manifest contains five session-aligned NVDA markets, a funded passive-liquidity pool, and independent evidence for direct-maker and pooled fills, nonce-replay rejection, Pyth settlement, account closure, timeout refund, pool accounting conservation, and complete LP withdrawal.

This is a devnet system, not a mainnet release. Executable quotes fail closed whenever the deployment flag, session, cutoff, oracle configuration, data freshness, pool authorization, collateral limits, or server-side signing configuration is invalid.

## Layout

- `programs/vsol`: on-chain program
- `sdk`: quote codecs, share math, payout helpers, and PDA derivations
- `scripts/bootstrap.ts`: idempotent market/pool setup plus adversarial direct and pooled smoke lifecycles
- `scripts/keeper.ts`: lightweight, idempotent series keeper -- mints the next rolling markets and authorizes them on the passive pool
- `scripts/lib/expiry-grid.ts`: the shared rolling 15M/1H/EOD/7D/30D UTC grid logic used by both bootstrap and the keeper
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

The scheduler is timezone- and weekend-aware, but it does not yet include an authoritative exchange holiday or early-close calendar. Do not use the generated schedule on mainnet without that calendar.

Short-dated rungs (15M, 1H) expire within the hour, so something has to keep minting the next rung or intraday trading goes dead between bootstrap runs -- that is what `scripts/keeper.ts` is for.

## Series keeper

`bootstrap.ts` is a heavyweight, one-shot, adversarial setup script -- it funds signers, mints test assets, and runs a full smoke lifecycle. It is not meant to run on a schedule. `scripts/keeper.ts` is the lightweight counterpart: on every run it computes the current five-rung grid with the same `rollingMarketSchedule` helper bootstrap uses (from `scripts/lib/expiry-grid.ts`, so the two can never drift), then for each rung:

- Creates the market if it doesn't exist yet (skips silently if it does -- this is the normal case).
- Authorizes the series on the deployed passive liquidity pool if that authorization is missing or stale (skips if already current).

It never disables anything, never moves funds, never touches expired series, and never writes the deployment manifest -- it only adds what's missing. It is idempotent and concurrency-tolerant: running two keepers at once, or running it back-to-back with no new rungs due, is a no-op ("skip" lines only) and still exits 0.

Market creation is permissionless, so **anyone with a funded key can run a keeper**. Only the pool-authorization step needs the pool's manager key; on devnet that is the same persisted `.devnet/<cluster>-creator.json` signer bootstrap already uses. If the pool currently has open positions or locked collateral, `set_liquidity_pool_market` reverts on-chain -- the keeper detects this and logs a clear skip for that rung instead of failing the run; it will succeed on a later pass once positions settle.

It is safe to run on a short interval -- every 5 minutes is a reasonable default for keeping the intraday rungs alive:

```bash
npm run keeper
```

## Commands

```bash
npm run check
npm run devnet:bootstrap
npm run devnet:verify
npm run keeper
```

The bootstrap script creates only mock assets and local ignored test signers. It posts a fully verified Pyth price update through the official receiver, publishes permissionless settlement, verifies successful settlement and timeout refund, then writes the deployment-ready flag. Never commit `.devnet`, deployment keypairs, upgrade authorities, or funded wallets.

`devnet:verify` reads the deployment in two batched RPC operations: one account batch and one transaction-history batch. Run it against the configured Helius endpoint in deployment CI to avoid public-devnet rate limits.
