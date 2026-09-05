"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Clock3,
  Info,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { marketsByCategory, markets } from "../lib/markets";
import { expiryCodes, formatExpiryDetail, resolveExpiry, type ExpiryCode, type ExpiryDefinition } from "../lib/expiries";
import { endWalletSession, establishWalletSession, fetchSessionWallet } from "../lib/session-client";
import { injectedSolanaWallet, signSerializedSolanaTransaction } from "../lib/solana-wallet";
import {
  VSOL_PROGRAM_ID,
  solanaExplorerUrl,
  type VsolQuotePayload,
} from "../lib/vsol";
import { EarnView } from "./EarnView";
import { LaunchView } from "./LaunchView";
import { PortfolioView, type SavedPosition } from "./PortfolioView";
import { TradingViewMarketChart, type MarketSnapshot } from "./TradingViewMarketChart";

type Tab = "market" | "portfolio" | "earn" | "launch";
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
  /** P(finishing in the money) at the solved strike -- the honest counterweight to the payoff multiple. */
  probabilityItm: number;
  /** The gap-risk-adjusted annualized vol actually priced into `premium` (can run above `pricingVolatility` when the reference is stale). */
  impliedVolatility: number;
};

type SeriesState = {
  symbol: string;
  code: ExpiryCode;
  market: string;
  oracle: string;
  expiry: number;
  observationWindowSeconds: number;
  lastTradeAt: number;
  available: boolean;
  availabilityReason: string;
};

// One entry per LIVE market in /api/markets' `snapshots` array: either a
// Hermes price or the reason there isn't one. The route already fetches these
// for every live market (see app/api/markets/route.ts).
type MarketSnapshotResult = {
  symbol: string;
  snapshot?: { price: number };
  error?: string;
};

type CatalogPoolState = {
  address: string;
  label: string;
  quotable: boolean;
  authorizedMarkets: string[];
};

// Every configured market is SHOWN; only the live ones can be selected.
// `tradable` is read off the market config's `status` field (see
// `MarketStatus` in app/lib/markets.ts) -- never a symbol comparison here --
// so a market moving between live and coming-soon is a one-line config edit.
function toAsset(market: (typeof markets)[number]) {
  return {
    ticker: market.symbol,
    name: market.name,
    token: market.tokenAddress,
    oracleStatus: market.oracleStatus,
    intradayEligible: market.intradayEligible,
    tradable: market.status === "live",
    statusNote: market.statusNote,
    statusTag: market.statusTag,
    // Both read straight from config so no view can invent an asset class.
    assetClass: market.assetClass,
    blurb: market.blurb,
    pythSymbol: market.pythSymbol,
  };
}

const assets = markets.map(toAsset);
const tradableAssets = assets.filter((asset) => asset.tradable);
// Grouped for display by app/lib/markets.ts's marketsByCategory -- the
// grouping rule and the category order live there, not here, so adding a
// market never means editing this component. The per-group `tradable` count
// is derived from `status` (never from the category), because a category is
// not a proxy for tradability: today every crypto market happens to be live
// and every stock one is not, and hardcoding that coincidence is the bug
// this comment exists to prevent.
const assetGroups = marketsByCategory.map((group) => {
  const groupAssets = group.markets.map(toAsset);
  return {
    category: group.category,
    label: group.label,
    assets: groupAssets,
    tradableCount: groupAssets.filter((asset) => asset.tradable).length,
  };
});

