// Pure, import-free readiness logic for the trade ticket's quote panel.
// No imports on purpose: tests load this file directly via Node's native
// type-stripping (see tests/quote-readiness.test.mjs), the same way
// tests/market-data.test.mjs loads app/lib/market-data.ts.

/**
 * What the quote panel should show right now, in priority order:
 * a busy wallet action always wins, then "no wallet found at all" vs
 * "found one but not connected", then "connected but not signed in for
 * this app", and finally "ready to quote."
 */
export type QuoteReadiness =
  | { kind: "no-provider" }
  | { kind: "connect" }
  | { kind: "busy" }
  | { kind: "sign-in"; reason: string }
  | { kind: "ready" };

export type QuoteReadinessInput = {
  /** Whether an injected Solana wallet (Phantom, etc.) was found in this browser. `null` = not checked yet. */
  providerDetected: boolean | null;
  /** The connected wallet's base58 address, or "" if none is connected. */
  walletAddress: string;
  /** True while connecting, funding, or signing in -- any wallet action in flight. */
  walletBusy: boolean;
  /** The wallet address the current SIWS session cookie is bound to, or null if there is none. */
  sessionWallet: string | null;
  /** The last sign-in notice/error, shown as the sign-in reason when present. */
  sessionNotice: string;
};

export function quoteReadiness(input: QuoteReadinessInput): QuoteReadiness {
  if (input.walletBusy) return { kind: "busy" };
  if (!input.walletAddress) {
    return input.providerDetected === false ? { kind: "no-provider" } : { kind: "connect" };
  }
  if (input.sessionWallet !== input.walletAddress) {
    return { kind: "sign-in", reason: input.sessionNotice };
  }
  return { kind: "ready" };
}

export type QuoteInputIssueInput = {
  /** What the buyer pays, in tUSDC -- the premium, not the payout. */
  stake: number;
  /** Smallest stake whose payout the pool will underwrite at this payoff tier. */
  stakeMin: number;
  /** Largest stake whose payout the pool will underwrite at this payoff tier. */
  stakeMax: number;
  /** Whether the selected expiry has a tradeable onchain series. */
  expiryAvailable: boolean;
  /** Why the selected expiry is unavailable, shown verbatim when it is. */
  expiryReason: string;
  /** Whether the active liquidity pool is wired for quotes. `null` when there is no active pool to check. */
  poolQuotable: boolean | null;
};

/**
 * The reason a quote can't be requested for the current ticket inputs, or
 * null when they're valid. Mirrors the checks `requestQuote` used to run
 * inline so the auto-quote effect and the manual submit path can't drift.
 */
export function quoteInputIssue(input: QuoteInputIssueInput): string | null {
  if (input.stake < input.stakeMin || input.stake > input.stakeMax) {
    // Bounds are per payoff tier: the buyer types what they pay, and the
    // payout it buys has to stay inside what the devnet pool underwrites.
    // No "then retry" -- quoting is automatic, so a valid amount is enough.
    return `Pay between $${input.stakeMin.toLocaleString()} and $${input.stakeMax.toLocaleString()}.`;
  }
  if (!input.expiryAvailable) {
    return input.expiryReason;
  }
  if (input.poolQuotable === false) {
    return "Executable quotes come from the Tend pool today. Other authorized pools are listed honestly, but no quote service is integrated for them yet.";
  }
  return null;
}

/** How long the ticket waits after the last input change before auto-requesting a quote. */
export const AUTO_QUOTE_DEBOUNCE_MS = 600;

/** How many consecutive expiries auto-refresh silently before showing a neutral "expired" state instead. */
export const MAX_AUTO_REFRESHES = 3;
