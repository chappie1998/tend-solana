"use client";

import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { marketBySymbol } from "../lib/markets";

export type MarketSnapshot = {
  price: number;
  confidence: number;
  confidenceBps: number;
  exponent: number;
  publishTime: number;
  slot: number | null;
  ageSeconds: number;
  mode: "live" | "closed" | "stale";
  source: "Pyth Core Hermes";
  warning: string;
};

type Resolution = "1" | "5" | "15" | "60" | "D";
type ChartState = "loading" | "success" | "error";

const resolutions: Array<{ value: Resolution; label: string }> = [
  { value: "1", label: "1m" },
  { value: "5", label: "5m" },
  { value: "15", label: "15m" },
  { value: "60", label: "1h" },
  { value: "D", label: "1D" },
];

export function TradingViewMarketChart({
  direction,
  target,
  ticker,
  onSnapshot,
}: {
  direction: "up" | "down";
  target: number | null;
  ticker: string;
  onSnapshot: (snapshot: MarketSnapshot | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resolution, setResolution] = useState<Resolution>("5");
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [state, setState] = useState<ChartState>("loading");
  const [error, setError] = useState("");
  const [requestVersion, setRequestVersion] = useState(0);
  const market = marketBySymbol(ticker);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/market-data?symbol=${encodeURIComponent(ticker)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { snapshot?: MarketSnapshot; error?: string };
        if (!response.ok || !result.snapshot) throw new Error(result.error ?? "Pyth market data is unavailable.");
        return result.snapshot;
      })
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        onSnapshot(nextSnapshot);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Pyth market data is unavailable.");
        onSnapshot(null);
      });
    return () => controller.abort();
  }, [onSnapshot, requestVersion, ticker]);

  useEffect(() => {
    if (!containerRef.current || !market) return;
    const container = containerRef.current;
    container.replaceChildren();
    setState("loading");
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";
    const attribution = document.createElement("div");
    attribution.className = "tradingview-widget-copyright";
    attribution.innerHTML = `<a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank"><span class="blue-text">${ticker} chart by TradingView</span></a>`;
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.text = JSON.stringify({
      autosize: true,
      symbol: market.tradingViewSymbol,
      interval: resolution,
      timezone: "America/New_York",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "rgba(13, 21, 29, 1)",
      gridColor: "rgba(62, 75, 86, 0.35)",
      allow_symbol_change: false,
      calendar: false,
      details: true,
      hide_side_toolbar: false,
      hide_top_toolbar: true,
      save_image: false,
      withdateranges: true,
      support_host: "https://www.tradingview.com",
    });
    script.onload = () => setState("success");
    script.onerror = () => {
      setError("TradingView could not load in this browser.");
      setState("error");
    };
    container.appendChild(widget);
    container.appendChild(attribution);
    container.appendChild(script);
    return () => container.replaceChildren();
  }, [market, requestVersion, resolution, ticker]);

  return (
    <section className="tv-chart" aria-label={`${ticker} TradingView chart`}>
      <div className="chart-toolbar">
        <div>
          <strong>TradingView market display</strong>
          <span>Exchange data may be live, delayed, or end-of-day under TradingView entitlements.</span>
        </div>
        <div className="resolution-picker" role="group" aria-label="Chart interval">
          {resolutions.map((item) => <button type="button" key={item.value} className={resolution === item.value ? "active" : ""} aria-pressed={resolution === item.value} onClick={() => { setResolution(item.value); setError(""); }}>{item.label}</button>)}
        </div>
      </div>
      {target !== null && <div className={`chart-target ${direction}`}><span>RFQ strike</span><strong>${target.toFixed(2)}</strong></div>}
      <div className="chart-canvas-wrap">
        {state === "loading" && <div className="chart-state" role="status"><LoaderCircle className="spin" size={20} aria-hidden="true" /><strong>Loading TradingView</strong><span>Connecting the official advanced chart…</span></div>}
        {state === "error" && <div className="chart-state error" role="alert"><AlertTriangle size={20} aria-hidden="true" /><strong>Couldn’t load TradingView</strong><span>{error}</span><button type="button" className="button secondary" onClick={() => { setError(""); setRequestVersion((value) => value + 1); }}><RefreshCw size={14} aria-hidden="true" /> Retry</button></div>}
        <div
          ref={containerRef}
          className={state === "error"
            ? "chart-canvas tradingview-widget-container"
            : "chart-canvas tradingview-widget-container visible"}
        />
      </div>
      <div className="chart-source" aria-live="polite">
        <span className={`data-mode ${snapshot?.mode ?? "loading"}`}>{snapshot?.mode === "live" ? "Pyth live" : snapshot?.mode === "closed" ? "Market closed" : snapshot?.mode === "stale" ? "Pyth stale" : "Checking Pyth"}</span>
        <span>{snapshot ? `Pyth ${snapshot.price.toFixed(2)} ± ${snapshot.confidence.toFixed(4)} · ${snapshot.ageSeconds}s old` : "Settlement feed pending"}</span>
        <span>{snapshot?.warning ?? "The TradingView chart is never used for settlement."}</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a>
      </div>
    </section>
  );
}
