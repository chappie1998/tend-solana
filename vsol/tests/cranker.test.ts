import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  computeFinalSettlementDeadline,
  computeMarketCloseDeadline,
  computeObservationEnd,
  computeSettlementDeadline,
  computeTierTwoOpenAt,
  confidenceBpsOf,
  decideMarketPublishAction,
  decidePositionAction,
  decodeDirectPositionMarket,
  decodeMarketAccountForCleanup,
  decodePoolPositionAccount,
  decodeTokenAccountAmount,
  describeSettlementError,
  DIRECT_POSITION_ACCOUNT_SIZE,
  DIRECT_POSITION_DISCRIMINATOR,
  filterExpiredOpenPositions,
  groupPositionsByMarket,
  isSettlementPrintAcceptable,
  MARKET_ACCOUNT_DISCRIMINATOR,
  MARKET_ACCOUNT_SIZE,
  marketsWithOpenPositions,
  marketsWithOutstandingCollateral,
  POOL_POSITION_ACCOUNT_SIZE,
  POOL_POSITION_DISCRIMINATOR,
  pythPriceToScaledAtoms,
  redact,
  selectMarketCloseCandidates,
  selectMarketsNeedingSettlementAttempt,
  selectViableSettlementTier,
  SETTLEMENT_REFUND_PRIORITY_SECONDS,
  walkPrintSequenceForAcceptablePrint,
  type DecodedMarketForCleanup,
  type DecodedPoolPosition,
  type SettlementPrintCandidate,
  type SettlementPrintProbe,
} from "../scripts/lib/settlement.ts";

// Every test here exercises pure logic only -- no live RPC, no Program
// instance, no Connection -- per the cranker's design: the RPC-touching
// pieces (fetchOpenPoolPositions, fetchMarketStates, publishSettlementForMarket,
// settlePoolPositionOnChain, refundPoolPositionOnChain) are thin, and the
// decision logic that determines what to do with what the chain returns is
// what actually needs coverage.

function fixturePosition(overrides: Partial<{
  address: PublicKey;
  status: number;
  direction: 0 | 1;
  pool: PublicKey;
  market: PublicKey;
  nonceRecord: PublicKey;
  buyer: PublicKey;
  quoteAuthority: PublicKey;
  settlementMint: PublicKey;
  nonce: bigint;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  feeBps: number;
  openedAt: number;
  quoteExpiry: number;
}> = {}): { address: PublicKey; buffer: Buffer } {
  const address = overrides.address ?? new PublicKey(Buffer.alloc(32, 0x09));
  const data = Buffer.alloc(POOL_POSITION_ACCOUNT_SIZE);
  Buffer.from(POOL_POSITION_DISCRIMINATOR).copy(data, 0);
  data[8] = 1; // bump
  data[9] = 2; // vault_bump
  data[10] = overrides.status ?? 1; // status: Open
  data[11] = overrides.direction ?? 0; // direction: up
  (overrides.pool ?? new PublicKey(Buffer.alloc(32, 0x01))).toBuffer().copy(data, 12);
  (overrides.market ?? new PublicKey(Buffer.alloc(32, 0x02))).toBuffer().copy(data, 44);
  (overrides.nonceRecord ?? new PublicKey(Buffer.alloc(32, 0x03))).toBuffer().copy(data, 76);
  (overrides.buyer ?? new PublicKey(Buffer.alloc(32, 0x04))).toBuffer().copy(data, 108);
  (overrides.quoteAuthority ?? new PublicKey(Buffer.alloc(32, 0x05))).toBuffer().copy(data, 140);
  (overrides.settlementMint ?? new PublicKey(Buffer.alloc(32, 0x06))).toBuffer().copy(data, 172);
  data.writeBigUInt64LE(overrides.nonce ?? 42n, 204);
  data.writeBigUInt64LE(overrides.strike ?? 100_000_000n, 212);
  data.writeBigUInt64LE(overrides.width ?? 10_000_000n, 220);
  data.writeBigUInt64LE(overrides.premium ?? 500_000n, 228);
  data.writeBigUInt64LE(overrides.maxPayout ?? 5_000_000n, 236);
  data.writeUInt16LE(overrides.feeBps ?? 25, 244);
  data.writeBigInt64LE(BigInt(overrides.openedAt ?? 1_000), 246);
  data.writeBigInt64LE(BigInt(overrides.quoteExpiry ?? 1_500), 254);
  return { address, buffer: data };
}

test("decodePoolPositionAccount reads every field at its documented offset", () => {
  const pool = new PublicKey(Buffer.alloc(32, 0x11));
  const market = new PublicKey(Buffer.alloc(32, 0x22));
  const buyer = new PublicKey(Buffer.alloc(32, 0x33));
  const { address, buffer } = fixturePosition({ pool, market, buyer, direction: 1, nonce: 7n });
  const decoded = decodePoolPositionAccount(address, buffer);
  assert.equal(decoded.address, address.toBase58());
  assert.equal(decoded.pool, pool.toBase58());
  assert.equal(decoded.market, market.toBase58());
  assert.equal(decoded.buyer, buyer.toBase58());
  assert.equal(decoded.direction, 1);
  assert.equal(decoded.nonce, 7n);
  assert.equal(decoded.status, 1);
});

test("decodePoolPositionAccount rejects the wrong size", () => {
  const { address, buffer } = fixturePosition();
  assert.throws(() => decodePoolPositionAccount(address, buffer.subarray(0, POOL_POSITION_ACCOUNT_SIZE - 1)));
});

test("decodePoolPositionAccount rejects a mismatched discriminator", () => {
  const { address, buffer } = fixturePosition();
  buffer[0] = buffer[0] ^ 0xff;
  assert.throws(() => decodePoolPositionAccount(address, buffer));
});

function decoded(market: PublicKey, address: PublicKey, quoteAuthority = new PublicKey(Buffer.alloc(32, 0x05))): DecodedPoolPosition {
  const { buffer } = fixturePosition({ address, market, quoteAuthority });
  return decodePoolPositionAccount(address, buffer);
}

test("filterExpiredOpenPositions returns exactly the positions whose market has passed expiry", () => {
  const expiredMarket = new PublicKey(Buffer.alloc(32, 0xa1));
  const liveMarket = new PublicKey(Buffer.alloc(32, 0xa2));
  const unknownMarket = new PublicKey(Buffer.alloc(32, 0xa3));
  const expiredPosition = decoded(expiredMarket, new PublicKey(Buffer.alloc(32, 0xb1)));
  const livePosition = decoded(liveMarket, new PublicKey(Buffer.alloc(32, 0xb2)));
  const unknownMarketPosition = decoded(unknownMarket, new PublicKey(Buffer.alloc(32, 0xb3)));

  const marketExpiries = new Map<string, number>([
    [expiredMarket.toBase58(), 1_000],
    [liveMarket.toBase58(), 5_000],
  ]);
  const now = 2_000;

  const result = filterExpiredOpenPositions(
    [expiredPosition, livePosition, unknownMarketPosition],
    marketExpiries,
    now,
  );
  assert.deepEqual(result.map((p) => p.address), [expiredPosition.address]);
});

