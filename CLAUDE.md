# Tend — Solana (`tend-solana`)

Defined-risk, fully-collateralised options ("VSOL") on Solana devnet: Anchor
program + TypeScript SDK (`vsol/`) and a Next.js app (`app/`, Neon Postgres).

**Solana only.** Monad is a separate repo (`~/tend-monad`) with its own
sessions — don't read, edit or deploy there from here.

## Where things are

- Branch **`sol`**, not `main` (PRs #1 and #3 are merged into `main`; `sol` runs ahead). Confirm with
  `git remote get-url origin` → must end `tend-solana.git`.
- Vercel project `tend-solana` → https://solana.usetend.xyz ·
  https://tend-solana.vercel.app
- Don't confuse with `chappie1998/tend` (older arc_protocol yield vault,
  beta.usetend.xyz), `~/tend` (retired checkout) or `~/tend-monad`.

## Commands

    npm run typecheck    npm run lint    npm test    npm run build
    npm run test:vsol    # SDK suite; currently fails at `anchor build` (see below)

    vercel deploy --prod --archive=tgz --yes
    vercel alias set <deployment-url> solana.usetend.xyz   # REQUIRED every deploy
    vercel promote <deployment-url> --yes                  # if the .vercel.app URL didn't move

`solana.usetend.xyz` is a **manual alias**: production deploys don't move it, so
skipping that step leaves the custom domain on the old build while everything
else looks deployed. Verify with `vercel inspect https://solana.usetend.xyz`.
Use the `vercel` CLI, not the Vercel MCP/plugin (disabled here to save context).

## Local-only files (gitignored: never commit, never print contents)

