"use client";

import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type MarketSnapshot = {
  price: number;
  changePercent: number;
  sessionVolume: number | null;
  asOf: number;
  mode: "live" | "delayed" | "demo";
  source: string;
  warning: string;
};

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Resolution = "1m" | "5m" | "15m" | "1h" | "1D";
type ChartState = "loading" | "success" | "error";

const resolutions: Resolution[] = ["1m", "5m", "15m", "1h", "1D"];

export function TradingViewMarketChart({
  direction,
  target,
  ticker,
  onSnapshot,
}: {
  direction: "up" | "down";
  target: number;
  ticker: string;
  onSnapshot: (snapshot: MarketSnapshot | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resolution, setResolution] = useState<Resolution>("5m");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [state, setState] = useState<ChartState>("loading");
  const [error, setError] = useState("");
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/market-data?symbol=${encodeURIComponent(ticker)}&resolution=${resolution}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { candles?: Candle[]; snapshot?: MarketSnapshot; error?: string };
        if (!response.ok || !result.candles?.length || !result.snapshot) throw new Error(result.error ?? "Market data is unavailable.");
        return { candles: result.candles, snapshot: result.snapshot };
      })
      .then((result) => {
      setCandles(result.candles);
      setSnapshot(result.snapshot);
      onSnapshot(result.snapshot);
      setState("success");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Market data is unavailable.");
        setState("error");
        onSnapshot(null);
      });
    return () => controller.abort();
  }, [onSnapshot, requestVersion, resolution, ticker]);

  useEffect(() => {
    if (state !== "success" || !containerRef.current || !candles.length) return;
    let disposed = false;
    let cleanup = () => {};
    void import("lightweight-charts").then(({ CandlestickSeries, ColorType, LineStyle, createChart }) => {
      if (disposed || !containerRef.current) return;
      const styles = getComputedStyle(containerRef.current);
      const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
      const chart = createChart(containerRef.current, {
        autoSize: true,
        attributionLogo: true,
        layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: color("--ink-faint", "#7a858e"), fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
        grid: { vertLines: { color: color("--line", "#d9d9d2") }, horzLines: { color: color("--line", "#d9d9d2") } },
        rightPriceScale: { borderColor: color("--line-strong", "#bfc2bd") },
        timeScale: { borderColor: color("--line-strong", "#bfc2bd"), timeVisible: resolution !== "1D", secondsVisible: false, rightOffset: 3 },
        crosshair: { vertLine: { color: color("--ink-faint", "#7a858e"), labelBackgroundColor: color("--surface-ink", "#121b25") }, horzLine: { color: color("--ink-faint", "#7a858e"), labelBackgroundColor: color("--surface-ink", "#121b25") } },
      });
      const series = chart.addSeries(CandlestickSeries, {
        upColor: color("--positive", "#1f7050"),
        downColor: color("--negative", "#a6473f"),
        wickUpColor: color("--positive", "#1f7050"),
        wickDownColor: color("--negative", "#a6473f"),
        borderVisible: false,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      });
      series.setData(candles.map((candle) => ({ ...candle, time: candle.time as never })));
      series.createPriceLine({
        price: target,
        color: direction === "up" ? color("--accent", "#b45c36") : color("--negative", "#a6473f"),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "STRIKE",
      });
      chart.timeScale().fitContent();
      cleanup = () => chart.remove();
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [candles, direction, resolution, state, target]);

  return (
    <section className="tv-chart" aria-label={`${ticker} market chart`}>
      <div className="chart-toolbar">
        <div>
          <strong>Reference market</strong>
          <span>{snapshot?.source ?? "Loading market source"}</span>
        </div>
        <div className="resolution-picker" role="group" aria-label="Chart interval">
          {resolutions.map((item) => <button type="button" key={item} className={resolution === item ? "active" : ""} aria-pressed={resolution === item} onClick={() => { setState("loading"); setError(""); setResolution(item); }}>{item}</button>)}
        </div>
      </div>
      <div className="chart-canvas-wrap">
        {state === "loading" && <div className="chart-state" role="status"><LoaderCircle className="spin" size={20} aria-hidden="true" /><strong>Loading market bars</strong><span>Checking source and freshness…</span></div>}
        {state === "error" && <div className="chart-state error" role="alert"><AlertTriangle size={20} aria-hidden="true" /><strong>Couldn’t load chart data</strong><span>{error}</span><button type="button" className="button secondary" onClick={() => { setState("loading"); setError(""); setRequestVersion((value) => value + 1); }}><RefreshCw size={14} aria-hidden="true" /> Retry</button></div>}
        <div ref={containerRef} className={state === "success" ? "chart-canvas visible" : "chart-canvas"} />
        {snapshot?.mode === "demo" && state === "success" && <div className="demo-watermark" aria-hidden="true">DEMO DATA</div>}
      </div>
      <div className="chart-source" aria-live="polite">
        <span className={`data-mode ${snapshot?.mode ?? "loading"}`}>{snapshot?.mode === "live" ? "Live display" : snapshot?.mode === "delayed" ? "Delayed" : "Demo only"}</span>
        <span>{snapshot ? `Updated ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(snapshot.asOf))}` : "Checking freshness"}</span>
        <span>{snapshot?.warning ?? "Chart data is never the settlement oracle."}</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
      </div>
    </section>
  );
}