const navItems: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "market", label: "Trade", icon: Activity },
  { id: "portfolio", label: "Portfolio", icon: LayoutDashboard },
  { id: "earn", label: "Write & earn", icon: TrendingUp },
  { id: "launch", label: "Launch", icon: Rocket },
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
        <div><strong>Ready for an executable quote</strong><p>The deployed V2 pool authority signs a one-shot RFQ.</p></div>
        <button type="button" className="button primary" onClick={onQuote}>Request live quotes <Zap size={16} aria-hidden="true" /></button>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="quote-loading" role="status" aria-live="polite">
        <div className="loading-title"><LoaderCircle size={17} className="spin" aria-hidden="true" /> Requesting an executable quote</div>
        <div className="quote-skeleton"><span /><span /><span /></div>
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
    poolLiquidity?: string;
    seriesCount?: number;
    error?: string;
    explorerUrl?: string;
    pythFeedId?: string;
    oracleProgram?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch("/api/vsol/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => { if (!cancelled) setStatus(result as typeof status); })
      .catch(() => { if (!cancelled) setStatus({ ok: false }); });
    void load();
    const poll = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(poll, 15_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);

  const explorer = status?.explorerUrl ?? solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58());
  return (
    <div className={status?.ok ? "protocol-strip verified" : "protocol-strip"}>
      <div><span className="protocol-pulse" /><span><strong>{status === null ? "Checking VSOL devnet…" : status.ok ? "VSOL V2 pool + Pyth series verified" : status.deploymentReady === false ? "Pyth deployment pending" : "Execution unavailable"}</strong><small>{status?.ok ? `${status.poolLiquidity ?? "0"} tUSDC available · ${status.seriesCount ?? 0} verified series` : status?.error ?? "Executable quotes stay paused until every proof passes"}</small></span></div>
      <a href={explorer} target="_blank" rel="noreferrer">View program <ArrowUpRight size={14} /></a>
    </div>
  );
}

const EXPIRY_NOTE_RULES: Array<[RegExp, string]> = [
  [/cutoff/i, "Cutoff passed"],
  [/already settled/i, "Settled"],
];

// Exact string app/lib/vsol-server.ts's getVsolSeriesState throws (and the
// onchain catalog reports via /api/markets) when a rung's market account does
// not exist yet. A buyer can still trade it -- their fill mints and
// authorizes the series in the same transaction (see buildVsolQuoteTransaction) --
// so this is treated as selectable, not blocked, while keeping the honest
// underlying reason intact for anything that still needs the real one.
const MINT_ON_DEMAND_REASON = "This series has not been minted yet.";
const MINT_ON_DEMAND_CHIP_NOTE = "Mints on fill";
const MINT_ON_DEMAND_FULL_NOTE = "First trade mints this series onchain — you pay ~0.003 SOL rent.";

// Chips show a short label because the full reason is already surfaced in the policy line below and on hover.
function expiryChipNote(item: Pick<ExpiryDefinition, "available" | "detail" | "availabilityReason">): string {
  if (item.available) return item.availabilityReason === MINT_ON_DEMAND_REASON ? MINT_ON_DEMAND_CHIP_NOTE : item.detail;
  return EXPIRY_NOTE_RULES.find(([test]) => test.test(item.availabilityReason))?.[1] ?? "Unavailable";
}

