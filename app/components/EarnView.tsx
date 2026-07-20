"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BadgeCheck,
  CircleDollarSign,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { formatAtoms } from "../lib/format";
import { signSerializedSolanaTransaction } from "../lib/solana-wallet";
import { solanaExplorerUrl, VSOL_PROGRAM_ID } from "../lib/vsol";

type LiquidityState = {
  ready: boolean;
  reason?: string;
  checkedAt: string;
  pool?: {
    address: string;
    assetVault: string;
    settlementMint: string;
    decimals: number;
    availableAssetsAtoms: string;
    lockedCollateralAtoms: string;
    totalSharesAtoms: string;
    openPositions: number;
    depositsOpen: boolean;
    withdrawalsOpen: boolean;
  };
  provider?: {
    address: string;
    walletAssetsAtoms: string;
    sharesAtoms: string;
    redeemableAssetsAtoms: string;
  };
};

type LiquidityAction = {
  id: string;
  action: "deposit" | "withdraw";
  amountAtoms: string;
  sharesAtoms: string | null;
  transactionSignature: string;
  simulationSlot: number | null;
  simulationUnitsConsumed: number | null;
  createdAt: string;
};

type Receipt = {
  signature: string;
  action: "deposit" | "withdraw";
  amountAtoms: string;
  simulation: { id: string; slot: number | null; unitsConsumed: number | null; logsHash: string };
};

