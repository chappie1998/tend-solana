# VSOL security model

## Protected assets

VSOL protects buyer premium, writer maximum-payout collateral, maker quote authorization, settlement integrity, and protocol administration.

## Trust assumptions

- Solana runtime and SPL Token classic behave as specified.
- The program upgrade authority can change code and is therefore trusted on devnet.
- Pyth Core and its upgraded Solana receiver are trusted for the selected feed’s verified price update.
- The maker controls its off-chain signing key; compromise permits quotes only against capital already deposited in that maker’s writer vault.
- The isolated faucet controls only the valueless mock settlement mint and a limited devnet SOL balance.

## Implemented controls

- PDA seed constraints bind every config, market, writer vault, nonce, position, and token vault.
- Maker signatures are checked through the immediately preceding Ed25519 precompile instruction.
- Signed data includes the cluster genesis hash, config version, program, config, market, buyer, maker, nonce, direction, economics, and deadline.
- A nonce PDA can be filled or cancelled once and can never be recreated.
- Premium and maximum payout are transferred atomically into a position vault.
- Payout and fee calculations use checked widened arithmetic; payout is capped by escrow.
- The protocol fee is snapshotted into each position at fill time, so governance cannot change that position's fee before settlement.
- Settlement and refunds remain callable during a pause.
- Missed oracle finalization returns buyer premium and writer collateral after the configured deadline.
- Authorities are separated and admin transfer is two-step.
- Fee-on-transfer and Token-2022 assets are out of scope for v1.
- Settlement rejects the wrong receiver owner, partial verification, wrong feed ID, excessive confidence, stale updates, and publications outside the expiry observation window.

## Known limitations

- No independent audit has been completed.
- The Pyth-integrated binary and lifecycle are verified on devnet, but devnet verification is not a substitute for an independent audit.
- Market disruption, exchange halt, holiday, and corporate-action policies are not implemented.
- Upgrade and administrative authorities are not yet multisigs or timelocked.
- No permissionless maker onboarding or on-chain risk limits beyond full collateralization.
- No automated rolling-market or settlement keeper in the production web deployment.
- No corporate-action adapter for real tokenized securities.
- The web dependency graph reports three high-severity advisories and the isolated devnet bootstrap graph reports seven, all through the upstream `bigint-buffer` package. npm's proposed force-fix downgrades SPL Token and Pyth packages to incompatible releases, so it has not been applied. The application does not call the vulnerable `toBigIntLE` helper, but this is still a mainnet release blocker until the upstream Solana dependencies remove or patch it. Independently patchable `bn.js`, `postcss`, and `uuid` packages are narrowly pinned without forcing incompatible versions into newer transitive branches.

## Mainnet gate

Do not deploy this configuration to mainnet. A production release needs an immutable or governed oracle adapter, independent audit, upgrade multisig, timelock, monitoring, runbooks, regulatory controls, and a staged capped-value launch.
