# VSOL Operations: Keeper & Cranker

This covers the two scheduled GitHub Actions workflows that keep the VSOL
rolling grid alive on devnet without a human running commands by hand:

- `.github/workflows/vsol-keeper.yml`
- `.github/workflows/vsol-cranker.yml`

**Scope: devnet only.** Everything these workflows touch — the mock USDC
mint, the mock RWA mint, and the markets/pools created against them — is a
valueless devnet asset. There is no real money at risk. That said, the
signer keys are still credentials (they authorize on-chain writes), so they
are handled as secrets, not because the funds behind them matter, but
because a leaked key could be used to spam or grief the devnet deployment.

## What each workflow does

### `vsol-keeper.yml`

Runs `npm --prefix vsol run keeper`, which mints the next rolling 15M/1H
(and longer-dated) markets that the UTC expiry grid says should exist right
now, and authorizes those series on the liquidity pool. It is idempotent and
safe to run concurrently with itself.

- **Cadence:** every 10 minutes, at `:03,:13,:23,:33,:43,:53` (cron
  `3,13,23,33,43,53 * * * *`). The off-`:00` offset avoids the crush of jobs
  every other repo schedules at the top of the hour.
- **Manual run:** open the workflow under the repo's **Actions** tab and use
  **Run workflow** (`workflow_dispatch`).

### `vsol-cranker.yml`

Runs `npm --prefix vsol run cranker`, which settles/refunds expired open
positions (pool and direct) against the Pyth price, then cleans up
(`close_settled_market`) markets that are safe to reclaim rent from. This is
the permissionless liveness layer — if it stops running, any buyer can still
settle their own position directly.

- **Cadence:** every 30 minutes, at `:17,:47` (cron `17,47 * * * *`).
- **Manual run:** same as above, via **Run workflow** in the Actions tab.

Both workflows also declare `concurrency` groups (`vsol-keeper` /
`vsol-cranker`) with `cancel-in-progress: false`, so if a run is still
in-flight when the next scheduled trigger fires, the new run queues instead
of stacking on top of or cancelling the old one.

**Cadence is approximate.** GitHub's scheduled cron triggers are
best-effort and are commonly delayed by several minutes when the shared
runner queue is under load. Treat "every 10 minutes" / "every 30 minutes" as
"about that often," not a hard guarantee — nothing in the rolling grid
depends on sub-minute precision.

## Secrets the operator must set

**The assistant/agent never handles these keys.** The repo owner (operator)
sets them directly in **Settings → Secrets and variables → Actions** on
`github.com/chappie1998/usetend`. Each is consumed only via `${{ secrets.* }}`
in the workflow `env:`, written to a file, and never logged.

| Secret name | Written to | Used by |
|---|---|---|
| `VSOL_DEVNET_CREATOR_KEY` | `vsol/.devnet/devnet-creator.json` | keeper, cranker |
| `VSOL_DEVNET_USDC_MINT_KEY` | `vsol/.devnet/devnet-mock-usdc-mint.json` | keeper only |
| `VSOL_DEVNET_RWA_MINT_KEY` | `vsol/.devnet/devnet-mock-rwa-mint.json` | keeper only |
| `VSOL_RPC_URL` | env var (not a file) | keeper, cranker |
| `PYTH_API_KEY` | env var (not a file) | cranker only |
| `PYTH_HERMES_URL` *(optional)* | env var (not a file) | cranker only |

Each keypair secret's value is the raw JSON array of secret-key bytes (the
same format as any Solana CLI keypair file), copy-pasted as the secret's
value — e.g. `[12,34,56,...]`.

`VSOL_RPC_URL` **must** be a private devnet RPC endpoint. The public
`api.devnet.solana.com` endpoint 403s or rate-limits under any kind of
recurring, unattended load — do not point these workflows at it.

`PYTH_API_KEY` and `PYTH_HERMES_URL` are only read by the cranker (it is the
one calling Hermes for settlement prices; the keeper does not need them). If
`PYTH_HERMES_URL` is left unset, the cranker falls back to the public Hermes
endpoint on its own.

### How secrets reach disk without leaking

Each workflow has a "Write devnet signer keypair(s)" step that does exactly
this, per key:

```bash
printf '%s' "$CREATOR_KEY" > .devnet/devnet-creator.json
```

with `CREATOR_KEY` bound from `${{ secrets.VSOL_DEVNET_CREATOR_KEY }}` in the
step's `env:` block. The secret value never appears on a command line, is
never interpolated into a `run:` string directly, and is never `echo`ed. The
workflows do not use `set -x`, so the shell never traces commands (which
could otherwise expose the expanded value). `vsol/.devnet/` is gitignored,
and these workflows never run `git add` / `git commit`, so there is no path
by which a materialized key could end up in the repository.

## Funding is a manual operator responsibility

