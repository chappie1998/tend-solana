import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  computeSettlementDeadline,
  decideMarketPublishAction,
  decidePositionAction,
  decodeDirectPositionMarket,
  decodeMarketAccountForCleanup,
  decodePoolPositionAccount,
  describeSettlementError,
  DIRECT_POSITION_ACCOUNT_SIZE,
  DIRECT_POSITION_DISCRIMINATOR,
  filterExpiredOpenPositions,
  groupPositionsByMarket,
  MARKET_ACCOUNT_DISCRIMINATOR,
  MARKET_ACCOUNT_SIZE,
  marketsWithOpenPositions,
  POOL_POSITION_ACCOUNT_SIZE,
  POOL_POSITION_DISCRIMINATOR,
  redact,
  selectMarketCloseCandidates,
  type DecodedMarketForCleanup,
  type DecodedPoolPosition,
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

test("computeSettlementDeadline is expiry + observation window + settlement grace", () => {
  assert.equal(computeSettlementDeadline(WINDOW), 1_000 + 30 + 900);
});

test("decideMarketPublishAction: skips when the oracle is already finalized", () => {
  const decision = decideMarketPublishAction({ ...WINDOW, now: 1_500, oracleFinalized: true });
  assert.equal(decision.kind, "skip");
});

test("decideMarketPublishAction: skips before expiry", () => {
  const decision = decideMarketPublishAction({ ...WINDOW, now: 500, oracleFinalized: false });
  assert.equal(decision.kind, "skip");
});

test("decideMarketPublishAction: skips once the settlement deadline has passed (refund path applies)", () => {
  const decision = decideMarketPublishAction({ ...WINDOW, now: 1_000 + 30 + 900 + 1, oracleFinalized: false });
  assert.equal(decision.kind, "skip");
});

test("decideMarketPublishAction: publishes when expired, unfinalized, and within the settlement window", () => {
  const decision = decideMarketPublishAction({ ...WINDOW, now: 1_050, oracleFinalized: false });
  assert.equal(decision.kind, "publish");
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

test("decidePositionAction: refunds once past the settlement deadline with no finalized oracle", () => {
  const deadline = computeSettlementDeadline(WINDOW);
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
}> = {}): { address: PublicKey; buffer: Buffer } {
  const address = overrides.address ?? new PublicKey(Buffer.alloc(32, 0x21));
  const data = Buffer.alloc(MARKET_ACCOUNT_SIZE);
  Buffer.from(MARKET_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  (overrides.oracle ?? new PublicKey(Buffer.alloc(32, 0x22))).toBuffer().copy(data, 137);
  data.writeBigInt64LE(BigInt(overrides.expiry ?? 1_000), 193);
  data.writeUInt32LE(overrides.observationWindowSeconds ?? 30, 201);
  data.writeUInt32LE(overrides.settlementGraceSeconds ?? 900, 205);
  (overrides.creator ?? new PublicKey(Buffer.alloc(32, 0x23))).toBuffer().copy(data, 245);
  return { address, buffer: data };
}

test("decodeMarketAccountForCleanup reads every field at its documented offset", () => {
  const oracle = new PublicKey(Buffer.alloc(32, 0x31));
  const creator = new PublicKey(Buffer.alloc(32, 0x32));
  const { address, buffer } = fixtureMarket({ oracle, creator, expiry: 5_000, observationWindowSeconds: 60, settlementGraceSeconds: 120 });
  const decoded = decodeMarketAccountForCleanup(address, buffer);
  assert.equal(decoded.address, address.toBase58());
  assert.equal(decoded.oracle, oracle.toBase58());
  assert.equal(decoded.creator, creator.toBase58());
  assert.equal(decoded.expiry, 5_000);
  assert.equal(decoded.observationWindowSeconds, 60);
  assert.equal(decoded.settlementGraceSeconds, 120);
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
const CLOSE_DEADLINE = computeSettlementDeadline(CLOSE_WINDOW);

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
    maxPerRun: 2,
  });
  assert.deepEqual(result.map((m) => m.address), markets.slice(0, 2).map((m) => m.address));
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
    maxPerRun: 25,
  });

  assert.deepEqual(result, []);
});
