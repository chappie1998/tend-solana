"use client";

import { ArrowUpRight, BadgeCheck, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Target, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatAtoms } from "../lib/format";
import { signSerializedSolanaTransaction } from "../lib/solana-wallet";
import { solanaExplorerUrl } from "../lib/vsol";
import type { ExpiryCode } from "../lib/expiries";

export type SavedPosition = {
  id: string;
  walletAddress: string;
  quoteId: string;
  maker: string;
  symbol: string;
  direction: "up" | "down";
  amount: number;
  premium: number;
  strike: number;
  capPrice: number;
  expiryDays: number;
  expiryCode: ExpiryCode;
  optionExpiryAt: string;
  observationWindowSeconds: number;
  tradeLockSeconds: number;
  status: "preview_confirmed" | "settled";
  createdAt: string;
  transactionSignature?: string;
  simulationId?: string;
  simulationStatus?: "passed" | "failed";
  simulationSlot?: number | null;
  simulationUnitsConsumed?: number | null;
  simulationLogsHash?: string;
};

export function isVerifiedPosition(position: SavedPosition) {
  return position.simulationStatus === "passed"
    && Boolean(position.transactionSignature)
    && Boolean(position.simulationId)
    && Boolean(position.simulationLogsHash);
}

type ChainPositionRow = {
  address: string;
  pool: string;
  market: string;
  direction: "up" | "down";
  status: "open" | "unknown";
  strike: string;
  cap: string;
  premium: string;
  maxPayout: string;
  premiumAtoms: string;
  maxPayoutAtoms: string;
  openedAt: number;
  symbol: string | null;
  seriesCode: string | null;
  marketExpiry: number | null;
  provenance: {
    transactionSignature: string | null;
    simulationId: string | null;
    simulationLogsHash: string | null;
  } | null;
};

type ChainState =
  | { phase: "loading" }
  | { phase: "signin-required"; message: string }
  | { phase: "error"; message: string }
  | { phase: "ready"; positions: ChainPositionRow[]; checkedAt: string };

type CloseQuote = {
  intentId: string;
  transaction: string;
  positionAddress: string;
  symbol: string;
  direction: "up" | "down";
  buybackAtoms: string;
  minProceedsAtoms: string;
  fairValueAtoms: string;
  maxPayoutAtoms: string;
  premiumAtoms: string;
  settlementDecimals: number;
  spreadBps: number;
  quoteExpiry: number;
};

type CloseReceipt = { signature: string; buybackAtoms: string };

// Every non-idle/non-loading phase carries the quote it applies to (or null
// when pricing itself failed), so the modal never has to guess which quote
// an error or receipt belongs to.
type CloseState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; quote: CloseQuote }
  | { phase: "submitting"; quote: CloseQuote }
  | { phase: "error"; message: string; quote: CloseQuote | null }
  | { phase: "done"; quote: CloseQuote; receipt: CloseReceipt };

function MiniLogo({ ticker }: { ticker: string }) {
  return <span className={`asset-logo asset-${ticker.toLowerCase()}`}>{ticker.slice(0, 1)}</span>;
}

