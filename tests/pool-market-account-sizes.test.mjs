import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";

// Pool bindings exist at TWO byte lengths on devnet: 82 (created before the
// 2026-09-28 program upgrade) and 86 (carrying the `open_positions` counter).
// A reader pinned to one size fails on the other -- which broke executable
// quotes in production the moment the first new binding was listed.
const root = new URL("../", import.meta.url);

async function binding(size, { openPositions = 0 } = {}) {
  const { POOL_MARKET_ACCOUNT_DISCRIMINATOR } = await import(new URL("app/lib/vsol-server.ts", root));
  const data = Buffer.alloc(size);
  POOL_MARKET_ACCOUNT_DISCRIMINATOR.copy(data, 0);
  new PublicKey("11111111111111111111111111111112").toBuffer().copy(data, 9);
  new PublicKey("SysvarC1ock11111111111111111111111111111111").toBuffer().copy(data, 41);
  data.writeBigInt64LE(1_790_000_000n, 73);
  data[81] = 1;
  if (size === 86) data.writeUInt32LE(openPositions, 82);
  return data;
}

test("the app decodes BOTH pool-binding sizes, and only the new one carries a count", async () => {
  const { decodePoolMarketAccount } = await import(new URL("app/lib/vsol-server.ts", root));
  const legacy = decodePoolMarketAccount(await binding(82));
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.lastTradeAt, 1_790_000_000);
  assert.equal(legacy.openPositions, null, "a legacy binding's count is the UNKNOWN sentinel, not zero");
  const current = decodePoolMarketAccount(await binding(86, { openPositions: 3 }));
  assert.equal(current.openPositions, 3);
  assert.throws(() => decodePoolMarketAccount(Buffer.alloc(84)), /size is invalid/);
});

test("the catalog finds pool bindings by discriminator, never by a single dataSize", async () => {
  const source = await readFile(new URL("app/lib/chain-catalog.ts", root), "utf8");
  assert.match(source, /POOL_MARKET_ACCOUNT_DISCRIMINATOR/);
  assert.doesNotMatch(source, /POOL_MARKET_ACCOUNT_SIZE\b/, "a dataSize filter hides every binding of the other size");
});

test("scripts read pool bindings through the size-tolerant reader, not Anchor's decoder", async () => {
  for (const file of ["vsol/scripts/keeper.ts", "vsol/scripts/bootstrap.ts"]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /account\.liquidityPoolMarket\.fetch/, `${file}: Anchor cannot decode a legacy 82-byte binding`);
    assert.match(source, /fetchPoolMarketBinding\(/);
  }
});
