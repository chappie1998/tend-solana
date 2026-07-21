"use client";

import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import {
  type ChartResolution,
  type MarketBar,
} from "../lib/market-bars";

export type MarketSnapshot = {
  price: number;
  confidence: number;
  confidenceBps: number;
  exponent: number;
  publishTime: number;
  slot: number | null;
  ageSeconds: number;
  mode: "live" | "stale";
  source: "Pyth Core Hermes";
  warning: string;
};

type ChartState = "loading" | "success" | "error";

type MarketBarsPayload = {
  symbol: string;
  resolution: ChartResolution;
  source: "Pyth Benchmarks";
  freshness: "live" | "stale";
  bars: MarketBar[];
  asOf: number;
  lastBarTime: number;
};

const resolutions: Array<{ value: ChartResolution; label: string }> = [
  { value: "1", label: "1m" },
  { value: "5", label: "5m" },
  { value: "15", label: "15m" },
  { value: "60", label: "1h" },
  { value: "D", label: "1D" },
];

const newYorkAxisTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

const newYorkCrosshairTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const dailyAxisDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

const monthAxisDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
});

const dailyCrosshairDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

function unixTime(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function chartTickLabel(time: Time, tickMarkType: TickMarkType, resolution: ChartResolution) {
  const date = new Date(unixTime(time) * 1_000);
  if (resolution === "D" || tickMarkType <= TickMarkType.DayOfMonth) {
    if (tickMarkType === TickMarkType.Year) return String(date.getUTCFullYear());
    if (tickMarkType === TickMarkType.Month) return monthAxisDate.format(date);
    return dailyAxisDate.format(date);
  }
  return newYorkAxisTime.format(date);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

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
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const targetLineRef = useRef<IPriceLine | null>(null);
  const renderedBarsRef = useRef<MarketBar[]>([]);
  const hasFittedRef = useRef(false);
  const resolutionRef = useRef<ChartResolution>("5");
  const [resolution, setResolution] = useState<ChartResolution>("5");
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [bars, setBars] = useState<MarketBar[]>([]);
  const [barsMeta, setBarsMeta] = useState<MarketBarsPayload | null>(null);
  const [state, setState] = useState<ChartState>("loading");
  const [chartError, setChartError] = useState("");
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    resolutionRef.current = resolution;
  }, [resolution]);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | undefined;
    let activeController: AbortController | null = null;
    let hasLoadedOnce = false;

    const loadSnapshot = async () => {
      // Until the first load has actually succeeded, never gate on visibility.
      if (hasLoadedOnce && document.visibilityState === "hidden") {
        if (pollTimer !== undefined) window.clearTimeout(pollTimer);
        pollTimer = window.setTimeout(loadSnapshot, 60_000);
        return;
      }
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 8_000);
      try {
        const response = await fetch(`/api/market-data?symbol=${encodeURIComponent(ticker)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const result = await response.json() as { snapshot?: MarketSnapshot; error?: string };
        if (!response.ok || !result.snapshot) throw new Error(result.error ?? "Pyth market data is unavailable.");
        if (stopped) return;
        hasLoadedOnce = true;
        setSnapshot(result.snapshot);
        setSnapshotError("");
        onSnapshot(result.snapshot);
        pollTimer = window.setTimeout(loadSnapshot, result.snapshot.mode === "live" ? 10_000 : 60_000);
      } catch (error) {
        if (stopped) return;
        if (isAbortError(error) && !timedOut) {
          // Aborted by a visibility flap rather than superseded: retry soon so a
          // load interrupted mid-flight can never strand the loading state.
          if (activeController === controller) pollTimer = window.setTimeout(loadSnapshot, 1_000);
          return;
        }
        const message = timedOut
          ? "Pyth reference request timed out."
          : error instanceof Error ? error.message : "Pyth market data is unavailable.";
        setSnapshot(null);
        setSnapshotError(message);
        onSnapshot(null);
        pollTimer = window.setTimeout(loadSnapshot, 30_000);
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        activeController?.abort();
        return;
      }
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      void loadSnapshot();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    void loadSnapshot();
    return () => {
      stopped = true;
      activeController?.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [onSnapshot, requestVersion, ticker]);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | undefined;
    let activeController: AbortController | null = null;
    let hasLoadedOnce = false;

    const loadBars = async () => {
      // Until the first load has actually succeeded, never gate on visibility.
      if (hasLoadedOnce && document.visibilityState === "hidden") {
        if (pollTimer !== undefined) window.clearTimeout(pollTimer);
        pollTimer = window.setTimeout(loadBars, 5 * 60_000);
        return;
      }
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 10_000);
      try {
        const response = await fetch(`/api/market-bars?symbol=${encodeURIComponent(ticker)}&resolution=${resolution}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const result = await response.json() as Partial<MarketBarsPayload> & { error?: string };
        if (!response.ok || !Array.isArray(result.bars) || result.bars.length === 0) {
          throw new Error(result.error ?? "Pyth returned no chart bars.");
        }
        if (stopped) return;
        hasLoadedOnce = true;
        setBars(result.bars);
        setBarsMeta(result as MarketBarsPayload);
        setChartError("");
        setState("success");
        const livePollMs: Record<ChartResolution, number> = {
          "1": 30_000,
          "5": 60_000,
          "15": 2 * 60_000,
          "60": 5 * 60_000,
          D: 15 * 60_000,
        };
        pollTimer = window.setTimeout(loadBars, result.freshness === "live" ? livePollMs[resolution] : 5 * 60_000);
      } catch (error) {
        if (stopped) return;
        if (isAbortError(error) && !timedOut) {
          // Aborted by a visibility flap rather than superseded: retry soon so a
          // load interrupted mid-flight can never strand the loading state.
          if (activeController === controller) pollTimer = window.setTimeout(loadBars, 1_000);
          return;
        }
        const message = timedOut
          ? "Real Pyth chart data timed out."
          : error instanceof Error ? error.message : "Real Pyth chart data is unavailable.";
        setChartError(message);
        setState((current) => current === "success" ? current : "error");
        pollTimer = window.setTimeout(loadBars, 30_000);
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        activeController?.abort();
        return;
      }
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      void loadBars();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    void loadBars();
    return () => {
      stopped = true;
      activeController?.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [requestVersion, resolution, ticker]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    const chart = createChart(container, {
      width: Math.max(1, container.clientWidth),
      height: Math.max(270, container.clientHeight),
      layout: {
        attributionLogo: true,
        background: { type: ColorType.Solid, color: "#0d151d" },
        textColor: "#82909d",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "rgba(62, 75, 86, 0.24)" },
        horzLines: { color: "rgba(62, 75, 86, 0.24)" },
      },
      rightPriceScale: { borderColor: "rgba(62, 75, 86, 0.55)" },
      timeScale: {
        borderColor: "rgba(62, 75, 86, 0.55)",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => chartTickLabel(time, tickMarkType, resolutionRef.current),
      },
      localization: {
        priceFormatter: (price: number) => `$${price.toFixed(2)}`,
        timeFormatter: (time: Time) => {
          const date = new Date(unixTime(time) * 1_000);
          return resolutionRef.current === "D" ? dailyCrosshairDate.format(date) : newYorkCrosshairTime.format(date);
        },
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#68c6a1",
      downColor: "#e06d63",
      borderVisible: false,
      wickUpColor: "#68c6a1",
      wickDownColor: "#e06d63",
      priceLineVisible: true,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width > 0 && height > 0) chart.resize(width, height);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      targetLineRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      renderedBarsRef.current = [];
      hasFittedRef.current = false;
      chart.remove();
      container.replaceChildren();
    };
  }, [ticker]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const rendered = renderedBarsRef.current;
    const samePrefix = rendered.length > 0
      && bars.length >= rendered.length
      && rendered.slice(0, -1).every((bar, index) => {
        const next = bars[index];
        return next !== undefined
          && bar.time === next.time
          && bar.open === next.open
          && bar.high === next.high
          && bar.low === next.low
          && bar.close === next.close;
      });
    if (samePrefix) {
      for (const bar of bars.slice(Math.max(0, rendered.length - 1))) {
        series.update({ ...bar, time: bar.time as UTCTimestamp });
      }
    } else {
      series.setData(bars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })));
    }
    renderedBarsRef.current = bars;
    if (bars.length > 0 && !hasFittedRef.current) {
      chart.timeScale().fitContent();
      hasFittedRef.current = true;
    }
  }, [bars]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (targetLineRef.current) {
      series.removePriceLine(targetLineRef.current);
      targetLineRef.current = null;
    }
    if (target === null) return;
    targetLineRef.current = series.createPriceLine({
      price: target,
      color: direction === "up" ? "#68c6a1" : "#e06d63",
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: true,
      title: "RFQ",
    });
  }, [direction, target]);

  const retry = () => {
    setState("loading");
    setChartError("");
    setSnapshotError("");
    setBars([]);
    setBarsMeta(null);
    setRequestVersion((value) => value + 1);
  };

  const selectResolution = (next: ChartResolution) => {
    if (next === resolution) return;
    setState("loading");
    setChartError("");
    setBars([]);
    setBarsMeta(null);
    renderedBarsRef.current = [];
    hasFittedRef.current = false;
    setResolution(next);
  };

  const refreshFailed = state === "success" && chartError.length > 0;
  const sourceStatus = refreshFailed
    ? "Chart refresh delayed"
    : snapshot?.mode === "live"
    ? "Pyth live"
    : snapshot?.mode === "stale"
      ? "Pyth stale"
      : "Checking Pyth";
  const sourceMode = refreshFailed ? "stale" : snapshot?.mode ?? "loading";

  return (
    <section className="tv-chart" aria-label={`${ticker} real Pyth market chart`}>
      <div className="chart-toolbar">
        <div>
          <strong>Pyth market chart</strong>
          <span>Pyth Benchmarks OHLC in New York market time, rendered locally with TradingView Lightweight Charts.</span>
        </div>
        <div className="resolution-picker" role="group" aria-label="Chart interval">
          {resolutions.map((item) => <button type="button" key={item.value} className={resolution === item.value ? "active" : ""} aria-pressed={resolution === item.value} onClick={() => selectResolution(item.value)}>{item.label}</button>)}
        </div>
      </div>
      {target !== null && <div className={`chart-target ${direction}`}><span>RFQ strike</span><strong>${target.toFixed(2)}</strong></div>}
      <div className="chart-canvas-wrap">
        {state === "loading" && <div className="chart-state" role="status"><LoaderCircle className="spin" size={20} aria-hidden="true" /><strong>Loading real Pyth bars</strong><span>Fetching verified market history from Tend’s first-party API…</span></div>}
        {state === "error" && <div className="chart-state error" role="alert"><AlertTriangle size={20} aria-hidden="true" /><strong>Couldn’t load real market bars</strong><span>{chartError}</span><button type="button" className="button secondary" onClick={retry}><RefreshCw size={14} aria-hidden="true" /> Retry</button></div>}
        <div ref={containerRef} className={state === "success" ? "chart-canvas visible" : "chart-canvas"} />
      </div>
      <div className="chart-source" aria-live="polite">
        <span className={`data-mode ${sourceMode}`}>{sourceStatus}</span>
        <span>{snapshot ? `Pyth ${snapshot.price.toFixed(2)} ± ${snapshot.confidence.toFixed(4)} · ${snapshot.ageSeconds}s old` : snapshotError || "Pyth reference pending"}</span>
        <span>{refreshFailed
          ? `${chartError} Last good Pyth bar remains displayed.`
          : barsMeta ? `${barsMeta.source} · ${bars.length.toLocaleString()} real bars · no simulated candles` : "Chart history is served by Pyth Benchmarks."}</span>
        {refreshFailed && <button type="button" className="chart-source-retry" onClick={retry}><RefreshCw size={12} aria-hidden="true" /> Retry</button>}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a>
      </div>
    </section>
  );
}
