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

test("custom oracle readiness validates owner, publisher, scale, price and age", async () => {
  const { assessCustomPriceFeed } = await import(new URL("app/lib/custom-oracle-readiness.ts", root));
  const { VSOL_PROGRAM_ID } = await import(new URL("app/lib/vsol.ts", root));
  const authority = new PublicKey(Buffer.alloc(32, 7));
  const account = (data, owner = VSOL_PROGRAM_ID) => ({ data, owner, executable: false, lamports: 1, rentEpoch: 0 });

  const healthy = assessCustomPriceFeed({ symbol: "NVDA", account: account(feedData({ publisher: authority })), oracleAuthority: authority, now: 1_020 });
  assert.equal(healthy.ready, true);
  assert.equal(healthy.source, "Hyperliquid xyz mark");
  assert.equal(healthy.ageSeconds, 20);

  assert.equal(assessCustomPriceFeed({ symbol: "NVDA", account: null, oracleAuthority: authority, now: 1_020 }).ready, false);
  assert.match(assessCustomPriceFeed({ symbol: "NVDA", account: account(feedData({ publisher: authority }), PublicKey.default), oracleAuthority: authority, now: 1_020 }).reason, /wrong owner/);
  assert.match(assessCustomPriceFeed({ symbol: "NVDA", account: account(feedData({ publisher: PublicKey.default })), oracleAuthority: authority, now: 1_020 }).reason, /publisher/);
  assert.match(assessCustomPriceFeed({ symbol: "NVDA", account: account(feedData({ publisher: authority, scale: 10n })), oracleAuthority: authority, now: 1_020 }).reason, /scale/);
  assert.match(assessCustomPriceFeed({ symbol: "NVDA", account: account(feedData({ publisher: authority, price: 0n })), oracleAuthority: authority, now: 1_020 }).reason, /positive/);
  assert.equal(assessCustomPriceFeed({ symbol: "NVDA", account: account(feedData({ publisher: authority, confidence: 5_000_000n })), oracleAuthority: authority, now: 1_020 }).ready, true);
  assert.match(assessCustomPriceFeed({ symbol: "NVDA", account: account(feedData({ publisher: authority, confidence: 5_000_001n })), oracleAuthority: authority, now: 1_020 }).reason, /confidence/);
  assert.match(assessCustomPriceFeed({ symbol: "NVDA", account: account(feedData({ publisher: authority })), oracleAuthority: authority, now: 1_031 }).reason, /31s old/);
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
