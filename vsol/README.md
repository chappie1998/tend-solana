# VSOL protocol

Anchor program and SDK for fully collateralized cash-settled UP/DOWN positions on Solana.

The Pyth-integrated binary is deployed on devnet. The checked-in manifest contains the Pyth-bound NVDA UI market and independent fill, replay-rejection, Pyth-settlement, account-close, timeout, and refund evidence. Executable quotes still fail closed whenever the manifest flag, market session, data freshness, oracle configuration, or server secrets are invalid.

## Layout

- `programs/vsol`: on-chain program
- `sdk`: quote codec, payout helpers, and PDA derivations
- `scripts/bootstrap.ts`: idempotent devnet setup plus adversarial smoke lifecycle
- `scripts/verify-deployment.ts`: independent account and transaction verifier
- `deployments/devnet.json`: public deployment evidence
- `target/idl` and `target/types`: generated client interface tracked for the web build

## Commands

```bash
npm run check
npm run devnet:bootstrap
npm run devnet:verify
```

The bootstrap script creates only mock assets and local ignored test signers. It posts a fully verified Pyth price update through the official receiver, publishes permissionless settlement, verifies successful settlement and timeout refund, then writes the deployment-ready flag. Never commit `.devnet`, deployment keypairs, upgrade authorities, or funded wallets.