`devnet-creator.json` is the fee payer and rent payer for both jobs: it
pays rent for every market the keeper mints, and pays the transaction fees
the cranker spends settling, refunding, and closing markets. It **will**
drain over time — this has happened before.

Each workflow runs a small pre-flight balance check (a few lines of inline
Node using `@solana/web3.js`, already a dependency of `vsol/`) before doing
any real work:

- Balance logged either way.
- Below **0.5 SOL**: prints a clear `WARNING` line, but still proceeds with
  the run (a low balance may still be enough for the keeper to safely skip
  work, or for the cranker to complete a few settlements).
- Below **0.01 SOL** (essentially empty): the step fails outright with a
  clear `FATAL` message instead of proceeding to spam failing transactions
  against the chain.

**Devnet airdrops via a private RPC are unreliable, so these workflows do
not attempt to auto-airdrop.** Keeping `devnet-creator` funded is a manual
job for the operator: check the balance (the workflow logs it every run),
and top it up — e.g. via `solana airdrop` against a faucet, or by
transferring devnet SOL from another funded devnet key — when the
`WARNING` starts showing up.

## Alternative: local cron instead of GitHub Actions

If you'd rather not use Actions, run the same two commands from any machine
that stays on, with `VSOL_RPC_URL` (and the other env vars) exported and the
`vsol/.devnet/*.json` keypair files already in place. One-line crontab
example (runs the keeper every 10 minutes):

```
*/10 * * * * cd /path/to/tend && VSOL_RPC_URL="https://your-private-rpc" npm --prefix vsol run keeper >> /tmp/vsol-keeper.log 2>&1
```

Add a second line on a `*/30 * * * *` schedule running
`npm --prefix vsol run cranker` for the cranker. `launchd` (macOS) or
`systemd` timers work the same way — a periodic unit invoking the same npm
command with the same environment and `.devnet` files present.

## Custom settlement oracle service

The demo settlement path uses one local, continuously supervised worker:

```bash
npm --prefix vsol run custom-oracle:run
```

It pushes all six live references, captures the first valid observation in
each market's expiry window, publishes the retained observation, then settles
or refunds pool positions. Each symbol has its own serialized push/capture
lane; relay and payout work runs separately. A kernel-held localhost port
lease prevents a manual invocation from overlapping the supervised worker.
`custom-oracle:once` performs one complete pass and exits nonzero if any
operational lane fails.

The machine must stay awake and networked. On macOS, run the launchd command
under `caffeinate -i`; configure launchd `KeepAlive` for crash restart. Keep
`VSOL_RPC_URL` and signer material in the process environment or the existing
gitignored `.devnet` files, never in the plist or logs. Logs redact the RPC
URL. The authority key is `vsol/.devnet/devnet-custom-oracle-authority.json`.

Crypto references come from Coinbase Exchange. Stock references come from
Hyperliquid's `xyz` mark price. Hyperliquid does not expose a separate source
observation timestamp in this API, so its stored timestamp is Tend's bounded
HTTP fetch time. Changing a source requires a code and review change; do not
rotate the protocol config merely to switch providers because the config's
domain version also binds signed quotes.

At expiry, the program permanently retains the first authenticated source
observation whose source timestamp is inside `[expiry, expiry +
observation_window]`. Publication may happen later through the market's final
deadline and does not require the rolling feed to remain fresh. If no valid
observation is captured during the window, a later price can never replace
it; the existing refund path applies after the settlement deadline.

Operator commands from the repository root:

```bash
# one-shot mutating settlement pass; stop the launchd worker first
npm --prefix vsol run custom-oracle:once

# foreground run (the launchd program uses this same entrypoint)
npm --prefix vsol run custom-oracle:run

# inspect recent launchd state and logs (replace the label/path used locally)
launchctl print gui/$(id -u)/xyz.usetend.solana-oracle
tail -n 100 ~/Library/Logs/tend-solana-oracle/output.log
tail -n 100 ~/Library/Logs/tend-solana-oracle/error.log

# stop/start the installed service
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/xyz.usetend.solana-oracle.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/xyz.usetend.solana-oracle.plist
```

Before a devnet demonstration, require `/api/vsol/status` to return `ok: true`,
confirm every per-symbol feed is ready, and inspect the launchd logs. Do not
run `custom-oracle:once` while the supervised service owns the lease. Then run the HTTP smoke with an
isolated wallet. Its default mode fills and early-closes a 15-minute NVDA
position. `VSOL_SMOKE_SETTLEMENT=1` leaves that position open and emits a
receipt for independent post-expiry payout verification; it never signs or
supplies an oracle price. Verify that receipt after expiry with:

```bash
npm --prefix vsol run smoke:settlement:verify -- /tmp/tend-smoke-settlement-receipt.json
```

The verifier is read-only. It requires the position account to be closed,
reads the finalized oracle price, reproduces the program's integer payout and
round-up fee math, checks the buyer token balance, and proves the pool's locked
collateral returned to its pre-fill value.