function expiryChipTitle(item: Pick<ExpiryDefinition, "available" | "label" | "detail" | "availabilityReason">): string {
  if (!item.available) return item.availabilityReason;
  return item.availabilityReason === MINT_ON_DEMAND_REASON ? MINT_ON_DEMAND_FULL_NOTE : `${item.label}, settles ${item.detail}`;
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
  const [assetTicker, setAssetTicker] = useState(() => tradableAssets[0]?.ticker ?? "");
  const [direction, setDirection] = useState<Direction>("up");
  const [expiry, setExpiry] = useState<ExpiryCode>("30D");
  const [payoff, setPayoff] = useState(5);
  const [amount, setAmount] = useState("1000");
  const [quoteState, setQuoteState] = useState<QuoteState>("idle");
  const [quotes, setQuotes] = useState<MakerQuote[]>([]);
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [quoteError, setQuoteError] = useState("Use an amount between $100 and $5,000, then retry.");
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [complete, setComplete] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [executionState, setExecutionState] = useState<"idle" | "loading" | "error">("idle");
  const [executionError, setExecutionError] = useState("");
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);
  const [seriesStates, setSeriesStates] = useState<SeriesState[]>([]);
  const [seriesError, setSeriesError] = useState("Checking verified onchain series…");
  const [pools, setPools] = useState<CatalogPoolState[]>([]);
  // Last known Hermes price per live market symbol, for the selector strip
  // only. The SELECTED market's headline price and its live/stale badge still
  // come from the chart's own snapshot -- this never overrides that.
  const [stripPrices, setStripPrices] = useState<Record<string, number>>({});
  const [selectedPool, setSelectedPool] = useState("");
  const [vsolQuote, setVsolQuote] = useState<VsolQuotePayload | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Only ever a tradable asset: the coming-soon chips are disabled, so
  // `assetTicker` can never hold one, and the fallback stays on the live set.
  const asset = tradableAssets.find((item) => item.ticker === assetTicker) ?? tradableAssets[0] ?? assets[0];
  const notional = Number(amount) || 0;
  const expiryOptions = expiryCodes.map((code) => {
    const definition = resolveExpiry(code, asset.ticker, now);
    const series = seriesStates.find((item) => item.symbol === asset.ticker && item.code === code);
    if (!definition.available) return definition;
    if (!series) return { ...definition, available: false, availabilityReason: seriesError || `No verified ${code} onchain series is published.` };
    const expiryAt = series.expiry * 1_000;
    const exact = {
      ...definition,
      expiryAt,
      durationMinutes: Math.max(1, Math.ceil((expiryAt - now) / 60_000)),
      observationWindowSeconds: series.observationWindowSeconds,
      tradeLockSeconds: Math.max(0, series.expiry - series.lastTradeAt),
      detail: formatExpiryDetail(code, expiryAt, now),
      // A rung whose market hasn't been minted yet is still selectable: the
      // first buyer's fill mints and authorizes it. availabilityReason is
      // left as-is so expiryChipNote/the policy line below can still tell
      // this case apart from a genuinely tradeable, already-minted series.
      available: series.available || series.availabilityReason === MINT_ON_DEMAND_REASON,
      availabilityReason: series.availabilityReason,
    };
    return exact;
  });
  const expiryDefinition = expiryOptions.find((item) => item.code === expiry) ?? resolveExpiry(expiry, asset.ticker, now);
  const bestQuote = quotes.find((quote) => quote.id === selectedQuoteId) ?? quotes[0];
  const premium = bestQuote?.premium ?? 0;
  const target = bestQuote?.strike ?? null;
  const displayedPrice = marketSnapshot?.price ?? null;
  const currentSeries = seriesStates.find((item) => item.symbol === asset.ticker && item.code === expiry);
  const authorizedPools = currentSeries
    ? pools.filter((pool) => pool.authorizedMarkets.includes(currentSeries.market))
    : [];
  const defaultPool = authorizedPools.find((pool) => pool.quotable) ?? authorizedPools[0] ?? null;
  const activePool = authorizedPools.find((pool) => pool.address === selectedPool) ?? defaultPool;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/markets", { cache: "no-store" });
        const result = await response.json() as { series?: SeriesState[]; seriesError?: string | null; pools?: CatalogPoolState[]; snapshots?: MarketSnapshotResult[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Onchain market catalog is unavailable.");
        if (!cancelled) {
          setSeriesStates(result.series ?? []);
          setSeriesError(result.seriesError ?? (result.series?.length ? "" : "No verified onchain series is published."));
          setPools(result.pools ?? []);
          // /api/markets already polls Hermes for EVERY live market, and this
          // used to throw those away and keep only the selected asset's price
          // (which arrives separately, from the chart). With one live market
          // that was invisible; with three it meant two of the three chips
          // read "Pyth pending" forever, which reads as broken rather than as
          // unselected. Same response, no extra request.
          setStripPrices(Object.fromEntries(
            (result.snapshots ?? [])
              .filter((entry) => typeof entry.snapshot?.price === "number")
              .map((entry) => [entry.symbol, entry.snapshot!.price]),
          ));
        }
      } catch (error) {
        if (!cancelled) {
          setSeriesStates([]);
          setSeriesError(error instanceof Error ? error.message : "Onchain market catalog is unavailable.");
          // Deliberately NOT cleared: a failed catalog poll is not evidence
          // that the last known prices were wrong, and blanking every chip on
          // one transient error is worse than showing a slightly stale price
          // -- the selected market's own live/stale badge is what states
          // freshness, and it is driven by the chart's own snapshot.
        }
      }
    };
    void load();
    const poll = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(poll, 15_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
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
      if (remaining === 0 && executionState !== "loading") {
        setComplete(false);
        setExecutionState("idle");
        setExecutionError("");
        setQuotes([]);
        setSelectedQuoteId("");
        setVsolQuote(null);
        setQuoteError("The signed quote expired. Request a fresh executable price.");
        setQuoteState("error");
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [quoteState, bestQuote, executionState]);

  // Signed quotes bind the exact buyer, so switching wallets invalidates them mid-render.
  const [quotedWallet, setQuotedWallet] = useState(walletAddress);
  if (quotedWallet !== walletAddress) {
    setQuotedWallet(walletAddress);
    setQuoteState("idle");
    setQuotes([]);
    setSelectedQuoteId("");
    setVsolQuote(null);
    setComplete(false);
    setExecutionState("idle");
    setExecutionError("");
  }

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
    if (activePool && !activePool.quotable) {
      setQuoteError("Executable quotes come from the Tend pool today. Other authorized pools are listed honestly, but no quote service is integrated for them yet.");
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
      const signedTransaction = await signSerializedSolanaTransaction(vsolQuote.transaction);
      const sendResponse = await fetch("/api/vsol/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction: signedTransaction,
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
      invalidateQuote();
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
          <div className="asset-heading"><MiniLogo ticker={asset.ticker} /><div><div className="asset-name"><h2>{asset.ticker}</h2>{/* Both strings come from app/lib/markets.ts. SOL was hardcoded as "Stock Token" here, which is simply untrue — the config carries what each instrument actually is so no view can invent it. */}<span>{asset.assetClass}</span></div><p>{asset.blurb}</p></div></div>
          <span className="asset-picker">Devnet sandbox</span>
        </div>

        <div className="asset-strip" role="group" aria-label="Available markets">
          {assetGroups.map((group) => (
            <section key={group.category} className="asset-group" aria-label={group.label}>
              <h3 className="asset-group-head">{group.label}<span>{group.tradableCount > 0 ? `${group.tradableCount} tradable` : "Coming soon"}</span></h3>
              <div className="asset-group-row">
                {group.assets.map((item) => (
                  <button key={item.ticker} type="button" disabled={!item.tradable} title={item.tradable ? undefined : item.statusNote} aria-disabled={!item.tradable} onClick={() => { if (!item.tradable) return; setAssetTicker(item.ticker); setMarketSnapshot(null); if (!resolveExpiry(expiry, item.ticker, Date.now()).available) setExpiry("7D"); invalidateQuote(); }} className={!item.tradable ? "asset-chip coming-soon" : asset.ticker === item.ticker ? "asset-chip active" : "asset-chip"}>
                    <MiniLogo ticker={item.ticker} /><span><strong>{item.ticker}</strong><small>{!item.tradable ? "Coming soon" : item.ticker === asset.ticker && displayedPrice !== null ? `$${displayedPrice.toFixed(2)}` : stripPrices[item.ticker] !== undefined ? `$${stripPrices[item.ticker].toFixed(2)}` : "Pyth pending"}</small></span>
                    {/* The two coming-soon cases are different in kind (an un-entitled
                        feed vs no feed at all) and a user cannot tell which is which
                        from "Coming soon", so the distinction is rendered, not only
                        tooltipped -- but as `statusTag`'s two words, not `statusNote`'s
                        full sentence. Three sentences inline made the UNTRADABLE
                        markets taller than the tradable ones. The authoritative
                        sentence is still one hover away (the button's `title`), and it
                        is still the same string the server returns from resolveExpiry,
                        so the reason shown is the reason enforced.

                        A market that is tradable but not selected shows nothing here:
                        it has a live price in the line above, and an em-dash beside a
                        real price reads as missing data rather than as "not the
                        market you are looking at". */}
                    {item.tradable
                      ? item.ticker === asset.ticker
                        ? <em className={marketSnapshot?.mode === "live" ? "positive" : ""}>{marketSnapshot?.mode ?? "—"}</em>
                        : null
                      : <span className="asset-chip-note">{item.statusTag}</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="market-card">
          <div className="price-row">
            <div><span className="eyebrow">Pyth settlement reference</span><div className="spot-price"><strong>{displayedPrice === null ? "—" : `$${displayedPrice.toFixed(2)}`}</strong><span className={`price-mode ${marketSnapshot?.mode ?? "loading"}`}>{marketSnapshot?.mode === "live" ? "Live" : marketSnapshot?.mode === "stale" ? "Stale" : "Loading"}</span></div>{marketSnapshot?.mode === "stale" && <small className="reference-gap-note">Reference {Math.max(1, Math.round(marketSnapshot.ageSeconds / 60))} min old · gap risk priced</small>}</div>
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
            <div className="choice-row expiry-row">{expiryOptions.filter((item) => item.group === "intraday").map((item) => <button type="button" key={item.code} className={expiry === item.code ? "choice active" : "choice"} disabled={!item.available} title={expiryChipTitle(item)} onClick={() => { setExpiry(item.code); invalidateQuote(); }}>{item.shortLabel}<small>{expiryChipNote(item)}</small></button>)}</div>
            <div className="expiry-group-head standard"><span>Standard</span><small>Longer observation window</small></div>
            <div className="choice-row standard-expiry-row">{expiryOptions.filter((item) => item.group === "standard").map((item) => <button type="button" key={item.code} className={expiry === item.code ? "choice active" : "choice"} disabled={!item.available} title={expiryChipTitle(item)} onClick={() => { setExpiry(item.code); invalidateQuote(); }}>{item.shortLabel}<small>{expiryChipNote(item)}</small></button>)}</div>
            <p className="expiry-policy"><ShieldCheck size={13} aria-hidden="true" /> {expiryDefinition.available ? (expiryDefinition.availabilityReason === MINT_ON_DEMAND_REASON ? MINT_ON_DEMAND_FULL_NOTE : `${expiryDefinition.tradeLockSeconds}s trade lock · ${expiryDefinition.observationWindowSeconds}s oracle window`) : expiryDefinition.availabilityReason}</p>
          </fieldset>

          {authorizedPools.length > 1 && (
            <fieldset className="field-group"><legend>Liquidity pool</legend>
              <div className="choice-row">
                {authorizedPools.map((pool) => (
                  <button
                    type="button"
                    key={pool.address}
                    className={activePool?.address === pool.address ? "choice active" : "choice"}
                    title={pool.quotable ? "Quotes are signed by this pool's authority." : "Visible on-chain, but no quote service is integrated for this pool yet."}
                    onClick={() => { setSelectedPool(pool.address); invalidateQuote(); }}
                  >
                    {pool.label}<small>{pool.quotable ? "Executable quotes" : "Read-only"}</small>
                  </button>
                ))}
              </div>
              <p className="expiry-policy"><Info size={13} aria-hidden="true" /> {activePool?.quotable
                ? "The selected pool's authority signs your one-shot quote."
                : "This pool authorized the series on-chain, but Tend has no quote integration for it yet."}</p>
            </fieldset>
          )}

          <fieldset className="field-group"><legend>Target payoff</legend><div className="choice-row">{[2, 5, 10].map((item) => <button type="button" key={item} className={payoff === item ? "choice active" : "choice"} onClick={() => { setPayoff(item); invalidateQuote(); }}>{item}×<small>{item === 2 ? "Balanced" : item === 5 ? "Popular" : "Aggressive"}</small></button>)}</div></fieldset>

          <div className="field-group"><label htmlFor="amount">Position size</label><div className="amount-input"><span>$</span><input id="amount" type="number" inputMode="decimal" min="100" max="5000" step="100" value={amount} onChange={(event) => { setAmount(event.target.value); invalidateQuote(); }} autoComplete="off" aria-describedby="amount-note" /><span>tUSDC</span></div><div id="amount-note" className="input-note"><span>Min $100</span><span>Devnet max $5,000</span></div></div>

          <div className="economics">
            <div className={target === null ? "econ-row--empty" : undefined}><span>RFQ strike <Info size={13} aria-hidden="true" /></span><strong>{target === null ? "—" : `$${target.toFixed(2)}`}</strong></div>
            <div className={bestQuote ? undefined : "econ-row--empty"}><span>Signed premium</span><strong>{bestQuote ? `$${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</strong></div>
            <div className={bestQuote ? undefined : "econ-row--empty"}><span>Maximum loss</span><strong className={bestQuote ? "risk" : undefined}>{bestQuote ? `$${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</strong></div>
            <div className={bestQuote ? undefined : "econ-row--empty"}><span>Realized volatility</span><strong>{bestQuote ? `${bestQuote.pricingVolatility.toFixed(1)}%` : "—"}</strong></div>
            {/* Honest counterweight to the payoff multiple, and the vol
                actually priced into the premium above (can run hotter than
                "Realized volatility" when the reference is stale and the
                gap-risk bump kicks in) -- additive, next to the payoff dial. */}
            <div className={bestQuote ? undefined : "econ-row--empty"}><span>Win probability</span><strong>{bestQuote ? `${(bestQuote.probabilityItm * 100).toFixed(1)}%` : "—"}</strong></div>
            <div className={bestQuote ? undefined : "econ-row--empty"}><span>Implied volatility</span><strong>{bestQuote ? `${bestQuote.impliedVolatility.toFixed(1)}%` : "—"}</strong></div>
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
            <p>{bestQuote?.maker ?? "The best maker"}’s quote stays executable for {secondsLeft}s. Your maximum loss is fixed before you sign.</p>
            {vsolQuote?.mintOnDemand && <p className="expiry-policy"><ShieldCheck size={13} aria-hidden="true" /> {MINT_ON_DEMAND_FULL_NOTE}</p>}
            <div className="review-grid"><div><span>Premium</span><strong>${premium.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div><span>Strike</span><strong>{target === null ? "—" : `$${target.toFixed(2)}`}</strong></div><div><span>Expiry</span><strong>{expiryDefinition.shortLabel} · {expiryDefinition.detail}</strong></div><div><span>Max payout</span><strong>${notional.toLocaleString()}</strong></div></div>
            {executionError && <p className="execution-error" role="alert">{executionError}</p>}
            {walletAddress ? (
              <button type="button" className="button primary full" onClick={confirmPreviewPosition} disabled={executionState === "loading" || !bestQuote || !vsolQuote} aria-busy={executionState === "loading"}><ShieldCheck size={16} aria-hidden="true" /> {executionState === "loading" ? "Signing & confirming…" : "Execute on Solana devnet"}</button>
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

export function TendTerminal() {
  const [activeTab, setActiveTab] = useState<Tab>("market");
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletError, setWalletError] = useState("");
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletFunding, setWalletFunding] = useState(false);
  const [sessionWallet, setSessionWallet] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState("");
  const [positions, setPositions] = useState<SavedPosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState("");
  const pageTitle = useMemo(() => navItems.find((item) => item.id === activeTab)?.label ?? "Trade", [activeTab]);

  useEffect(() => {
    let cancelled = false;
    void fetchSessionWallet().then((wallet) => {
      if (!cancelled && wallet) setSessionWallet(wallet);
    });
    return () => { cancelled = true; };
  }, []);

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

  const signInWithWallet = useCallback(async (address: string) => {
    const result = await establishWalletSession(address);
    if (result.status === "active") {
      setSessionWallet(address);
      setSessionNotice("");
      return;
    }
    setSessionWallet((current) => (current === address ? current : null));
    setSessionNotice(result.reason);
  }, []);

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
      provider.on?.("accountChanged", (publicKey) => {
        const next = publicKey?.toBase58() ?? "";
        setWalletAddress(next);
        setSessionWallet(null);
        setSessionNotice("");
        if (next) void signInWithWallet(next);
        else void endWalletSession();
      });
      // Silent SIWS: proves wallet ownership with a message signature. Wallets
      // without signMessage keep trading; chain-derived reads stay locked.
      await signInWithWallet(address);
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
      {sessionNotice && <div className="wallet-error" role="status">{sessionNotice}<button type="button" onClick={() => setSessionNotice("")} aria-label="Dismiss sign-in notice"><X size={15} /></button></div>}
      {menuOpen && <div className="mobile-nav"><span>{pageTitle}</span><ProductNav active={activeTab} onChange={(tab) => { selectTab(tab); setMenuOpen(false); }} /></div>}
      <div id="main">{activeTab === "market" ? <TradeView walletAddress={walletAddress} onConnect={connectWallet} onPositionSaved={(position) => { setPositions((current) => [position, ...current]); setActiveTab("portfolio"); }} /> : activeTab === "portfolio" ? <PortfolioView walletAddress={walletAddress} sessionWallet={sessionWallet} positions={positions} isLoading={positionsLoading} error={positionsError} onRetry={loadPositions} onTrade={() => selectTab("market")} /> : activeTab === "earn" ? <EarnView walletAddress={walletAddress} onConnect={connectWallet} /> : <LaunchView walletAddress={walletAddress} onConnect={connectWallet} />}</div>
      <footer><div><Logo /><span>VSOL defined-risk markets on Solana.</span></div><div><a href="#risk">Risk</a><a href="https://solana.com/docs" target="_blank" rel="noreferrer">Solana docs</a><a href={solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">Program</a><span>© 2026 Tend Labs</span></div></footer>
    </div>
  );
}
