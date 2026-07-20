"use client";

import {
  BadgeCheck,
  CalendarPlus,
  Layers,
  LoaderCircle,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { expiryCodes, resolveExpiry, type ExpiryCode } from "../lib/expiries";
import { signSerializedSolanaTransaction } from "../lib/solana-wallet";
import { solanaExplorerUrl } from "../lib/vsol";

type LaunchReceipt = {
  kind: string;
  signature: string;
  targetAddress: string;
  label: string;
};

type SeriesOption = {
  address: string;
  label: string;
  verified: boolean;
};

async function runLaunchFlow(payload: Record<string, unknown>) {
  const prepareResponse = await fetch("/api/vsol/launch/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const prepared = await prepareResponse.json() as { intentId?: string; transaction?: string; error?: string } & Record<string, unknown>;
  if (!prepareResponse.ok || !prepared.intentId || !prepared.transaction) {
    throw new Error(prepared.error ?? "The launch transaction could not be prepared.");
  }
  const signedTransaction = await signSerializedSolanaTransaction(prepared.transaction);
  const sendResponse = await fetch("/api/vsol/launch/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intentId: prepared.intentId, walletAddress: payload.walletAddress, transaction: signedTransaction }),
  });
  const sent = await sendResponse.json() as { signature?: string; targetAddress?: string; error?: string };
  if (!sendResponse.ok || !sent.signature || !sent.targetAddress) {
    throw new Error(sent.error ?? "Devnet did not confirm the launch transaction.");
  }
  return { prepared, sent };
}

export function LaunchView({ walletAddress, onConnect }: { walletAddress: string; onConnect: () => void | Promise<void> }) {
  const [expiry, setExpiry] = useState<ExpiryCode>("30D");
  const [quoteAuthority, setQuoteAuthority] = useState("");
  const [maxUtilizationBps, setMaxUtilizationBps] = useState("8000");
  const [maxPositionBps, setMaxPositionBps] = useState("2500");
  const [poolAddress, setPoolAddress] = useState("");
  const [seriesMarket, setSeriesMarket] = useState("");
  const [seriesOptions, setSeriesOptions] = useState<SeriesOption[]>([]);
  const [busy, setBusy] = useState<"series" | "pool" | "authorize" | null>(null);
  const [errors, setErrors] = useState<{ series?: string; pool?: string; authorize?: string }>({});
  const [receipts, setReceipts] = useState<LaunchReceipt[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const loadSeriesOptions = useCallback(async () => {
    try {
      const response = await fetch("/api/markets", { cache: "no-store" });
      const result = await response.json() as {
        series?: { symbol: string; code: string; market: string }[];
        discovered?: { address: string; symbol: string; expiry: number }[];
      };
      const verified = (result.series ?? []).map((entry) => ({
        address: entry.market,
        label: `${entry.symbol} ${entry.code} · verified`,
        verified: true,
      }));
      const discovered = (result.discovered ?? []).map((entry) => ({
        address: entry.address,
        label: `${entry.symbol} · expires ${new Date(entry.expiry * 1_000).toLocaleDateString()} · discovered`,
        verified: false,
      }));
      setSeriesOptions([...verified, ...discovered]);
    } catch {
      setSeriesOptions([]);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadSeriesOptions(), 0);
    return () => window.clearTimeout(initial);
  }, [loadSeriesOptions]);

  // Wallet switches invalidate receipts and defaults bound to the old wallet.
  const [receiptWallet, setReceiptWallet] = useState(walletAddress);
  if (receiptWallet !== walletAddress) {
    setReceiptWallet(walletAddress);
    setReceipts([]);
    setErrors({});
    setQuoteAuthority("");
    setPoolAddress("");
  }

  const gridOptions = expiryCodes.map((code) => resolveExpiry(code, "NVDA", now));
  const selectedGrid = gridOptions.find((option) => option.code === expiry) ?? gridOptions[gridOptions.length - 1];

  async function submitPanel(panel: "series" | "pool" | "authorize", event: FormEvent) {
    event.preventDefault();
    if (!walletAddress) return void onConnect();
    setBusy(panel);
    setErrors((current) => ({ ...current, [panel]: undefined }));
    try {
      if (panel === "series") {
        const { sent } = await runLaunchFlow({ walletAddress, kind: "create_market", expiryCode: expiry });
        setReceipts((current) => [{ kind: "Series created", signature: sent.signature!, targetAddress: sent.targetAddress!, label: `NVDA ${expiry}` }, ...current]);
      } else if (panel === "pool") {
        const { sent } = await runLaunchFlow({
          walletAddress,
          kind: "create_pool",
          quoteAuthority: quoteAuthority.trim() || walletAddress,
          maxUtilizationBps: Number(maxUtilizationBps),
          maxPositionBps: Number(maxPositionBps),
        });
        setPoolAddress(sent.targetAddress!);
        setReceipts((current) => [{ kind: "Pool created", signature: sent.signature!, targetAddress: sent.targetAddress!, label: "You are the manager" }, ...current]);
      } else {
        if (!poolAddress.trim() || !seriesMarket) throw new Error("Choose the pool you manage and a series to authorize.");
        const { sent } = await runLaunchFlow({
          walletAddress,
          kind: "authorize_market",
          poolAddress: poolAddress.trim(),
          marketAddress: seriesMarket,
        });
        setReceipts((current) => [{ kind: "Series authorized", signature: sent.signature!, targetAddress: sent.targetAddress!, label: "Pool ↔ series binding" }, ...current]);
      }
      await loadSeriesOptions();
    } catch (error) {
      setErrors((current) => ({ ...current, [panel]: error instanceof Error ? error.message : "The launch transaction failed." }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="dashboard-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">Permissionless launch</span>
          <h1>Create a series. Run a pool.</h1>
          <p>Anyone can launch option series on the published expiry grid and operate a liquidity pool. Your wallet signs as creator and manager — this server never holds those keys. Devnet only: rent and balances use valueless mock assets.</p>
        </div>
      </div>

      <div className="liquidity-grid">
        <section className="positions-card liquidity-action-card">
          <div className="section-head"><div><h2><CalendarPlus size={17} aria-hidden="true" /> Create a series</h2><p>Series land on the NYSE-valid grid. Identical parameters share one deterministic onchain address, so duplicates are impossible.</p></div></div>
          <form onSubmit={(event) => submitPanel("series", event)}>
            <div className="choice-row standard-expiry-row">
              {gridOptions.map((option) => (
                <button
                  type="button"
                  key={option.code}
                  className={expiry === option.code ? "choice active" : "choice"}
                  disabled={!option.available}
                  title={option.available ? `${option.label}, settles ${option.detail}` : option.availabilityReason}
                  onClick={() => setExpiry(option.code)}
                >
                  {option.shortLabel}<small>{option.available ? option.detail : "Unavailable"}</small>
                </button>
              ))}
            </div>
            <p className="liquidity-action-note"><ShieldCheck size={14} aria-hidden="true" /> {selectedGrid.available
              ? `Settles at ${selectedGrid.detail} New York time. Creating costs devnet rent only; trading requires a pool to authorize the series.`
              : selectedGrid.availabilityReason}</p>
            {errors.series && <div className="execution-error" role="alert">{errors.series}</div>}
            {!walletAddress
              ? <button type="button" className="button primary full" onClick={onConnect}><Wallet size={16} aria-hidden="true" /> Connect wallet</button>
              : <button type="submit" className="button primary full" disabled={busy !== null || !selectedGrid.available} aria-busy={busy === "series"}>{busy === "series" ? <><LoaderCircle size={16} className="spin" aria-hidden="true" /> Simulating & confirming…</> : "Create series on devnet"}</button>}
          </form>
        </section>

        <section className="positions-card liquidity-action-card">
          <div className="section-head"><div><h2><Layers size={17} aria-hidden="true" /> Create a pool</h2><p>Settlement stays in the published devnet tUSDC mint. You become the pool manager; the quote authority signs executable prices.</p></div></div>
          <form onSubmit={(event) => submitPanel("pool", event)}>
            <label className="field-group liquidity-amount" htmlFor="launch-quote-authority">Quote authority
              <span className="amount-input"><input id="launch-quote-authority" value={quoteAuthority} onChange={(event) => setQuoteAuthority(event.target.value)} placeholder={walletAddress || "Connected wallet"} autoComplete="off" spellCheck={false} /></span>
            </label>
            <label className="field-group liquidity-amount" htmlFor="launch-utilization">Max utilization (bps)
              <span className="amount-input"><input id="launch-utilization" value={maxUtilizationBps} onChange={(event) => setMaxUtilizationBps(event.target.value)} inputMode="numeric" autoComplete="off" /></span>
            </label>
            <label className="field-group liquidity-amount" htmlFor="launch-position">Max position (bps)
              <span className="amount-input"><input id="launch-position" value={maxPositionBps} onChange={(event) => setMaxPositionBps(event.target.value)} inputMode="numeric" autoComplete="off" /></span>
            </label>
            <p className="liquidity-action-note"><ShieldCheck size={14} aria-hidden="true" /> Risk caps bind onchain: 0 &lt; position cap ≤ utilization cap ≤ 10000 bps. Depositors delegate pricing to the pool they choose.</p>
            {errors.pool && <div className="execution-error" role="alert">{errors.pool}</div>}
            {!walletAddress
              ? <button type="button" className="button primary full" onClick={onConnect}><Wallet size={16} aria-hidden="true" /> Connect wallet</button>
              : <button type="submit" className="button primary full" disabled={busy !== null} aria-busy={busy === "pool"}>{busy === "pool" ? <><LoaderCircle size={16} className="spin" aria-hidden="true" /> Simulating & confirming…</> : "Create pool on devnet"}</button>}
          </form>

          <form onSubmit={(event) => submitPanel("authorize", event)} className="launch-authorize">
            <div className="section-head"><div><h3>Authorize a series</h3><p>As pool manager, choose which series your pool will quote.</p></div></div>
            <label className="field-group liquidity-amount" htmlFor="launch-pool-address">Pool address (you manage)
              <span className="amount-input"><input id="launch-pool-address" value={poolAddress} onChange={(event) => setPoolAddress(event.target.value)} placeholder="Created pool address" autoComplete="off" spellCheck={false} /></span>
            </label>
            <label className="field-group liquidity-amount" htmlFor="launch-series-market">Series
              <span className="amount-input">
                <select id="launch-series-market" value={seriesMarket} onChange={(event) => setSeriesMarket(event.target.value)}>
                  <option value="">Choose a series…</option>
                  {seriesOptions.map((option) => <option key={option.address} value={option.address}>{option.label}</option>)}
                </select>
              </span>
            </label>
            {errors.authorize && <div className="execution-error" role="alert">{errors.authorize}</div>}
            {walletAddress && <button type="submit" className="button secondary full" disabled={busy !== null} aria-busy={busy === "authorize"}>{busy === "authorize" ? <><LoaderCircle size={16} className="spin" aria-hidden="true" /> Simulating & confirming…</> : "Authorize series for pool"}</button>}
          </form>
        </section>
      </div>

      {receipts.length > 0 && (
        <section className="positions-card">
          <div className="section-head"><div><h2>Confirmed launches</h2><p>Every action was simulated, submitted, confirmed, then re-verified against onchain state.</p></div></div>
          <div className="liquidity-history">
            {receipts.map((receipt) => (
              <div key={receipt.signature} className="liquidity-history-row">
                <span className="positive"><BadgeCheck size={14} aria-hidden="true" /> {receipt.kind}</span>
                <strong>{receipt.label}</strong>
                <span>
                  <a href={solanaExplorerUrl("address", receipt.targetAddress)} target="_blank" rel="noreferrer">Account</a>
                  {" · "}
                  <a href={solanaExplorerUrl("tx", receipt.signature)} target="_blank" rel="noreferrer">Tx</a>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="risk-note">Creating a series or pool does not make it tradable in Tend’s ticket: quotes require a pool with an integrated quote authority. Discovered series and pools appear read-only in the market catalog.</p>
    </main>
  );
}
