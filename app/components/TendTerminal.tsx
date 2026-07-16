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
import { FormEvent, useEffect, useMemo, useState } from "react";

type Tab = "market" | "portfolio" | "earn";
type Direction = "up" | "down";
type QuoteState = "idle" | "loading" | "success" | "error";

const assets = [
  { ticker: "NVDA", name: "NVIDIA", price: 184.62, move: 2.84, iv: 46.2, token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
  { ticker: "TSLA", name: "Tesla", price: 336.41, move: -1.16, iv: 57.8, token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
  { ticker: "AAPL", name: "Apple", price: 229.78, move: 0.64, iv: 28.4, token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
  { ticker: "SPCX", name: "SpaceX exposure", price: 246.18, move: 4.21, iv: 68.9, token: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa" },
] as const;

const quoteMakers = [
  { name: "Aster", premium: 928, latency: "0.8s", badge: "Best price" },
  { name: "Northstar", premium: 944, latency: "1.1s", badge: "Deepest" },
  { name: "Maverick", premium: 971, latency: "0.6s", badge: "Fastest" },
];

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

function MarketChart({ direction }: { direction: Direction }) {
  return (
    <div className="chart-wrap" aria-label="Thirty day NVIDIA token price chart">
      <div className="chart-axis">
        <span>$190</span><span>$180</span><span>$170</span><span>$160</span>
      </div>
      <div className="chart-stage">
        <div className="chart-grid" />
        <div className="chart-area" />
        <div className="chart-line" />
        <div className={direction === "up" ? "strike-line up" : "strike-line down"}>
          <span>{direction === "up" ? "$192.50 target" : "$176.00 target"}</span>
        </div>
        <div className="spot-dot"><span>$184.62</span></div>
        <div className="chart-labels"><span>Jun 17</span><span>Jun 27</span><span>Jul 7</span><span>Today</span></div>
      </div>
    </div>
  );
}

function QuotePanel({
  state,
  notional,
  onQuote,
  onExecute,
}: {
  state: QuoteState;
  notional: number;
  onQuote: () => void;
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
        <div><strong>Enter a valid order size</strong><p>Use an amount between $100 and $50,000, then retry.</p></div>
        <button type="button" className="button secondary" onClick={onQuote}><RefreshCw size={15} aria-hidden="true" /> Retry</button>
      </div>
    );
  }

  return (
    <div className="quote-results">
      <div className="quote-results-head"><div><span className="eyebrow">Executable for 12s</span><h3>Best of 3 quotes</h3></div><span className="live-dot">Live</span></div>
      <div className="quote-list">
        {quoteMakers.map((maker, index) => (
          <button type="button" className={index === 0 ? "quote-row selected" : "quote-row"} key={maker.name}>
            <span className="maker-rank">0{index + 1}</span>
            <span><strong>{maker.name}</strong><small>{maker.latency} response</small></span>
            <span className="maker-badge">{maker.badge}</span>
            <span className="quote-price"><strong>${maker.premium.toLocaleString()}</strong><small>{((maker.premium / notional) * 100).toFixed(2)}% premium</small></span>
          </button>
        ))}
      </div>
      <button type="button" className="button primary full" onClick={onExecute}>Review & execute <ArrowUpRight size={16} aria-hidden="true" /></button>
    </div>
  );
}

function TradeView({ onConnect }: { onConnect: () => void }) {
  const [assetTicker, setAssetTicker] = useState("NVDA");
  const [direction, setDirection] = useState<Direction>("up");
  const [expiry, setExpiry] = useState("7D");
  const [payoff, setPayoff] = useState(5);
  const [amount, setAmount] = useState("10000");
  const [quoteState, setQuoteState] = useState<QuoteState>("idle");
  const [complete, setComplete] = useState(false);
  const asset = assets.find((item) => item.ticker === assetTicker) ?? assets[0];
  const notional = Number(amount) || 0;
  const premium = Math.round(notional / payoff * 0.464);
  const target = direction === "up" ? asset.price * 1.0427 : asset.price * 0.9533;

  useEffect(() => {
    if (!complete) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setComplete(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [complete]);

  function requestQuote(event?: FormEvent) {
    event?.preventDefault();
    if (notional < 100 || notional > 50000) {
      setQuoteState("error");
      return;
    }
    setQuoteState("loading");
    window.setTimeout(() => setQuoteState("success"), 850);
  }

  return (
    <main className="trade-layout">
      <section className="market-column">
        <div className="market-header">
          <div className="asset-heading"><MiniLogo ticker={asset.ticker} /><div><div className="asset-name"><h1>{asset.ticker}</h1><span>Stock Token</span></div><p>{asset.name} economic exposure</p></div></div>
          <button className="asset-picker" type="button" aria-label="Choose another market">Change market <ChevronDown size={16} aria-hidden="true" /></button>
        </div>

        <div className="asset-strip" role="group" aria-label="Available markets">
          {assets.map((item) => (
            <button key={item.ticker} type="button" onClick={() => { setAssetTicker(item.ticker); setQuoteState("idle"); }} className={asset.ticker === item.ticker ? "asset-chip active" : "asset-chip"}>
              <MiniLogo ticker={item.ticker} /><span><strong>{item.ticker}</strong><small>${item.price.toFixed(2)}</small></span><em className={item.move > 0 ? "positive" : "negative"}>{item.move > 0 ? "+" : ""}{item.move}%</em>
            </button>
          ))}
        </div>

        <div className="market-card">
          <div className="price-row">
            <div><span className="eyebrow">Robinhood Chain · 24/7</span><div className="spot-price"><strong>${asset.price.toFixed(2)}</strong><span className={asset.move > 0 ? "positive-box" : "negative-box"}>{asset.move > 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}{Math.abs(asset.move)}%</span></div></div>
            <div className="market-stats"><div><span>24h volume</span><strong>$4.84M</strong></div><div><span>Open interest</span><strong>$1.26M</strong></div><div><span>ATM IV</span><strong>{asset.iv}%</strong></div></div>
          </div>
          <MarketChart direction={direction} />
          <div className="market-footer"><span><Clock3 size={14} aria-hidden="true" /> Preview mark · not live</span><span title={asset.token}><BadgeCheck size={14} aria-hidden="true" /> Canonical token verified</span><span><ShieldCheck size={14} aria-hidden="true" /> Fully collateralized</span></div>
        </div>

        <div className="transparency-card">
          <div><BookOpen size={19} aria-hidden="true" /><span><strong>Price, explained.</strong><small>Tend shows the cost of leverage—not just the multiplier.</small></span></div>
          <button type="button">How Tend prices risk <ArrowUpRight size={15} aria-hidden="true" /></button>
        </div>
      </section>

      <aside className="ticket-column">
        <form className="trade-ticket" onSubmit={requestQuote}>
          <div className="ticket-head"><div><span className="eyebrow">Defined-risk option</span><h2>Build your position</h2></div><span className="no-liquidation"><LockKeyhole size={13} aria-hidden="true" /> 100% locked</span></div>

          <fieldset className="field-group"><legend>Direction</legend><div className="segmented">
            <button type="button" className={direction === "up" ? "segment active up" : "segment"} onClick={() => { setDirection("up"); setQuoteState("idle"); }}><ArrowUpRight size={17} aria-hidden="true" /> Up</button>
            <button type="button" className={direction === "down" ? "segment active down" : "segment"} onClick={() => { setDirection("down"); setQuoteState("idle"); }}><ArrowDownRight size={17} aria-hidden="true" /> Down</button>
          </div></fieldset>

          <fieldset className="field-group"><legend>Expires</legend><div className="choice-row">{["7D", "14D", "30D"].map((item) => <button type="button" key={item} className={expiry === item ? "choice active" : "choice"} onClick={() => { setExpiry(item); setQuoteState("idle"); }}>{item}<small>{item === "7D" ? "Jul 24" : item === "14D" ? "Jul 31" : "Aug 16"}</small></button>)}</div></fieldset>

          <fieldset className="field-group"><legend>Target payoff</legend><div className="choice-row">{[2, 5, 10].map((item) => <button type="button" key={item} className={payoff === item ? "choice active" : "choice"} onClick={() => { setPayoff(item); setQuoteState("idle"); }}>{item}×<small>{item === 2 ? "Balanced" : item === 5 ? "Popular" : "Aggressive"}</small></button>)}</div></fieldset>

          <div className="field-group"><label htmlFor="amount">Position size</label><div className="amount-input"><span>$</span><input id="amount" type="number" inputMode="decimal" min="100" max="50000" step="100" value={amount} onChange={(event) => { setAmount(event.target.value); setQuoteState("idle"); }} autoComplete="off" aria-describedby="amount-note" /><span>USDG</span></div><div id="amount-note" className="input-note"><span>Min $100</span><span>Available $24,650</span></div></div>

          <div className="economics">
            <div><span>Target price <Info size={13} aria-hidden="true" /></span><strong>${target.toFixed(2)}</strong></div>
            <div><span>Estimated premium</span><strong>${premium.toLocaleString()}</strong></div>
            <div><span>Maximum loss</span><strong className="risk">${premium.toLocaleString()}</strong></div>
            <div><span>Implied volatility</span><strong>{(asset.iv + payoff * 0.76).toFixed(1)}%</strong></div>
            <div className="economics-total"><span>Potential payout</span><strong>${Math.round(premium * payoff).toLocaleString()}</strong></div>
          </div>

          <QuotePanel state={quoteState} notional={notional} onQuote={() => requestQuote()} onExecute={() => setComplete(true)} />
        </form>
        <p className="risk-note">Options can lose their full premium. Tend does not provide investment advice.</p>
      </aside>

      {complete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && setComplete(false)}>
          <div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <button type="button" className="icon-button close" aria-label="Close review" onClick={() => setComplete(false)}><X size={20} /></button>
            <div className="success-mark"><ShieldCheck size={25} aria-hidden="true" /></div>
            <span className="eyebrow">Best quote secured</span><h2 id="review-title">Review your {asset.ticker} {direction.toUpperCase()}</h2>
            <p>Aster’s quote is locked for 12 seconds. Your maximum loss is fixed before you sign.</p>
            <div className="review-grid"><div><span>Premium</span><strong>$928</strong></div><div><span>Target</span><strong>${target.toFixed(2)}</strong></div><div><span>Expiry</span><strong>{expiry}</strong></div><div><span>Max payout</span><strong>${(928 * payoff).toLocaleString()}</strong></div></div>
            <button type="button" className="button primary full" onClick={onConnect}><Wallet size={16} aria-hidden="true" /> Connect wallet to execute</button>
            <button type="button" className="button ghost full" onClick={() => setComplete(false)}>Back to edit</button>
          </div>
        </div>
      )}
    </main>
  );
}

function PortfolioView() {
  return (
    <main className="dashboard-view">
      <div className="view-heading"><div><span className="eyebrow">Portfolio</span><h1>Know exactly what can happen.</h1><p>Defined-risk positions, marked honestly.</p></div><button type="button" className="button secondary"><RefreshCw size={15} aria-hidden="true" /> Refresh marks</button></div>
      <div className="metric-grid"><div className="metric-card"><span>Portfolio value</span><strong>$24,650.00</strong><small className="positive">+$1,284.22 all time</small></div><div className="metric-card"><span>Premium at risk</span><strong>$1,372.00</strong><small>5.6% of portfolio</small></div><div className="metric-card"><span>Open positions</span><strong>3</strong><small>2 up · 1 protective</small></div><div className="metric-card"><span>Next expiry</span><strong>2d 14h</strong><small>NVDA · Jul 19</small></div></div>
      <section className="positions-card"><div className="section-head"><div><h2>Open positions</h2><p>Live value and defined outcomes.</p></div><button type="button" className="text-button">Export history <ArrowUpRight size={14} /></button></div>
        <div className="position-table" role="table" aria-label="Open positions"><div className="table-row table-head" role="row"><span>Market</span><span>Position</span><span>Paid</span><span>Current value</span><span>Return</span><span>Expires</span></div>
          <div className="table-row" role="row"><span className="asset-cell"><MiniLogo ticker="NVDA" /><strong>NVDA</strong></span><span>UP · $192.50</span><span>$928</span><span>$1,184</span><span className="positive">+$256.00</span><span>2d 14h</span></div>
          <div className="table-row" role="row"><span className="asset-cell"><MiniLogo ticker="TSLA" /><strong>TSLA</strong></span><span>DOWN · $320.00</span><span>$444</span><span>$318</span><span className="negative">−$126.00</span><span>9d 14h</span></div>
        </div>
      </section>
      <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>Your third position is awaiting a quote</strong><p>Market makers will respond during the next quoting window.</p></div><button type="button" className="button secondary">View request</button></div>
    </main>
  );
}

function EarnView() {
  const stress = [{ label: "−20%", value: "−$3,840", tone: "loss", width: 86 }, { label: "−10%", value: "−$1,140", tone: "loss", width: 52 }, { label: "Flat", value: "+$684", tone: "gain", width: 31 }, { label: "+10%", value: "+$684", tone: "gain", width: 31 }, { label: "+20%", value: "−$1,905", tone: "loss", width: 61 }];
  return (
    <main className="dashboard-view">
      <div className="view-heading"><div><span className="eyebrow">Writer desk</span><h1>Earn premium. See the obligation.</h1><p>No disguised APY. Every outcome stays visible.</p></div><button type="button" className="button primary"><CircleDollarSign size={16} aria-hidden="true" /> Deposit collateral</button></div>
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
  const [connected, setConnected] = useState(false);
  const pageTitle = useMemo(() => navItems.find((item) => item.id === activeTab)?.label ?? "Trade", [activeTab]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a href="#main" className="skip-link">Skip to content</a>
        <Logo />
        <div className="desktop-nav"><ProductNav active={activeTab} onChange={setActiveTab} /></div>
        <div className="header-actions">
          <div className="network-pill"><span /><strong>Robinhood Chain</strong><small>Testnet</small></div>
          <button type="button" className={connected ? "wallet-button connected" : "wallet-button"} onClick={() => setConnected((value) => !value)}><Wallet size={16} aria-hidden="true" /> {connected ? "0x7A…19F2" : "Connect wallet"}</button>
          <button type="button" className="icon-button mobile-menu" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </header>
      {menuOpen && <div className="mobile-nav"><span>{pageTitle}</span><ProductNav active={activeTab} onChange={(tab) => { setActiveTab(tab); setMenuOpen(false); }} /></div>}
      <div id="main">{activeTab === "market" ? <TradeView onConnect={() => { setConnected(true); }} /> : activeTab === "portfolio" ? <PortfolioView /> : <EarnView />}</div>
      <footer><div><Logo /><span>Defined-risk markets for tokenized assets.</span></div><div><a href="#risk">Risk</a><a href="#docs">Docs</a><a href="#status">Status</a><span>© 2026 Tend Labs</span></div></footer>
    </div>
  );
}
