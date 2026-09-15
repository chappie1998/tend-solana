"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Clock3,
  Copy,
  ExternalLink,
  Info,
  LayoutDashboard,
  LineChart,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marketsByCategory, markets, type MarketCategory } from "../lib/markets";
import { expiryCodes, formatExpiryDetail, resolveExpiry, type ExpiryCode, type ExpiryDefinition } from "../lib/expiries";
import { otherSidePremium, payoffTiersFor, stakeBoundsForPayoff } from "../lib/options";
import { endWalletSession, establishWalletSession, fetchSessionWallet } from "../lib/session-client";
import { useWalletBridge, type WalletBridge } from "../lib/wallet-bridge";
import {
  AUTO_QUOTE_DEBOUNCE_MS,
  MAX_AUTO_REFRESHES,
  quoteInputIssue,
  quoteReadiness,
  type QuoteReadiness,
} from "../lib/quote-readiness";
import {
  VSOL_PROGRAM_ID,
  solanaExplorerUrl,
  type VsolQuotePayload,
} from "../lib/vsol";
import { EarnView } from "./EarnView";
import { LaunchView } from "./LaunchView";
import { PortfolioView, type SavedPosition } from "./PortfolioView";
import { TradePositionsPanel } from "./TradePositionsPanel";
import { TradingViewMarketChart, type MarketSnapshot } from "./TradingViewMarketChart";

type Tab = "crypto" | "stocks" | "portfolio" | "earn" | "launch";
type Direction = "up" | "down";
// "expired" is a distinct value (not "error"): it's the neutral, no-fault
// state after MAX_AUTO_REFRESHES silent re-quotes, versus a real fetch failure.
type QuoteState = "idle" | "loading" | "success" | "error" | "expired";

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
// spot price (from whichever provider /api/markets' `dataSource` names) or
// the reason there isn't one. The route already fetches these for every live
// market (see app/api/markets/route.ts).
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

// Crypto and Stocks are now separate top-level destinations rather than two
// rows of one combined strip, so there is no longer a single module-wide
// asset list -- each is scoped to its own category inside TradeView (below),
// sourced from marketsByCategory the same way the old combined groups were.

