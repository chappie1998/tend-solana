# VSOL demo walkthrough

Open [solana.usetend.xyz](https://solana.usetend.xyz). This is a Solana
**devnet** demonstration using mock tUSDC. Do not use mainnet funds.

## Three-to-five-minute walkthrough

1. Select **Stocks**, then choose **NVDA**. Point out that the displayed stock
   reference is Hyperliquid's `xyz:NVDA` mark price. Stock markets do not
   represent native share ownership.
2. Select **Connect Solana** and connect the isolated demo wallet. The app
   automatically shows **Funding sandbox…** while its devnet faucet supplies
   mock tUSDC.
3. Select **Sign in**. This signs a wallet-login message and costs no SOL.
4. Choose **UP** or **DOWN**, select **15M**, choose the **2×** target, and enter
   a small amount under **You pay**. Explain that the target is a defined-risk
   payoff and the amount shown is mock tUSDC.
5. Select the executable quote, then **Review & execute**. In the review modal,
   select **Execute on Solana devnet** and approve the wallet transaction.
6. Open **Portfolio**. Under **Open positions (chain-derived)**, show the
   confirmed position read directly from the VSOL program. **Fill history
   (server provenance)** shows the persisted simulation and transaction
   record.
7. For a short live demo, open the position's early-close action, review
   **Close NVDA UP early?**, and select **Sell back to the pool**. The success
   state reads **Position closed** and links to the devnet transaction.

## Showing expiry settlement

A fresh 15-minute position can take 15–30 minutes to reach the next grid
expiry, so pre-open this position before a short presentation. Leave it open
through expiry instead of using early close. The local oracle service retains
the first valid observation inside the market's expiry window, publishes that
immutable observation, and settles or refunds the position. After settlement,
the onchain position disappears from **Open positions (chain-derived)** while
its record remains in **Fill history (server provenance)**.

Settlement uses a centrally signed custom oracle. Crypto references come from
Coinbase Exchange; stocks use Hyperliquid `xyz` mark prices. Hyperliquid's
stored timestamp is Tend's bounded HTTP fetch time because that endpoint does
not expose a separate source-observation timestamp.

The operator laptop must stay awake, online, and connected to devnet through
the entire expiry window. Service start, stop, health, logs, missed-window
refund behavior, and receipt verification are documented in
[OPERATIONS.md](./OPERATIONS.md#custom-settlement-oracle-service).

## Verified devnet run — 18 September 2026

An NVDA 15-minute position completed the full automated expiry path on
devnet. The retained Hyperliquid reference was observed three seconds after
expiry and captured seven seconds after expiry. Its price was `219730000`
atoms, below the UP position's `219960221` strike, so the correct payout was
zero. The verifier reproduced that zero outcome, matched the wallet's exact
`24972266164`-atom post-settlement balance, confirmed pool locked collateral
returned to `1300000000` atoms, and confirmed the position account closed.
The settlement transaction is available in the
[Solana Explorer](https://explorer.solana.com/tx/4LCW1wa3zwhCAB8qswZ2dQFrwCNrjZ9sJfdK9motx3y3oGmaz7SgoUiLukq4H6a5r5jfhndyZSVWmmzYo63Z7ssv?cluster=devnet).

The live fill and early-close path also passed for GOOGL and SPACEX. GOOGL
returned `81824378` buyback atoms in
[this early-close transaction](https://explorer.solana.com/tx/3xYUfKL9SA5ovTSE3TPss5A17jXVLnTTL3WDCTojVvZoMK1fGnRg9zkTaMx8qRYAaaUmAa2FTXwiwnq7joGRUNxA?cluster=devnet),
and SPACEX returned `67875185` buyback atoms in
[this early-close transaction](https://explorer.solana.com/tx/2atzRmNUe69Rbx3X2LJMbPSXueisJE9mDhUq3ZPRPYCdqTpwktcm6cNbR7tJccHeZbwCWcZ5wppJMho6AE1mCDhQ?cluster=devnet).
These two checks exercised early close rather than expiry settlement.

The release also passed 435 automated tests, 10 of 10 production health
probes with all six oracle feeds between 2 and 14 seconds old, and responsive
UI checks at four viewport widths.