test("filterExpiredOpenPositions treats expiry as inclusive (now === expiry counts as expired)", () => {
  const market = new PublicKey(Buffer.alloc(32, 0xc1));
  const position = decoded(market, new PublicKey(Buffer.alloc(32, 0xc2)));
  const marketExpiries = new Map<string, number>([[market.toBase58(), 1_000]]);
  assert.equal(filterExpiredOpenPositions([position], marketExpiries, 1_000).length, 1);
  assert.equal(filterExpiredOpenPositions([position], marketExpiries, 999).length, 0);
});

test("groupPositionsByMarket groups by market and preserves order within a group", () => {
  const marketA = new PublicKey(Buffer.alloc(32, 0xd1));
  const marketB = new PublicKey(Buffer.alloc(32, 0xd2));
  const first = decoded(marketA, new PublicKey(Buffer.alloc(32, 0xe1)));
  const second = decoded(marketB, new PublicKey(Buffer.alloc(32, 0xe2)));
  const third = decoded(marketA, new PublicKey(Buffer.alloc(32, 0xe3)));

  const groups = groupPositionsByMarket([first, second, third]);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get(marketA.toBase58())?.map((p) => p.address), [first.address, third.address]);
  assert.deepEqual(groups.get(marketB.toBase58())?.map((p) => p.address), [second.address]);
});

const WINDOW = { expiry: 1_000, observationWindowSeconds: 30, settlementGraceSeconds: 900 };
const PUBLISH_WINDOW = { ...WINDOW, maxSettlementStalenessSeconds: 86_400 };

test("computeSettlementDeadline is expiry + observation window + settlement grace", () => {
  assert.equal(computeSettlementDeadline(WINDOW), 1_000 + 30 + 900);
});

test("computeTierTwoOpenAt is computeSettlementDeadline plus SETTLEMENT_REFUND_PRIORITY_SECONDS", () => {
  assert.equal(computeTierTwoOpenAt(WINDOW), 1_000 + 30 + 900 + SETTLEMENT_REFUND_PRIORITY_SECONDS);
  // Deliberately later than the refund deadline -- see the "refund wins the
  // tie" tests below.
  assert.ok(computeTierTwoOpenAt(WINDOW) > computeSettlementDeadline(WINDOW));
});

test("computeFinalSettlementDeadline is computeSettlementDeadline plus maxSettlementStalenessSeconds (NOT computeTierTwoOpenAt plus staleness)", () => {
  assert.equal(computeFinalSettlementDeadline(PUBLISH_WINDOW), 1_000 + 30 + 900 + 86_400);
});

test("decideMarketPublishAction: skips when the oracle is already finalized", () => {
  const decision = decideMarketPublishAction({ ...PUBLISH_WINDOW, now: 1_500, oracleFinalized: true });
  assert.equal(decision.kind, "skip");
});

test("decideMarketPublishAction: skips before expiry", () => {
  const decision = decideMarketPublishAction({ ...PUBLISH_WINDOW, now: 500, oracleFinalized: false });
  assert.equal(decision.kind, "skip");
});

test("decideMarketPublishAction: still attempts publish just past the settlement deadline -- tier 2 might apply once its own gate opens", () => {
  // Before the tier-2 timing fix, the cranker gave up here (the bare
  // settlement deadline). Tier 2 by definition only ever becomes reachable
  // AFTER this instant, so stopping here would mean the cranker could never
  // land a legitimate tier-2 settlement at all.
  const deadline = computeSettlementDeadline(PUBLISH_WINDOW);
  const decision = decideMarketPublishAction({ ...PUBLISH_WINDOW, now: deadline + 1, oracleFinalized: false });
  assert.equal(decision.kind, "publish");
});

test("decideMarketPublishAction: skips once the final settlement deadline (deadline + staleness) has passed", () => {
  const finalDeadline = computeFinalSettlementDeadline(PUBLISH_WINDOW);
  const decision = decideMarketPublishAction({ ...PUBLISH_WINDOW, now: finalDeadline + 1, oracleFinalized: false });
  assert.equal(decision.kind, "skip");
});

test("decideMarketPublishAction: publishes when expired, unfinalized, and within the settlement window", () => {
  const decision = decideMarketPublishAction({ ...PUBLISH_WINDOW, now: 1_050, oracleFinalized: false });
  assert.equal(decision.kind, "publish");
});

test("computeObservationEnd is expiry + observation window (matches computeSettlementDeadline minus grace)", () => {
  assert.equal(computeObservationEnd(WINDOW), 1_000 + 30);
  assert.equal(computeObservationEnd(WINDOW) + WINDOW.settlementGraceSeconds, computeSettlementDeadline(WINDOW));
});

// selectViableSettlementTier is the fix for the confirmed live bug:
// fetchLatestPythUpdate always returned the newest Hermes print, which only
// ever satisfies tier 1 (and only when the cranker's 10-minute interval
// happens to land inside the 30-second observation window), and could NEVER
// satisfy tier 2 -- a fresh "latest" print is by construction never at or
// before `expiry` once the market has already expired. These tests pin the
// exact boundaries this selector must reuse from decideMarketPublishAction's
// own helpers (computeObservationEnd / computeTierTwoOpenAt /
// computeFinalSettlementDeadline), not restate them.
test("selectViableSettlementTier: before expiry -> neither tier", () => {
  assert.equal(selectViableSettlementTier({ ...PUBLISH_WINDOW, now: 500 }), null);
});

test("selectViableSettlementTier: at expiry exactly -> tier-one (inclusive lower bound, matches tier_one_ok)", () => {
  assert.equal(selectViableSettlementTier({ ...PUBLISH_WINDOW, now: PUBLISH_WINDOW.expiry }), "tier-one");
});

test("selectViableSettlementTier: at observation_end exactly -> still tier-one (inclusive upper bound, matches publish_time <= observation_end)", () => {
  const observationEnd = computeObservationEnd(PUBLISH_WINDOW);
  assert.equal(selectViableSettlementTier({ ...PUBLISH_WINDOW, now: observationEnd }), "tier-one");
});