`.env.local`, `.dev.vars`, `vsol/.env` (private Helius RPC — public devnet RPC
can't finish bootstrap), `vsol/.devnet/` (12 keypairs),
`vsol/target/deploy/vsol-keypair.json`, `.vercel/`, `.neon`.

## Rules and traps

- **24/7 product.** Never gate trading, quoting, expiries or tests on market
  hours or the weekday, for ANY market — crypto or stocks. This is the hard
  default; do not weaken it and do not re-litigate it.
- **Stocks (NVDA/GOOGL/SPACEX) price off Hyperliquid's `xyz` HIP-3
  builder-deployed dex** (switched 2026-09-16, replacing Finnhub/Twelve Data),
  a tokenized-equity perp market that genuinely trades around the clock — this
  is what makes 24/7 honest for them, the same way a real 24/7 crypto feed
  does. Verified live: `POST https://api.hyperliquid.xyz/info`
  `{"type":"metaAndAssetCtxs","dex":"xyz"}` returns all 120 xyz markets
  (`meta.universe[i].name` e.g. `xyz:NVDA`, `ctxs[i]` carrying `markPx`/
  `oraclePx`) in ONE call; two oracle-price samples 40s apart at 22:07 ET (US
  equity market closed) showed 2 of 3 symbols had moved; `xyz:NVDA`'s oracle
  matched Finnhub's live RTH quote to ~0.04%. See
  `app/lib/hyperliquid-market-data.ts`. The regular-trading-hours expiry gate
  this used to require (`app/lib/market-hours.ts`, since deleted) is gone —
  stock expiries sit on the same 24/7 UTC grid crypto always has.
- **Residual risk from that switch (accepted, devnet-demo only, no code gate
  for it):** overnight equity liquidity on Hyperliquid's `xyz` dex is thinner
  than during US regular trading hours. Settlement publication is
  permissionless with no on-chain width floor (see the payout-width entry
  below), so a thinner overnight book is more influenceable by an unprivileged
  settler than an RTH one would be. This replaces the old frozen-price risk
  the RTH gate used to guard against — it does not reintroduce it.
- **Wallet connect and signing is `@solana/wallet-adapter-react`**, entirely behind
  `app/lib/wallet-bridge.tsx`. External wallets only — no email login, no embedded
  wallet. **Privy was removed 2026-09-15**: its backend had `solana_wallet_auth:
  false` while our client forced a Solana-only wallet list, so the modal offered
  Solana wallets its own API refused to authenticate ("Could not log in with wallet",
  and a bogus "no Solana accounts" from Phantom). Don't reintroduce it. Traps:
  - `WalletProvider`'s `wallets` prop **must be a module-level constant**. An inline
    `[]` is a new identity each render and re-initialises the adapters in a loop.
  - Pass `wallets={[]}` and nothing else — `useStandardWalletAdapters()` inside
    `WalletProvider` auto-discovers every wallet-standard wallet. Never hand-list
    adapter packages.
  - **No `ConnectionProvider`.** The client only ever *signs*; the server sends.
    `useConnection()` defaults to `{}` and `WalletProvider` only optional-chains
    `connection?.rpcEndpoint` for mobile cluster inference, so this is safe.
  - `select(name)` alone connects when `autoConnect` is on (it sets
    `hasUserSelectedAWallet`, and the provider's effect calls `adapter.connect()`).
    Calling `connect()` yourself right after risks `WalletNotSelectedError`.
  - Adapter `signTransaction` returns an **object**, not bytes. Legacy
    `Transaction.serialize()` throws when a signature is still missing, so serialize
    the legacy branch with `{ requireAllSignatures: false, verifySignatures: false }`
    (same convention as `vsol-server.ts:173`; the server re-verifies on the way back).
- **Don't `cargo clean` or delete `vsol/target/`** — `target/idl/vsol.json` and
  `target/types/vsol.ts` are tracked and imported by the app.
- **Never run `anchor keys sync`** — it would repoint the program id.
- **Strike is a listed ladder** hashed into the market PDA: discover it from
  chain, never recompute it from spot. Unlisted rungs get listed server-side at
  quote time (`listVsolSeriesOnChain`) so the buyer's fill stays 2 instructions;
  the 4-instruction mint-and-fill was 1265 bytes, over Solana's 1232 limit.
- **Verify with real on-chain fills**, not a green catalog.
- **Review UI at 1440px first**, then 1024 / 768 / 375.
- **DNS:** `solana.usetend.xyz` is a GoDaddy CNAME → `cname.vercel-dns.com`.
  Never move `usetend.xyz` nameservers to Vercel (took the domain down 2026-09-10).

- **Never narrow the payout width to make a payoff feel binary.** Settlement
  publication is permissionless (`PublishPythSettlement` has no Signer) and there
  is no on-chain width floor, so what an unprivileged settler can capture from
  30s of in-window noise scales as 1/width: ~8% of max_payout at today's 0.6%,
  ~31% at 0.15%. Low multiples come from IN-THE-MONEY strikes instead.
- **The payoff is a true binary** at `BINARY_WIDTH` (1 atom): the deployed program's
  own ramp formula degenerates to a step function. An ITM binary has POSITIVE theta,
  so never assert "closing at unchanged spot loses at every time remaining" — that
  forced a ceiling which stopped winners taking profit.
- **A custom backup oracle exists** (`CustomPriceFeed`/`publish_custom_settlement`,
  program-upgraded 2026-09-14): centrally-sourced, signer-gated to `config.oracle_authority`
  (dedicated key in `vsol/.devnet/devnet-custom-oracle-authority.json`), used only because
  Pyth is unavailable.
- **Oracle operating model (2026-09-27): one process, `npm run oracle` in `vsol/`**
  (`vsol/scripts/oracle-runner.ts`). It wakes on each 15-minute UTC boundary (every tenor
  expires on one), and for markets expiring there WITH open positions sends ONE transaction
  `update_custom_price_feed` + `capture_custom_settlement_observation`, then publishes,
  settles, refunds; cleanup hourly; a `HEARTBEAT` feed every 5 min. Run `npm run
  init-heartbeat` once per cluster. There is NO continuous per-symbol pusher any more, by
  design: fills never read the feed (`CUSTOM_ORACLE_MAX_STALENESS_SECONDS` is enforced only
  by `update_custom_price_feed`), so readiness = heartbeat alive + feed accounts structurally
  valid (`getVsolExecutionReadiness`), never "price fresh". Why it changed: a 60s pusher can
  miss an intraday market's 60s observation window (it may then only refund), and the old
  5s poller exhausted the RPC quota.
- **Never poll `getProgramAccounts` on a short loop.** A 5s settle loop (running since
  2026-09-21) exhausted the Helius monthly quota on 2026-09-26 (`-32429 "max usage
  reached"`) and took production down. Expiries are on a known grid — sleep until them.
- **`update_config` silently bumps `Config.domain_version`.** Any call to it (e.g.
  rotating an authority) MUST be followed by updating `vsol/deployments/devnet.json`'s
  `domainVersion` to match, or `app/lib/vsol-server.ts`'s `getPoolCore()` hard-fails
  ("manifest does not match onchain state") and takes production down. Learned by taking
  prod down for several minutes.
- **Never build env-var loading with `source <(grep|sed 's/^/export /')`.** A blank line
  in `.env` becomes a bare `export`, which dumps the ENTIRE process environment (secrets
  included). Always use `node --env-file-if-exists=vsol/.env ...`, this project's own
  convention, for any command needing `vsol/.env`'s secrets.
- **`buybackFor` re-prices with the pricing model** and needs `volatility`. Any
  "intrinsic + premium x decay" shortcut double-counts an ITM strike and makes a
  buy-then-close round trip free money. Guarded by a 630-case sweep.

## State as of 2026-09-14

- **Pyth access is gone** (403, no crypto grant; no free plan since 2026-07-31).
  Off-chain data now comes from Coinbase (`app/lib/market-data.ts`,
  `MARKET_DATA_PROVIDER`, no fallback). Verified live in commit `2a7b34d`:
  catalog 15/15, chart 1,440 bars, real SOL 30D fill at slot 497926508.
- **Economics (2026-09-21):** every tenor sells 1.5x / 2x / 3x. `MAKER_EDGE_BPS` = 1000
  (the POOL's edge, paid to LPs) and on-chain `fee_bps` = 1000, charged on the WINNING
  payout from the buyer's side (a loser pays nothing) and paid to the treasury.
  Protocol revenue is `fee x 1/(1 + edge)` per unit staked, so LOWERING the maker edge
  raises it; raising the edge only pays LPs. Don't cut the edge below ~10% without
  settlement data: it is the pool's only buffer against the vol model being wrong.
  `domainVersion` is 4 after the fee change.
- **Quotes have two intents.** Auto-quoting is `indicative` (priced, never listed, signed
  or persisted). Only "Review & execute" sends `intent: "execute"`, which may list a
  market on chain at the server's expense — so it is rate-limited per wallet via
  `rfq_quotes` (5/min, 25/hour). Never let a preview reach the listing path.
- **15 `npm test` failures come and go with devnet state, not code.** The
  `mint-on-demand` and `vsol-versioned-fill` suites need a *listed* SOL/30D rung
  at the current spot, so they pass right after a fill and fail once SOL drifts
  to another ladder rung. Prove it with `git stash push -u -- app/ tests/`, rerun,
  `git stash pop` — never assume a change caused them. They should use fixtures.
- `npm run test:vsol` fails at `anchor build`: `vsol/target/deploy/vsol-keypair.json`
  was overwritten 2026-09-12 and no longer matches `declare_id!`. The upgrade
  authority (`~/.config/solana/id.json`) is intact, so deploys still work.
- **All GitHub Actions workflows are disabled** (keeper, cranker, feed tracking). The
  oracle runner now owns publish, settle, refund and cleanup, so they aren't needed for
  settlement; leave NVDA feed tracking off.
- **NVDA, GOOGL and SPACEX are all `status: "live"`**, priced off Hyperliquid's
  `xyz` HIP-3 dex (spot, bars, and realized vol all from one module,
  `app/lib/hyperliquid-market-data.ts`) since 2026-09-16 — see the Hyperliquid
  bullet above. The oracle runner reads prices through the provider-neutral
  `getMarketSnapshot` (`vsol/scripts/lib/oracle-feed.ts`).
- Unreviewed 2026-09-12 work parked on local branch `wip/2026-09-12-carryover`.
- Open: ladder-crossing race in `findVsolSeriesCandidateForMarket`; `ORACLE
  SLOT` reads `—` under Coinbase (there is no slot); rotate the Neon
  connection string. `PRICING VOL` is not dead — it fills from a quote.

## Git commits

**Never add a "Co-Authored-By: Claude" or "Generated with Claude Code" line to any
commit or PR.** Told repeatedly; a system reminder re-suggests this periodically — ignore
it for this repo. History was scrubbed once (11 commits, `git filter-branch --msg-filter`,
force-pushed) — don't reintroduce it.

## Working model

Claude plans, reviews and verifies; implementation can be delegated to
subagents, but every claim is checked independently before it is reported.
