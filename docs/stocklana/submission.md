# Stocklana submission package — Tend

Use this as the source of truth when completing the Stocklana form. Video links are intentionally pending until the rebuilt videos are hosted. The repository is private; do not represent it as public or open source.

## Project name

Tend

## Tagline

Defined-risk, on-chain stock-reference positions on Solana devnet.

## Description (329 words)

Short-horizon market views are easy to form and difficult to express with a clear loss limit. Perpetuals can impose margin and liquidation thresholds; option interfaces can require users to navigate strikes and expiries. Tend gives a user a simpler experience: choose UP or DOWN, see the defined payoff before signing, and know the maximum loss is the premium, excluding network fees.

Tend is a Solana devnet application for defined-risk UP or DOWN positions against stock-reference prices. In the live demo, a user connects a Solana wallet, receives valueless mock tUSDC from a devnet faucet, signs in, selects a reference such as NVDA, chooses direction, expiry, target payoff, and stake, then receives a signed executable quote. The user reviews and approves a Solana devnet transaction. The resulting position appears in a chain-derived portfolio; it can be closed early back to the pool or held to expiry.

Tend does not represent ownership of a share. For stocks, the reference price is Hyperliquid's `xyz` mark price, including `xyz:NVDA`, `xyz:GOOGL`, and `xyz:SPCX` for the Tend SPACEX market. Positions use mock tUSDC and are for the devnet demonstration only.

The protocol is designed around bounded outcomes. At fill, the maximum writer payout is reserved atomically in program-controlled collateral. Quotes are bound to the buyer and protected against replay. At expiry, a centrally signed custom oracle attempts to capture the first valid reference inside a 30-second observation window and publishes that immutable observation. If there is no valid capture, the program refunds after its settlement deadline. This centralized oracle is an explicit current trust boundary.

The live devnet proof includes a completed NVDA expiry path. The observed price was 219730000 atoms, below the 219960221 UP strike, so the correct payout was zero; the verifier confirmed the zero outcome, closed position, and returned locked collateral. GOOGL and SPACEX also passed live fill and early-close flows. The release recorded 435 automated tests, 10/10 production health probes, and six oracle feeds aged 2–14 seconds (18 September validation snapshot).

## Why Solana

Tend needs a wallet-signed trade, deterministic collateral reservation at fill, a position account that can be independently read from chain state, and a verifiable settlement result. Solana makes that lifecycle a single user-facing transaction flow on devnet: a signed quote is executed, collateral and position state live in program-owned accounts, and the portfolio can display the confirmed on-chain result. The product does not ask a user to trust a database entry for the core position state.

## Technical proof

* Live app: https://solana.usetend.xyz
* Verified NVDA expiry settlement (correct zero payout): https://explorer.solana.com/tx/4LCW1wa3zwhCAB8qswZ2dQFrwCNrjZ9sJfdK9motx3y3oGmaz7SgoUiLukq4H6a5r5jfhndyZSVWmmzYo63Z7ssv?cluster=devnet
* GOOGL early close: https://explorer.solana.com/tx/3xYUfKL9SA5ovTSE3TPss5A17jXVLnTTL3WDCTojVvZoMK1fGnRg9zkTaMx8qRYAaaUmAa2FTXwiwnq7joGRUNxA?cluster=devnet
* SPACEX early close: https://explorer.solana.com/tx/2atzRmNUe69Rbx3X2LJMbPSXueisJE9mDhUq3ZPRPYCdqTpwktcm6cNbR7tJccHeZbwCWcZ5wppJMho6AE1mCDhQ?cluster=devnet

## Current limits

Tend is devnet-only and uses valueless mock tUSDC. It is not share ownership, has not received an independent audit, and must not be used with real funds. Settlement currently depends on Tend’s single-authority signed oracle and its availability through the expiry window. A missed valid capture can lead to a refund after the settlement deadline. Stock references use Hyperliquid `xyz` marks, whose stored timestamp is Tend's bounded HTTP fetch time.

## Next steps

Publish the rebuilt technical and demo videos; keep the demo deterministic and show the actual devnet lifecycle. Continue hardening the oracle/operations path, add independent security review, and complete the market, liquidity, custody, governance, and legal work required before any mainnet consideration.

## Team

Ankit — builder. GitHub username: `chappie1998`.

## Form fields to complete at submission time

* Demo: https://solana.usetend.xyz
* Video: **Pending upload. Add hosted original demo/technical video URL before submitting; do not substitute a placeholder.**
* GitHub: private repository; do not link or claim public/open-source availability.
* Sponsor/bounty tracks: no claim included. Do not select PreStocks, Tessera, Meteora, Pyth, or any other bounty without independently verifying eligibility.
