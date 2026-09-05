// Records one observation of every NVDA-related Pyth feed, for deciding
// whether the tokenized `Crypto.NVDAX/USD` feed is a sound settlement source
// for Tend's 24/7 expiry grid.
//
// WHY THIS EXISTS
//
// `Equity.US.NVDA/USD` stops publishing outside US equity hours. Measured
// 2026-08-25 at 04:56Z, its newest print was 8.9 hours old, and a market
// expiring at 04:45Z settled on a stale pre-close print at $209.46 while the
// tokenized feed had a live print at expiry of $210.32 -- opposite sides of
// the $210 strike. The dark feed did not merely make the outcome
// predictable; it produced a different and wrong one.
//
// `Crypto.NVDAX/USD` (tokenized NVDA) appears to publish continuously, which
// would fix that with no program change -- the feed id is just a market
// parameter. Before switching, three things need evidence rather than one
// spot check:
//
//   1. Coverage. Is it genuinely live 24/7, INCLUDING a weekend? Hermes'
//      historical retention is only ~31h, so this cannot be backfilled --
//      it has to be sampled forward across a weekend.
//   2. Tracking error. NVDAx is a tokenized claim, not the equity. How far
//      does it drift from `Equity.US.NVDA/USD` when both are live?
//   3. Confidence. The equity feed blows its confidence band open at the
//      close (measured 887 bps against a 500 bps bound). Does the tokenized
//      feed do anything similar overnight or at the weekend, which would
//      make it unsettleable exactly when it is most needed?
//
// HOW IT MEASURES
//
// Deliberately uses `getLatestPriceUpdates` (not the historical endpoint) and
// records each print's `publish_time`. Staleness at sample time is then the
// coverage measurement: a feed publishing right now returns a print seconds
// old, a dark one returns hours. This avoids the trap that produced a bad
// earlier estimate -- Hermes' historical endpoint is exact-second, so probing
// it on a grid conflates "no print at this exact second" with "feed dark".
//
// Appends one JSON object per line to vsol/.feed-tracking/samples.jsonl
// (gitignored). Never overwrites, so repeated runs accumulate.
//
// Usage:  npm --prefix vsol run feed:sample

import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const HERMES = process.env.PYTH_HERMES_URL?.trim() || "https://hermes.pyth.network";
const workspace = resolve(import.meta.dirname, "..");
const outputDir = resolve(workspace, ".feed-tracking");
const outputPath = resolve(outputDir, "samples.jsonl");

/** The feeds worth watching. `.PRE`/`.POST`/`.ON` are deliberately excluded: measured 2026-08-25, all three were ~70 days stale, i.e. abandoned. */
const FEEDS = [
  "Equity.US.NVDA/USD",
  "Crypto.NVDAX/USD",
  // The token's intended peg to the underlying. A drift here is the cleanest
  // signal that NVDAx has decoupled, independent of either price feed.
  "Crypto.NVDAX/NVDA.RR",
] as const;

export type FeedObservation = {
  symbol: string;
  feedId: string;
  /** Null when Hermes returned no usable parsed price at all. */
  price: number | null;
  publishTime: number | null;
  /** Seconds between the print's publish time and this sample. The coverage measurement. */
  stalenessSeconds: number | null;
  /** conf / price in basis points -- compare against a market's max_confidence_bps (500 for the NVDA rungs). */
  confidenceBps: number | null;
  error?: string;
};

export type TrackingSample = {
  sampledAt: number;
  iso: string;
  /** UTC day-of-week (0 = Sunday) and hour, so the report can bucket by session/weekend without re-parsing. */
  utcDay: number;
  utcHour: number;
  feeds: FeedObservation[];
};

async function feedIds(): Promise<Map<string, string>> {
  const response = await fetch(`${HERMES}/v2/price_feeds?query=NVDA`);
  if (!response.ok) throw new Error(`Hermes feed listing failed: ${response.status}`);
  const listed = (await response.json()) as Array<{ id: string; attributes?: { symbol?: string } }>;
  const bySymbol = new Map<string, string>();
  for (const entry of listed) {
    const symbol = entry.attributes?.symbol;
    if (symbol) bySymbol.set(symbol, entry.id);
  }
  return bySymbol;
}

async function observe(symbol: string, feedId: string, sampledAt: number): Promise<FeedObservation> {
  try {
    const response = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`);
    if (!response.ok) return { symbol, feedId, price: null, publishTime: null, stalenessSeconds: null, confidenceBps: null, error: `HTTP ${response.status}` };
    const body = (await response.json()) as { parsed?: Array<{ price: { price: string; conf: string; expo: number; publish_time: number } }> };
    const parsed = body.parsed?.[0]?.price;
    if (!parsed) return { symbol, feedId, price: null, publishTime: null, stalenessSeconds: null, confidenceBps: null, error: "no parsed price" };
    const price = Number(parsed.price) * 10 ** parsed.expo;
    const confidenceBps = Number(parsed.price) === 0 ? null : Math.round((Number(parsed.conf) / Number(parsed.price)) * 10_000);
    return {
      symbol,
      feedId,
      price,
      publishTime: parsed.publish_time,
      stalenessSeconds: sampledAt - parsed.publish_time,
      confidenceBps,
    };
  } catch (error) {
    return { symbol, feedId, price: null, publishTime: null, stalenessSeconds: null, confidenceBps: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const bySymbol = await feedIds();
  const sampledAt = Math.floor(Date.now() / 1_000);
  const when = new Date(sampledAt * 1_000);

  const feeds: FeedObservation[] = [];
  for (const symbol of FEEDS) {
    const feedId = bySymbol.get(symbol);
    if (!feedId) {
      feeds.push({ symbol, feedId: "", price: null, publishTime: null, stalenessSeconds: null, confidenceBps: null, error: "not listed by Hermes" });
      continue;
    }
    feeds.push(await observe(symbol, feedId, sampledAt));
  }

  const sample: TrackingSample = {
    sampledAt,
    iso: when.toISOString(),
    utcDay: when.getUTCDay(),
    utcHour: when.getUTCHours(),
    feeds,
  };

  await mkdir(outputDir, { recursive: true });
  await appendFile(outputPath, `${JSON.stringify(sample)}\n`);

  const summary = feeds
    .map((feed) => {
      if (feed.price === null) return `${feed.symbol}=unavailable(${feed.error})`;
      return `${feed.symbol}=$${feed.price.toFixed(2)} (${feed.stalenessSeconds}s old, ${feed.confidenceBps}bps)`;
    })
    .join("  ");
  console.log(`${sample.iso}  ${summary}`);
}

await main();
