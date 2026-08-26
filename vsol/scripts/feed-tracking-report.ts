// Turns the samples collected by feed-tracking-sample.ts into the three
// answers needed to decide whether Tend's NVDA market should settle on
// `Crypto.NVDAX/USD` instead of `Equity.US.NVDA/USD`:
//
//   1. COVERAGE   -- is the tokenized feed live around the clock, including
//                    a weekend? Reported per UTC hour and split
//                    weekday/weekend, against the equity feed as a control.
//   2. TRACKING   -- how far does NVDAx drift from the equity price while
//                    both are live? Reported in basis points, with the tail
//                    (p95/max) rather than just the mean, because a
//                    settlement oracle is only as good as its worst moment.
//   3. CONFIDENCE -- does the tokenized feed ever widen its band past a
//                    market's `max_confidence_bps` (500 for the NVDA rungs)?
//                    The equity feed does exactly this at the close (887 bps
//                    measured), which makes it unsettleable precisely when
//                    the fallback is needed.
//
// A feed counts as LIVE at a sample when its newest print was under
// LIVE_THRESHOLD_SECONDS old at sample time -- see feed-tracking-sample.ts
// for why staleness-at-sample-time is the honest coverage measure.
//
// Usage:  npm --prefix vsol run feed:report

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TrackingSample } from "./feed-tracking-sample.ts";

const workspace = resolve(import.meta.dirname, "..");
const inputPath = resolve(workspace, ".feed-tracking", "samples.jsonl");

const EQUITY = "Equity.US.NVDA/USD";
const TOKENIZED = "Crypto.NVDAX/USD";
const REDEMPTION = "Crypto.NVDAX/NVDA.RR";

/**
 * A print older than this means the feed was not publishing at sample time.
 * 120s is deliberately generous: it must not mistake a feed that publishes
 * every ~30-60s for a dark one, while still being far below the multi-hour
 * staleness an actually-dark feed shows (8.9 hours, measured).
 */
const LIVE_THRESHOLD_SECONDS = 120;