const navItems: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "stocks", label: "Stocks", icon: LineChart },
  { id: "crypto", label: "Crypto", icon: Activity },
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
  quotes,
  errorMessage,
  secondsLeft,
  selectedQuoteId,
  readiness,
  inputIssue,
  catalogSettled,
  onQuote,
  onSelect,
  onExecute,
  onConnect,
  onSignIn,
}: {
  state: QuoteState;
  quotes: MakerQuote[];
  errorMessage: string;
  secondsLeft: number;
  selectedQuoteId: string;
  readiness: QuoteReadiness;
  inputIssue: string | null;
  catalogSettled: boolean;
  onQuote: () => void;
  onSelect: (quoteId: string) => void;
  onExecute: () => void;
  onConnect: () => void | Promise<void>;
  onSignIn: () => void | Promise<void>;
}) {
  if (state === "success") {
    return (
      <div className="quote-results">
        <div className="quote-results-head"><div><span className="eyebrow">Executable for {secondsLeft}s</span><h3>Signed devnet quote</h3></div><span className="live-dot">Onchain</span></div>
        <div className="quote-list">
          {quotes.map((maker, index) => (
            <button type="button" className={maker.id === selectedQuoteId ? "quote-row selected" : "quote-row"} key={maker.id} onClick={() => onSelect(maker.id)} aria-pressed={maker.id === selectedQuoteId}>
              <span className="maker-rank">0{index + 1}</span>
              <span><strong>{maker.maker}</strong><small>{(maker.latencyMs / 1000).toFixed(1)}s response</small></span>
              <span className="maker-badge">{maker.badge}</span>
              <span className="quote-price"><strong>${maker.premium.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><small>{((maker.premium / maker.maxPayout) * 100).toFixed(2)}% of payout</small></span>
            </button>
          ))}
        </div>
        <button type="button" className="button primary full" onClick={onExecute}>Review & execute <ArrowUpRight size={16} aria-hidden="true" /></button>
      </div>
    );
  }

  if (readiness.kind === "no-provider") {
    return (
      <div className="quote-empty">
        <div className="empty-icon"><Wallet size={20} aria-hidden="true" /></div>
        {/* `configured` now means "this browser has a wallet-standard Solana
            wallet", not "this deployment set up a sign-in provider" -- the
            meaning changed when Privy was removed. Blaming the deployment
            here sent visitors looking for a fault that is on their side. */}
        <div><strong>No Solana wallet detected</strong><p>Quotes are signed for your wallet address, so trading needs a Solana wallet in this browser. Install one — Phantom, Solflare or Backpack — then reload this page.</p></div>
        <a className="button primary" href="https://solana.com/wallets" target="_blank" rel="noreferrer"><Wallet size={16} aria-hidden="true" /> Get a Solana wallet</a>
      </div>
    );
  }

  if (readiness.kind === "connect") {
    return (
      <div className="quote-empty">
        <div className="empty-icon"><Wallet size={20} aria-hidden="true" /></div>
        <div><strong>Connect a wallet to see your price</strong><p>Your quote is signed for your exact wallet address.</p></div>
        <button type="button" className="button primary" onClick={onConnect}><Wallet size={16} aria-hidden="true" /> Connect wallet</button>
      </div>
    );
  }

  if (readiness.kind === "busy") {
    return (
      <div className="quote-empty">
        <button type="button" className="button primary full" disabled aria-busy="true"><LoaderCircle size={16} className="spin" aria-hidden="true" /> Waiting for wallet…</button>
      </div>
    );
  }

  if (readiness.kind === "sign-in") {
    return (
      <div className="quote-empty">
        <div className="empty-icon"><Wallet size={20} aria-hidden="true" /></div>
        <div><strong>Sign in to get a quote</strong><p>{readiness.reason || "Sign a message to prove this wallet is yours. It is not a transaction and costs nothing."}</p></div>
        <button type="button" className="button primary" onClick={onSignIn}><Wallet size={16} aria-hidden="true" /> Sign in</button>
      </div>
    );
  }

  // readiness.kind === "ready" from here on.

  // The onchain catalog hasn't answered yet, so every expiry still reads as
  // unavailable. That's loading, not a ticket the user has to fix -- show the
  // skeleton and let the auto-quote fire the moment the catalog lands.
  if (!catalogSettled) {
    return (
      <div className="quote-loading" role="status" aria-live="polite">
        <div className="loading-title"><LoaderCircle size={17} className="spin" aria-hidden="true" /> {CHECKING_SERIES}</div>
        <div className="quote-skeleton"><span /><span /><span /></div>
      </div>
    );
  }

  if (inputIssue) {
    return (
      <div className="quote-empty">
        <div className="empty-icon"><Sparkles size={20} aria-hidden="true" /></div>
        <div><strong>Can’t price this ticket yet</strong><p>{inputIssue}</p></div>
      </div>
    );
  }

  if (state === "expired") {
    return (
      <div className="quote-empty">
        <div className="empty-icon"><Clock3 size={20} aria-hidden="true" /></div>
        <div><strong>Quote expired</strong><p>Request a fresh executable price.</p></div>
        <button type="button" className="button secondary" onClick={onQuote}><RefreshCw size={15} aria-hidden="true" /> Refresh quote</button>
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

  // "idle" (debounce pending) or "loading": the request is either about to
  // fire or already in flight -- same skeleton either way.
  return (
    <div className="quote-loading" role="status" aria-live="polite">
      <div className="loading-title"><LoaderCircle size={17} className="spin" aria-hidden="true" /> Pricing your position…</div>
      <div className="quote-skeleton"><span /><span /><span /></div>
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

  // Silent while healthy. A permanent "everything is verified" banner is noise
  // on a trading surface -- it occupies the top of the page saying nothing
  // actionable 99% of the time. What matters is the exception, so this renders
  // only once execution is actually degraded (paused, deployment pending, or
  // the status probe failing). The same liquidity it used to advertise still
  // reaches the trader where it changes a decision: on the quote itself.
  if (status === null || status.ok) return null;

  const explorer = status.explorerUrl ?? solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58());
  return (
    <div className="protocol-strip">
      <div><span className="protocol-pulse" /><span><strong>{status.deploymentReady === false ? "Pyth deployment pending" : "Execution unavailable"}</strong><small>{status.error ?? "Executable quotes stay paused until every proof passes"}</small></span></div>
      <a href={explorer} target="_blank" rel="noreferrer">View program <ArrowUpRight size={14} /></a>
    </div>
  );
}

// Shown while the onchain catalog request is still in flight (see the
// EXPIRY_NOTE_RULES entry that maps it to a "Checking…" chip note).
const CHECKING_SERIES = "Checking verified onchain series…";

const EXPIRY_NOTE_RULES: Array<[RegExp, string]> = [
  [/cutoff/i, "Cutoff passed"],
  [/already settled/i, "Settled"],
  // Until /api/markets answers, every rung carries the catalog's loading
  // message and so fell through to "Unavailable" -- which states something
  // false about the market rather than about the request still being in
  // flight. Matches the CHECKING_SERIES text below.
  [/^checking verified onchain series/i, "Checking…"],
];

// Exact string app/lib/vsol-server.ts's getVsolSeriesState throws (and the
// onchain catalog reports via /api/markets) when a rung's market account does
// not exist yet. A buyer can still trade it -- requesting a quote lists the
// series on chain server-side first (listVsolSeriesOnChain), then quotes the
// ordinary fill -- so this is treated as selectable, not blocked, while
// keeping the honest underlying reason intact for anything that needs it.
//
// The buyer pays no extra rent and signs nothing extra: the listing is its own
// server-signed transaction, which is also why the buyer's fill stays at two
// instructions and inside the packet limit.
const MINT_ON_DEMAND_REASON = "This series has not been minted yet.";
const MINT_ON_DEMAND_FULL_NOTE = "No one has listed this expiry yet — requesting a quote lists it onchain first, then quotes it. Costs you nothing extra.";

// Chips show a short label because the full reason is already surfaced in the policy line below and on hover.
function expiryChipNote(item: Pick<ExpiryDefinition, "available" | "detail" | "availabilityReason">): string {
  // Every tradeable rung shows its settlement date, including one that still
  // has to be listed on chain. "Lists on quote" used to replace the date on
  // those, which made four of five chips read identically and hid the one
  // thing that actually distinguishes them. The listing caveat is not lost:
  // MINT_ON_DEMAND_FULL_NOTE states it in full under the rows for the
  // SELECTED expiry, and expiryChipTitle keeps it one hover away on each.
  if (item.available) return item.detail;
  return EXPIRY_NOTE_RULES.find(([test]) => test.test(item.availabilityReason))?.[1] ?? "Unavailable";
}

function expiryChipTitle(item: Pick<ExpiryDefinition, "available" | "label" | "detail" | "availabilityReason">): string {
  if (!item.available) return item.availabilityReason;
  return item.availabilityReason === MINT_ON_DEMAND_REASON ? MINT_ON_DEMAND_FULL_NOTE : `${item.label}, settles ${item.detail}`;
}

/** Short, provider-accurate label for on-screen copy -- never a hardcoded provider name. */
function shortDataSourceLabel(source: string | null | undefined): string {
  if (source === "Pyth Core Hermes") return "Pyth";
  if (source === "Coinbase Exchange") return "Coinbase";
  if (source === "Finnhub") return "Finnhub";
  if (source === "Twelve Data") return "Twelve Data";
  return "Market";
}

/** The "you pay" input, re-clamped into the stake bounds a new payoff tier implies -- unchanged if it's already inside them. */
function clampedAmountForPayoff(nextPayoff: number, currentAmount: string): string {
  const bounds = stakeBoundsForPayoff(nextPayoff);
  const current = Number(currentAmount) || 0;
  const clamped = Math.min(bounds.max, Math.max(bounds.min, current));
  return clamped !== current ? String(clamped) : currentAmount;
}

/** Short marketing label for a payoff tier button -- covers every value across both the intraday and standard ladders (see payoffTiersFor). */
function payoffTierLabel(tier: number): string {
  if (tier === 2) return "Even odds";
  if (tier === 3) return "Bold";
  if (tier === 5) return "Popular";
  if (tier === 6) return "Long shot";
  return "Aggressive";
}

function TradeView({
  category,
  walletAddress,
  onConnect,
  onPositionSaved,
  bridge,
  walletBusy,
  sessionWallet,
  sessionNotice,
  onSignIn,
  onSessionExpired,
  positions,
}: {
  category: MarketCategory;
  walletAddress: string;
  onConnect: () => void | Promise<void>;
  onPositionSaved: (position: SavedPosition) => void;
  bridge: WalletBridge;
  walletBusy: boolean;
  sessionWallet: string | null;
  sessionNotice: string;
  onSignIn: () => void | Promise<void>;
  onSessionExpired: () => void;
  positions: SavedPosition[];
}) {
  // This tab's markets ONLY, sourced from marketsByCategory (the single
  // place grouping is decided -- see app/lib/markets.ts) rather than
  // re-filtering `markets` by category here, so Crypto and Stocks never
  // diverge on which symbols belong to which shelf. `tradable` still reads
  // off each market's own `status`, never off `category` -- see toAsset's
  // comment above for why that distinction is load-bearing.
  const categoryGroup = marketsByCategory.find((group) => group.category === category);
  const categoryLabel = categoryGroup?.label ?? category;
  const categoryAssets = (categoryGroup?.markets ?? []).map(toAsset);
  const tradableCategoryAssets = categoryAssets.filter((item) => item.tradable);
  // First tradable market in this category; if none are tradable (Stocks,
  // today), the first market in the category so the tab still has a default.
  const defaultAssetTicker = tradableCategoryAssets[0]?.ticker ?? categoryAssets[0]?.ticker ?? "";
  const [assetTicker, setAssetTicker] = useState(defaultAssetTicker);
  const [direction, setDirection] = useState<Direction>("up");
  const [expiry, setExpiry] = useState<ExpiryCode>("30D");
  const [payoff, setPayoff] = useState(5);
  const [amount, setAmount] = useState("100");
  const [quoteState, setQuoteState] = useState<QuoteState>("idle");
  const [quotes, setQuotes] = useState<MakerQuote[]>([]);
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [quoteError, setQuoteError] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [complete, setComplete] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [executionState, setExecutionState] = useState<"idle" | "loading" | "error">("idle");
  const [executionError, setExecutionError] = useState("");
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);
  const [seriesStates, setSeriesStates] = useState<SeriesState[]>([]);
  const [seriesError, setSeriesError] = useState(CHECKING_SERIES);
  // False only until the first /api/markets response (success OR failure).
  // Until then the ticket can't be priced simply because the catalog hasn't
  // arrived, which is a loading state -- not something the user must fix.
  const [catalogSettled, setCatalogSettled] = useState(false);
  const [pools, setPools] = useState<CatalogPoolState[]>([]);
  // Last known spot price per live market symbol, for the selector strip
  // only. The SELECTED market's headline price and its live/stale badge still
  // come from the chart's own snapshot -- this never overrides that.
  const [stripPrices, setStripPrices] = useState<Record<string, number>>({});
  // Which off-chain provider /api/markets is currently reading from (see
  // app/lib/market-data.ts) -- drives the "<provider> pending" chip label
  // below. Never a hardcoded name.
  const [dataSourceLabel, setDataSourceLabel] = useState("Market");
  const [selectedPool, setSelectedPool] = useState("");
  const [vsolQuote, setVsolQuote] = useState<VsolQuotePayload | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Only ever a tradable asset when one exists in this category: the
  // coming-soon chips are disabled, so `assetTicker` can never hold one while
  // any tradable market is available, and the fallback stays on this
  // category's own set (see toAsset's comment -- never the other shelf's).
  const asset = tradableCategoryAssets.find((item) => item.ticker === assetTicker) ?? tradableCategoryAssets[0] ?? categoryAssets[0];
  // What the buyer typed is what they PAY. The payout it buys is solved
  // server-side and only known once a quote exists (see payoutForStake).
  const stake = Number(amount) || 0;
  const stakeBounds = stakeBoundsForPayoff(payoff);
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
  // Short-dated series sell a near-binary 1.5x/2x/3x ladder; longer ones the
  // original 2x/5x/10x (see payoffTiersFor) -- purely a function of the
  // RESOLVED duration, so this tracks the clock even when the expiry code
  // itself doesn't change (e.g. EOD's remaining time falling under an hour).
  const payoffTiers = payoffTiersFor(expiryDefinition.durationMinutes);
  // Re-clamp the selected tier into the new ladder the moment it stops
  // being valid -- mirrors the wallet-switch reset below (state repair
  // during render, so a stale tier is never shown selected for even one
  // frame) rather than selectPayoff/invalidateQuote directly, which also
  // bump requestSeqRef -- a ref mutation that belongs in an effect, not
  // render, the same reasoning the wallet-switch reset below already follows.
  if (!payoffTiers.includes(payoff)) {
    const nextPayoff = payoffTiers[0];
    const clampedAmount = clampedAmountForPayoff(nextPayoff, amount);
    if (clampedAmount !== amount) setAmount(clampedAmount);
    setPayoff(nextPayoff);
    setQuoteState("idle");
    setQuotes([]);
    setSelectedQuoteId("");
    setVsolQuote(null);
  }
  const bestQuote = quotes.find((quote) => quote.id === selectedQuoteId) ?? quotes[0];
  // Solved server-side from the stake, so it only exists once a quote does.
  const maxPayout = bestQuote?.maxPayout ?? null;
  const premium = bestQuote?.premium ?? 0;
  const target = bestQuote?.strike ?? null;
  // Two-sided "cents on the dollar" display (Split's framing: UP + DOWN
  // premiums at one strike sum to the payout). Derived client-side, purely
  // from numbers this quote already returned (maxPayout, probabilityItm) --
  // no second /api/quotes call, and not the executable price for the
  // opposite direction (which would solve its own strike -- see
  // otherSidePremium's doc comment in app/lib/options.ts). Indicative only.
  // Reads the same market's pricingOverrides.makerEdgeBps the server priced
  // this quote's own side with (app/api/quotes/route.ts), inert today since
  // no market sets one, but keeps this estimate consistent with the server
  // if/when one does.
  const otherSideEstimate = bestQuote
    ? otherSidePremium({
        maxPayout: bestQuote.maxPayout,
        probabilityItm: bestQuote.probabilityItm,
        makerEdgeBps: markets.find((item) => item.symbol === asset.ticker)?.pricingOverrides?.makerEdgeBps,
      })
    : null;
  const displayedPrice = marketSnapshot?.price ?? null;
  const currentSeries = seriesStates.find((item) => item.symbol === asset.ticker && item.code === expiry);
  const authorizedPools = currentSeries
    ? pools.filter((pool) => pool.authorizedMarkets.includes(currentSeries.market))
    : [];
  const defaultPool = authorizedPools.find((pool) => pool.quotable) ?? authorizedPools[0] ?? null;
  const activePool = authorizedPools.find((pool) => pool.address === selectedPool) ?? defaultPool;
  // `bridge.ready` is false until the wallet adapter has mounted client-side
  // -- that's the same "not checked yet" state quoteReadiness expects. Once
  // ready, `providerDetected` reflects whether any wallet-standard Solana
  // wallet was actually found in this browser (bridge.configured) -- there
  // is no email fallback now, external wallets only.
  const providerDetected = !bridge.ready ? null : bridge.configured;
  const readiness = quoteReadiness({ providerDetected, walletAddress, walletBusy, sessionWallet, sessionNotice });
  const inputIssue = quoteInputIssue({
    stake,
    stakeMin: stakeBounds.min,
    stakeMax: stakeBounds.max,
    expiryAvailable: expiryDefinition.available,
    expiryReason: expiryDefinition.availabilityReason,
    poolQuotable: activePool ? activePool.quotable : null,
  });
  // Bumped by invalidateQuote() and by every new runQuote() call so a
  // response for inputs that no longer match the ticket is ignored, even if
  // it lands after a newer request has already started (see requestQuote).
  const requestSeqRef = useRef(0);
  // Consecutive silent expiry auto-refreshes, reset on any user input change
  // or manual request; capped at MAX_AUTO_REFRESHES (see the expiry effect).
  const autoRefreshCountRef = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/markets", { cache: "no-store" });
        const result = await response.json() as { series?: SeriesState[]; seriesError?: string | null; pools?: CatalogPoolState[]; snapshots?: MarketSnapshotResult[]; dataSource?: string; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Onchain market catalog is unavailable.");
        if (!cancelled) {
          setSeriesStates(result.series ?? []);
          setSeriesError(result.seriesError ?? (result.series?.length ? "" : "No verified onchain series is published."));
          setPools(result.pools ?? []);
          if (result.dataSource) setDataSourceLabel(result.dataSource);
          // /api/markets already polls every live market's configured
          // provider, and this used to throw those away and keep only the
          // selected asset's price (which arrives separately, from the
          // chart). With one live market that was invisible; with three it
          // meant two of the three chips read "pending" forever, which reads
          // as broken rather than as unselected. Same response, no extra
          // request.
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
      } finally {
        if (!cancelled) setCatalogSettled(true);
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
        // The review modal always closes on expiry, whether or not this
        // expiry goes on to auto-refresh -- a stale signed quote must never
        // sit behind an open "Execute" button.
        const wasReviewing = complete;
        setComplete(false);
        setExecutionState("idle");
        setExecutionError("");
        setQuotes([]);
        setSelectedQuoteId("");
        setVsolQuote(null);
        const canAutoRefresh = !wasReviewing
          && document.visibilityState === "visible"
          && autoRefreshCountRef.current < MAX_AUTO_REFRESHES;
        if (canAutoRefresh) {
          // Idle + ready + no input issue is exactly what the auto-quote
          // effect below watches for, so this alone re-triggers a request.
          autoRefreshCountRef.current += 1;
          setQuoteState("idle");
        } else {
          // Past the cap (or the user was mid-review, or the tab is
          // backgrounded): stop refreshing silently and show a neutral
          // "expired" state with a manual refresh button instead.
          setQuoteState("expired");
        }
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [quoteState, bestQuote, executionState, complete]);

  // Reset to this category's default asset the moment `category` itself
  // changes -- e.g. switching from Crypto to Stocks in the nav. Mirrors the
  // wallet-switch reset just below: state repair during render (a plain
  // conditional setState, not useEffect+setState, which
  // react-hooks/set-state-in-effect forbids as an error). Inlines
  // invalidateQuote's state resets rather than calling it directly, because
  // that function also bumps requestSeqRef/autoRefreshCountRef -- ref writes
  // the react-hooks/refs rule forbids during render; the ref bump for a
  // category change is handled by the effect below instead, alongside the
  // wallet one.
  const [resolvedCategory, setResolvedCategory] = useState(category);
  if (resolvedCategory !== category) {
    setResolvedCategory(category);
    setAssetTicker(defaultAssetTicker);
    setMarketSnapshot(null);
    setComplete(false);
    setExecutionState("idle");
    setExecutionError("");
    setQuoteState("idle");
    setQuotes([]);
    setSelectedQuoteId("");
    setVsolQuote(null);
  }

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

  // Refs are read/written outside render (event handlers, effects) only --
  // this mirrors the wallet-switch and category-switch resets above without
  // mutating a ref during render.
  useEffect(() => {
    requestSeqRef.current += 1;
    autoRefreshCountRef.current = 0;
  }, [walletAddress, category]);

  // Clamps the stake into the new tier's bounds as the tier changes, so the
  // ticket is never left in a state that cannot be quoted.
  function selectPayoff(next: number) {
    const clamped = clampedAmountForPayoff(next, amount);
    if (clamped !== amount) setAmount(clamped);
    setPayoff(next);
    invalidateQuote();
  }

  function invalidateQuote() {
    // Any input change orphans an in-flight request (if there is one) and
    // resets the expiry auto-refresh budget for the new inputs.
    requestSeqRef.current += 1;
    autoRefreshCountRef.current = 0;
    setQuoteState("idle");
    setQuotes([]);
    setSelectedQuoteId("");
    setVsolQuote(null);
  }

  async function runQuote({ manual }: { manual: boolean }) {
    // Not ready (no wallet, no provider, mid wallet-action, not signed in):
    // the panel already shows the missing step, so there's nothing to error.
    if (readiness.kind !== "ready") return;
    // Invalid inputs: the panel already shows the issue text with no button,
    // so a stray Enter keypress should just no-op rather than show an error.
    if (inputIssue) return;
    // A request is already in flight for these exact inputs. Without this,
    // submitting the form (Enter) mid-debounce could race the pending
    // auto-quote timer and fire two requests -- and a quote request can list
    // a strike rung on chain, so a duplicate is not free.
    if (quoteState === "loading") return;
    // Only a MANUAL request (Enter, Retry, Refresh quote) refills the expiry
    // auto-refresh budget. Resetting it here for automatic requests too would
    // make the MAX_AUTO_REFRESHES cap unreachable, and an abandoned tab would
    // re-quote -- and re-list rungs on chain -- forever.
    if (manual) autoRefreshCountRef.current = 0;
    const seq = ++requestSeqRef.current;
    setQuoteState("loading");
    setQuotes([]);
    try {
      const response = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: asset.ticker, direction, stake, expiryCode: expiry, payoff, walletAddress }),
      });
      const result = await response.json() as { quotes?: MakerQuote[]; vsol?: VsolQuotePayload; error?: string };
      // Inputs (or the wallet) moved on while this request was in flight --
      // invalidateQuote() or a newer runQuote() already bumped the
      // sequence, so this response is for a ticket that no longer exists.
      if (seq !== requestSeqRef.current) return;
      if (response.status === 401) {
        // The session cookie expired or was cleared server-side mid-flight.
        // Drop back to the sign-in step instead of showing a fetch error.
        onSessionExpired();
        setQuoteState("idle");
        return;
      }
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
      if (seq !== requestSeqRef.current) return;
      setQuoteError("The quote service is unreachable. Check your connection and retry.");
      setQuoteState("error");
    }
  }

  function requestQuote(event?: FormEvent) {
    event?.preventDefault();
    void runQuote({ manual: true });
  }

  // Always-fresh ref to runQuote so the auto-quote effect below can depend on
  // the primitive quote-input values (stable across unrelated re-renders,
  // e.g. the price ticker) instead of this function's identity, which is
  // recreated every render. Assigned in an effect (not during render) so refs
  // are never written mid-render.
  const runQuoteRef = useRef(runQuote);
  useEffect(() => {
    runQuoteRef.current = runQuote;
  });

  // One string per distinct "ticket" the user could request a quote for.
  // Changing any of these -- or the catalog/session state settling into
  // "ready" -- should (re)start the auto-quote debounce.
  const quoteInputsKey = [walletAddress, asset.ticker, direction, expiry, payoff, stake, activePool?.address ?? ""].join("|");

  useEffect(() => {
    if (readiness.kind !== "ready" || quoteState !== "idle" || inputIssue !== null || complete) return;
    const timer = window.setTimeout(() => { void runQuoteRef.current({ manual: false }); }, AUTO_QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [quoteInputsKey, readiness.kind, quoteState, inputIssue, complete]);

  async function confirmPreviewPosition() {
    if (!bestQuote || !walletAddress || !vsolQuote) return;
    setExecutionState("loading");
    setExecutionError("");
    try {
      const signedTransaction = await bridge.signTransactionBase64(vsolQuote.transaction);
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
          amount: bestQuote.maxPayout,
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
        <VsolStatus />
        <div className="market-header">
          <div className="asset-heading"><MiniLogo ticker={asset.ticker} /><div><div className="asset-name"><h2>{asset.ticker}</h2>{/* Both strings come from app/lib/markets.ts. SOL was hardcoded as "Stock Token" here, which is simply untrue — the config carries what each instrument actually is so no view can invent it. */}<span>{asset.assetClass}</span></div><p>{asset.blurb}</p></div></div>
          {/* The "Devnet sandbox" pill that used to sit here said the same
              thing as the header's "Devnet · VSOL" network pill, one row up. */}
        </div>

        <div className="asset-strip" role="group" aria-label="Available markets">
          {/* Crypto and Stocks are now separate nav destinations, so this strip
              lists ONE category's markets -- the two-group layout collapsed to
              one section, still built from the same asset-group chrome (and the
              same `marketsByCategory`-sourced data) the combined strip used. */}
          <section className="asset-group" aria-label={categoryLabel}>
            <h3 className="asset-group-head">{categoryLabel}<span>{tradableCategoryAssets.length > 0 ? `${tradableCategoryAssets.length} tradable` : "Coming soon"}</span></h3>
            <div className="asset-group-row">
              {categoryAssets.map((item) => (
                <button key={item.ticker} type="button" disabled={!item.tradable} title={item.tradable ? undefined : item.statusNote} aria-disabled={!item.tradable} onClick={() => { if (!item.tradable) return; setAssetTicker(item.ticker); setMarketSnapshot(null); if (!resolveExpiry(expiry, item.ticker, Date.now()).available) setExpiry("7D"); invalidateQuote(); }} className={!item.tradable ? "asset-chip coming-soon" : asset.ticker === item.ticker ? "asset-chip active" : "asset-chip"}>
                  <MiniLogo ticker={item.ticker} /><span><strong>{item.ticker}</strong><small>{!item.tradable ? "Coming soon" : item.ticker === asset.ticker && displayedPrice !== null ? `$${displayedPrice.toFixed(2)}` : stripPrices[item.ticker] !== undefined ? `$${stripPrices[item.ticker].toFixed(2)}` : `${shortDataSourceLabel(dataSourceLabel)} pending`}</small></span>
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
        </div>

        <div className="market-card">
          <div className="price-row">
            <div><span className="eyebrow">{shortDataSourceLabel(marketSnapshot?.source ?? dataSourceLabel)} reference</span><div className="spot-price"><strong>{displayedPrice === null ? "—" : `$${displayedPrice.toFixed(2)}`}</strong><span className={`price-mode ${marketSnapshot?.mode ?? "loading"}`}>{marketSnapshot?.mode === "live" ? "Live" : marketSnapshot?.mode === "stale" ? "Stale" : "Loading"}</span></div>{marketSnapshot?.mode === "stale" && <small className="reference-gap-note">Reference {Math.max(1, Math.round(marketSnapshot.ageSeconds / 60))} min old · gap risk priced</small>}</div>
            {/* Only the confidence stat survives here. "Oracle slot" read
                marketSnapshot.slot, which only a Pyth snapshot ever carried --
                under the Coinbase reference it is structurally always "—".
                "Pricing vol" was the same number the ticket already shows as
                "Realized volatility", blank until a quote exists. Two of three
                slots permanently showing em-dashes read as broken data. */}
            <div className="market-stats"><div><span>{shortDataSourceLabel(marketSnapshot?.source ?? dataSourceLabel)} confidence</span><strong>{marketSnapshot ? `${marketSnapshot.confidenceBps.toFixed(2)} bps` : "—"}</strong></div></div>
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

          <fieldset className="field-group"><legend>Target payoff</legend><div className="choice-row">{payoffTiers.map((item) => <button type="button" key={item} className={payoff === item ? "choice active" : "choice"} onClick={() => { selectPayoff(item); }}>{item}×<small>{payoffTierLabel(item)}</small></button>)}</div></fieldset>

          {/* The buyer types what LEAVES THEIR WALLET, not the payout. It
              used to be labelled "Position size" and carried the payout
              notional, so someone typing 100 was quoted a $20 premium -- the
              number they entered was never the number they paid. The payout
              that stake buys is solved server-side and shown below. Bounds
              move with the payoff tier, because the payout they imply has to
              stay inside what the devnet pool can underwrite. */}
          <div className="field-group"><label htmlFor="amount">You pay</label><div className="amount-input"><span>$</span><input id="amount" type="number" inputMode="decimal" min={stakeBounds.min} max={stakeBounds.max} step="10" value={amount} onChange={(event) => { setAmount(event.target.value); invalidateQuote(); }} autoComplete="off" aria-describedby="amount-note" /><span>tUSDC</span></div><div id="amount-note" className="input-note"><span>Min ${stakeBounds.min}</span><span>Max ${stakeBounds.max.toLocaleString()}</span></div></div>

          {/* Two numbers decide the trade: what leaves the wallet, and what
              can come back. Everything else is pricing evidence, and it now
              sits behind "Pricing detail" instead of ahead of the answer.

              "Max payout" deliberately restates the position size: the payoff
              dial does NOT move it -- it moves the PREMIUM. That reads as a
              frozen number unless the ratio is on screen, so the multiple the
              quote actually achieved is shown beside it. It is the quote's own
              effectiveLeverage (maxPayout / premium), not the tier the user
              clicked: the strike solver clamps when a tier's target premium is
              unreachable (a short-dated at-the-money spread simply cannot cost
              half the payout), so 2x can settle at 3.3x. Showing the tier here
              would state a multiple the buyer is not getting. */}
          <div className="economics">
            <div className={bestQuote ? undefined : "econ-row--empty"}>
              <span>Signed premium</span>
              <strong className={bestQuote ? "risk" : undefined}>
                {bestQuote ? `$${premium.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                {/* Indicative only, never executable: the fair-value-plus-edge
                    price of the OPPOSITE direction at this SAME strike (see
                    otherSidePremium's doc comment). A real quote for the
                    opposite direction would solve its own strike, so this is
                    not what /api/quotes would actually return for it -- only
                    the direction above is ever signed. */}
                {bestQuote && otherSideEstimate !== null && (
                  <small title="Indicative: the fair value of the opposite direction at this same strike, plus the maker edge. Not an executable price -- only the direction above is ever signed.">
                    ≈${otherSideEstimate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} for the other side
                  </small>
                )}
              </strong>
            </div>
            {/* TRUE BINARY: the payout is a SWITCH, not a ramp
                (definedRiskPayout at BINARY_WIDTH, the smallest legal
                on-chain width -- one price atom). Hit the target and win the
                full number below; miss it and the entire premium is lost --
                no partial payout in between, so both outcomes are stated as
                their own unambiguous headline rows rather than a single
                number that could read as a coin flip. */}
            <div className="economics-total"><span>Max payout</span><strong>{maxPayout === null ? "—" : `$${maxPayout.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}{bestQuote && <small>{direction === "up" ? "at or above" : "at or below"} ${bestQuote.strike.toFixed(2)}</small>}</strong></div>
            {/* The price the buyer needs to hit for the FULL payout, stated
                as its own headline number rather than only the small
                annotation above -- direction-aware. For a binary, this IS
                the breakeven (there is no separate partial-payout zone to
                give one a different value), so there is no separate
                "Breakeven" row any more. */}
            <div className={bestQuote ? undefined : "econ-row--empty"}><span>Target {direction === "up" ? "(at or above)" : "(at or below)"}</span><strong>{bestQuote ? `$${bestQuote.strike.toFixed(2)}` : "—"}</strong></div>
            {/* The other half of the all-or-nothing statement: anything on
                the wrong side of the target, however close, pays exactly
                $0 -- not "nothing below $X", which read as a second price
                level rather than the flip side of the same target above. */}
            <div className={bestQuote ? undefined : "econ-row--empty"}><span>{direction === "up" ? "Below target" : "Above target"}</span><strong className={bestQuote ? "risk" : undefined}>$0</strong></div>
            <details className="econ-detail">
              <summary>Pricing detail</summary>
              <div className={target === null ? "econ-row--empty" : undefined}><span>RFQ strike <Info size={13} aria-hidden="true" /></span><strong>{target === null ? "—" : `$${target.toFixed(2)}`}</strong></div>
              <div className={bestQuote ? undefined : "econ-row--empty"}><span>Maximum loss</span><strong className={bestQuote ? "risk" : undefined}>{bestQuote ? `$${premium.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</strong></div>
              {/* Honest counterweight to the payoff multiple, and the vol
                  actually priced into the premium above (can run hotter than
                  "Realized volatility" when the reference is stale and the
                  gap-risk bump kicks in). */}
              <div className={bestQuote ? undefined : "econ-row--empty"}><span>Chance of hitting target</span><strong>{bestQuote ? `${(bestQuote.probabilityItm * 100).toFixed(1)}%` : "—"}</strong></div>
              <div className={bestQuote ? undefined : "econ-row--empty"}><span>Realized volatility</span><strong>{bestQuote ? `${bestQuote.pricingVolatility.toFixed(1)}%` : "—"}</strong></div>
              <div className={bestQuote ? undefined : "econ-row--empty"}><span>Implied volatility</span><strong>{bestQuote ? `${bestQuote.impliedVolatility.toFixed(1)}%` : "—"}</strong></div>
            </details>
          </div>

          <QuotePanel state={quoteState} quotes={quotes} errorMessage={quoteError} secondsLeft={secondsLeft} selectedQuoteId={selectedQuoteId} readiness={readiness} inputIssue={inputIssue} catalogSettled={catalogSettled} onSelect={setSelectedQuoteId} onQuote={() => requestQuote()} onExecute={() => setComplete(true)} onConnect={onConnect} onSignIn={onSignIn} />
        </form>
        <p className="risk-note" id="risk">Devnet only: mock tokens, real market reference data, no real asset value. Options can lose their full premium.</p>
      </aside>

      <TradePositionsPanel walletAddress={walletAddress} sessionWallet={sessionWallet} positions={positions} onConnect={onConnect} />

      {complete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && setComplete(false)}>
          <div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <button type="button" className="icon-button close" aria-label="Close review" onClick={() => setComplete(false)}><X size={20} /></button>
            <div className="success-mark"><ShieldCheck size={25} aria-hidden="true" /></div>
            <span className="eyebrow">Best quote secured</span><h2 id="review-title">Review your {asset.ticker} {direction.toUpperCase()}</h2>
            <p>{bestQuote?.maker ?? "The best maker"}’s quote stays executable for {secondsLeft}s. Your maximum loss is fixed before you sign.</p>
            {vsolQuote?.mintOnDemand && <p className="expiry-policy"><ShieldCheck size={13} aria-hidden="true" /> {MINT_ON_DEMAND_FULL_NOTE}</p>}
            <div className="review-grid"><div><span>Premium</span><strong>${premium.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div><div><span>Strike</span><strong>{target === null ? "—" : `$${target.toFixed(2)}`}</strong></div><div><span>Expiry</span><strong>{expiryDefinition.shortLabel} · {expiryDefinition.detail}</strong></div><div><span>Max payout</span><strong>{maxPayout === null ? "—" : `$${maxPayout.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</strong></div></div>
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
  const bridge = useWalletBridge();
  const walletAddress = bridge.address;
  const [activeTab, setActiveTab] = useState<Tab>("stocks");
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const walletMenuRef = useRef<HTMLDivElement>(null);
  const [walletError, setWalletError] = useState("");
  const [walletFunding, setWalletFunding] = useState(false);
  const [walletSigning, setWalletSigning] = useState(false);
  const [sessionWallet, setSessionWallet] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState("");
  const [positions, setPositions] = useState<SavedPosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState("");
  const pageTitle = useMemo(() => navItems.find((item) => item.id === activeTab)?.label ?? "Crypto", [activeTab]);

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
    const result = await establishWalletSession(address, bridge.signMessageBase64);
    if (result.status === "active") {
      setSessionWallet(address);
      setSessionNotice("");
      return;
    }
    setSessionWallet((current) => (current === address ? current : null));
    setSessionNotice(result.reason);
  }, [bridge.signMessageBase64]);

  // Sign in an already-connected wallet (the "Sign in" step in the quote
  // panel, as opposed to the silent SIWS attempt triggered by the
  // address-change effect below). establishWalletSession never throws for a
  // declined signature -- the bridge's signMessageBase64 rejection is caught
  // inside it and turned into `{ status: "failed", reason }`, where `reason`
  // is whatever raw text the wallet returned. A manual "Sign in" click that
  // doesn't succeed is overwhelmingly a dismissed signature prompt, so show
  // one clear, wallet-agnostic message instead of unpredictable provider
  // copy. The try/catch stays as a defensive backstop in case a future
  // wallet integration throws instead of returning.
  const signIn = useCallback(async () => {
    if (!walletAddress) return;
    setWalletSigning(true);
    try {
      const result = await establishWalletSession(walletAddress, bridge.signMessageBase64);
      if (result.status === "active") {
        setSessionWallet(walletAddress);
        setSessionNotice("");
      } else if (result.status === "unsupported") {
        setSessionWallet(null);
        setSessionNotice(result.reason);
      } else {
        setSessionWallet(null);
        setSessionNotice("Sign-in was cancelled.");
      }
    } catch {
      setSessionNotice("Sign-in was cancelled.");
    } finally {
      setWalletSigning(false);
    }
  }, [walletAddress, bridge.signMessageBase64]);

  const onSessionExpired = useCallback(() => setSessionWallet(null), []);

  // The accountChanged-equivalent behaviour: bridge.address is a reactive
  // value (the wallet adapter owns the connection), so this effect -- not a
  // provider event listener -- is what now reacts to a fresh connect, a
  // switched account, or a disconnect. Session state always resets and
  // re-attempts silent SIWS (or ends the session for a disconnect); the devnet faucet
  // claim runs only on the "" -> address transition, i.e. an actual new
  // connection, exactly as connectWallet() used to trigger it once.
  const previousWalletAddressRef = useRef(walletAddress);
  useEffect(() => {
    const previous = previousWalletAddressRef.current;
    previousWalletAddressRef.current = walletAddress;
    if (previous === walletAddress) return;

    setSessionWallet(null);
    setSessionNotice("");
    setWalletMenuOpen(false);
    if (!walletAddress) {
      void endWalletSession();
      return;
    }
    // Silent SIWS: proves wallet ownership with a message signature. Wallets
    // without signMessage keep trading; chain-derived reads stay locked.
    // Chained via .then() (matching the fetchSessionWallet().then(...) effect
    // above), rather than calling signInWithWallet directly, so this effect's
    // own state updates stay synchronous and only the async continuation
    // resolves the sign-in.
    void Promise.resolve().then(async () => {
      await signInWithWallet(walletAddress);
      if (!previous) await claimDevnetFunds(walletAddress);
    });
  }, [walletAddress, signInWithWallet]);

  // Opening our own wallet picker modal is all this does: the picker (and
  // the adapter it connects) report their own errors, and dismissing it is
  // not a failure worth a banner. The app reacts to the outcome through
  // bridge.address (the effect above) and bridge.connecting.
  const connectWallet = useCallback(async () => {
    setWalletError("");
    await bridge.connect();
  }, [bridge]);

  // bridge.disconnect() throws when the connected wallet never implemented
  // the (optional) wallet-standard disconnect feature -- rare, but silently
  // swallowing it would look identical to the bug this fixed: clicking
  // Disconnect and nothing happening. Surface it instead of hiding it.
  const disconnectWallet = useCallback(async () => {
    setWalletMenuOpen(false);
    try {
      await bridge.disconnect();
    } catch {
      setWalletError("This wallet doesn't support disconnecting from a page. Disconnect this site from inside your wallet extension instead.");
    }
  }, [bridge]);

  const copyWalletAddress = useCallback(async () => {
    if (!walletAddress) return;
    await navigator.clipboard.writeText(walletAddress);
    setAddressCopied(true);
    window.setTimeout(() => setAddressCopied(false), 1500);
  }, [walletAddress]);

  // Close the wallet menu on an outside click or a disconnect -- there is no
  // other way to dismiss it (it has no backdrop), so both cases need to be
  // handled explicitly rather than relying on losing focus.
  useEffect(() => {
    if (!walletMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (walletMenuRef.current && !walletMenuRef.current.contains(event.target as Node)) {
        setWalletMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [walletMenuOpen]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a href="#main" className="skip-link">Skip to content</a>
        <Logo />
        <div className="desktop-nav"><ProductNav active={activeTab} onChange={selectTab} /></div>
        <div className="header-actions">
          <div className="network-pill"><span /><strong>Solana</strong><small>Devnet · VSOL</small></div>
          <div className="wallet-control" ref={walletMenuRef}>
            <button
              type="button"
              className={walletAddress ? "wallet-button connected" : "wallet-button"}
              onClick={() => { if (walletAddress) { setWalletMenuOpen((value) => !value); } else { void connectWallet(); } }}
              aria-busy={bridge.connecting || walletFunding}
              aria-haspopup={walletAddress ? "menu" : undefined}
              aria-expanded={walletAddress ? walletMenuOpen : undefined}
            >
              <Wallet size={16} aria-hidden="true" /> {bridge.connecting ? "Connecting…" : walletFunding ? "Funding sandbox…" : walletAddress ? `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}` : "Connect Solana"}
            </button>
            {walletMenuOpen && walletAddress && (
              <div className="wallet-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { void copyWalletAddress(); }}>
                  <Copy size={14} aria-hidden="true" /> {addressCopied ? "Copied" : "Copy address"}
                </button>
                <a role="menuitem" href={solanaExplorerUrl("address", walletAddress)} target="_blank" rel="noreferrer" onClick={() => setWalletMenuOpen(false)}>
                  <ExternalLink size={14} aria-hidden="true" /> View on Explorer
                </a>
                <button type="button" role="menuitem" className="wallet-menu-disconnect" onClick={() => { void disconnectWallet(); }}>
                  <LogOut size={14} aria-hidden="true" /> Disconnect
                </button>
              </div>
            )}
          </div>
          <button type="button" className="icon-button mobile-menu" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </header>
      {walletError && <div className="wallet-error" role="alert">{walletError}<button type="button" onClick={() => setWalletError("")} aria-label="Dismiss wallet error"><X size={15} /></button></div>}
      {sessionNotice && <div className="wallet-error" role="status">{sessionNotice}<button type="button" onClick={() => setSessionNotice("")} aria-label="Dismiss sign-in notice"><X size={15} /></button></div>}
      {menuOpen && <div className="mobile-nav"><span>{pageTitle}</span><ProductNav active={activeTab} onChange={(tab) => { selectTab(tab); setMenuOpen(false); }} /></div>}
      <div id="main">{activeTab === "crypto" || activeTab === "stocks" ? <TradeView category={activeTab} walletAddress={walletAddress} onConnect={connectWallet} onPositionSaved={(position) => { setPositions((current) => [position, ...current]); }} bridge={bridge} walletBusy={bridge.connecting || walletFunding || walletSigning} sessionWallet={sessionWallet} sessionNotice={sessionNotice} onSignIn={signIn} onSessionExpired={onSessionExpired} positions={positions} /> : activeTab === "portfolio" ? <PortfolioView walletAddress={walletAddress} sessionWallet={sessionWallet} positions={positions} isLoading={positionsLoading} error={positionsError} onRetry={loadPositions} onTrade={() => selectTab("stocks")} /> : activeTab === "earn" ? <EarnView walletAddress={walletAddress} onConnect={connectWallet} /> : <LaunchView walletAddress={walletAddress} onConnect={connectWallet} />}</div>
      <footer><div><Logo /><span>VSOL defined-risk markets on Solana.</span></div><div><a href="#risk">Risk</a><a href="https://solana.com/docs" target="_blank" rel="noreferrer">Solana docs</a><a href={solanaExplorerUrl("address", VSOL_PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">Program</a><span>© 2026 Tend Labs</span></div></footer>
    </div>
  );
}
