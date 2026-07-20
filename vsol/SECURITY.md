# VSOL security model

## Protected assets

VSOL protects buyer premium, direct-writer and pooled maximum-payout collateral, maker quote authorization, passive-provider shares, settlement integrity, and protocol administration.

## Trust assumptions

- Solana runtime and SPL Token classic behave as specified.
- The program upgrade authority can change code and is therefore trusted on devnet.
- Pyth Core and its upgraded Solana receiver are trusted for the selected feed’s verified price update.
- The maker controls its off-chain signing key; compromise permits quotes only against capital already deposited in that maker’s writer vault.
- A pool quote authority controls pricing but has no withdrawal authority. Compromise can consume available pool risk limits through valid quotes, so utilization and per-position caps remain critical containment controls.
- Passive providers accept option-writing losses pro rata. A deposit is not a stable-value account and premium is not risk-free yield.
- The isolated faucet controls only the valueless mock settlement mint and a limited devnet SOL balance.

## Implemented controls

- PDA seed constraints bind every config, market, direct writer vault, liquidity pool, provider ledger, market authorization, nonce, position, and token vault.
- Maker signatures are checked through the immediately preceding Ed25519 precompile instruction.
- Signed data includes the cluster genesis hash, config version, program, config, market, buyer, maker, nonce, direction, economics, and deadline.
- Pool-signed data has a distinct `VSOLPLP1` domain and additionally binds the pool, quote authority, and exact pool economics.
- A nonce PDA can be filled or cancelled once and can never be recreated.
- Premium and maximum payout are transferred atomically into a position vault.
- Payout and fee calculations use checked widened arithmetic; payout is capped by escrow.
- The protocol fee is snapshotted into each position at fill time, so governance cannot change that position's fee before settlement.
- Settlement and refunds remain callable during a pause.
- Missed oracle finalization returns buyer premium and writer collateral after the configured deadline.
- Authorities are separated and admin transfer is two-step.
- Fee-on-transfer and Token-2022 assets are out of scope for v1.
- Settlement rejects the wrong receiver owner, partial verification, wrong feed ID, excessive confidence, stale updates, and publications outside the expiry observation window.

## Passive pool controls

- Shares are internal account entries, minted and redeemed pro rata with checked `u128` arithmetic and downward rounding.
- Zero-share deposits and zero-asset withdrawals are rejected; callers can enforce minimum shares and minimum assets for slippage protection.
- Deposits and withdrawals require both `open_positions == 0` and `locked_collateral == 0`, preventing entry or exit against incompletely marked obligations.
- Each market requires a separate pool authorization PDA and a cutoff timestamp.
- Fills enforce both maximum utilization and maximum position basis points against current pool assets.
- `locked_collateral` and `open_positions` are incremented before a pooled obligation becomes active and decremented only by settlement or the allowed timeout refund.
- Settlement and refund accept only the exact pool PDA and exact SPL-token vault as the writer destination.
- Quote authorities can be rotated, and individual pool-market authorizations can be disabled by the protocol admin; quote authorities cannot move provider assets.
- The devnet smoke lifecycle proves a normal settlement, timeout refund, nonce replay rejection, zero residual obligations, token-account conservation, and complete final withdrawal.

## Settlement and market-catalog controls

- The deployed NVDA catalog contains `15M`, `1H`, `EOD`, `7D`, and `30D` markets with session-aligned expiries and explicit pre-expiry trade cutoffs.
- Each catalog market narrows the accepted Pyth publication interval to 30 seconds and has a 15-minute finalization grace period.
- The old midnight-expiry market is disabled, and the verifier rejects the deployment if it is re-enabled.
- The verifier independently reads on-chain market terms, pool ownership/funding, market authorization PDAs, oracle feed bindings, saved transactions, and smoke-test instruction logs.

## Known limitations

- No independent audit has been completed.
- The Pyth-integrated binary and lifecycle are verified on devnet, but devnet verification is not a substitute for an independent audit.
- Settlement still uses the first valid Pyth update submitted inside the configured observation window. Narrowing the window reduces but does not eliminate caller selection among multiple valid updates. A deterministic benchmark/TWAP policy is required before mainnet.
- The market scheduler is aware of New York time, weekdays, and the regular reference session, but an authoritative holiday/early-close calendar is not implemented.
- Market disruption, exchange halt, and corporate-action policies are not implemented.
- Upgrade and administrative authorities are not yet multisigs or timelocked.
- There is no automated rolling-market or settlement keeper in the production web deployment. `bootstrap.ts` is a deployment/smoke tool, not an always-on keeper.
- The passive pool permits quoting only by its configured authority; permissionless pool quoting and independent risk committees are not implemented.
- Pool shares are deliberately non-transferable internal balances. Secondary LP liquidity and in-obligation deposits/withdrawals are out of scope.
- No corporate-action adapter for real tokenized securities.
- The web dependency graph reports three high-severity advisories and the isolated devnet bootstrap graph reports seven, all through the upstream `bigint-buffer` package. npm's proposed force-fix downgrades SPL Token and Pyth packages to incompatible releases, so it has not been applied. The application does not call the vulnerable `toBigIntLE` helper, but this is still a mainnet release blocker until the upstream Solana dependencies remove or patch it. Independently patchable `bn.js`, `postcss`, and `uuid` packages are narrowly pinned without forcing incompatible versions into newer transitive branches.

## Mainnet gate

Do not deploy this configuration to mainnet. A production release needs a deterministic settlement benchmark, authoritative exchange calendar, automated keepers, immutable or governed oracle adapter, independent audits of both direct and pooled paths, upgrade multisig, timelock, monitoring, runbooks, regulatory controls, provider disclosures, and a staged capped-value launch.
