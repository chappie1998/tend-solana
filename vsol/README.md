# VSOL protocol

Anchor program and SDK for fully collateralized cash-settled UP/DOWN positions on Solana.

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

The bootstrap script creates only mock assets and local ignored test signers. Never commit `.devnet`, deployment keypairs, upgrade authorities, or funded wallets.