/** The bound the NVDA rungs are created with (MARKET_MAX_CONFIDENCE_BPS). */
const MAX_CONFIDENCE_BPS = 500;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function isLive(staleness: number | null | undefined): boolean {
  return typeof staleness === "number" && staleness <= LIVE_THRESHOLD_SECONDS;
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(inputPath, "utf8");
  } catch {
    console.error(`No samples yet at ${inputPath}. Run \`npm --prefix vsol run feed:sample\` (or let the scheduled workflow collect some) first.`);
    process.exit(1);
  }

  const samples = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TrackingSample);

  if (samples.length === 0) {
    console.error("The sample file is empty.");
    process.exit(1);
  }

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const spanHours = (last.sampledAt - first.sampledAt) / 3_600;

  console.log("NVDA feed tracking report");
  console.log("=========================");
  console.log(`samples   ${samples.length}`);
  console.log(`window    ${first.iso}  ->  ${last.iso}  (${spanHours.toFixed(1)}h)`);
  console.log(`live if   newest print <= ${LIVE_THRESHOLD_SECONDS}s old at sample time`);

  const get = (sample: TrackingSample, symbol: string) => sample.feeds.find((feed) => feed.symbol === symbol);

  // --- 1. Coverage --------------------------------------------------------
  console.log("\n1. COVERAGE");
  const weekendSamples = samples.filter((sample) => sample.utcDay === 0 || sample.utcDay === 6);
  const weekdaySamples = samples.filter((sample) => sample.utcDay !== 0 && sample.utcDay !== 6);

  for (const [label, subset] of [["all", samples], ["weekday", weekdaySamples], ["weekend", weekendSamples]] as const) {
    const equityLive = subset.filter((sample) => isLive(get(sample, EQUITY)?.stalenessSeconds)).length;
    const tokenLive = subset.filter((sample) => isLive(get(sample, TOKENIZED)?.stalenessSeconds)).length;
    console.log(`  ${label.padEnd(8)} n=${String(subset.length).padStart(4)}   equity ${pct(equityLive, subset.length).padStart(6)}   tokenized ${pct(tokenLive, subset.length).padStart(6)}`);
  }
  if (weekendSamples.length === 0) {
    console.log("  NOTE: no weekend samples yet -- the weekend question is still unanswered.");
  }

  console.log("\n  by UTC hour (E = equity live %, T = tokenized live %):");
  for (let hour = 0; hour < 24; hour += 1) {
    const subset = samples.filter((sample) => sample.utcHour === hour);
    if (subset.length === 0) continue;
    const equityLive = subset.filter((sample) => isLive(get(sample, EQUITY)?.stalenessSeconds)).length;
    const tokenLive = subset.filter((sample) => isLive(get(sample, TOKENIZED)?.stalenessSeconds)).length;
    const bar = (n: number) => "#".repeat(Math.round((10 * n) / subset.length)).padEnd(10, ".");
    console.log(`    ${String(hour).padStart(2, "0")}:00  n=${String(subset.length).padStart(3)}  E ${bar(equityLive)} ${pct(equityLive, subset.length).padStart(6)}   T ${bar(tokenLive)} ${pct(tokenLive, subset.length).padStart(6)}`);
  }

  // --- 2. Tracking error --------------------------------------------------
  console.log("\n2. TRACKING ERROR (tokenized vs equity, both live)");
  const basisBps: number[] = [];
  for (const sample of samples) {
    const equity = get(sample, EQUITY);
    const token = get(sample, TOKENIZED);
    if (!equity?.price || !token?.price) continue;
    if (!isLive(equity.stalenessSeconds) || !isLive(token.stalenessSeconds)) continue;
    basisBps.push(((token.price - equity.price) / equity.price) * 10_000);
  }
  if (basisBps.length === 0) {
    console.log("  no samples where BOTH feeds were live -- cannot measure tracking error yet.");
  } else {
    const absSorted = [...basisBps].map(Math.abs).sort((a, b) => a - b);
    const mean = basisBps.reduce((sum, value) => sum + value, 0) / basisBps.length;
    console.log(`  n=${basisBps.length}`);
    console.log(`  mean basis   ${mean >= 0 ? "+" : ""}${mean.toFixed(1)} bps  (tokenized ${mean >= 0 ? "above" : "below"} equity)`);
    console.log(`  |basis| p50  ${quantile(absSorted, 0.5).toFixed(1)} bps`);
    console.log(`  |basis| p95  ${quantile(absSorted, 0.95).toFixed(1)} bps`);
    console.log(`  |basis| max  ${absSorted[absSorted.length - 1]!.toFixed(1)} bps`);
    console.log("  Read the tail, not the mean: a settlement oracle is only as good as its worst moment.");
  }

  const redemption = samples.map((sample) => get(sample, REDEMPTION)?.price).filter((price): price is number => typeof price === "number");
  if (redemption.length > 0) {
    const min = Math.min(...redemption);
    const max = Math.max(...redemption);
    console.log(`  redemption rate (NVDAX/NVDA): min ${min.toFixed(4)}  max ${max.toFixed(4)}  -- a drift from 1.0000 means the token itself has decoupled`);
  }

  // --- 3. Confidence ------------------------------------------------------
  console.log(`\n3. CONFIDENCE vs the ${MAX_CONFIDENCE_BPS} bps market bound`);
  for (const symbol of [EQUITY, TOKENIZED]) {
    const observations = samples
      .map((sample) => get(sample, symbol))
      .filter((feed) => feed && isLive(feed.stalenessSeconds) && typeof feed.confidenceBps === "number");
    if (observations.length === 0) {
      console.log(`  ${symbol.padEnd(22)} no live samples`);
      continue;
    }
    const values = observations.map((feed) => feed!.confidenceBps!).sort((a, b) => a - b);
    const breaches = values.filter((value) => value > MAX_CONFIDENCE_BPS).length;
    console.log(
      `  ${symbol.padEnd(22)} n=${String(values.length).padStart(4)}  p50 ${String(quantile(values, 0.5)).padStart(4)}  p95 ${String(quantile(values, 0.95)).padStart(4)}  max ${String(values[values.length - 1]).padStart(5)}  over-bound ${breaches} (${pct(breaches, values.length)})`,
    );
  }

  // --- Verdict scaffolding ------------------------------------------------
  console.log("\nWHAT WOULD MAKE THE SWITCH SAFE");
  console.log("  - tokenized coverage at or near 100% in EVERY UTC hour, weekend included");
  console.log("  - |basis| p95 small relative to the strike ladder step ($5 on a ~$210 name is ~240 bps)");
  console.log("  - zero confidence breaches over the bound while live");
  const weekendCovered = weekendSamples.length > 0;
  if (!weekendCovered) console.log("\n  Not yet decidable: no weekend in the sample window.");
}

await main();
