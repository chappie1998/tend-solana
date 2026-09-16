# VSOL by Tend

VSOL is Tend’s Solana-native defined-risk options protocol. This `sol` branch contains the web application, Anchor program, TypeScript SDK, database migrations, and devnet deployment tools. The `main` branch remains the Robinhood Chain product.

> Status: the Pyth-enabled program is deployed and lifecycle-verified on Solana devnet. The checked-in manifest is marked `pythUpgradeDeployed: true` only after real fill, replay-rejection, Pyth settlement, escrow-close, timeout, and refund proofs passed. Assets remain valueless mock tokens. The code has not received an independent audit. Never use real funds.

## Existing devnet deployment

| Component | Address |
| --- | --- |
| Program | `2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v` |
| Config | `688RQvX2SEpnSuEndbjvRivFQpMzGjaz8hhGvAPGj1bY` |
| Pyth-bound NVDA market | `FoXzcwgxDqvgEdFEqsne3H14nzWCcu3dnqNPQUS3RnaH` |
| Settlement mint | `EaU6Yus9b7SWz3gzRNMuerpn1U9mYpfm996CQd2Lzhh4` |

The program upgrade transaction and every lifecycle proof are recorded in `vsol/deployments/devnet.json`. The bootstrap changes `pythUpgradeDeployed` to `true` only after all onchain checks pass; the independent verifier then re-reads program ownership, market/feed binding, oracle contents, closed position accounts, and transaction logs.

## Product flow

1. Connect an injected Solana wallet such as Phantom.
2. The private devnet faucet funds that wallet with mock tUSDC and a small amount of devnet SOL.
3. Request an RFQ. The server signs the exact buyer, maker, market, economics, nonce, program, cluster, and configuration version.
4. Review the defined payoff and sign the serialized transaction in the wallet.
5. The server validates the exact instruction/account set, verifies signatures, simulates with signature checks, and persists a content-hashed simulation record before submitting.
6. The portfolio record is created only after the backend independently verifies the confirmed on-chain fill and its linked passing simulation.

The market panel renders real Pyth Benchmarks OHLC history locally with TradingView Lightweight Charts and is display-only. Pyth Core Hermes supplies the independently displayed reference price and 20-session realized-volatility input. Onchain settlement accepts only a fully verified upgraded Pyth `PriceUpdateV2`, exact feed ID, bounded confidence, expiry observation window, and maximum age. Short-duration series are represented but remain disabled until exact onchain markets are published.

## Protocol design

- Program-owned PDA writer vaults and per-position escrow vaults
- Fully collateralized maximum payout before every fill
- Buyer-paid premium with no liquidation path
- Immediate-preceding Ed25519 maker-signature verification
- One-shot maker nonce PDAs for replay prevention
- Genesis-hash and config-version domain separation
- Fill-time fee snapshots so later governance updates cannot alter open-position fees
- Linear capped UP/DOWN settlement using checked `u128` arithmetic
- Separate admin, pause, and eligibility authorities
- Optional wallet eligibility records
- Permissionless Pyth settlement publication; no administrator-selected price
- Settlement remains available while new fills are paused
- Deterministic refund if the oracle misses its settlement deadline
- SPL Token classic only in v1 to avoid transfer-fee ambiguity

## Local development

Requirements: Node.js 24+, Rust 1.89, Solana CLI 3.1.10, and Anchor CLI 1.0.2.

```bash
npm install
npm --prefix vsol install
npm run dev
```

The app needs two isolated devnet-only server secrets:

```text
VSOL_MAKER_SECRET_KEY=<JSON byte array or base64-encoded JSON>
VSOL_FAUCET_SECRET_KEY=<JSON byte array or base64-encoded JSON>
VSOL_RPC_URL=<private Solana devnet RPC URL>
PYTH_HERMES_URL=https://hermes.pyth.network
PYTH_API_KEY=<server-only key>
```

Stock markets (NVDA/GOOGL/SPACEX) price off Hyperliquid's public "xyz" HIP-3
dex (`app/lib/hyperliquid-market-data.ts`) -- no API key required.

Never use the program admin, upgrade authority, mainnet wallet, or personally funded key for these roles.
Solana’s public endpoints are suitable for development but may block or throttle hosted server traffic. Use a private devnet RPC for the deployed app.

## Verification

```bash
npm run check
npm --prefix vsol run devnet:verify
```

The protocol suite tests payout bounds, fee rounding, escrow conservation, signature message format, cluster-domain separation, deterministic PDAs, replay behavior, Pyth account ownership, full verification, exact feed binding, and exponent normalization. The deployment harness posts a fresh Pyth update through the official receiver transaction builder, executes fill/settlement and oracle-timeout/refund lifecycles, and checks that both position vaults close.

## Before mainnet

Mainnet deployment is blocked until all of the following are complete:

- independent smart-contract and infrastructure audits;
- fuzz/property tests across all instruction account substitutions;
- multisig upgrade/admin authorities and timelocked governance;
- production market-calendar, halt, and corporate-action policy;
- external market makers, monitoring, incident response, and legal review;
- audited custody, token eligibility, and jurisdiction controls.

See `vsol/SECURITY.md` for the threat model and `vsol/deployments/devnet.json` for reproducible on-chain evidence.
