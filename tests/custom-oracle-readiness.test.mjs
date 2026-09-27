import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";

const root = new URL("../", import.meta.url);

function feedData({ symbol = "NVDA", price = 100_000_000n, confidence = 10n, scale = 1_000_000n, observedAt = 1_000, publisher }) {
  const data = Buffer.alloc(89);
  createHash("sha256").update("account:CustomPriceFeed").digest().copy(data, 0, 0, 8);
  data.write(symbol, 9, "ascii");
  data.writeBigUInt64LE(scale, 25);
  data.writeBigUInt64LE(price, 33);
  data.writeBigUInt64LE(confidence, 41);
  data.writeBigInt64LE(BigInt(observedAt), 49);
  publisher.toBuffer().copy(data, 57);
  return data;
}

test("heartbeat readiness: fresh, stale, wrong publisher, and missing feed account", async () => {
  const { assessHeartbeatFeed } = await import(new URL("app/lib/custom-oracle-readiness.ts", root));
  const { VSOL_PROGRAM_ID } = await import(new URL("app/lib/vsol.ts", root));
  const authority = new PublicKey(Buffer.alloc(32, 7));
  const otherAuthority = new PublicKey(Buffer.alloc(32, 9));
  const account = (data, owner = VSOL_PROGRAM_ID) => ({ data, owner, executable: false, lamports: 1, rentEpoch: 0 });
  const heartbeatData = (overrides) => feedData({ symbol: "HEARTBEAT", price: 1n, confidence: 0n, publisher: authority, ...overrides });

  // Missing entirely (init-heartbeat-feed.ts has not run yet).
  const missing = assessHeartbeatFeed({ account: null, oracleAuthority: authority, now: 1_000 });
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /not initialized/);

  // Fresh: published moments ago.
  const fresh = assessHeartbeatFeed({ account: account(heartbeatData({ observedAt: 1_000 })), oracleAuthority: authority, now: 1_010 });
  assert.equal(fresh.ready, true);
  assert.equal(fresh.ageSeconds, 10);

  // Stale: older than HEARTBEAT_MAX_AGE_SECONDS (900s) -- the runner may be down.
  const stale = assessHeartbeatFeed({ account: account(heartbeatData({ observedAt: 1_000 })), oracleAuthority: authority, now: 1_000 + 901 });
  assert.equal(stale.ready, false);
  assert.match(stale.reason, /901s old/);
  assert.match(stale.reason, /runner may be down/);

  // Exactly at the boundary is still ready; the boundary itself belongs to the caller.
  const atBoundary = assessHeartbeatFeed({ account: account(heartbeatData({ observedAt: 1_000 })), oracleAuthority: authority, now: 1_000 + 900 });
  assert.equal(atBoundary.ready, true);

  // Wrong publisher: config.oracle_authority was rotated and the heartbeat
  // was last written by the OLD authority.
  const wrongPublisher = assessHeartbeatFeed({ account: account(heartbeatData({})), oracleAuthority: otherAuthority, now: 1_010 });
  assert.equal(wrongPublisher.ready, false);
  assert.match(wrongPublisher.reason, /publisher/);

  // Wrong owner and a malformed layout both fail cleanly too.
  assert.match(assessHeartbeatFeed({ account: account(heartbeatData({}), PublicKey.default), oracleAuthority: authority, now: 1_010 }).reason, /wrong owner/);
  assert.match(assessHeartbeatFeed({ account: account(Buffer.alloc(10)), oracleAuthority: authority, now: 1_010 }).reason, /layout is invalid/);
});

test("custom feed STRUCTURAL readiness checks plumbing only, never price freshness or confidence", async () => {
  const { assessCustomFeedStructure } = await import(new URL("app/lib/custom-oracle-readiness.ts", root));
  const { VSOL_PROGRAM_ID } = await import(new URL("app/lib/vsol.ts", root));
  const authority = new PublicKey(Buffer.alloc(32, 7));
  const otherAuthority = new PublicKey(Buffer.alloc(32, 9));
  const account = (data, owner = VSOL_PROGRAM_ID) => ({ data, owner, executable: false, lamports: 1, rentEpoch: 0 });

  // Missing feed account: never initialized at all.
  assert.equal(assessCustomFeedStructure({ symbol: "SOL", account: null, oracleAuthority: authority }).ready, false);

  // A feed that has never been published to (publisher still the all-zero
  // default init_custom_price_feed sets) is structurally fine -- the SAME
  // transaction that will eventually capture this market also publishes to
  // it first (see lib/publish-capture-transaction.ts), so nothing about a
  // fresh, untouched feed indicates a capture would fail.
  const neverPublished = feedData({ symbol: "SOL", price: 0n, publisher: PublicKey.default });
  assert.equal(assessCustomFeedStructure({ symbol: "SOL", account: account(neverPublished), oracleAuthority: authority }).ready, true);

  // A STALE, MISMATCHED publisher (rotated authority, feed not yet
  // re-published under the new one) is genuinely unready.
  const stalePublisher = feedData({ symbol: "SOL", publisher: otherAuthority });
  const staleResult = assessCustomFeedStructure({ symbol: "SOL", account: account(stalePublisher), oracleAuthority: authority });
  assert.equal(staleResult.ready, false);
  assert.match(staleResult.reason, /publisher/);

  // Wrong scale and wrong symbol both fail.
  assert.match(assessCustomFeedStructure({ symbol: "SOL", account: account(feedData({ symbol: "SOL", publisher: authority, scale: 10n })), oracleAuthority: authority }).reason, /scale/);
  assert.match(assessCustomFeedStructure({ symbol: "SOL", account: account(feedData({ symbol: "BTC", publisher: authority })), oracleAuthority: authority }).reason, /symbol/);

  // Crucially: a ZERO price and huge confidence do NOT fail this check --
  // that is the whole point of "structural, not price-freshness".
  const zeroPriceWideConfidence = feedData({ symbol: "SOL", price: 0n, confidence: 999_999_999n, publisher: authority });
  const structural = assessCustomFeedStructure({ symbol: "SOL", account: account(zeroPriceWideConfidence), oracleAuthority: authority });
  assert.equal(structural.ready, true);
});

test("Clock sysvar decoding uses the canonical unix timestamp offset", async () => {
  const { decodeClockUnixTimestamp } = await import(new URL("app/lib/solana-clock.ts", root));
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(1_789_744_750n, 32);
  const account = {
    data,
    owner: new PublicKey("Sysvar1111111111111111111111111111111111111"),
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
  assert.equal(decodeClockUnixTimestamp(account), 1_789_744_750);
  assert.throws(() => decodeClockUnixTimestamp({ ...account, data: Buffer.alloc(39) }), /invalid/);
  assert.throws(() => decodeClockUnixTimestamp({ ...account, owner: PublicKey.default }), /invalid/);
});
