"use client";

// Full-width panel for the bottom of the Trade page (Hyperliquid-style: a
// tabbed strip of dense rows, always visible under the chart, so a trader
// never has to leave Trade to see a fill they just executed). Reads open
// positions through the same app/lib/use-chain-positions.ts hook
// PortfolioView uses -- never a second implementation of that fetch -- and
// renders the server-provenance fill history the caller already holds.

import { LockKeyhole, RefreshCw, Target } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { solanaExplorerUrl } from "../lib/vsol";
import { useChainPositions, type ChainPositionRow } from "../lib/use-chain-positions";
import { MiniLogo, isVerifiedPosition, type SavedPosition } from "./PortfolioView";

type PanelTab = "positions" | "history";

// Renders a human countdown ("6d 4h", "48m", "Expired") from a market's unix
// expiry. `nowMs` is passed in (rather than read from Date.now() here) so
// every row in the table re-renders off the same tick -- see the nowMs
// effect below, the same pattern PortfolioView already keeps fresh for its
// close-quote countdown.
function formatExpiresIn(marketExpiry: number | null, nowMs: number): string {
  if (!marketExpiry) return "—";
  const remainingMs = marketExpiry * 1_000 - nowMs;
  if (remainingMs <= 0) return "Expired";
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function ConnectPrompt({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="empty-position">
      <Target size={20} aria-hidden="true" />
      <div><strong>Connect a wallet</strong><p>Positions and fill history belong to a wallet. Connect one to see them here.</p></div>
      <button type="button" className="button secondary" onClick={onConnect}>Connect wallet</button>
    </div>
  );
}

export function TradePositionsPanel({
  walletAddress,
  sessionWallet,
  positions,
  onConnect,
}: {
  walletAddress: string;
  sessionWallet: string | null;
  positions: SavedPosition[];
  onConnect: () => void;
}) {
  const { state: chain, reload: reloadChain } = useChainPositions(walletAddress, sessionWallet);
  const [tab, setTab] = useState<PanelTab>("positions");
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Countdown tick for the Expires column. setState only ever runs inside
  // the interval callback, never synchronously in the effect body.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // A fresh fill is prepended to `positions` by TendTerminal the moment it
  // saves (see onPositionSaved) -- that's the signal to re-read chain state
  // so the new position appears here without a tab switch. Deferred via
  // setTimeout(0), the same pattern app/lib/use-chain-positions.ts's own
  // mount effect uses, so the reload's setState never runs synchronously
  // inside this effect body.
  const latestFillIdRef = useRef(positions[0]?.id ?? null);
  useEffect(() => {
    const latestId = positions[0]?.id ?? null;
    if (latestId === latestFillIdRef.current) return;
    latestFillIdRef.current = latestId;
    if (!latestId) return;
    const timer = window.setTimeout(() => void reloadChain(), 0);
    return () => window.clearTimeout(timer);
  }, [positions, reloadChain]);

  const chainPositions = chain.phase === "ready" ? chain.positions : [];
  const verifiedHistory = positions.filter(isVerifiedPosition);

  const positionsLabel = chain.phase === "ready" ? `Positions · ${chainPositions.length}` : "Positions";
  const historyLabel = `Fill history · ${verifiedHistory.length}`;

  let positionsContent;
  if (!walletAddress) {
    positionsContent = <ConnectPrompt onConnect={onConnect} />;
  } else if (chain.phase === "loading") {
    positionsContent = (
      <div className="portfolio-loading" role="status" aria-label="Loading chain positions">
        {[0, 1].map((item) => <div className="quote-skeleton" key={item}><span /><span /><span /></div>)}
      </div>
    );
  } else if (chain.phase === "signin-required") {
    positionsContent = (
      <div className="empty-position"><LockKeyhole size={20} aria-hidden="true" /><div><strong>Wallet sign-in required</strong><p>{chain.message}</p></div></div>
    );
  } else if (chain.phase === "error") {
    positionsContent = (
      <div className="quote-error" role="alert"><div><strong>Couldn’t read chain positions</strong><p>{chain.message}</p></div><button type="button" className="button secondary" onClick={() => void reloadChain()}><RefreshCw size={15} /> Retry</button></div>
    );
  } else if (chainPositions.length) {
    positionsContent = (
      <div className="position-table" role="table" aria-label="Open chain positions">
        <div className="table-row table-head trade-positions-row" role="row"><span>Market</span><span>Side</span><span>Strike</span><span>Premium</span><span>Max winning</span><span>Expires</span><span>Status</span><span>Links</span></div>
        {chainPositions.map((position: ChainPositionRow) => (
          <div className="table-row trade-positions-row" role="row" key={position.address}>
            <span className="asset-cell"><MiniLogo ticker={position.symbol ?? "?"} /><strong>{position.symbol ?? "Unknown"}</strong>{position.seriesCode ? <small> {position.seriesCode}</small> : null}</span>
            <span className={position.direction === "up" ? "positive" : "negative"}>{position.direction.toUpperCase()}</span>
            <span>${position.strike}</span>
            <span>${position.premium}</span>
            <span>${position.maxPayout}</span>
            <span>{formatExpiresIn(position.marketExpiry, nowMs)}</span>
            <span className="positive">{position.status === "open" ? "Open onchain" : "Unknown status"}{position.provenance ? " · Verified fill" : ""}</span>
            <span>
              <a href={solanaExplorerUrl("address", position.address)} target="_blank" rel="noreferrer">Position</a>
              {position.provenance?.transactionSignature ? <> · <a href={solanaExplorerUrl("tx", position.provenance.transactionSignature)} target="_blank" rel="noreferrer">Tx</a></> : null}
              {position.provenance?.simulationId ? <> · <a href={`/api/vsol/simulations?id=${encodeURIComponent(position.provenance.simulationId)}`} target="_blank" rel="noreferrer">Sim</a></> : null}
            </span>
          </div>
        ))}
      </div>
    );
  } else {
    positionsContent = (
      <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>No open onchain positions</strong><p>Execute a confirmed devnet fill and it will appear here straight from the chain — no database required.</p></div></div>
    );
  }

  let historyContent;
  if (!walletAddress) {
    historyContent = <ConnectPrompt onConnect={onConnect} />;
  } else if (verifiedHistory.length) {
    historyContent = (
      <div className="position-table" role="table" aria-label="Fill history">
        <div className="table-row table-head trade-history-row" role="row"><span>Market</span><span>Side</span><span>Strike</span><span>Premium</span><span>Notional</span><span>Status</span><span>Links</span></div>
        {verifiedHistory.map((position) => (
          <div className="table-row trade-history-row" role="row" key={position.id}>
            <span className="asset-cell"><MiniLogo ticker={position.symbol} /><strong>{position.symbol}</strong></span>
            <span className={position.direction === "up" ? "positive" : "negative"}>{position.direction.toUpperCase()}</span>
            <span>${position.strike.toFixed(2)}</span>
            <span>${position.premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            <span>${position.amount.toLocaleString()}</span>
            <span className="positive">Verified · {position.simulationUnitsConsumed?.toLocaleString() ?? "—"} CU</span>
            <span><a href={solanaExplorerUrl("tx", position.transactionSignature!)} target="_blank" rel="noreferrer">Tx</a> · <a href={`/api/vsol/simulations?id=${encodeURIComponent(position.simulationId!)}`} target="_blank" rel="noreferrer">Sim</a></span>
          </div>
        ))}
      </div>
    );
  } else {
    historyContent = (
      <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>No verified fills yet</strong><p>Confirmed devnet fills with stored simulations will appear here.</p></div></div>
    );
  }

  return (
    <section className="positions-card trade-positions-panel">
      <div className="section-head">
        <div className="tab-strip" role="tablist" aria-label="Trade page positions">
          <button type="button" role="tab" id="tp-tab-positions" aria-selected={tab === "positions"} aria-controls="tp-panel-positions" className={tab === "positions" ? "tab-btn active" : "tab-btn"} onClick={() => setTab("positions")}>{positionsLabel}</button>
          <button type="button" role="tab" id="tp-tab-history" aria-selected={tab === "history"} aria-controls="tp-panel-history" className={tab === "history" ? "tab-btn active" : "tab-btn"} onClick={() => setTab("history")}>{historyLabel}</button>
        </div>
        <div className="trade-positions-meta">
          {chain.phase === "ready" && <span className="verified">Checked {new Date(chain.checkedAt).toLocaleTimeString()}</span>}
          <button type="button" className="text-button" aria-label="Refresh positions" onClick={() => void reloadChain()}><RefreshCw size={13} aria-hidden="true" /></button>
        </div>
      </div>
      {tab === "positions" ? (
        <div role="tabpanel" id="tp-panel-positions" aria-labelledby="tp-tab-positions">{positionsContent}</div>
      ) : (
        <div role="tabpanel" id="tp-panel-history" aria-labelledby="tp-tab-history">{historyContent}</div>
      )}
    </section>
  );
}
