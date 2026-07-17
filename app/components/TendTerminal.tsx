"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  BarChart3,
  BookOpen,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Info,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { quoteFor } from "../lib/options";
import { markets } from "../lib/markets";

type Tab = "market" | "portfolio" | "earn";
type Direction = "up" | "down";
type QuoteState = "idle" | "loading" | "success" | "error";

type MakerQuote = {
  id: string;
  maker: string;
  premium: number;
  maxPayout: number;
  strike: number;
  cap: number;
  breakeven: number;
  impliedVolatility: number;
  effectiveLeverage: number;
  latencyMs: number;
  badge: string;
  expiresAt: number;
};

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type SavedPosition = {
  id: string;
  walletAddress: string;
  quoteId: string;
  maker: string;
  symbol: string;
  direction: Direction;
  amount: number;
  premium: number;
  strike: number;
  capPrice: number;
  expiryDays: number;
  status: "preview_confirmed" | "settled";
  createdAt: string;
};

const assets = markets.map((market) => ({
  ticker: market.symbol,
  name: market.name,
  price: market.price,
  move: market.change,
  iv: market.iv,
  token: market.tokenAddress,
}));

const navItems: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "market", label: "Trade", icon: Activity },
  { id: "portfolio", label: "Portfolio", icon: LayoutDashboard },
  { id: "earn", label: "Write & earn", icon: TrendingUp },
];

function Logo() {
  return (
    <div className="logo" aria-label="Tend home">
      <span className="logo-mark" aria-hidden="true">t</span>
      <span>tend</span>
    </div>
  );
}

function MiniLogo({ ticker }: { ticker: string }) {
  return <span className={`asset-logo asset-${ticker.toLowerCase()}`}>{ticker.slice(0, 1)}</span>;
}