test("selectViableSettlementTier: just past observation_end, before tier_two_open_at -> neither tier (the dead gap)", () => {
  const observationEnd = computeObservationEnd(PUBLISH_WINDOW);
  const tierTwoOpenAt = computeTierTwoOpenAt(PUBLISH_WINDOW);
  assert.ok(observationEnd + 1 <= tierTwoOpenAt, "the gap must be non-empty for this test to mean anything");
  assert.equal(selectViableSettlementTier({ ...PUBLISH_WINDOW, now: observationEnd + 1 }), null);
});

test("selectViableSettlementTier: exactly at tier_two_open_at -> still neither tier (on-chain gate is strictly greater-than)", () => {
  const tierTwoOpenAt = computeTierTwoOpenAt(PUBLISH_WINDOW);
  assert.equal(selectViableSettlementTier({ ...PUBLISH_WINDOW, now: tierTwoOpenAt }), null);
});

test("selectViableSettlementTier: just past tier_two_open_at -> tier-two", () => {
  const tierTwoOpenAt = computeTierTwoOpenAt(PUBLISH_WINDOW);
  assert.equal(selectViableSettlementTier({ ...PUBLISH_WINDOW, now: tierTwoOpenAt + 1 }), "tier-two");
});

test("selectViableSettlementTier: at the final settlement deadline exactly -> still tier-two (inclusive, matches decideMarketPublishAction)", () => {
  const finalDeadline = computeFinalSettlementDeadline(PUBLISH_WINDOW);
  assert.equal(selectViableSettlementTier({ ...PUBLISH_WINDOW, now: finalDeadline }), "tier-two");
});

test("selectViableSettlementTier: past the final settlement deadline -> neither tier", () => {
  const finalDeadline = computeFinalSettlementDeadline(PUBLISH_WINDOW);
  assert.equal(selectViableSettlementTier({ ...PUBLISH_WINDOW, now: finalDeadline + 1 }), null);
});

// --- confidenceBpsOf / isSettlementPrintAcceptable / walkPrintSequenceForAcceptablePrint ---
// The THIRD bug in this chain, confirmed by a live on-chain rejection: a
// real cranker run submitted a tier-2 settlement and the program rejected it
// with custom error 6039 (OracleConfidenceTooWide). "The latest print that
// exists" is not the same thing as "the latest print the chain will accept"
// -- Pyth blows its confidence band open on the FINAL print before a feed
// goes quiet. Measured live against feed
// b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593 (NVDA,
// max_confidence_bps 500 on this deployment):
//   20:00:19Z (closing print, market close): price 20844000, conf 1849000 -> conf_bps 887 (REJECTED)
//   19:45:00Z (mid-session, ~15 min earlier): price 20862500, conf 10929   -> conf_bps 5   (passes)
//   16:56Z    (mid-session):                  price 20965828, conf 11307  -> conf_bps 5    (passes)
// For any market expiring while the feed is dark, "latest print at/before
// expiry" IS that closing print, so tier-2 selection was predictably picking
// a print the program is guaranteed to reject.

test("confidenceBpsOf: the measured closing print floors to 887 bps", () => {
  assert.equal(confidenceBpsOf({ publishTime: 0, price: 20_844_000n, conf: 1_849_000n }), 887);
});

test("confidenceBpsOf: the measured 19:45:00Z print floors to 5 bps", () => {
  assert.equal(confidenceBpsOf({ publishTime: 0, price: 20_862_500n, conf: 10_929n }), 5);
});

test("confidenceBpsOf: the measured 16:56Z print floors to 5 bps", () => {
  assert.equal(confidenceBpsOf({ publishTime: 0, price: 20_965_828n, conf: 11_307n }), 5);
});

const CONF_WINDOW = { expiry: 1_000, observationWindowSeconds: 30, settlementGraceSeconds: 900, maxSettlementStalenessSeconds: 86_400 };

