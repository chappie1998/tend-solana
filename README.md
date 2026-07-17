# VSOL by Tend

VSOL is Tend’s Solana-native defined-risk options protocol. This `sol` branch contains the production web application, Anchor program, TypeScript SDK, deployment tools, and verified Solana devnet deployment. The `main` branch remains the Robinhood Chain product.

> Status: devnet sandbox. The assets are mock tokens, the settlement oracle is controlled by the devnet operator, and the code has not received an independent security audit. Do not use real funds or deploy this configuration to mainnet.

## Live devnet deployment

| Component | Address |
| --- | --- |
| Program | `2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v` |
| Config | `688RQvX2SEpnSuEndbjvRivFQpMzGjaz8hhGvAPGj1bY` |
| Rolling market | See `vsol/deployments/devnet.json` |
| Settlement mint | `EaU6Yus9b7SWz3gzRNMuerpn1U9mYpfm996CQd2Lzhh4` |

The checked-in deployment manifest includes the executable program, market, oracle, writer vault, public smoke-test transaction signatures, and the cluster-bound RFQ domain.

## Product flow

1. Connect an injected Solana wallet such as Phantom.
2. The private devnet faucet funds that wallet with mock tUSDC and a small amount of devnet SOL.
3. Request an RFQ. The server signs the exact buyer, maker, market, economics, nonce, program, cluster, and configuration version.
4. Review the defined payoff and sign the serialized transaction in the wallet.
5. The app submits only a valid signed VSOL transaction to devnet.
6. The portfolio record is created only after the backend independently verifies the confirmed on-chain fill.

Charts use TradingView Lightweight Charts. Their feed is display-only and never used for settlement. Short-duration series (15m, 1h, and end-of-day) are represented in the product but intentionally gated until a production settlement oracle and rolling-market operator are available. The live sandbox publishes a 30-day series.

## Protocol design

- Program-owned PDA writer vaults and per-position escrow vaults
- Fully collateralized maximum payout before every fill
- Buyer-paid premium with no liquidation path
- Immediate-preceding Ed25519 maker-signature verification
- One-shot maker nonce PDAs for replay prevention
- Genesis-hash and config-version domain separation
- Fill-time fee snapshots so later governance updates cannot alter open-position fees
- Linear capped UP/DOWN settlement using checked `u128` arithmetic
- Separate admin, pause, oracle, and eligibility authorities
- Optional wallet eligibility records
- Settlement remains available while new fills are paused
- Deterministic refund if the oracle misses its settlement deadline
- SPL Token classic only in v1 to avoid transfer-fee ambiguity

## Local development

Requirements: Node.js 22+, Rust 1.89, Solana CLI 3.1.10, and Anchor CLI 1.0.2.

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
```

Never use the program admin, upgrade authority, mainnet wallet, or personally funded key for these roles.
Solana’s public endpoints are suitable for development but may block or throttle hosted server traffic. Use a private devnet RPC for the deployed app.

## Verification

```bash
npm run check
npm --prefix vsol run devnet:verify
```

The protocol suite tests payout bounds, fee rounding, escrow conservation, signature message format, cluster-domain separation, deterministic PDAs, and replay behavior. The deployment harness additionally executes successful fill/settlement and oracle-timeout/refund lifecycles, then checks that both position vaults close.

## Before mainnet

Mainnet deployment is blocked until all of the following are complete:

- replace the controlled devnet oracle with a reviewed production adapter;
- independent smart-contract and infrastructure audits;
- fuzz/property tests across all instruction account substitutions;
- multisig upgrade/admin authorities and timelocked governance;
- production market-calendar, halt, and corporate-action policy;
- external market makers, monitoring, incident response, and legal review;
- audited custody, token eligibility, and jurisdiction controls.

See `vsol/SECURITY.md` for the threat model and `vsol/deployments/devnet.json` for reproducible on-chain evidence.
