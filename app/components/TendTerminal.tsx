"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
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
  pricingVolatility: number;
  volatilitySource: string;
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
  simulationId?: string;
  simulationStatus?: "passed" | "failed";
  simulationSlot?: number | null;
  simulationUnitsConsumed?: number | null;
  simulationLogsHash?: string;
  simulation?: {
    status: "passed" | "failed";
    slot: number | null;
    unitsConsumed: number | null;
    logsHash: string;
  };
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
    deploymentReady?: boolean;
    executable?: boolean;
    writerLiquidity?: number;
    explorerUrl?: string;
    pythFeedId?: string;
    oracleProgram?: string;
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
      <div><span className="protocol-pulse" /><span><strong>{status === null ? "Checking VSOL devnet…" : status.ok ? "VSOL program + Pyth market verified" : status.deploymentReady === false ? "Pyth deployment pending" : "Devnet RPC unavailable"}</strong><small>{status?.ok ? `${(status.writerLiquidity ?? 0).toLocaleString()} tUSDC escrow · feed ${status.pythFeedId?.slice(0, 8) ?? "pending"}…` : "Executable quotes stay paused until every proof passes"}</small></span></div>
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
      return { ...definition, available: false, availabilityReason: "The Pyth oracle path is ready, but this exact expiry series has not been published on devnet." };
    }
    if (definition.group === "intraday" && definition.available && marketSnapshot?.mode !== "live") {
      return { ...definition, available: false, availabilityReason: "Intraday quotes require a fresh licensed display feed." };
    }
    return definition;
  });
  const expiryDefinition = expiryOptions.find((item) => item.code === expiry) ?? resolveExpiry(expiry, asset.ticker, now);
  const bestQuote = quotes.find((quote) => quote.id === selectedQuoteId) ?? quotes[0];
  const premium = bestQuote?.premium ?? 0;
  const target = bestQuote?.strike ?? null;
  const displayedPrice = marketSnapshot?.price ?? null;

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
        body: JSON.stringify({
          transaction: btoa(signedBinary),
          quoteId: bestQuote.id,
          walletAddress,
        }),
      });
      const sent = await sendResponse.json() as { signature?: string; simulation?: { id: string; status: "passed" | "failed"; slot: number | null; unitsConsumed: number | null; logsHash: string }; error?: string };
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
          simulationId: sent.simulation?.id,
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
              <MiniLogo ticker={item.ticker} /><span><strong>{item.ticker}</strong><small>{item.ticker === asset.ticker && displayedPrice !== null ? `$${displayedPrice.toFixed(2)}` : "Pyth pending"}</small></span><em className={item.ticker === asset.ticker && marketSnapshot?.mode === "live" ? "positive" : ""}>{item.ticker === asset.ticker ? marketSnapshot?.mode ?? "—" : "—"}</em>
            </button>
          ))}
        </div>

        <div className="market-card">
          <div className="price-row">
            <div><span className="eyebrow">Pyth settlement reference</span><div className="spot-price"><strong>{displayedPrice === null ? "—" : `$${displayedPrice.toFixed(2)}`}</strong><span className={`price-mode ${marketSnapshot?.mode ?? "loading"}`}>{marketSnapshot?.mode === "live" ? "Live" : marketSnapshot?.mode === "closed" ? "Closed" : marketSnapshot?.mode === "stale" ? "Stale" : "Loading"}</span></div></div>
            <div className="market-stats"><div><span>Pyth confidence</span><strong>{marketSnapshot ? `${marketSnapshot.confidenceBps.toFixed(2)} bps` : "—"}</strong></div><div><span>Oracle slot</span><strong>{marketSnapshot?.slot?.toLocaleString() ?? "—"}</strong></div><div><span>Pricing vol</span><strong>{bestQuote ? `${bestQuote.pricingVolatility.toFixed(1)}%` : "—"}</strong></div></div>
          </div>
          <TradingViewMarketChart key={asset.ticker} direction={direction} target={target} ticker={asset.ticker} onSnapshot={setMarketSnapshot} />
          <div className="market-footer"><span><Clock3 size={14} aria-hidden="true" /> TradingView is display-only</span><span title={asset.token}><BadgeCheck size={14} aria-hidden="true" /> Pyth feed · mock RWA mint</span><span><ShieldCheck size={14} aria-hidden="true" /> Fully collateralized</span></div>
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
            <div><span>RFQ strike <Info size={13} aria-hidden="true" /></span><strong>{target === null ? "—" : `$${target.toFixed(2)}`}</strong></div>
            <div><span>Signed premium</span><strong>{bestQuote ? `$${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</strong></div>
            <div><span>Maximum loss</span><strong className="risk">{bestQuote ? `$${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</strong></div>
            <div><span>Realized volatility</span><strong>{bestQuote ? `${bestQuote.pricingVolatility.toFixed(1)}%` : "—"}</strong></div>
            <div className="economics-total"><span>Maximum payout</span><strong>${notional.toLocaleString()}</strong></div>
          </div>

          <QuotePanel state={quoteState} notional={notional} quotes={quotes} errorMessage={quoteError} secondsLeft={secondsLeft} selectedQuoteId={selectedQuoteId} onSelect={setSelectedQuoteId} onQuote={() => requestQuote()} onExecute={() => setComplete(true)} />
        </form>
        <p className="risk-note" id="risk">Devnet only: mock tokens, real Pyth reference data, no real asset value. Options can lose their full premium.</p>
      </aside>

      {complete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && setComplete(false)}>
          <div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <button type="button" className="icon-button close" aria-label="Close review" onClick={() => setComplete(false)}><X size={20} /></button>
            <div className="success-mark"><ShieldCheck size={25} aria-hidden="true" /></div>
            <span className="eyebrow">Best quote secured</span><h2 id="review-title">Review your {asset.ticker} {direction.toUpperCase()}</h2>
            <p>{bestQuote?.maker ?? "The best maker"}’s quote is locked for 30 seconds. Your maximum loss is fixed before you sign.</p>
            <div className="review-grid"><div><span>Premium</span><strong>${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div><span>Strike</span><strong>{target === null ? "—" : `$${target.toFixed(2)}`}</strong></div><div><span>Expiry</span><strong>{expiryDefinition.shortLabel} · {expiryDefinition.detail}</strong></div><div><span>Max payout</span><strong>${notional.toLocaleString()}</strong></div></div>
            {executionError && <p className="execution-error" role="alert">{executionError}</p>}
            {walletAddress ? (
              <button type="button" className="button primary full" onClick={confirmPreviewPosition} disabled={executionState === "loading"} aria-busy={executionState === "loading"}><ShieldCheck size={16} aria-hidden="true" /> {executionState === "loading" ? "Signing & confirming…" : "Execute on Solana devnet"}</button>
            ) : (
              <button type="button" className="button primary full" onClick={onConnect}><Wallet size={16} aria-hidden="true" /> Connect wallet to continue</button>
            )}
            <p className="preview-disclaimer">Your wallet signs a real devnet transaction using mock tUSDC. Settlement accepts only a fully verified Pyth update for the market feed; VSOL remains unaudited and must not receive mainnet funds.</p>
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
    const header = "symbol,direction,strike,premium,notional,expiry_code,option_expiry_at,observation_window_seconds,status,transaction_signature,simulation_id,simulation_slot,simulation_units_consumed,simulation_logs_hash";
    const rows = positions.map((position) => [position.symbol, position.direction, position.strike, position.premium, position.amount, expiryLabel(position), position.optionExpiryAt, position.observationWindowSeconds, position.status, position.transactionSignature ?? "", position.simulationId ?? "", position.simulationSlot ?? "", position.simulationUnitsConsumed ?? "", position.simulationLogsHash ?? ""].join(","));
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
          {positions.map((position) => <div className="table-row" role="row" key={position.id}><span className="asset-cell"><MiniLogo ticker={position.symbol} /><strong>{position.symbol}</strong></span><span>{position.direction.toUpperCase()} · ${position.strike.toFixed(2)}</span><span>${position.premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>${position.amount.toLocaleString()}</span><span className="positive">{position.simulationStatus === "passed" ? `Simulated · ${position.simulationUnitsConsumed?.toLocaleString() ?? "—"} CU` : "Devnet confirmed"}</span><span>{position.transactionSignature ? <><a href={solanaExplorerUrl("tx", position.transactionSignature)} target="_blank" rel="noreferrer">Tx</a>{position.simulationId ? <> · <a href={`/api/vsol/simulations?id=${encodeURIComponent(position.simulationId)}`} target="_blank" rel="noreferrer">Sim</a></> : null}</> : expiryLabel(position)}</span></div>)}
        </div> : <div className="empty-position"><Target size={20} aria-hidden="true" /><div><strong>No positions yet</strong><p>Connect a Solana wallet and execute a devnet quote to see it here.</p></div><button type="button" className="button secondary" onClick={onTrade}>Build a position</button></div>}
      </section>
    </main>
  );
}

function EarnView() {
  const [status, setStatus] = useState<{
    ok?: boolean;
    writerLiquidity?: number;
    writerVault?: string;
    market?: string;
    oracle?: string;
    pythFeedId?: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/vsol/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((value) => { if (!cancelled) setStatus(value as typeof status); })
      .catch(() => { if (!cancelled) setStatus({ ok: false }); });
    return () => { cancelled = true; };
  }, []);
  return (
    <main className="dashboard-view">
      <div className="view-heading"><div><span className="eyebrow">Writer desk</span><h1>Earn premium. See the obligation.</h1><p>No disguised APY. Every outcome stays visible.</p></div><a className="button primary" href={solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer"><CircleDollarSign size={16} aria-hidden="true" /> Inspect VSOL vault</a></div>
      <div className="metric-grid"><div className="metric-card"><span>Writer escrow</span><strong>{status?.ok ? `${(status.writerLiquidity ?? 0).toLocaleString()} tUSDC` : "—"}</strong><small>Read from the SPL token vault</small></div><div className="metric-card"><span>Premium earned</span><strong>—</strong><small>No indexed realized-P&amp;L ledger yet</small></div><div className="metric-card"><span>Open obligation</span><strong>—</strong><small>Protocol-wide position index pending</small></div><div className="metric-card"><span>Oracle</span><strong>{status?.pythFeedId ? "Pyth Core" : "—"}</strong><small>{status?.pythFeedId ? `${status.pythFeedId.slice(0, 10)}…` : "Checking devnet"}</small></div></div>
      <div className="writer-grid">
        <section className="positions-card"><div className="section-head"><div><h2>Verifiable accounts</h2><p>Only confirmed devnet state is shown.</p></div><span className="verified"><BadgeCheck size={14} /> RPC verified</span></div><div className="stress-note"><Info size={16} aria-hidden="true" /><p>Tend will not invent writer P&amp;L, utilization, uptime, or exposure. Those panels stay unavailable until an onchain indexer can reconcile every fill and settlement.</p></div></section>
        <section className="positions-card risk-composition"><div className="section-head"><div><h2>Devnet links</h2><p>Inspect ownership and balances directly.</p></div></div><div className="legend"><div><span>Writer vault</span><strong>{status?.writerVault ? <a href={solanaExplorerUrl("address", status.writerVault)} target="_blank" rel="noreferrer">Explorer</a> : "—"}</strong></div><div><span>Market</span><strong>{status?.market ? <a href={solanaExplorerUrl("address", status.market)} target="_blank" rel="noreferrer">Explorer</a> : "—"}</strong></div><div><span>Settlement record</span><strong>{status?.oracle ? <a href={solanaExplorerUrl("address", status.oracle)} target="_blank" rel="noreferrer">Explorer</a> : "—"}</strong></div></div></section>
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