test("isSettlementPrintAcceptable: the measured closing print is REJECTED at the real 500 bps market bound (tier-two) -- this is the confirmed live rejection (error 6039)", () => {
  const closingPrint: SettlementPrintCandidate = { publishTime: CONF_WINDOW.expiry, price: 20_844_000n, conf: 1_849_000n };
  const result = isSettlementPrintAcceptable({ tier: "tier-two", candidate: closingPrint, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "confidence_too_wide");
});

test("isSettlementPrintAcceptable: the SAME closing print is accepted at a hypothetical 1000 bps bound", () => {
  const closingPrint: SettlementPrintCandidate = { publishTime: CONF_WINDOW.expiry, price: 20_844_000n, conf: 1_849_000n };
  const result = isSettlementPrintAcceptable({ tier: "tier-two", candidate: closingPrint, window: CONF_WINDOW, maxConfidenceBps: 1_000 });
  assert.equal(result.ok, true);
});

test("isSettlementPrintAcceptable: the measured 19:45:00Z print is accepted at the real 500 bps bound (tier-two)", () => {
  const midSessionPrint: SettlementPrintCandidate = { publishTime: CONF_WINDOW.expiry, price: 20_862_500n, conf: 10_929n };
  const result = isSettlementPrintAcceptable({ tier: "tier-two", candidate: midSessionPrint, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, true);
});

test("isSettlementPrintAcceptable (tier-two): staleness exactly at maxSettlementStalenessSeconds is accepted", () => {
  const candidate: SettlementPrintCandidate = {
    publishTime: CONF_WINDOW.expiry - CONF_WINDOW.maxSettlementStalenessSeconds,
    price: 1_000_000n,
    conf: 1n,
  };
  const result = isSettlementPrintAcceptable({ tier: "tier-two", candidate, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, true);
});

test("isSettlementPrintAcceptable (tier-two): staleness one second beyond the bound is rejected", () => {
  const candidate: SettlementPrintCandidate = {
    publishTime: CONF_WINDOW.expiry - CONF_WINDOW.maxSettlementStalenessSeconds - 1,
    price: 1_000_000n,
    conf: 1n,
  };
  const result = isSettlementPrintAcceptable({ tier: "tier-two", candidate, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "staleness_exceeds_bound");
});

test("isSettlementPrintAcceptable (tier-two): publish_time one second after expiry is rejected", () => {
  const candidate: SettlementPrintCandidate = { publishTime: CONF_WINDOW.expiry + 1, price: 1_000_000n, conf: 1n };
  const result = isSettlementPrintAcceptable({ tier: "tier-two", candidate, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "publish_time_after_upper_bound");
});

test("isSettlementPrintAcceptable (tier-one): publish_time at expiry exactly is accepted (inclusive lower bound)", () => {
  const candidate: SettlementPrintCandidate = { publishTime: CONF_WINDOW.expiry, price: 1_000_000n, conf: 1n };
  const result = isSettlementPrintAcceptable({ tier: "tier-one", candidate, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, true);
});

test("isSettlementPrintAcceptable (tier-one): publish_time at observation_end exactly is accepted (inclusive upper bound)", () => {
  const observationEnd = computeObservationEnd(CONF_WINDOW);
  const candidate: SettlementPrintCandidate = { publishTime: observationEnd, price: 1_000_000n, conf: 1n };
  const result = isSettlementPrintAcceptable({ tier: "tier-one", candidate, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, true);
});

test("isSettlementPrintAcceptable (tier-one): publish_time one second before expiry is rejected", () => {
  const candidate: SettlementPrintCandidate = { publishTime: CONF_WINDOW.expiry - 1, price: 1_000_000n, conf: 1n };
  const result = isSettlementPrintAcceptable({ tier: "tier-one", candidate, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "publish_time_before_lower_bound");
});

test("isSettlementPrintAcceptable (tier-one): publish_time one second after observation_end is rejected", () => {
  const observationEnd = computeObservationEnd(CONF_WINDOW);
  const candidate: SettlementPrintCandidate = { publishTime: observationEnd + 1, price: 1_000_000n, conf: 1n };
  const result = isSettlementPrintAcceptable({ tier: "tier-one", candidate, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "publish_time_after_upper_bound");
});

test("isSettlementPrintAcceptable (tier-one): a wide-confidence print INSIDE the observation window is still rejected -- e.g. an expiry landing exactly at market close", () => {
  const candidate: SettlementPrintCandidate = { publishTime: CONF_WINDOW.expiry, price: 20_844_000n, conf: 1_849_000n };
  const result = isSettlementPrintAcceptable({ tier: "tier-one", candidate, window: CONF_WINDOW, maxConfidenceBps: 500 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "confidence_too_wide");
});

// walkPrintSequenceForAcceptablePrint is the mechanism that recovers from the
// live failures. It walks the feed's ACTUAL print sequence (resuming at
// publishTime - 1 after each rejection) rather than a fixed grid, because the
// measured acceptable print sat 916s from the anchor -- not a multiple of the
// old 60s stride, which stepped straight over it. Driven here by a synthetic,
// network-free probe.

/** Builds a probe over a synthetic feed: a map of publishTime -> candidate, where any timestamp resolves to the newest print at or before it (Hermes' own behaviour), and gaps resolve to "absent". */
function syntheticFeed(prints: SettlementPrintCandidate[], probed?: number[]): SettlementPrintProbe<null> {
  const sorted = [...prints].sort((x, y) => y.publishTime - x.publishTime);
  return async (timestamp) => {
    probed?.push(timestamp);
    const hit = sorted.find((print) => print.publishTime === timestamp);
    return hit ? { kind: "print", candidate: hit, value: null } : { kind: "absent" };
  };
}

test("walkPrintSequenceForAcceptablePrint: the measured trace -- anchor print is the wide closing print (887 bps), the print one second earlier is tight (5 bps) -> selects the tight one in 2 probes", async () => {
  // The real numbers from the live feed: 1787601619 carried 887 bps, and
  // 1787601618 -- one second earlier -- carried 5 bps.
  const wideClosingPrint: SettlementPrintCandidate = { publishTime: 1_000, price: 20_844_000n, conf: 1_849_000n }; // 887 bps
  const tightPrint: SettlementPrintCandidate = { publishTime: 999, price: 20_842_523n, conf: 10_929n }; // 5 bps
  const result = await walkPrintSequenceForAcceptablePrint({
    probe: syntheticFeed([wideClosingPrint, tightPrint]),
    tier: "tier-two",
    window: CONF_WINDOW,
    maxConfidenceBps: 500,
    startTimestamp: 1_000,
    lowerBound: 900,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.candidate.publishTime, 999);
    assert.equal(result.probeCount, 2, "the walk must step onto the very next print, not scan a grid");
  }
});

test("walkPrintSequenceForAcceptablePrint: on a dense in-session feed it steps print-by-print through consecutive wide prints to the first tight one", async () => {
  // Mirrors the real feed's in-session shape: a print every second. The
  // newest three are wide, the fourth is tight. Resuming at
  // `publishTime - 1` must land on each successive real print -- the old
  // fixed 60s stride would have jumped clean past all four.
  const wide = (publishTime: number): SettlementPrintCandidate => ({ publishTime, price: 20_844_000n, conf: 1_849_000n });
  const tight: SettlementPrintCandidate = { publishTime: 9_996, price: 20_842_523n, conf: 10_929n };
  const probed: number[] = [];
  const result = await walkPrintSequenceForAcceptablePrint({
    probe: async (timestamp) => {
      probed.push(timestamp);
      if (timestamp >= 9_997) return { kind: "print", candidate: wide(timestamp), value: null };
      if (timestamp === 9_996) return { kind: "print", candidate: tight, value: null };
      return { kind: "absent" };
    },
    tier: "tier-two",
    window: { ...CONF_WINDOW, expiry: 10_000, maxSettlementStalenessSeconds: 86_400 },
    maxConfidenceBps: 500,
    startTimestamp: 9_999,
    lowerBound: 10_000 - 86_400,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.candidate.publishTime, 9_996);
  assert.deepEqual(probed, [9_999, 9_998, 9_997, 9_996], "each probe must land on the next real print, not a grid position");
});

test("walkPrintSequenceForAcceptablePrint: crosses a multi-hour dark gap cheaply by widening the step", async () => {
  // One tight print ~6 hours before the anchor, nothing in between: the
  // geometric gap growth must reach it in a handful of probes, not hundreds.
  const tight: SettlementPrintCandidate = { publishTime: 100_000 - 21_600, price: 20_862_500n, conf: 10_929n };
  const probed: number[] = [];
  const result = await walkPrintSequenceForAcceptablePrint({
    probe: async (timestamp) => {
      probed.push(timestamp);
      return timestamp <= tight.publishTime
        ? { kind: "print", candidate: tight, value: null }
        : { kind: "absent" };
    },
    tier: "tier-two",
    window: { ...CONF_WINDOW, expiry: 100_000, maxSettlementStalenessSeconds: 86_400 },
    maxConfidenceBps: 500,
    startTimestamp: 100_000,
    lowerBound: 100_000 - 86_400,
  });
  assert.equal(result.ok, true);
  assert.ok(probed.length < 20, `expected a widening step to cross 6h in <20 probes, took ${probed.length}`);
});

test("walkPrintSequenceForAcceptablePrint: every print in range is wide -> confidence_too_wide, NOT no_print_available", async () => {
  const wide: SettlementPrintCandidate = { publishTime: 1_000, price: 20_844_000n, conf: 1_849_000n };
  const result = await walkPrintSequenceForAcceptablePrint({
    probe: async () => ({ kind: "print", candidate: wide, value: null }),
    tier: "tier-two",
    window: CONF_WINDOW,
    maxConfidenceBps: 500,
    startTimestamp: 1_000,
    lowerBound: 900,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "confidence_too_wide");
    if (result.reason === "confidence_too_wide") {
      assert.equal(result.bestConfBps, 887);
      assert.equal(result.maxConfidenceBps, 500);
    }
  }
});

test("walkPrintSequenceForAcceptablePrint: no print anywhere in range -> no_print_available", async () => {
  const result = await walkPrintSequenceForAcceptablePrint<null>({
    probe: async () => ({ kind: "absent" }),
    tier: "tier-two",
    window: CONF_WINDOW,
    maxConfidenceBps: 500,
    startTimestamp: 1_000,
    lowerBound: 900,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_print_available");
});

test("walkPrintSequenceForAcceptablePrint: a non-404 probe error PROPAGATES and is never reported as no_print_available", async () => {
  // The regression test for the confirmed false negative: a transient
  // `fetch failed` must not masquerade as "the feed published nothing".
  await assert.rejects(
    () =>
      walkPrintSequenceForAcceptablePrint<null>({
        probe: async () => {
          throw new Error("fetch failed");
        },
        tier: "tier-two",
        window: CONF_WINDOW,
        maxConfidenceBps: 500,
        startTimestamp: 1_000,
        lowerBound: 900,
      }),
    /fetch failed/,
  );
});

test("walkPrintSequenceForAcceptablePrint: never probes below lowerBound, so it can never widen the staleness bound to make a print fit", async () => {
  const probed: number[] = [];
  await walkPrintSequenceForAcceptablePrint<null>({
    probe: async (timestamp) => {
      probed.push(timestamp);
      return { kind: "absent" };
    },
    tier: "tier-two",
    window: CONF_WINDOW,
    maxConfidenceBps: 500,
    startTimestamp: 1_000,
    lowerBound: 940,
  });
  const minProbed = Math.min(...probed);
  assert.ok(minProbed >= 940, `expected no probe below lowerBound (940), got ${minProbed}`);
});

test("decidePositionAction: skips before expiry regardless of oracle state", () => {
  assert.equal(decidePositionAction({ ...WINDOW, now: 500, oracleFinalized: true }).kind, "skip");
  assert.equal(decidePositionAction({ ...WINDOW, now: 500, oracleFinalized: false }).kind, "skip");
});

test("decidePositionAction: settles once expired with a finalized oracle", () => {
  const decision = decidePositionAction({ ...WINDOW, now: 1_050, oracleFinalized: true });
  assert.equal(decision.kind, "settle");
});

test("decidePositionAction: waits (skips) once expired with an unfinalized oracle inside the settlement window", () => {
  const decision = decidePositionAction({ ...WINDOW, now: 1_050, oracleFinalized: false });
  assert.equal(decision.kind, "skip");
});

test("decidePositionAction: refunds once past the settlement deadline with no finalized oracle -- refund wins the tie against tier 2 (see SETTLEMENT_REFUND_PRIORITY_SECONDS)", () => {
  const deadline = computeSettlementDeadline(WINDOW);
  // Refund is available here even though tier 2's own gate has not opened
  // yet (computeTierTwoOpenAt(WINDOW) is still SETTLEMENT_REFUND_PRIORITY_SECONDS
  // away) -- decidePositionAction deliberately does not wait around for the
  // mere possibility of a later tier-2 settlement once refunding is legal.
  assert.ok(deadline + 1 < computeTierTwoOpenAt(WINDOW));
  assert.equal(decidePositionAction({ ...WINDOW, now: deadline + 1, oracleFinalized: false }).kind, "refund");
  // A finalized oracle always wins over the refund path, even past the deadline.
  assert.equal(decidePositionAction({ ...WINDOW, now: deadline + 1, oracleFinalized: true }).kind, "settle");
});

test("redact removes every occurrence of the secret and is a no-op for an empty secret", () => {
  assert.equal(redact("connecting to https://rpc.example/abc123 now", "https://rpc.example/abc123"), "connecting to [redacted] now");
  assert.equal(redact("no secret here", ""), "no secret here");
});

test("describeSettlementError redacts the secret and passes through a plain Error message", () => {
  const error = new Error("failed against https://rpc.example/abc123");
  assert.equal(describeSettlementError(error, "https://rpc.example/abc123"), "failed against [redacted]");
});

test("describeSettlementError handles a non-Error thrown value", () => {
  assert.equal(describeSettlementError("boom", "secret"), "boom");
});

// pythPriceToScaledAtoms is the shared price*10^expo->PRICE_SCALE conversion
// bootstrap.ts's smoke settlement does inline and keeper.ts's discover-first
// strike-ladder lookup also needs (see the function's doc comment in
// scripts/lib/settlement.ts). A typical Pyth equity feed publishes a
// negative expo (mantissa many places larger than the human price).
test("pythPriceToScaledAtoms converts a negative-exponent Pyth price to PRICE_SCALE atoms", () => {
  // NVDA at $123.45 with Pyth's typical expo -8: mantissa 12_345_000_000.
  const atoms = pythPriceToScaledAtoms(12_345_000_000n, -8, 1_000_000n);
  assert.equal(atoms, 123_450_000n); // $123.45 at PRICE_SCALE (1e6).
});

test("pythPriceToScaledAtoms handles a non-negative exponent", () => {
  // mantissa 5, expo 2 => 500 in the feed's native unit.
  const atoms = pythPriceToScaledAtoms(5n, 2, 1_000_000n);
  assert.equal(atoms, 500_000_000n); // 500 at PRICE_SCALE.
});

test("pythPriceToScaledAtoms round-trips a whole-dollar price", () => {
  const atoms = pythPriceToScaledAtoms(100n, 0, 1_000_000n);
  assert.equal(atoms, 100_000_000n);
});

// --- Market cleanup ----------------------------------------------------------
// The candidate-selection predicate is the whole safety story for
// close_settled_market: the instruction cannot itself verify no open
// position still references the market, so selectMarketCloseCandidates must
// never mark a market safe unless the caller's own fresh position scan
// proves it has zero open positions. These tests exercise that predicate in
// isolation (no RPC), plus the decoder it depends on and the per-run cap.

function fixtureMarket(overrides: Partial<{
  address: PublicKey;
  oracle: PublicKey;
  creator: PublicKey;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  marketId: Buffer;
  symbol: string;
  pythFeedId: Buffer;
  maxConfidenceBps: number;
  priceScale: bigint;
  maxSettlementStalenessSeconds: number;
  enabled: boolean;
  strike: bigint;
}> = {}): { address: PublicKey; buffer: Buffer } {
  const address = overrides.address ?? new PublicKey(Buffer.alloc(32, 0x21));
  const data = Buffer.alloc(MARKET_ACCOUNT_SIZE);
  Buffer.from(MARKET_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  (overrides.marketId ?? Buffer.alloc(32, 0x20)).copy(data, 41);
  (overrides.oracle ?? new PublicKey(Buffer.alloc(32, 0x22))).toBuffer().copy(data, 137);
  Buffer.from((overrides.symbol ?? "NVDA").padEnd(16, "\0"), "ascii").copy(data, 169);
  data.writeBigUInt64LE(overrides.priceScale ?? 1_000_000n, 185);
  data.writeBigInt64LE(BigInt(overrides.expiry ?? 1_000), 193);
  data.writeUInt32LE(overrides.observationWindowSeconds ?? 30, 201);
  data.writeUInt32LE(overrides.settlementGraceSeconds ?? 900, 205);
  data.writeUInt16LE(overrides.maxConfidenceBps ?? 500, 209);
  (overrides.pythFeedId ?? Buffer.alloc(32, 0x24)).copy(data, 211);
  data[244] = overrides.enabled ?? true ? 1 : 0;
  (overrides.creator ?? new PublicKey(Buffer.alloc(32, 0x23))).toBuffer().copy(data, 245);
  data.writeUInt32LE(overrides.maxSettlementStalenessSeconds ?? 86_400, 277);
  data.writeBigUInt64LE(overrides.strike ?? 100_000_000n, 281);
  return { address, buffer: data };
}

test("decodeMarketAccountForCleanup reads every field at its documented offset", () => {
  const oracle = new PublicKey(Buffer.alloc(32, 0x31));
  const creator = new PublicKey(Buffer.alloc(32, 0x32));
  const marketId = Buffer.alloc(32, 0x33);
  const pythFeedId = Buffer.alloc(32, 0x34);
  const { address, buffer } = fixtureMarket({
    oracle,
    creator,
    expiry: 5_000,
    observationWindowSeconds: 60,
    settlementGraceSeconds: 120,
    marketId,
    symbol: "NVDA",
    pythFeedId,
    maxConfidenceBps: 250,
    priceScale: 1_000_000n,
    maxSettlementStalenessSeconds: 43_200,
    enabled: false,
    strike: 150_000_000n,
  });
  const decoded = decodeMarketAccountForCleanup(address, buffer);
  assert.equal(decoded.address, address.toBase58());
  assert.equal(decoded.oracle, oracle.toBase58());
  assert.equal(decoded.creator, creator.toBase58());
  assert.equal(decoded.expiry, 5_000);
  assert.equal(decoded.observationWindowSeconds, 60);
  assert.equal(decoded.settlementGraceSeconds, 120);
  assert.equal(decoded.marketId, marketId.toString("hex"));
  assert.equal(decoded.symbol, "NVDA");
  assert.equal(decoded.pythFeedId, pythFeedId.toString("hex"));
  assert.equal(decoded.maxConfidenceBps, 250);
  assert.equal(decoded.priceScale, 1_000_000n);
  assert.equal(decoded.maxSettlementStalenessSeconds, 43_200);
  assert.equal(decoded.enabled, false);
  assert.equal(decoded.strike, 150_000_000n);
});

test("decodeMarketAccountForCleanup NUL-trims a short symbol", () => {
  const { address, buffer } = fixtureMarket({ symbol: "EOD" });
  const decoded = decodeMarketAccountForCleanup(address, buffer);
  assert.equal(decoded.symbol, "EOD");
});

test("decodeMarketAccountForCleanup rejects the wrong size", () => {
  const { address, buffer } = fixtureMarket();
  assert.throws(() => decodeMarketAccountForCleanup(address, buffer.subarray(0, MARKET_ACCOUNT_SIZE - 1)));
});

test("decodeMarketAccountForCleanup rejects a mismatched discriminator", () => {
  const { address, buffer } = fixtureMarket();
  buffer[0] = buffer[0] ^ 0xff;
  assert.throws(() => decodeMarketAccountForCleanup(address, buffer));
});

function marketFixture(
  addressSeed: number,
  overrides: Partial<{ expiry: number; observationWindowSeconds: number; settlementGraceSeconds: number }> = {},
): DecodedMarketForCleanup {
  const { address, buffer } = fixtureMarket({ address: new PublicKey(Buffer.alloc(32, addressSeed)), ...overrides });
  return decodeMarketAccountForCleanup(address, buffer);
}

const CLOSE_WINDOW = { expiry: 1_000, observationWindowSeconds: 30, settlementGraceSeconds: 900 };
// The CLOSE deadline, not the settlement/refund deadline — closing is gated a
// further MARKET_CLEANUP_BUFFER_SECONDS out so cleanup can never race an
// in-flight refund. See computeMarketCloseDeadline in scripts/lib/settlement.ts.
const CLOSE_DEADLINE = computeMarketCloseDeadline(CLOSE_WINDOW);

test("selectMarketCloseCandidates returns exactly the markets past their close deadline with no open position", () => {
  const pastDeadlineNoPosition = marketFixture(0x41, CLOSE_WINDOW);
  const pastDeadlineWithPosition = marketFixture(0x42, CLOSE_WINDOW);
  const notYetPastDeadline = marketFixture(0x43, { ...CLOSE_WINDOW, expiry: CLOSE_WINDOW.expiry + 10_000 });
  // An "already closed" market is simply absent from the `markets` array
  // passed in -- there is no third state to represent, since a closed
  // account no longer exists on-chain and fetchAllMarkets would never
  // return it. That absence is exercised implicitly: the candidate set below
  // is computed only from the three markets actually supplied.

  const result = selectMarketCloseCandidates({
    markets: [pastDeadlineNoPosition, pastDeadlineWithPosition, notYetPastDeadline],
    now: CLOSE_DEADLINE + 1,
    marketsWithOpenPositions: new Set([pastDeadlineWithPosition.address]),
    marketsWithOutstandingCollateral: new Set(),
    maxPerRun: 25,
  });

  assert.deepEqual(result.map((m) => m.address), [pastDeadlineNoPosition.address]);
});

test("a market past its deadline but WITH an open position referencing it is NOT a candidate (stranding prevention)", () => {
  const market = marketFixture(0x51, CLOSE_WINDOW);
  const result = selectMarketCloseCandidates({
    markets: [market],
    now: CLOSE_DEADLINE + 1,
    marketsWithOpenPositions: new Set([market.address]),
    marketsWithOutstandingCollateral: new Set(),
    maxPerRun: 25,
  });
  assert.deepEqual(result, []);
});

test("a market whose deadline has not elapsed is not a candidate, even with no open position", () => {
  const market = marketFixture(0x52, CLOSE_WINDOW);
  const result = selectMarketCloseCandidates({
    markets: [market],
    now: CLOSE_DEADLINE, // exactly at the deadline: the on-chain check is strict `now > deadline`
    marketsWithOpenPositions: new Set(),
    marketsWithOutstandingCollateral: new Set(),
    maxPerRun: 25,
  });
  assert.deepEqual(result, []);
});

test("selectMarketCloseCandidates honors the per-run cap, preserving input order", () => {
  const markets = [0x61, 0x62, 0x63, 0x64, 0x65].map((seed) => marketFixture(seed, CLOSE_WINDOW));
  const result = selectMarketCloseCandidates({
    markets,
    now: CLOSE_DEADLINE + 1,
    marketsWithOpenPositions: new Set(),
    marketsWithOutstandingCollateral: new Set(),
    maxPerRun: 2,
  });
  assert.deepEqual(result.map((m) => m.address), markets.slice(0, 2).map((m) => m.address));
});

// --- Complete-set collateral vault (FINDING 1's off-chain mirror) -----------
// `close_settled_market` now refuses to close a market whose collateral
// vault still holds outstanding balance (see `MarketHasOutstandingCollateral`
// in vsol/programs/vsol/src/lib.rs). These tests exercise the off-chain
// mirror of that same exclusion: a market with a non-zero vault balance is
// never a close candidate, even with zero open positions and a fully
// elapsed close deadline; a market whose vault is empty (or was never
// created) is unaffected.

// The real SPL Token `Account` layout is 165 bytes; this fixture only needs
// to be at least long enough to contain the `amount` field at offset 64.
const TOKEN_ACCOUNT_FIXTURE_SIZE = 165;

test("decodeTokenAccountAmount reads the amount field at its documented offset", () => {
  const data = Buffer.alloc(TOKEN_ACCOUNT_FIXTURE_SIZE);
  data.writeBigUInt64LE(123_456_789n, 64);
  assert.equal(decodeTokenAccountAmount(data), 123_456_789n);
});

test("decodeTokenAccountAmount rejects a buffer too small to contain the amount field", () => {
  assert.throws(() => decodeTokenAccountAmount(Buffer.alloc(64)));
});

test("marketsWithOutstandingCollateral includes only markets with a strictly positive balance", () => {
  const empty = new PublicKey(Buffer.alloc(32, 0xa1));
  const neverCreated = new PublicKey(Buffer.alloc(32, 0xa2));
  const outstanding = new PublicKey(Buffer.alloc(32, 0xa3));
  const balances = new Map<string, bigint>([
    [empty.toBase58(), 0n],
    [neverCreated.toBase58(), 0n],
    [outstanding.toBase58(), 1n],
  ]);
  const result = marketsWithOutstandingCollateral(balances);
  assert.equal(result.size, 1);
  assert.ok(result.has(outstanding.toBase58()));
  assert.ok(!result.has(empty.toBase58()));
  assert.ok(!result.has(neverCreated.toBase58()));
});

test("a market past its deadline with an empty complete-set vault (or none ever created) is not excluded", () => {
  const market = marketFixture(0xa4, CLOSE_WINDOW);
  const result = selectMarketCloseCandidates({
    markets: [market],
    now: CLOSE_DEADLINE + 1,
    marketsWithOpenPositions: new Set(),
    marketsWithOutstandingCollateral: marketsWithOutstandingCollateral(new Map([[market.address, 0n]])),
    maxPerRun: 25,
  });
  assert.deepEqual(result.map((m) => m.address), [market.address]);
});

test("a market past its deadline with a NON-ZERO complete-set vault balance is NOT a candidate, even with zero open positions", () => {
  const market = marketFixture(0xa5, CLOSE_WINDOW);
  const result = selectMarketCloseCandidates({
    markets: [market],
    now: CLOSE_DEADLINE + 1,
    marketsWithOpenPositions: new Set(),
    marketsWithOutstandingCollateral: marketsWithOutstandingCollateral(
      new Map([[market.address, 1_000_000n]]),
    ),
    maxPerRun: 25,
  });
  assert.deepEqual(result, []);
});

// --- Direct-maker Position (the `fill_quote`/`settle` path) -----------------
// Regression guard for the stranding bug the coordinator caught: cleanup
// originally only scanned pool-backed `PoolPosition` accounts, so a market
// with zero PoolPositions but one open direct-maker `Position` (opened via
// `fill_quote`, settled via `settle`/`refund_unsettled`) would be wrongly
// treated as empty and closed -- stranding that Position forever, since
// `settle`'s accounts struct loads `Market` via `has_one` and fails once the
// market account is gone. cranker.ts's runMarketCleanup now unions markets
// referenced by open PoolPositions AND open direct Positions before calling
// selectMarketCloseCandidates; these tests exercise the decoder for that
// second account type and prove the predicate blocks a market referenced
// only by a direct position, with no PoolPosition in sight.

function fixtureDirectPosition(overrides: Partial<{ address: PublicKey; market: PublicKey }> = {}): {
  address: PublicKey;
  buffer: Buffer;
} {
  const address = overrides.address ?? new PublicKey(Buffer.alloc(32, 0x71));
  const data = Buffer.alloc(DIRECT_POSITION_ACCOUNT_SIZE);
  Buffer.from(DIRECT_POSITION_DISCRIMINATOR).copy(data, 0);
  data[10] = 1; // status: Open
  (overrides.market ?? new PublicKey(Buffer.alloc(32, 0x72))).toBuffer().copy(data, 12);
  return { address, buffer: data };
}

test("decodeDirectPositionMarket reads the market field at its documented offset", () => {
  const market = new PublicKey(Buffer.alloc(32, 0x81));
  const { address, buffer } = fixtureDirectPosition({ market });
  const decoded = decodeDirectPositionMarket(address, buffer);
  assert.equal(decoded.address, address.toBase58());
  assert.equal(decoded.market, market.toBase58());
});

test("decodeDirectPositionMarket rejects the wrong size", () => {
  const { address, buffer } = fixtureDirectPosition();
  assert.throws(() => decodeDirectPositionMarket(address, buffer.subarray(0, DIRECT_POSITION_ACCOUNT_SIZE - 1)));
});

test("decodeDirectPositionMarket rejects a mismatched discriminator", () => {
  const { address, buffer } = fixtureDirectPosition();
  buffer[0] = buffer[0] ^ 0xff;
  assert.throws(() => decodeDirectPositionMarket(address, buffer));
});

test("marketsWithOpenPositions includes a market referenced only by a direct position (no PoolPosition at all)", () => {
  // This is the exact function whose original (buggy) inline form only
  // unioned PoolPosition markets. If it regresses to dropping the
  // directPositions argument, this assertion fails immediately.
  const market = new PublicKey(Buffer.alloc(32, 0x91));
  const directPosition = decodeDirectPositionMarket(
    new PublicKey(Buffer.alloc(32, 0x92)),
    fixtureDirectPosition({ market }).buffer,
  );
  const result = marketsWithOpenPositions({ poolPositions: [], directPositions: [directPosition] });
  assert.ok(result.has(market.toBase58()));
});

test("a market past its deadline with an open DIRECT position (no PoolPosition at all) is NOT a close candidate", () => {
  // End-to-end (still RPC-free) regression guard for the stranding bug: runs
  // the exact two-step pipeline runMarketCleanup uses -- build the union via
  // marketsWithOpenPositions, then filter via selectMarketCloseCandidates --
  // with zero PoolPositions and one direct Position on this market. Before
  // the fix (cleanup unioning only PoolPosition markets), this market would
  // have wrongly come back as a candidate and been closed, stranding the
  // direct position forever.
  const market = marketFixture(0x93, CLOSE_WINDOW);
  const directPosition = decodeDirectPositionMarket(
    new PublicKey(Buffer.alloc(32, 0x94)),
    fixtureDirectPosition({ market: new PublicKey(market.address) }).buffer,
  );

  const openPositionMarkets = marketsWithOpenPositions({ poolPositions: [], directPositions: [directPosition] });

  const result = selectMarketCloseCandidates({
    markets: [market],
    now: CLOSE_DEADLINE + 1,
    marketsWithOpenPositions: openPositionMarkets,
    marketsWithOutstandingCollateral: new Set(),
    maxPerRun: 25,
  });

  assert.deepEqual(result, []);
});

// --- selectMarketsNeedingSettlementAttempt (the enumeration fix) ------------
// Regression coverage for a bug confirmed on a live devnet run:
// runSettlementPhase used to build its ENTIRE work list from
// `[...new Set(positions.map(p => p.market))]` over `fetchOpenPoolPositions`
// alone, so a v2 conditional-token market -- whose only on-chain state is two
// SPL mints and a complete-set collateral vault, with NO PoolPosition and NO
// direct Position -- was never enumerated at all. Its oracle was therefore
// never finalized, and `redeem_winning` reverted with `OracleNotFinalized`
// forever; holders' only recourse was the pro-rata 50/50 `redeem_unresolved`
// fallback once `final_deadline` passed, regardless of who actually won. The
// first test below is exactly that scenario.

const SETTLEMENT_WINDOW = { expiry: 1_000, observationWindowSeconds: 30, settlementGraceSeconds: 900 };
const SETTLEMENT_NOW = SETTLEMENT_WINDOW.expiry + 10_000; // well past expiry

test("selectMarketsNeedingSettlementAttempt: past expiry, oracle unfinalized, non-zero vault, zero positions -> selected (the regression under test)", () => {
  const market = marketFixture(0xb1, SETTLEMENT_WINDOW);
  const result = selectMarketsNeedingSettlementAttempt({
    markets: [market],
    now: SETTLEMENT_NOW,
    marketsWithFinalizedOracle: new Set(),
    marketsWithOpenPositions: new Set(),
    marketsWithOutstandingCollateral: new Set([market.address]),
  });
  assert.deepEqual(result.map((m) => m.address), [market.address]);
});

test("selectMarketsNeedingSettlementAttempt: past expiry, oracle unfinalized, zero vault, zero positions -> not selected (nothing at stake)", () => {
  const market = marketFixture(0xb2, SETTLEMENT_WINDOW);
  const result = selectMarketsNeedingSettlementAttempt({
    markets: [market],
    now: SETTLEMENT_NOW,
    marketsWithFinalizedOracle: new Set(),
    marketsWithOpenPositions: new Set(),
    marketsWithOutstandingCollateral: new Set(),
  });
  assert.deepEqual(result, []);
});

test("selectMarketsNeedingSettlementAttempt: past expiry, oracle unfinalized, zero vault, open position -> selected (existing behavior preserved)", () => {
  const market = marketFixture(0xb3, SETTLEMENT_WINDOW);
  const result = selectMarketsNeedingSettlementAttempt({
    markets: [market],
    now: SETTLEMENT_NOW,
    marketsWithFinalizedOracle: new Set(),
    marketsWithOpenPositions: new Set([market.address]),
    marketsWithOutstandingCollateral: new Set(),
  });
  assert.deepEqual(result.map((m) => m.address), [market.address]);
});

test("selectMarketsNeedingSettlementAttempt: oracle already finalized -> not selected, even with something at stake", () => {
  const market = marketFixture(0xb4, SETTLEMENT_WINDOW);
  const result = selectMarketsNeedingSettlementAttempt({
    markets: [market],
    now: SETTLEMENT_NOW,
    marketsWithFinalizedOracle: new Set([market.address]),
    marketsWithOpenPositions: new Set([market.address]),
    marketsWithOutstandingCollateral: new Set([market.address]),
  });
  assert.deepEqual(result, []);
});

test("selectMarketsNeedingSettlementAttempt: not yet expired -> not selected regardless of vault or positions", () => {
  const market = marketFixture(0xb5, SETTLEMENT_WINDOW);
  const result = selectMarketsNeedingSettlementAttempt({
    markets: [market],
    now: SETTLEMENT_WINDOW.expiry - 1,
    marketsWithFinalizedOracle: new Set(),
    marketsWithOpenPositions: new Set([market.address]),
    marketsWithOutstandingCollateral: new Set([market.address]),
  });
  assert.deepEqual(result, []);
});

test("selectMarketsNeedingSettlementAttempt: at expiry exactly counts as past expiry (inclusive)", () => {
  const market = marketFixture(0xb6, SETTLEMENT_WINDOW);
  const result = selectMarketsNeedingSettlementAttempt({
    markets: [market],
    now: SETTLEMENT_WINDOW.expiry,
    marketsWithFinalizedOracle: new Set(),
    marketsWithOpenPositions: new Set(),
    marketsWithOutstandingCollateral: new Set([market.address]),
  });
  assert.deepEqual(result.map((m) => m.address), [market.address]);
});

test("selectMarketsNeedingSettlementAttempt: a market with BOTH an open position and outstanding collateral is selected exactly once, not duplicated", () => {
  const market = marketFixture(0xb7, SETTLEMENT_WINDOW);
  const result = selectMarketsNeedingSettlementAttempt({
    markets: [market],
    now: SETTLEMENT_NOW,
    marketsWithFinalizedOracle: new Set(),
    marketsWithOpenPositions: new Set([market.address]),
    marketsWithOutstandingCollateral: new Set([market.address]),
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result.map((m) => m.address), [market.address]);
});
