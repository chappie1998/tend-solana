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
import { Transaction } from "@solana/web3.js";
import { quoteFor } from "../lib/options";
import { markets } from "../lib/markets";
import { expiryCodes, resolveExpiry, type ExpiryCode } from "../lib/expiries";
import {
  VSOL_PROGRAM_ID,
  solanaExplorerUrl,
  type SolanaWalletProvider,
  type VsolQuotePayload,
} from "../lib/vsol";
import { TradingViewMarketChart, type MarketSnapshot } from "./TradingViewMarketChart";

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
  expiryCode: ExpiryCode;
  optionExpiryAt: string;
  observationWindowSeconds: number;
  tradeLockSeconds: number;
  status: "preview_confirmed" | "settled";
  createdAt: string;
  transactionSignature?: string;
};

function injectedSolanaWallet() {
  const target = window as typeof window & {
    phantom?: { solana?: SolanaWalletProvider };
    solana?: SolanaWalletProvider;
  };
  return target.phantom?.solana ?? target.solana;
}

const assets = markets.map((market) => ({
  ticker: market.symbol,
  name: market.name,
  price: market.price,
  move: market.change,
  iv: market.iv,
  token: market.tokenAddress,
  oracleStatus: market.oracleStatus,
  intradayEligible: market.intradayEligible,
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
        <div><strong>Ready for an executable quote</strong><p>The deployed devnet maker signs a one-shot RFQ.</p></div>
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
      <div className="quote-results-head"><div><span className="eyebrow">Executable for {secondsLeft}s</span><h3>Signed devnet quote</h3></div><span className="live-dot">Onchain</span></div>
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

function VsolStatus() {
  const [status, setStatus] = useState<{
    ok: boolean;
    executable?: boolean;
    writerLiquidity?: number;
    explorerUrl?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/vsol/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => { if (!cancelled) setStatus(result as typeof status); })
      .catch(() => { if (!cancelled) setStatus({ ok: false }); });
    return () => { cancelled = true; };
  }, []);

  const explorer = status?.explorerUrl ?? solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58());
  return (
    <div className={status?.ok ? "protocol-strip verified" : "protocol-strip"}>
      <div><span className="protocol-pulse" /><span><strong>{status === null ? "Checking VSOL devnet…" : status.ok ? "VSOL program verified" : "Devnet RPC unavailable"}</strong><small>{status?.executable ? `${(status.writerLiquidity ?? 0).toLocaleString()} tUSDC in writer escrow` : "Mock assets · controlled settlement oracle"}</small></span></div>
      <a href={explorer} target="_blank" rel="noreferrer">View program <ArrowUpRight size={14} /></a>
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
  const [expiry, setExpiry] = useState<ExpiryCode>("30D");
  const [payoff, setPayoff] = useState(5);
  const [amount, setAmount] = useState("1000");
  const [quoteState, setQuoteState] = useState<QuoteState>("idle");
  const [quotes, setQuotes] = useState<MakerQuote[]>([]);
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [quoteError, setQuoteError] = useState("Use an amount between $100 and $50,000, then retry.");
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [complete, setComplete] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [executionState, setExecutionState] = useState<"idle" | "loading" | "error">("idle");
  const [executionError, setExecutionError] = useState("");
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);
  const [vsolQuote, setVsolQuote] = useState<VsolQuotePayload | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const asset = assets.find((item) => item.ticker === assetTicker) ?? assets[0];
  const notional = Number(amount) || 0;
  const expiryOptions = expiryCodes.map((code) => {
    const definition = resolveExpiry(code, asset.ticker, now);
    if (code !== "30D") {
      return { ...definition, available: false, availabilityReason: "This series is protocol-ready but not published in the devnet sandbox until a production oracle is connected." };
    }
    if (definition.group === "intraday" && definition.available && marketSnapshot?.mode !== "live") {
      return { ...definition, available: false, availabilityReason: "Intraday quotes require a fresh licensed display feed." };
    }
    return definition;
  });
  const expiryDefinition = expiryOptions.find((item) => item.code === expiry) ?? resolveExpiry(expiry, asset.ticker, now);
  const estimate = quoteFor({ spot: asset.price, amount: notional, durationMinutes: expiryDefinition.durationMinutes, direction, payoff, volatility: asset.iv });
  const bestQuote = quotes.find((quote) => quote.id === selectedQuoteId) ?? quotes[0];
  const premium = bestQuote?.premium ?? estimate.premium;
  const target = bestQuote?.strike ?? estimate.strike;
  const displayedPrice = marketSnapshot?.price ?? asset.price;
  const displayedMove = marketSnapshot?.changePercent ?? asset.move;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

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
    setVsolQuote(null);
  }

  async function requestQuote(event?: FormEvent) {
    event?.preventDefault();
    if (!walletAddress) {
      setQuoteError("Connect a Solana wallet first; the RFQ is signed for that exact buyer address.");
      setQuoteState("error");
      return;
    }
    if (notional < 100 || notional > 5000) {
      setQuoteError("Use a devnet amount between $100 and $5,000, then retry.");
      setQuoteState("error");
      return;
    }
    if (!expiryDefinition.available) {
      setQuoteError(expiryDefinition.availabilityReason);
      setQuoteState("error");
      return;
    }
    setQuoteState("loading");
    setQuotes([]);
    try {
      const response = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: asset.ticker, direction, amount: notional, expiryCode: expiry, payoff, walletAddress }),
      });
      const result = await response.json() as { quotes?: MakerQuote[]; vsol?: VsolQuotePayload; error?: string };
      if (!response.ok || !result.quotes?.length) {
        setQuoteError(result.error ?? "Market makers did not return an executable price. Try again.");
        setQuoteState("error");
        return;
      }
      setQuotes(result.quotes);
      setVsolQuote(result.vsol ?? null);
      setSelectedQuoteId(result.quotes[0].id);
      setQuoteState("success");
    } catch {
      setQuoteError("The quote service is unreachable. Check your connection and retry.");
      setQuoteState("error");
    }
  }

  async function confirmPreviewPosition() {
    if (!bestQuote || !walletAddress || !vsolQuote) return;
    setExecutionState("loading");
    setExecutionError("");
    try {
      const provider = injectedSolanaWallet();
      if (!provider) throw new Error("Solana wallet unavailable");
      const bytes = Uint8Array.from(atob(vsolQuote.transaction), (character) => character.charCodeAt(0));
      const transaction = Transaction.from(bytes);
      const signed = await provider.signTransaction(transaction);
      const signedBytes = signed.serialize();
      let signedBinary = "";
      for (const byte of signedBytes) signedBinary += String.fromCharCode(byte);
      const sendResponse = await fetch("/api/vsol/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction: btoa(signedBinary) }),
      });
      const sent = await sendResponse.json() as { signature?: string; error?: string };
      if (!sendResponse.ok || !sent.signature) throw new Error(sent.error ?? "Devnet did not confirm the fill.");
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
          expiryCode: expiry,
          payoff,
          transactionSignature: sent.signature,
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
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "The wallet transaction was not executed.");
      setExecutionState("error");
    }
  }

  return (
    <main className="trade-layout">
      <section className="market-column">
        <div className="product-intro"><span className="eyebrow">VSOL · Solana-native defined risk</span><h1>Options, without the trapdoors.</h1><p>Choose up or down. Your loss is capped at the premium, and Solana escrows the writer’s full payout before the trade opens.</p></div>
        <VsolStatus />
        <div className="market-header">
          <div className="asset-heading"><MiniLogo ticker={asset.ticker} /><div><div className="asset-name"><h2>{asset.ticker}</h2><span>Stock Token</span></div><p>{asset.name} economic exposure</p></div></div>
          <span className="asset-picker">Devnet sandbox <ChevronDown size={16} aria-hidden="true" /></span>
        </div>

        <div className="asset-strip" role="group" aria-label="Available markets">
          {assets.map((item) => (
            <button key={item.ticker} type="button" onClick={() => { setAssetTicker(item.ticker); setMarketSnapshot(null); if (!resolveExpiry(expiry, item.ticker, Date.now()).available) setExpiry("7D"); invalidateQuote(); }} className={asset.ticker === item.ticker ? "asset-chip active" : "asset-chip"}>
              <MiniLogo ticker={item.ticker} /><span><strong>{item.ticker}</strong><small>${item.price.toFixed(2)}</small></span><em className={item.move > 0 ? "positive" : "negative"}>{item.move > 0 ? "+" : ""}{item.move}%</em>
            </button>
          ))}
        </div>

        <div className="market-card">
          <div className="price-row">
            <div><span className="eyebrow">Reference market · session-aware</span><div className="spot-price"><strong>${displayedPrice.toFixed(2)}</strong><span className={displayedMove > 0 ? "positive-box" : "negative-box"}>{displayedMove > 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}{Math.abs(displayedMove).toFixed(2)}%</span><span className={`price-mode ${marketSnapshot?.mode ?? "demo"}`}>{marketSnapshot?.mode === "live" ? "Live" : marketSnapshot?.mode === "delayed" ? "Delayed" : "Demo"}</span></div></div>
            <div className="market-stats"><div><span>Display volume</span><strong>{marketSnapshot?.sessionVolume ? marketSnapshot.sessionVolume.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 }) : "—"}</strong></div><div><span>Protocol OI</span><strong>—</strong></div><div><span>Model IV</span><strong>{asset.iv}%</strong></div></div>
          </div>
          <TradingViewMarketChart key={asset.ticker} direction={direction} target={target} ticker={asset.ticker} onSnapshot={setMarketSnapshot} />
          <div className="market-footer"><span><Clock3 size={14} aria-hidden="true" /> Chart feed is display-only</span><span title={asset.token}><BadgeCheck size={14} aria-hidden="true" /> Mock RWA on devnet</span><span><ShieldCheck size={14} aria-hidden="true" /> Fully collateralized</span></div>
        </div>

        <div className="transparency-card">
          <div><BookOpen size={19} aria-hidden="true" /><span><strong>Price, explained.</strong><small>Tend shows the cost of leverage—not just the multiplier.</small></span></div>
          <button type="button" onClick={() => setShowPricing((value) => !value)} aria-expanded={showPricing}>How Tend prices risk <ArrowUpRight size={15} aria-hidden="true" /></button>
        </div>
        {showPricing && <div className="pricing-explainer"><strong>Signed RFQ, verified by Solana.</strong><p>The devnet maker signs the exact buyer, market, economics, nonce, program, cluster, and config version. The buyer prepays the premium; a program-owned vault escrows the writer’s maximum payout.</p></div>}
      </section>

      <aside className="ticket-column">
        <form className="trade-ticket" onSubmit={requestQuote}>
          <div className="ticket-head"><div><span className="eyebrow">Defined-risk option</span><h2>Build your position</h2></div><span className="no-liquidation"><LockKeyhole size={13} aria-hidden="true" /> 100% locked</span></div>

          <fieldset className="field-group"><legend>Direction</legend><div className="segmented">
            <button type="button" className={direction === "up" ? "segment active up" : "segment"} onClick={() => { setDirection("up"); invalidateQuote(); }}><ArrowUpRight size={17} aria-hidden="true" /> Up</button>
            <button type="button" className={direction === "down" ? "segment active down" : "segment"} onClick={() => { setDirection("down"); invalidateQuote(); }}><ArrowDownRight size={17} aria-hidden="true" /> Down</button>
          </div></fieldset>

          <fieldset className="field-group expiry-field"><legend>Expires</legend>
            <div className="expiry-group-head"><span>Intraday</span><small>Protocol-ready · oracle gated</small></div>
            <div className="choice-row expiry-row">{expiryOptions.filter((item) => item.group === "intraday").map((item) => <button type="button" key={item.code} className={expiry === item.code ? "choice active" : "choice"} disabled={!item.available} title={item.available ? `${item.label}, settles ${item.detail}` : item.availabilityReason} onClick={() => { setExpiry(item.code); invalidateQuote(); }}>{item.shortLabel}<small>{item.available ? item.detail : !asset.intradayEligible ? "Unavailable" : item.availabilityReason.includes("feed") ? "Live feed required" : "Market closed"}</small></button>)}</div>
            <div className="expiry-group-head standard"><span>Standard</span><small>Longer observation window</small></div>
            <div className="choice-row standard-expiry-row">{expiryOptions.filter((item) => item.group === "standard").map((item) => <button type="button" key={item.code} className={expiry === item.code ? "choice active" : "choice"} disabled={!item.available} title={item.available ? `${item.label}, settles ${item.detail}` : item.availabilityReason} onClick={() => { setExpiry(item.code); invalidateQuote(); }}>{item.shortLabel}<small>{item.available ? item.detail : "Oracle gated"}</small></button>)}</div>
            <p className="expiry-policy"><ShieldCheck size={13} aria-hidden="true" /> {expiryDefinition.available ? `${expiryDefinition.tradeLockSeconds}s trade lock · ${expiryDefinition.observationWindowSeconds}s oracle window` : expiryDefinition.availabilityReason}</p>
          </fieldset>

          <fieldset className="field-group"><legend>Target payoff</legend><div className="choice-row">{[2, 5, 10].map((item) => <button type="button" key={item} className={payoff === item ? "choice active" : "choice"} onClick={() => { setPayoff(item); invalidateQuote(); }}>{item}×<small>{item === 2 ? "Balanced" : item === 5 ? "Popular" : "Aggressive"}</small></button>)}</div></fieldset>

          <div className="field-group"><label htmlFor="amount">Position size</label><div className="amount-input"><span>$</span><input id="amount" type="number" inputMode="decimal" min="100" max="5000" step="100" value={amount} onChange={(event) => { setAmount(event.target.value); invalidateQuote(); }} autoComplete="off" aria-describedby="amount-note" /><span>tUSDC</span></div><div id="amount-note" className="input-note"><span>Min $100</span><span>Devnet max $5,000</span></div></div>

          <div className="economics">
            <div><span>Target price <Info size={13} aria-hidden="true" /></span><strong>${target.toFixed(2)}</strong></div>
            <div><span>Estimated premium</span><strong>${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>
            <div><span>Maximum loss</span><strong className="risk">${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>
            <div><span>Implied volatility</span><strong>{(bestQuote?.impliedVolatility ?? asset.iv).toFixed(1)}%</strong></div>
            <div className="economics-total"><span>Maximum payout</span><strong>${notional.toLocaleString()}</strong></div>
          </div>

          <QuotePanel state={quoteState} notional={notional} quotes={quotes} errorMessage={quoteError} secondsLeft={secondsLeft} selectedQuoteId={selectedQuoteId} onSelect={setSelectedQuoteId} onQuote={() => requestQuote()} onExecute={() => setComplete(true)} />
        </form>
        <p className="risk-note" id="risk">Devnet only: mock assets, controlled oracle, no real value. Options can lose their full premium.</p>
      </aside>

      {complete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && setComplete(false)}>
          <div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <button type="button" className="icon-button close" aria-label="Close review" onClick={() => setComplete(false)}><X size={20} /></button>
            <div className="success-mark"><ShieldCheck size={25} aria-hidden="true" /></div>
            <span className="eyebrow">Best quote secured</span><h2 id="review-title">Review your {asset.ticker} {direction.toUpperCase()}</h2>
            <p>{bestQuote?.maker ?? "The best maker"}’s quote is locked for 30 seconds. Your maximum loss is fixed before you sign.</p>
            <div className="review-grid"><div><span>Premium</span><strong>${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div><span>Strike</span><strong>${target.toFixed(2)}</strong></div><div><span>Expiry</span><strong>{expiryDefinition.shortLabel} · {expiryDefinition.detail}</strong></div><div><span>Max payout</span><strong>${notional.toLocaleString()}</strong></div></div>
            {executionError && <p className="execution-error" role="alert">{executionError}</p>}
            {walletAddress ? (
              <button type="button" className="button primary full" onClick={confirmPreviewPosition} disabled={executionState === "loading"} aria-busy={executionState === "loading"}><ShieldCheck size={16} aria-hidden="true" /> {executionState === "loading" ? "Signing & confirming…" : "Execute on Solana devnet"}</button>
            ) : (
              <button type="button" className="button primary full" onClick={onConnect}><Wallet size={16} aria-hidden="true" /> Connect wallet to continue</button>
            )}
            <p className="preview-disclaimer">Your wallet signs a real devnet transaction using mock tUSDC. VSOL is unaudited and its demo oracle is controlled; never use mainnet funds.</p>
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
  const nextPosition = positions
    .filter((position) => position.optionExpiryAt && new Date(position.optionExpiryAt).getTime() > 0)
    .sort((left, right) => new Date(left.optionExpiryAt).getTime() - new Date(right.optionExpiryAt).getTime())[0];
  const expiryLabel = (position: SavedPosition) => position.expiryCode || (position.expiryDays ? `${position.expiryDays}D` : "—");
  function exportPositions() {
    if (!positions.length) return;
    const header = "symbol,direction,strike,premium,notional,expiry_code,option_expiry_at,observation_window_seconds,status";
    const rows = positions.map((position) => [position.symbol, position.direction, position.strike, position.premium, position.amount, expiryLabel(position), position.optionExpiryAt, position.observationWindowSeconds, position.status].join(","));
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
      <div className="metric-grid"><div className="metric-card"><span>Devnet notional</span><strong>${totalNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong><small>Mock tUSDC only</small></div><div className="metric-card"><span>Premium at risk</span><strong>${premiumAtRisk.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong><small>Maximum buyer loss</small></div><div className="metric-card"><span>Confirmed fills</span><strong>{positions.length}</strong><small>Verified before recording</small></div><div className="metric-card"><span>Next expiry</span><strong>{nextPosition ? expiryLabel(nextPosition) : "—"}</strong><small>{nextPosition?.symbol ?? "No positions"}</small></div></div>
      <section className="positions-card"><div className="section-head"><div><h2>Open positions</h2><p>Live value and defined outcomes.</p></div><button type="button" className="text-button" onClick={exportPositions} disabled={!positions.length}>Export history <ArrowUpRight size={14} /></button></div>
        {isLoading ? <div className="portfolio-loading" role="status" aria-label="Loading positions">{[0, 1].map((item) => <div className="quote-skeleton" key={item}><span /><span /><span /></div>)}</div> : error ? <div className="quote-error" role="alert"><div><strong>Couldn’t load positions</strong><p>{error}</p></div><button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} /> Retry</button></div> : positions.length ? <div className="position-table" role="table" aria-label="Open positions"><div className="table-row table-head" role="row"><span>Market</span><span>Position</span><span>Premium</span><span>Notional</span><span>Status</span><span>Expires</span></div>
          {positions.map((position) => <div className="table-row" role="row" key={position.id}><span className="asset-cell"><MiniLogo ticker={position.symbol} /><strong>{position.symbol}</strong></span><span>{position.direction.toUpperCase()} · ${position.strike.toFixed(2)}</span><span>${position.premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>${position.amount.toLocaleString()}</span><span className="positive">Devnet confirmed</span><span>{position.transactionSignature ? <a href={solanaExplorerUrl("tx", position.transactionSignature)} target="_blank" rel="noreferrer">Explorer</a> : expiryLabel(position)}</span></div>)}
        </div> : <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>No positions yet</strong><p>Connect a Solana wallet and execute a devnet quote to see it here.</p></div><button type="button" className="button secondary" onClick={onTrade}>Build a position</button></div>}
      </section>
    </main>
  );
}

function EarnView() {
  const stress = [{ label: "−20%", value: "−$3,840", tone: "loss", width: 86 }, { label: "−10%", value: "−$1,140", tone: "loss", width: 52 }, { label: "Flat", value: "+$684", tone: "gain", width: 31 }, { label: "+10%", value: "+$684", tone: "gain", width: 31 }, { label: "+20%", value: "−$1,905", tone: "loss", width: 61 }];
  return (
    <main className="dashboard-view">
      <div className="view-heading"><div><span className="eyebrow">Writer desk</span><h1>Earn premium. See the obligation.</h1><p>No disguised APY. Every outcome stays visible.</p></div><a className="button primary" href={solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer"><CircleDollarSign size={16} aria-hidden="true" /> Inspect VSOL vault</a></div>
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
  const [walletFunding, setWalletFunding] = useState(false);
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

  async function claimDevnetFunds(walletAddress: string) {
    setWalletFunding(true);
    try {
      const response = await fetch("/api/vsol/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The devnet faucet is unavailable.");
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "The devnet faucet is unavailable.");
    } finally {
      setWalletFunding(false);
    }
  }

  async function connectWallet() {
    const provider = injectedSolanaWallet();
    if (!provider) {
      setWalletError("No Solana wallet found. Install Phantom or another injected Solana wallet.");
      return;
    }
    setWalletConnecting(true);
    setWalletError("");
    try {
      const connected = await provider.connect();
      const address = connected.publicKey.toBase58();
      setWalletAddress(address);
      provider.on?.("accountChanged", (publicKey) => setWalletAddress(publicKey?.toBase58() ?? ""));
      await claimDevnetFunds(address);
    } catch {
      setWalletError("Wallet connection was cancelled.");
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
          <div className="network-pill"><span /><strong>Solana</strong><small>Devnet · VSOL</small></div>
          <button type="button" className={walletAddress ? "wallet-button connected" : "wallet-button"} onClick={connectWallet} aria-busy={walletConnecting || walletFunding}><Wallet size={16} aria-hidden="true" /> {walletConnecting ? "Connecting…" : walletFunding ? "Funding sandbox…" : walletAddress ? `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}` : "Connect Solana"}</button>
          <button type="button" className="icon-button mobile-menu" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </header>
      {walletError && <div className="wallet-error" role="alert">{walletError}<button type="button" onClick={() => setWalletError("")} aria-label="Dismiss wallet error"><X size={15} /></button></div>}
      {menuOpen && <div className="mobile-nav"><span>{pageTitle}</span><ProductNav active={activeTab} onChange={(tab) => { selectTab(tab); setMenuOpen(false); }} /></div>}
      <div id="main">{activeTab === "market" ? <TradeView walletAddress={walletAddress} onConnect={connectWallet} onPositionSaved={(position) => { setPositions((current) => [position, ...current]); setActiveTab("portfolio"); }} /> : activeTab === "portfolio" ? <PortfolioView positions={positions} isLoading={positionsLoading} error={positionsError} onRetry={loadPositions} onTrade={() => selectTab("market")} /> : <EarnView />}</div>
      <footer><div><Logo /><span>VSOL defined-risk markets on Solana.</span></div><div><a href="#risk">Risk</a><a href="https://solana.com/docs" target="_blank" rel="noreferrer">Solana docs</a><a href={solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">Program</a><span>© 2026 Tend Labs</span></div></footer>
    </div>
  );
}