export function PortfolioView({
  walletAddress,
  sessionWallet,
  positions,
  isLoading,
  error,
  onRetry,
  onTrade,
}: {
  walletAddress: string;
  sessionWallet: string | null;
  positions: SavedPosition[];
  isLoading: boolean;
  error: string;
  onRetry: () => void;
  onTrade: () => void;
}) {
  const [chain, setChain] = useState<ChainState>({ phase: "loading" });
  const [closeTarget, setCloseTarget] = useState<ChainPositionRow | null>(null);
  const [closeState, setCloseState] = useState<CloseState>({ phase: "idle" });
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadChain = useCallback(async () => {
    setChain({ phase: "loading" });
    try {
      const response = await fetch("/api/positions/chain", { cache: "no-store" });
      const result = await response.json() as {
        positions?: ChainPositionRow[];
        checkedAt?: string;
        error?: string;
        code?: string;
      };
      if (response.status === 401 || result.code === "WALLET_SESSION_REQUIRED") {
        setChain({ phase: "signin-required", message: result.error ?? "Sign in with your wallet signature to read chain positions." });
        return;
      }
      if (!response.ok || !result.positions) {
        setChain({ phase: "error", message: result.error ?? "Chain positions are unavailable." });
        return;
      }
      setChain({ phase: "ready", positions: result.positions, checkedAt: result.checkedAt ?? new Date().toISOString() });
    } catch {
      setChain({ phase: "error", message: "Chain positions are unreachable. Check your connection and retry." });
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadChain(), 0);
    return () => window.clearTimeout(initial);
  }, [loadChain, sessionWallet]);

  const loadCloseQuote = useCallback(async (position: ChainPositionRow) => {
    setCloseState({ phase: "loading" });
    try {
      const response = await fetch("/api/vsol/close/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionAddress: position.address }),
      });
      const result = await response.json() as CloseQuote & { error?: string };
      if (!response.ok || !result.intentId || !result.transaction) {
        setCloseState({ phase: "error", message: result.error ?? "The close quote could not be prepared.", quote: null });
        return;
      }
      setCloseState({ phase: "ready", quote: result });
    } catch {
      setCloseState({ phase: "error", message: "Could not reach the close pricing service. Check your connection and retry.", quote: null });
    }
  }, []);

  // Fetch a fresh quote whenever a position is selected for closing. Deferred
  // via setTimeout(0) so the state update happens after the effect commits,
  // matching the pattern `loadChain` already uses above.
  useEffect(() => {
    if (!closeTarget) return;
    const timer = window.setTimeout(() => void loadCloseQuote(closeTarget), 0);
    return () => window.clearTimeout(timer);
  }, [closeTarget, loadCloseQuote]);

  // Live countdown to the quote's expiry while the modal is open. The tick
  // itself only calls setState from inside the interval callback, never
  // synchronously in the effect body.
  useEffect(() => {
    if (closeState.phase !== "ready" && closeState.phase !== "submitting") return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [closeState.phase]);

  function closeModal() {
    setCloseTarget(null);
    setCloseState({ phase: "idle" });
  }

  async function submitClose() {
    if (closeState.phase !== "ready") return;
    const { quote } = closeState;
    setCloseState({ phase: "submitting", quote });
    try {
      const signedTransaction = await signSerializedSolanaTransaction(quote.transaction);
      const response = await fetch("/api/vsol/close/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intentId: quote.intentId, transaction: signedTransaction }),
      });
      const result = await response.json() as { signature?: string; buybackAtoms?: string; error?: string };
      if (!response.ok || !result.signature) {
        setCloseState({ phase: "error", message: result.error ?? "Devnet did not confirm the close transaction.", quote });
        return;
      }
      setCloseState({
        phase: "done",
        quote,
        receipt: { signature: result.signature, buybackAtoms: result.buybackAtoms ?? quote.buybackAtoms },
      });
      void loadChain();
    } catch (reason) {
      setCloseState({ phase: "error", message: reason instanceof Error ? reason.message : "The close transaction failed.", quote });
    }
  }

  const chainPositions = chain.phase === "ready" ? chain.positions : [];
  const premiumAtRisk = chainPositions.reduce((sum, position) => sum + BigInt(position.premiumAtoms), 0n);
  const maxPayoutTotal = chainPositions.reduce((sum, position) => sum + BigInt(position.maxPayoutAtoms), 0n);
  const nextExpiry = chainPositions
    .filter((position) => position.marketExpiry)
    .sort((left, right) => (left.marketExpiry ?? 0) - (right.marketExpiry ?? 0))[0];

  const verifiedHistory = positions.filter(isVerifiedPosition);
  const expiryLabel = (position: SavedPosition) => position.expiryCode || (position.expiryDays ? `${position.expiryDays}D` : "—");
  function exportHistory() {
    if (!verifiedHistory.length) return;
    const header = "symbol,direction,strike,premium,notional,expiry_code,option_expiry_at,status,transaction_signature,simulation_id,simulation_logs_hash";
    const rows = verifiedHistory.map((position) => [position.symbol, position.direction, position.strike, position.premium, position.amount, expiryLabel(position), position.optionExpiryAt, position.status, position.transactionSignature ?? "", position.simulationId ?? "", position.simulationLogsHash ?? ""].join(","));
    const url = URL.createObjectURL(new Blob([[header, ...rows].join("\n")], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "tend-positions.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  // Whichever phase is active, this is the quote the modal renders against
  // (or null once pricing itself has failed and there is nothing to show).
  const activeQuote = closeState.phase === "ready" || closeState.phase === "submitting" || closeState.phase === "done"
    ? closeState.quote
    : closeState.phase === "error" ? closeState.quote : null;
  const closePricing = activeQuote ? (() => {
    const decimals = activeQuote.settlementDecimals;
    const scale = 10 ** decimals;
    const buyback = Number(activeQuote.buybackAtoms) / scale;
    const fairValue = Number(activeQuote.fairValueAtoms) / scale;
    const maxPayout = Number(activeQuote.maxPayoutAtoms) / scale;
    const premium = Number(activeQuote.premiumAtoms) / scale;
    const secondsLeft = Math.max(0, Math.floor((activeQuote.quoteExpiry * 1_000 - nowMs) / 1_000));
    return { buyback, fairValue, maxPayout, premium, pnl: buyback - premium, secondsLeft, expired: secondsLeft <= 0 };
  })() : null;

  return (
    <>
    <main className="dashboard-view">
      <div className="view-heading">
        <div><span className="eyebrow">Portfolio</span><h1>Know exactly what can happen.</h1><p>Positions read straight from the Solana devnet program. The database only adds provenance.</p></div>
        <button type="button" className="button secondary" onClick={() => { void loadChain(); onRetry(); }}><RefreshCw size={15} aria-hidden="true" /> Refresh from chain</button>
      </div>

      <div className="metric-grid">
        <div className="metric-card"><span>Open onchain positions</span><strong>{chain.phase === "ready" ? chainPositions.length : "—"}</strong><small>PoolPosition accounts for this wallet</small></div>
        <div className="metric-card"><span>Premium at risk</span><strong>{chain.phase === "ready" ? `$${formatAtoms(premiumAtRisk.toString())}` : "—"}</strong><small>Maximum buyer loss</small></div>
        <div className="metric-card"><span>Escrowed max payout</span><strong>{chain.phase === "ready" ? `$${formatAtoms(maxPayoutTotal.toString())}` : "—"}</strong><small>Locked in program vaults</small></div>
        <div className="metric-card"><span>Next expiry</span><strong>{nextExpiry?.seriesCode ?? (nextExpiry?.marketExpiry ? new Date(nextExpiry.marketExpiry * 1_000).toLocaleDateString() : "—")}</strong><small>{nextExpiry?.symbol ?? "No open positions"}</small></div>
      </div>

      <section className="positions-card">
        <div className="section-head"><div><h2>Open positions (chain-derived)</h2><p>Read via the verified VSOL program; settled positions close their accounts and leave this list.</p></div>{chain.phase === "ready" && <span className="verified">Checked {new Date(chain.checkedAt).toLocaleTimeString()}</span>}</div>
        {!walletAddress ? (
          <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>Connect a wallet</strong><p>Chain positions belong to a wallet. Connect one to read its onchain state.</p></div><button type="button" className="button secondary" onClick={onTrade}>Go to trade</button></div>
        ) : chain.phase === "loading" ? (
          <div className="portfolio-loading" role="status" aria-label="Loading chain positions">{[0, 1].map((item) => <div className="quote-skeleton" key={item}><span /><span /><span /></div>)}</div>
        ) : chain.phase === "signin-required" ? (
          <div className="empty-position"><LockKeyhole size={20} aria-hidden="true" /><div><strong>Wallet sign-in required</strong><p>{chain.message}</p></div></div>
        ) : chain.phase === "error" ? (
          <div className="quote-error" role="alert"><div><strong>Couldn’t read chain positions</strong><p>{chain.message}</p></div><button type="button" className="button secondary" onClick={() => void loadChain()}><RefreshCw size={15} /> Retry</button></div>
        ) : chainPositions.length ? (
          <div className="position-table" role="table" aria-label="Open chain positions">
            <div className="table-row table-head" role="row"><span>Market</span><span>Position</span><span>Premium</span><span>Max payout</span><span>Status</span><span>Links</span></div>
            {chainPositions.map((position) => (
              <div className="table-row" role="row" key={position.address}>
                <span className="asset-cell"><MiniLogo ticker={position.symbol ?? "?"} /><strong>{position.symbol ?? "Unknown"}</strong>{position.seriesCode ? <small> {position.seriesCode}</small> : null}</span>
                <span>{position.direction.toUpperCase()} · ${position.strike}</span>
                <span>${position.premium}</span>
                <span>${position.maxPayout}</span>
                <span className="positive">{position.status === "open" ? "Open onchain" : "Unknown status"}{position.provenance ? " · Verified fill" : ""}</span>
                <span>
                  <a href={solanaExplorerUrl("address", position.address)} target="_blank" rel="noreferrer">Position</a>
                  {position.provenance?.transactionSignature ? <> · <a href={solanaExplorerUrl("tx", position.provenance.transactionSignature)} target="_blank" rel="noreferrer">Tx</a></> : null}
                  {position.provenance?.simulationId ? <> · <a href={`/api/vsol/simulations?id=${encodeURIComponent(position.provenance.simulationId)}`} target="_blank" rel="noreferrer">Sim</a></> : null}
                  {position.status === "open" ? <> · <button type="button" className="text-button" onClick={() => setCloseTarget(position)}>Close</button></> : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>No open onchain positions</strong><p>Execute a confirmed devnet fill and it will appear here straight from the chain — no database required.</p></div><button type="button" className="button secondary" onClick={onTrade}>Build a position</button></div>
        )}
      </section>

      <section className="positions-card">
        <div className="section-head"><div><h2>Fill history (server provenance)</h2><p>Server-verified fills with stored simulations. Settled positions remain here after their onchain accounts close.</p></div><button type="button" className="text-button" onClick={exportHistory} disabled={!verifiedHistory.length}>Export history <ArrowUpRight size={14} /></button></div>
        {isLoading ? (
          <div className="portfolio-loading" role="status" aria-label="Loading history">{[0].map((item) => <div className="quote-skeleton" key={item}><span /><span /><span /></div>)}</div>
        ) : error ? (
          <div className="quote-error" role="alert"><div><strong>Couldn’t load history</strong><p>{error}</p></div><button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} /> Retry</button></div>
        ) : verifiedHistory.length ? (
          <div className="position-table" role="table" aria-label="Fill history">
            <div className="table-row table-head" role="row"><span>Market</span><span>Position</span><span>Premium</span><span>Notional</span><span>Status</span><span>Links</span></div>
            {verifiedHistory.map((position) => (
              <div className="table-row" role="row" key={position.id}>
                <span className="asset-cell"><MiniLogo ticker={position.symbol} /><strong>{position.symbol}</strong></span>
                <span>{position.direction.toUpperCase()} · ${position.strike.toFixed(2)}</span>
                <span>${position.premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span>${position.amount.toLocaleString()}</span>
                <span className="positive">Verified · {position.simulationUnitsConsumed?.toLocaleString() ?? "—"} CU</span>
                <span><a href={solanaExplorerUrl("tx", position.transactionSignature!)} target="_blank" rel="noreferrer">Tx</a> · <a href={`/api/vsol/simulations?id=${encodeURIComponent(position.simulationId!)}`} target="_blank" rel="noreferrer">Sim</a></span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>No verified fills yet</strong><p>Confirmed devnet fills with stored simulations will appear here.</p></div></div>
        )}
      </section>
    </main>
    {closeTarget && (
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && closeModal()}>
        <div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="close-title">
          <button type="button" className="icon-button close" aria-label="Close dialog" onClick={closeModal}><X size={20} /></button>
          {closeState.phase === "loading" || closeState.phase === "idle" ? (
            <>
              <span className="eyebrow">Pricing early close</span>
              <h2 id="close-title">{closeTarget.symbol ?? "Position"} · {closeTarget.direction.toUpperCase()}</h2>
              <p>Fetching a fresh buyback quote from the pool…</p>
            </>
          ) : closeState.phase === "done" ? (
            <>
              <div className="success-mark"><ShieldCheck size={25} aria-hidden="true" /></div>
              <span className="eyebrow">Position closed</span>
              <h2 id="close-title">Sold back to the pool</h2>
              <p>The pool bought this position back early at the quoted buyback. It no longer appears in your open positions.</p>
              <div className="liquidity-receipt">
                <BadgeCheck size={18} />
                <div>
                  <strong>Received {formatAtoms(closeState.receipt.buybackAtoms, closeState.quote.settlementDecimals)} tUSDC</strong>
                  <a href={solanaExplorerUrl("tx", closeState.receipt.signature)} target="_blank" rel="noreferrer">View transaction</a>
                </div>
              </div>
              <button type="button" className="button primary full" onClick={closeModal}>Done</button>
            </>
          ) : activeQuote && closePricing ? (
            <>
              <span className="eyebrow">Sell before expiry</span>
              <h2 id="close-title">Close {activeQuote.symbol} {activeQuote.direction.toUpperCase()} early?</h2>
              <p>Closing early sells this position back to the pool below fair value. That spread is how the pool prices the risk of buying back the position before expiry — this is not a full-value exit.</p>
              <div className="review-grid">
                <div><span>Buyback proceeds</span><strong>${closePricing.buyback.toFixed(2)}</strong></div>
                <div><span>Fair value</span><strong>${closePricing.fairValue.toFixed(2)}</strong></div>
                <div><span>Spread below fair value</span><strong>{(activeQuote.spreadBps / 100).toFixed(2)}%</strong></div>
                <div><span>Max payout</span><strong>${closePricing.maxPayout.toFixed(2)}</strong></div>
                <div><span>Premium paid</span><strong>${closePricing.premium.toFixed(2)}</strong></div>
                <div><span>P/L vs premium</span><strong className={closePricing.pnl >= 0 ? "positive" : "negative"}>{closePricing.pnl >= 0 ? "+" : "-"}${Math.abs(closePricing.pnl).toFixed(2)}</strong></div>
              </div>
              {closeState.phase === "error" && <p className="execution-error" role="alert">{closeState.message}</p>}
              <p className="preview-disclaimer">
                {closePricing.expired ? "This quote expired." : `Quote valid for ${closePricing.secondsLeft}s.`} The buyback is quoted below fair value by design — the pool never buys back at the mid.
              </p>
              {closeState.phase === "error" ? (
                // A failed send invalidates the prepared intent server-side,
                // so retrying means fetching a fresh quote, not resubmitting.
                <button type="button" className="button primary full" onClick={() => void loadCloseQuote(closeTarget)}>Get a fresh quote</button>
              ) : (
                <button
                  type="button"
                  className="button primary full"
                  onClick={submitClose}
                  disabled={closePricing.expired || closeState.phase === "submitting"}
                  aria-busy={closeState.phase === "submitting"}
                >
                  {closeState.phase === "submitting"
                    ? <><LoaderCircle size={16} className="spin" /> Signing & confirming…</>
                    : closePricing.expired ? "Quote expired — reopen to refresh" : "Sell back to the pool"}
                </button>
              )}
              <button type="button" className="button ghost full" onClick={closeModal}>Cancel</button>
            </>
          ) : (
            <>
              <span className="eyebrow">Close unavailable</span>
              <h2 id="close-title">{closeTarget.symbol ?? "Position"}</h2>
              <p className="execution-error" role="alert">{closeState.phase === "error" ? closeState.message : "This position could not be priced for an early close."}</p>
              <button type="button" className="button ghost full" onClick={closeModal}>Close</button>
            </>
          )}
        </div>
      </div>
    )}
    </>
  );
}
