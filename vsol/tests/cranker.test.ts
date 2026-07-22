import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  computeSettlementDeadline,
  decideMarketPublishAction,
  decidePositionAction,
  decodePoolPositionAccount,
  describeSettlementError,
  filterExpiredOpenPositions,
  groupPositionsByMarket,
  POOL_POSITION_ACCOUNT_SIZE,
  POOL_POSITION_DISCRIMINATOR,
  redact,
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