function ProductNav({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return (
    <nav className="product-nav" aria-label="Product">
      {navItems.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={active === id ? "nav-item active" : "nav-item"}
          onClick={() => onChange(id)}
          aria-current={active === id ? "page" : undefined}
        >
          <Icon size={17} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function MarketChart({ direction, spot, target, ticker }: { direction: Direction; spot: number; target: number; ticker: string }) {
  return (
    <div className="chart-wrap" aria-label={`Thirty day ${ticker} token price chart`}>
      <div className="chart-axis">
        <span>${(spot * 1.08).toFixed(0)}</span><span>${(spot * 1.02).toFixed(0)}</span><span>${(spot * .96).toFixed(0)}</span><span>${(spot * .9).toFixed(0)}</span>
      </div>
      <div className="chart-stage">
        <div className="chart-grid" />
        <div className="chart-area" />
        <div className="chart-line" />
        <div className={direction === "up" ? "strike-line up" : "strike-line down"}>
          <span>${target.toFixed(2)} strike</span>
        </div>
        <div className="spot-dot"><span>${spot.toFixed(2)}</span></div>
        <div className="chart-labels"><span>Jun 17</span><span>Jun 27</span><span>Jul 7</span><span>Today</span></div>
      </div>
    </div>
  );
}

function QuotePanel({
  state,
  notional,
  quotes,
  errorMessage,
  secondsLeft,
  selectedQuoteId,
  onQuote,
  onSelect,
  onExecute,
}: {
  state: QuoteState;
  notional: number;
  quotes: MakerQuote[];
  errorMessage: string;
  secondsLeft: number;
  selectedQuoteId: string;
  onQuote: () => void;
  onSelect: (quoteId: string) => void;
  onExecute: () => void;
}) {
  if (state === "idle") {
    return (
      <div className="quote-empty">
        <div className="empty-icon"><Sparkles size={20} aria-hidden="true" /></div>
        <div><strong>Ready for a live quote</strong><p>Three market makers compete for your order.</p></div>
        <button type="button" className="button primary" onClick={onQuote}>Request live quotes <Zap size={16} aria-hidden="true" /></button>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="quote-loading" role="status" aria-live="polite">
        <div className="loading-title"><LoaderCircle size={17} className="spin" aria-hidden="true" /> Requesting executable quotes</div>
        {[0, 1, 2].map((item) => <div className="quote-skeleton" key={item}><span /><span /><span /></div>)}
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="quote-error" role="alert">
        <div><strong>Couldn’t return a quote</strong><p>{errorMessage}</p></div>
        <button type="button" className="button secondary" onClick={onQuote}><RefreshCw size={15} aria-hidden="true" /> Retry</button>
      </div>
    );
  }

  return (
    <div className="quote-results">
      <div className="quote-results-head"><div><span className="eyebrow">Executable for {secondsLeft}s</span><h3>Best of 3 quotes</h3></div><span className="live-dot">Live</span></div>
      <div className="quote-list">
        {quotes.map((maker, index) => (
          <button type="button" className={maker.id === selectedQuoteId ? "quote-row selected" : "quote-row"} key={maker.id} onClick={() => onSelect(maker.id)} aria-pressed={maker.id === selectedQuoteId}>
            <span className="maker-rank">0{index + 1}</span>
            <span><strong>{maker.maker}</strong><small>{(maker.latencyMs / 1000).toFixed(1)}s response</small></span>
            <span className="maker-badge">{maker.badge}</span>
            <span className="quote-price"><strong>${maker.premium.toLocaleString()}</strong><small>{((maker.premium / notional) * 100).toFixed(2)}% premium</small></span>
          </button>
        ))}
      </div>
      <button type="button" className="button primary full" onClick={onExecute}>Review & execute <ArrowUpRight size={16} aria-hidden="true" /></button>
    </div>
  );
}

function TradeView({
  walletAddress,
  onConnect,
  onPositionSaved,
}: {
  walletAddress: string;
  onConnect: () => void | Promise<void>;
  onPositionSaved: (position: SavedPosition) => void;
}) {
  const [assetTicker, setAssetTicker] = useState("NVDA");
  const [direction, setDirection] = useState<Direction>("up");
  const [expiry, setExpiry] = useState("7D");
  const [payoff, setPayoff] = useState(5);
  const [amount, setAmount] = useState("10000");
  const [quoteState, setQuoteState] = useState<QuoteState>("idle");
  const [quotes, setQuotes] = useState<MakerQuote[]>([]);
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [quoteError, setQuoteError] = useState("Use an amount between $100 and $50,000, then retry.");
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [complete, setComplete] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [executionState, setExecutionState] = useState<"idle" | "loading" | "error">("idle");
  const [executionError, setExecutionError] = useState("");
  const asset = assets.find((item) => item.ticker === assetTicker) ?? assets[0];
  const notional = Number(amount) || 0;
  const days = Number.parseInt(expiry, 10);
  const estimate = quoteFor({ spot: asset.price, amount: notional, days, direction, payoff, volatility: asset.iv });
  const bestQuote = quotes.find((quote) => quote.id === selectedQuoteId) ?? quotes[0];
  const premium = bestQuote?.premium ?? estimate.premium;
  const target = bestQuote?.strike ?? estimate.strike;

  useEffect(() => {
    if (!complete) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setComplete(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [complete]);

  useEffect(() => {
    if (quoteState !== "success" || !bestQuote) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((bestQuote.expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setQuoteState("idle");
        setQuotes([]);
        setSelectedQuoteId("");
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [quoteState, bestQuote]);

  function invalidateQuote() {
    setQuoteState("idle");
    setQuotes([]);
    setSelectedQuoteId("");
  }

  async function requestQuote(event?: FormEvent) {
    event?.preventDefault();
    if (notional < 100 || notional > 50000) {
      setQuoteError("Use an amount between $100 and $50,000, then retry.");
      setQuoteState("error");
      return;
    }
    setQuoteState("loading");
    setQuotes([]);
    try {
      const response = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: asset.ticker, direction, amount: notional, days, payoff }),
      });
      const result = await response.json() as { quotes?: MakerQuote[]; error?: string };
      if (!response.ok || !result.quotes?.length) {
        setQuoteError(result.error ?? "Market makers did not return an executable price. Try again.");
        setQuoteState("error");
        return;
      }
      setQuotes(result.quotes);
      setSelectedQuoteId(result.quotes[0].id);
      setQuoteState("success");
    } catch {
      setQuoteError("The quote service is unreachable. Check your connection and retry.");
      setQuoteState("error");
    }
  }

  async function confirmPreviewPosition() {
    if (!bestQuote || !walletAddress) return;
    setExecutionState("loading");
    setExecutionError("");
    try {
      const response = await fetch("/api/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress,
          quoteId: bestQuote.id,
          maker: bestQuote.maker,
          symbol: asset.ticker,
          direction,
          amount: notional,
          premium: bestQuote.premium,
          strike: bestQuote.strike,
          cap: bestQuote.cap,
          expiryDays: days,
          payoff,
        }),
      });
      const result = await response.json() as { position?: SavedPosition; error?: string };
      if (!response.ok || !result.position) {
        setExecutionError(result.error ?? "The position could not be saved. Refresh the quote and retry.");
        setExecutionState("error");
        return;
      }
      setComplete(false);
      setExecutionState("idle");
      onPositionSaved(result.position);
    } catch {
      setExecutionError("The position service is unreachable. Your quote was not executed.");
      setExecutionState("error");
    }
  }

  return (
    <main className="trade-layout">
      <section className="market-column">
        <div className="product-intro"><span className="eyebrow">Defined-risk markets</span><h1>Options, without the trapdoors.</h1><p>Choose up or down. Your loss is capped at the premium, and writers lock the full payout before you trade.</p></div>
        <div className="market-header">
          <div className="asset-heading"><MiniLogo ticker={asset.ticker} /><div><div className="asset-name"><h2>{asset.ticker}</h2><span>Stock Token</span></div><p>{asset.name} economic exposure</p></div></div>
          <span className="asset-picker">4 verified markets <ChevronDown size={16} aria-hidden="true" /></span>
        </div>

        <div className="asset-strip" role="group" aria-label="Available markets">
          {assets.map((item) => (
            <button key={item.ticker} type="button" onClick={() => { setAssetTicker(item.ticker); invalidateQuote(); }} className={asset.ticker === item.ticker ? "asset-chip active" : "asset-chip"}>
              <MiniLogo ticker={item.ticker} /><span><strong>{item.ticker}</strong><small>${item.price.toFixed(2)}</small></span><em className={item.move > 0 ? "positive" : "negative"}>{item.move > 0 ? "+" : ""}{item.move}%</em>
            </button>
          ))}
        </div>

        <div className="market-card">
          <div className="price-row">
            <div><span className="eyebrow">Robinhood Chain · 24/7</span><div className="spot-price"><strong>${asset.price.toFixed(2)}</strong><span className={asset.move > 0 ? "positive-box" : "negative-box"}>{asset.move > 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}{Math.abs(asset.move)}%</span></div></div>
            <div className="market-stats"><div><span>24h volume</span><strong>$4.84M</strong></div><div><span>Open interest</span><strong>$1.26M</strong></div><div><span>ATM IV</span><strong>{asset.iv}%</strong></div></div>
          </div>
          <MarketChart direction={direction} spot={asset.price} target={target} ticker={asset.ticker} />
          <div className="market-footer"><span><Clock3 size={14} aria-hidden="true" /> Preview mark · not live</span><span title={asset.token}><BadgeCheck size={14} aria-hidden="true" /> Canonical token verified</span><span><ShieldCheck size={14} aria-hidden="true" /> Fully collateralized</span></div>
        </div>

        <div className="transparency-card">
          <div><BookOpen size={19} aria-hidden="true" /><span><strong>Price, explained.</strong><small>Tend shows the cost of leverage—not just the multiplier.</small></span></div>
          <button type="button" onClick={() => setShowPricing((value) => !value)} aria-expanded={showPricing}>How Tend prices risk <ArrowUpRight size={15} aria-hidden="true" /></button>
        </div>
        {showPricing && <div className="pricing-explainer"><strong>Competitive RFQ, not a house price.</strong><p>Tend requests short-lived quotes from three makers, ranks the premium, and stores the executable terms server-side. The buyer prepays the premium; the writer must lock the full maximum payout.</p></div>}
      </section>

      <aside className="ticket-column">
        <form className="trade-ticket" onSubmit={requestQuote}>
          <div className="ticket-head"><div><span className="eyebrow">Defined-risk option</span><h2>Build your position</h2></div><span className="no-liquidation"><LockKeyhole size={13} aria-hidden="true" /> 100% locked</span></div>

          <fieldset className="field-group"><legend>Direction</legend><div className="segmented">
            <button type="button" className={direction === "up" ? "segment active up" : "segment"} onClick={() => { setDirection("up"); invalidateQuote(); }}><ArrowUpRight size={17} aria-hidden="true" /> Up</button>
            <button type="button" className={direction === "down" ? "segment active down" : "segment"} onClick={() => { setDirection("down"); invalidateQuote(); }}><ArrowDownRight size={17} aria-hidden="true" /> Down</button>
          </div></fieldset>

          <fieldset className="field-group"><legend>Expires</legend><div className="choice-row">{["7D", "14D", "30D"].map((item) => <button type="button" key={item} className={expiry === item ? "choice active" : "choice"} onClick={() => { setExpiry(item); invalidateQuote(); }}>{item}<small>{item === "7D" ? "Jul 24" : item === "14D" ? "Jul 31" : "Aug 16"}</small></button>)}</div></fieldset>

          <fieldset className="field-group"><legend>Target payoff</legend><div className="choice-row">{[2, 5, 10].map((item) => <button type="button" key={item} className={payoff === item ? "choice active" : "choice"} onClick={() => { setPayoff(item); invalidateQuote(); }}>{item}×<small>{item === 2 ? "Balanced" : item === 5 ? "Popular" : "Aggressive"}</small></button>)}</div></fieldset>

          <div className="field-group"><label htmlFor="amount">Position size</label><div className="amount-input"><span>$</span><input id="amount" type="number" inputMode="decimal" min="100" max="50000" step="100" value={amount} onChange={(event) => { setAmount(event.target.value); invalidateQuote(); }} autoComplete="off" aria-describedby="amount-note" /><span>USDG</span></div><div id="amount-note" className="input-note"><span>Min $100</span><span>Available $24,650</span></div></div>

          <div className="economics">
            <div><span>Target price <Info size={13} aria-hidden="true" /></span><strong>${target.toFixed(2)}</strong></div>
            <div><span>Estimated premium</span><strong>${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>
            <div><span>Maximum loss</span><strong className="risk">${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>
            <div><span>Implied volatility</span><strong>{(bestQuote?.impliedVolatility ?? asset.iv).toFixed(1)}%</strong></div>
            <div className="economics-total"><span>Maximum payout</span><strong>${notional.toLocaleString()}</strong></div>
          </div>

          <QuotePanel state={quoteState} notional={notional} quotes={quotes} errorMessage={quoteError} secondsLeft={secondsLeft} selectedQuoteId={selectedQuoteId} onSelect={setSelectedQuoteId} onQuote={() => requestQuote()} onExecute={() => setComplete(true)} />
        </form>
        <p className="risk-note" id="risk">Options can lose their full premium. Tend does not provide investment advice.</p>
      </aside>

      {complete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && setComplete(false)}>
          <div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <button type="button" className="icon-button close" aria-label="Close review" onClick={() => setComplete(false)}><X size={20} /></button>
            <div className="success-mark"><ShieldCheck size={25} aria-hidden="true" /></div>
            <span className="eyebrow">Best quote secured</span><h2 id="review-title">Review your {asset.ticker} {direction.toUpperCase()}</h2>
            <p>{bestQuote?.maker ?? "The best maker"}’s quote is locked for 30 seconds. Your maximum loss is fixed before you sign.</p>
            <div className="review-grid"><div><span>Premium</span><strong>${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div><span>Strike</span><strong>${target.toFixed(2)}</strong></div><div><span>Expiry</span><strong>{expiry}</strong></div><div><span>Max payout</span><strong>${notional.toLocaleString()}</strong></div></div>
            {executionError && <p className="execution-error" role="alert">{executionError}</p>}
            {walletAddress ? (
              <button type="button" className="button primary full" onClick={confirmPreviewPosition} disabled={executionState === "loading"} aria-busy={executionState === "loading"}><ShieldCheck size={16} aria-hidden="true" /> {executionState === "loading" ? "Confirming…" : "Confirm testnet preview"}</button>
            ) : (
              <button type="button" className="button primary full" onClick={onConnect}><Wallet size={16} aria-hidden="true" /> Connect wallet to continue</button>
            )}
            <p className="preview-disclaimer">Network fee: $0. This records a testnet preview position and sends no wallet transaction. Funds cannot move until TendMarket is deployed and audited.</p>
            <button type="button" className="button ghost full" onClick={() => setComplete(false)}>Back to edit</button>
          </div>
        </div>
      )}
    </main>
  );
}

function PortfolioView({
  positions,
  isLoading,
  error,
  onRetry,
  onTrade,
}: {
  positions: SavedPosition[];
  isLoading: boolean;
  error: string;
  onRetry: () => void;
  onTrade: () => void;
}) {
  const premiumAtRisk = positions.reduce((sum, position) => sum + position.premium, 0);
  const totalNotional = positions.reduce((sum, position) => sum + position.amount, 0);
  const nextExpiry = positions.length ? Math.min(...positions.map((position) => position.expiryDays)) : 0;
  function exportPositions() {
    if (!positions.length) return;
    const header = "symbol,direction,strike,premium,notional,expiry_days,status";
    const rows = positions.map((position) => [position.symbol, position.direction, position.strike, position.premium, position.amount, position.expiryDays, position.status].join(","));
    const url = URL.createObjectURL(new Blob([[header, ...rows].join("\n")], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "tend-positions.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <main className="dashboard-view">
      <div className="view-heading"><div><span className="eyebrow">Portfolio</span><h1>Know exactly what can happen.</h1><p>Defined-risk positions, marked honestly.</p></div><button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" /> Refresh marks</button></div>
      <div className="metric-grid"><div className="metric-card"><span>Preview notional</span><strong>${totalNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong><small>Testnet preview only</small></div><div className="metric-card"><span>Premium at risk</span><strong>${premiumAtRisk.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong><small>Maximum buyer loss</small></div><div className="metric-card"><span>Open positions</span><strong>{positions.length}</strong><small>Fully defined outcomes</small></div><div className="metric-card"><span>Next expiry</span><strong>{nextExpiry ? `${nextExpiry}d` : "—"}</strong><small>{positions[0]?.symbol ?? "No positions"}</small></div></div>
      <section className="positions-card"><div className="section-head"><div><h2>Open positions</h2><p>Live value and defined outcomes.</p></div><button type="button" className="text-button" onClick={exportPositions} disabled={!positions.length}>Export history <ArrowUpRight size={14} /></button></div>
        {isLoading ? <div className="portfolio-loading" role="status" aria-label="Loading positions">{[0, 1].map((item) => <div className="quote-skeleton" key={item}><span /><span /><span /></div>)}</div> : error ? <div className="quote-error" role="alert"><div><strong>Couldn’t load positions</strong><p>{error}</p></div><button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} /> Retry</button></div> : positions.length ? <div className="position-table" role="table" aria-label="Open positions"><div className="table-row table-head" role="row"><span>Market</span><span>Position</span><span>Premium</span><span>Notional</span><span>Status</span><span>Expires</span></div>
          {positions.map((position) => <div className="table-row" role="row" key={position.id}><span className="asset-cell"><MiniLogo ticker={position.symbol} /><strong>{position.symbol}</strong></span><span>{position.direction.toUpperCase()} · ${position.strike.toFixed(2)}</span><span>${position.premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>${position.amount.toLocaleString()}</span><span className="positive">Preview confirmed</span><span>{position.expiryDays}d</span></div>)}
        </div> : <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>No positions yet</strong><p>Request a quote and confirm a testnet preview to see it here.</p></div><button type="button" className="button secondary" onClick={onTrade}>Build a position</button></div>}
      </section>
    </main>
  );
}

function EarnView() {
  const stress = [{ label: "−20%", value: "−$3,840", tone: "loss", width: 86 }, { label: "−10%", value: "−$1,140", tone: "loss", width: 52 }, { label: "Flat", value: "+$684", tone: "gain", width: 31 }, { label: "+10%", value: "+$684", tone: "gain", width: 31 }, { label: "+20%", value: "−$1,905", tone: "loss", width: 61 }];
  return (
    <main className="dashboard-view">
      <div className="view-heading"><div><span className="eyebrow">Writer desk</span><h1>Earn premium. See the obligation.</h1><p>No disguised APY. Every outcome stays visible.</p></div><button type="button" className="button primary" disabled title="Available after the TendMarket testnet deployment"><CircleDollarSign size={16} aria-hidden="true" /> Vault opens after audit</button></div>
      <div className="metric-grid"><div className="metric-card"><span>Locked collateral</span><strong>$18,420.00</strong><small>74.7% utilization</small></div><div className="metric-card"><span>Premium earned</span><strong>$2,184.40</strong><small className="positive">+$684.00 this cycle</small></div><div className="metric-card"><span>Max obligation</span><strong>$12,600.00</strong><small>Fully reserved</small></div><div className="metric-card"><span>Quote uptime</span><strong>97.8%</strong><small>Top 18% of makers</small></div></div>
      <div className="writer-grid">
        <section className="positions-card"><div className="section-head"><div><h2>Scenario P&amp;L</h2><p>Estimated result at Jul 24 expiry.</p></div><span className="verified"><BadgeCheck size={14} /> Collateral verified</span></div><div className="stress-chart">{stress.map((item) => <div className="stress-row" key={item.label}><span>{item.label}</span><div className="stress-track"><i className={item.tone} style={{ width: `${item.width}%` }} /></div><strong className={item.tone === "gain" ? "positive" : "negative"}>{item.value}</strong></div>)}</div><div className="stress-note"><Info size={16} aria-hidden="true" /><p>Your largest modeled loss comes from a 20% downside move while writing puts. Collateral already covers the full obligation.</p></div></section>
        <section className="positions-card risk-composition"><div className="section-head"><div><h2>Exposure</h2><p>By market and direction.</p></div><button type="button" className="icon-button" aria-label="Open exposure analytics"><BarChart3 size={18} /></button></div><div className="donut" aria-label="Exposure: 58 percent NVIDIA, 27 percent Apple, 15 percent Tesla"><div><strong>$12.6K</strong><span>at risk</span></div></div><div className="legend"><div><i className="nvda" /><span>NVDA</span><strong>58%</strong></div><div><i className="aapl" /><span>AAPL</span><strong>27%</strong></div><div><i className="tsla" /><span>TSLA</span><strong>15%</strong></div></div></section>
      </div>
    </main>
  );
}

export function TendTerminal() {
  const [activeTab, setActiveTab] = useState<Tab>("market");
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletError, setWalletError] = useState("");
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [positions, setPositions] = useState<SavedPosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState("");
  const pageTitle = useMemo(() => navItems.find((item) => item.id === activeTab)?.label ?? "Trade", [activeTab]);

  const loadPositions = useCallback(async () => {
    setPositionsLoading(true);
    setPositionsError("");
    try {
      const response = await fetch("/api/positions", { cache: "no-store" });
      const result = await response.json() as { positions?: SavedPosition[]; error?: string };
      if (!response.ok || !result.positions) throw new Error(result.error ?? "Position history is unavailable.");
      setPositions(result.positions);
    } catch (error) {
      setPositionsError(error instanceof Error ? error.message : "Position history is unavailable.");
    } finally {
      setPositionsLoading(false);
    }
  }, []);

  const selectTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    if (tab === "portfolio") void loadPositions();
  }, [loadPositions]);

  async function connectWallet() {
    const provider = (window as typeof window & { ethereum?: EthereumProvider }).ethereum;
    if (!provider) {
      setWalletError("No EVM wallet found. Install Robinhood Wallet or another compatible wallet.");
      return;
    }
    setWalletConnecting(true);
    setWalletError("");
    try {
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xB626" }] });
      } catch (switchError) {
        const code = (switchError as { code?: number }).code;
        if (code !== 4902) throw switchError;
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0xB626",
            chainName: "Robinhood Chain Testnet",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
            blockExplorerUrls: ["https://explorer.testnet.chain.robinhood.com"],
          }],
        });
      }
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
      if (!accounts[0]) throw new Error("Wallet returned no account");
      setWalletAddress(accounts[0]);
    } catch {
      setWalletError("Wallet connection was cancelled or the network could not be added.");
    } finally {
      setWalletConnecting(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a href="#main" className="skip-link">Skip to content</a>
        <Logo />
        <div className="desktop-nav"><ProductNav active={activeTab} onChange={selectTab} /></div>
        <div className="header-actions">
          <div className="network-pill"><span /><strong>Robinhood Chain</strong><small>Preview</small></div>
          <button type="button" className={walletAddress ? "wallet-button connected" : "wallet-button"} onClick={connectWallet} aria-busy={walletConnecting}><Wallet size={16} aria-hidden="true" /> {walletConnecting ? "Connecting…" : walletAddress ? `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}` : "Connect wallet"}</button>
          <button type="button" className="icon-button mobile-menu" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </header>
      {walletError && <div className="wallet-error" role="alert">{walletError}<button type="button" onClick={() => setWalletError("")} aria-label="Dismiss wallet error"><X size={15} /></button></div>}
      {menuOpen && <div className="mobile-nav"><span>{pageTitle}</span><ProductNav active={activeTab} onChange={(tab) => { selectTab(tab); setMenuOpen(false); }} /></div>}
      <div id="main">{activeTab === "market" ? <TradeView walletAddress={walletAddress} onConnect={connectWallet} onPositionSaved={(position) => { setPositions((current) => [position, ...current]); setActiveTab("portfolio"); }} /> : activeTab === "portfolio" ? <PortfolioView positions={positions} isLoading={positionsLoading} error={positionsError} onRetry={loadPositions} onTrade={() => selectTab("market")} /> : <EarnView />}</div>
      <footer><div><Logo /><span>Defined-risk markets for tokenized assets.</span></div><div><a href="#risk">Risk</a><a href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer">Chain docs</a><a href="https://status.robinhood.com/" target="_blank" rel="noreferrer">Status</a><span>© 2026 Tend Labs</span></div></footer>
    </div>
  );
}