export function EarnView({ walletAddress, onConnect }: { walletAddress: string; onConnect: () => void | Promise<void> }) {
  const [state, setState] = useState<LiquidityState | null>(null);
  const [history, setHistory] = useState<LiquidityAction[]>([]);
  const [amount, setAmount] = useState("1000");
  const [action, setAction] = useState<"deposit" | "withdraw">("deposit");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  // Receipts belong to the wallet that signed them, so a wallet switch clears them mid-render.
  const [receiptWallet, setReceiptWallet] = useState(walletAddress);
  if (receiptWallet !== walletAddress) {
    setReceiptWallet(walletAddress);
    setReceipt(null);
    setError("");
  }

  const load = useCallback(async () => {
    if (!walletAddress) {
      setState(null);
      setHistory([]);
      return;
    }
    setLoading(true);
    try {
      const [stateResponse, historyResponse] = await Promise.all([
        fetch(`/api/vsol/liquidity?walletAddress=${encodeURIComponent(walletAddress)}`, { cache: "no-store" }),
        fetch(`/api/vsol/liquidity/history?walletAddress=${encodeURIComponent(walletAddress)}`, { cache: "no-store" }),
      ]);
      const stateResult = await stateResponse.json() as LiquidityState & { error?: string };
      const historyResult = await historyResponse.json() as { actions?: LiquidityAction[]; error?: string };
      if (!stateResponse.ok) throw new Error(stateResult.error ?? stateResult.reason ?? "Liquidity state is unavailable.");
      if (!historyResponse.ok) throw new Error(historyResult.error ?? "Liquidity history is unavailable.");
      setState(stateResult);
      setHistory(historyResult.actions ?? []);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Liquidity state is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const poll = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(poll, 12_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [load]);

  const decimals = state?.pool?.decimals ?? 6;
  const withdrawalBlocked = !state?.pool?.withdrawalsOpen
    || (state.pool.openPositions ?? 0) > 0
    || BigInt(state.pool.lockedCollateralAtoms || "0") > 0n;
  const actionEnabled = Boolean(walletAddress && state?.ready && !submitting)
    && (action === "deposit" ? Boolean(state?.pool?.depositsOpen) : !withdrawalBlocked);
  const actionNote = useMemo(() => {
    if (!walletAddress) return "Connect a wallet to read its real devnet balances.";
    if (!state?.ready) return state?.reason ?? "Waiting for a verified V2 liquidity pool deployment.";
    if (action === "withdraw" && withdrawalBlocked) return "Withdrawals unlock only after every active position settles and locked collateral returns to the pool.";
    return action === "deposit"
      ? "Your wallet transfers tUSDC into the program-owned pool and receives internal pool shares."
      : "Shares burn for the minimum verified tUSDC amount shown by the onchain pool.";
  }, [action, state, walletAddress, withdrawalBlocked]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!walletAddress) return void onConnect();
    if (!actionEnabled) return;
    setSubmitting(true);
    setError("");
    setReceipt(null);
    try {
      const prepareResponse = await fetch("/api/vsol/liquidity/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, action, amount }),
      });
      const prepared = await prepareResponse.json() as { intentId?: string; transaction?: string; error?: string };
      if (!prepareResponse.ok || !prepared.intentId || !prepared.transaction) {
        throw new Error(prepared.error ?? "The liquidity transaction could not be prepared.");
      }
      const signedTransaction = await signSerializedSolanaTransaction(prepared.transaction);
      const sendResponse = await fetch("/api/vsol/liquidity/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intentId: prepared.intentId, walletAddress, transaction: signedTransaction }),
      });
      const sent = await sendResponse.json() as Receipt & { error?: string };
      if (!sendResponse.ok || !sent.signature || !sent.simulation) throw new Error(sent.error ?? "Devnet did not confirm the liquidity transaction.");
      setReceipt(sent);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The liquidity transaction failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="dashboard-view">
      <div className="view-heading">
        <div><span className="eyebrow">Onchain liquidity pool</span><h1>Provide capital. Keep the constraints visible.</h1><p>Real devnet balances, real wallet signatures, and no invented APY.</p></div>
        <a className="button secondary" href={solanaExplorerUrl("address", state?.pool?.address ?? VSOL_PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer"><CircleDollarSign size={16} /> Inspect pool</a>
      </div>

      <div className="metric-grid">
        <div className="metric-card"><span>Wallet balance</span><strong>{formatAtoms(state?.provider?.walletAssetsAtoms, decimals)} tUSDC</strong><small>Read from your SPL token account</small></div>
        <div className="metric-card"><span>Your pool shares</span><strong>{formatAtoms(state?.provider?.sharesAtoms, decimals)}</strong><small>Internal provider ledger</small></div>
        <div className="metric-card"><span>Available pool capital</span><strong>{formatAtoms(state?.pool?.availableAssetsAtoms, decimals)} tUSDC</strong><small>Unencumbered onchain vault balance</small></div>
        <div className="metric-card"><span>Locked collateral</span><strong>{formatAtoms(state?.pool?.lockedCollateralAtoms, decimals)} tUSDC</strong><small>{state?.pool ? `${state.pool.openPositions} active position${state.pool.openPositions === 1 ? "" : "s"}` : "Checking pool"}</small></div>
      </div>

      <div className="liquidity-grid">
        <section className="positions-card liquidity-action-card">
          <div className="section-head"><div><h2>Manage liquidity</h2><p>Every action is simulated, submitted, confirmed, then reconciled against post-state.</p></div><span className={state?.ready ? "verified" : "verification-error"}>{loading ? <><LoaderCircle size={14} className="spin" /> Refreshing</> : state?.ready ? <><BadgeCheck size={14} /> RPC verified</> : <><Info size={14} /> Unavailable</>}</span></div>
          <form onSubmit={submit}>
            <div className="segmented liquidity-segmented">
              <button type="button" className={action === "deposit" ? "segment active up" : "segment"} onClick={() => setAction("deposit")}><ArrowDownToLine size={16} /> Deposit</button>
              <button type="button" className={action === "withdraw" ? "segment active down" : "segment"} onClick={() => setAction("withdraw")}><ArrowUpFromLine size={16} /> Withdraw</button>
            </div>
            <label className="field-group liquidity-amount" htmlFor="liquidity-amount">{action === "deposit" ? "tUSDC to deposit" : "Pool shares to redeem"}<span className="amount-input"><span>{action === "deposit" ? "$" : "#"}</span><input id="liquidity-amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" /><span>{action === "deposit" ? "tUSDC" : "shares"}</span></span></label>
            <p className="liquidity-action-note"><ShieldCheck size={14} /> {actionNote}</p>
            {error && <div className="execution-error" role="alert">{error}</div>}
            {!walletAddress ? <button type="button" className="button primary full" onClick={onConnect}><Wallet size={16} /> Connect wallet</button> : <button type="submit" className="button primary full" disabled={!actionEnabled} aria-busy={submitting}>{submitting ? <><LoaderCircle size={16} className="spin" /> Simulating & confirming…</> : action === "deposit" ? "Deposit on Solana devnet" : "Withdraw on Solana devnet"}</button>}
          </form>
          {receipt && <div className="liquidity-receipt"><BadgeCheck size={18} /><div><strong>Confirmed {receipt.action}</strong><span>{formatAtoms(receipt.amountAtoms, decimals)} · {receipt.simulation.unitsConsumed?.toLocaleString() ?? "—"} CU</span><a href={solanaExplorerUrl("tx", receipt.signature)} target="_blank" rel="noreferrer">View transaction</a></div></div>}
        </section>

        <section className="positions-card">
          <div className="section-head"><div><h2>Confirmed history</h2><p>Only actions with a passing stored simulation and confirmed signature appear.</p></div><button type="button" className="text-button" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button></div>
          {history.length ? <div className="liquidity-history">{history.map((item) => <div key={item.id} className="liquidity-history-row"><span className={item.action === "deposit" ? "positive" : ""}>{item.action === "deposit" ? "Deposit" : "Withdraw"}</span><strong>{formatAtoms(item.amountAtoms, decimals)}</strong><small>{new Date(item.createdAt).toLocaleString()}</small><span><a href={solanaExplorerUrl("tx", item.transactionSignature)} target="_blank" rel="noreferrer">Tx</a> · <a href={`/api/vsol/liquidity/simulations?id=${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer">Sim</a></span></div>)}</div> : <div className="empty-position"><CircleDollarSign size={20} /><div><strong>No confirmed liquidity actions</strong><p>Your first verified deposit will appear here.</p></div></div>}
        </section>
      </div>
    </main>
  );
}
