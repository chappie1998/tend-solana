import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ALT_DEACTIVATION_COOLDOWN_SLOTS,
  ALT_NOT_DEACTIVATED_SENTINEL,
  isLookupTableReadyToClose,
  isLookupTableSafeToDeactivate,
  latestLiveMarketOutliveDeadline,
  liveMarketFillAddresses,
  type ManifestMarketEntry,
  missingAddresses,
  ROTATION_ADDRESS_THRESHOLD,
  shouldRotateLookupTable,
} from "../scripts/lib/lookup-table.ts";

// Address lookup tables are append-only with a hard 256-address cap and no
// way to delete individual entries -- these tests cover the pure decision
// logic scripts/create-lookup-table.ts and scripts/keeper.ts both share for
// rotating to a fresh table before the cap is hit, and for safely retiring
// (deactivating, then closing) the table that gets rotated out.

function marketEntry(overrides: Partial<ManifestMarketEntry> & { code: string; expiry: number }): ManifestMarketEntry {
  return {
    address: Keypair.generate().publicKey.toBase58(),
    oracle: Keypair.generate().publicKey.toBase58(),
    settlementGraceSeconds: 900,
    maxSettlementStalenessSeconds: 86_400,
    ...overrides,
  };
}

test("shouldRotateLookupTable: false below the threshold, true at and above it", () => {
  assert.equal(shouldRotateLookupTable(0), false);
  assert.equal(shouldRotateLookupTable(ROTATION_ADDRESS_THRESHOLD - 1), false);
  assert.equal(shouldRotateLookupTable(ROTATION_ADDRESS_THRESHOLD), true);
  assert.equal(shouldRotateLookupTable(ROTATION_ADDRESS_THRESHOLD + 1), true);
  assert.equal(shouldRotateLookupTable(256), true);
});

test("shouldRotateLookupTable respects a custom threshold", () => {
  assert.equal(shouldRotateLookupTable(10, 20), false);
  assert.equal(shouldRotateLookupTable(20, 20), true);
});

test("liveMarketFillAddresses includes only unexpired markets' market+oracle pairs", () => {
  const now = 1_000_000;
  const live15m = marketEntry({ code: "15M", expiry: now + 900 });
  const liveEod = marketEntry({ code: "EOD", expiry: now + 86_400 });
  const expired = marketEntry({ code: "expired", expiry: now - 1 });
  const expiringNow = marketEntry({ code: "at-now", expiry: now }); // expiry === now is NOT live (strictly greater required)

  const addresses = liveMarketFillAddresses([live15m, liveEod, expired, expiringNow], now);
  const addressSet = new Set(addresses.map((a) => a.toBase58()));

  assert.ok(addressSet.has(live15m.address) && addressSet.has(live15m.oracle), "a live market's market+oracle must both be included");
  assert.ok(addressSet.has(liveEod.address) && addressSet.has(liveEod.oracle));
  assert.ok(!addressSet.has(expired.address) && !addressSet.has(expired.oracle), "an already-expired market must be excluded");
  assert.ok(!addressSet.has(expiringNow.address), "a market expiring exactly at `now` is no longer live and must be excluded");
  assert.equal(addresses.length, 4, "exactly two live markets contribute two addresses each");
});

test("liveMarketFillAddresses returns an empty list when nothing is live", () => {
  const now = 1_000_000;
  const expired = marketEntry({ code: "expired", expiry: now - 10 });
  assert.deepEqual(liveMarketFillAddresses([expired], now), []);
});

test("a freshly rotated table's seed set (stable + liveMarketFillAddresses) contains every live market and excludes expired ones", () => {
  const now = 1_000_000;
  const stableAddresses = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const live = [marketEntry({ code: "1H", expiry: now + 3_600 }), marketEntry({ code: "7D", expiry: now + 604_800 })];
  const expired = marketEntry({ code: "gone", expiry: now - 1 });

  const seed = [...stableAddresses, ...liveMarketFillAddresses([...live, expired], now)];
  const seedSet = new Set(seed.map((a) => a.toBase58()));

  for (const stable of stableAddresses) assert.ok(seedSet.has(stable.toBase58()), "every stable address must be present");
  for (const market of live) {
    assert.ok(seedSet.has(market.address) && seedSet.has(market.oracle), `${market.code} market+oracle must be present`);
  }
  assert.ok(!seedSet.has(expired.address) && !seedSet.has(expired.oracle), "the expired market must not be seeded");
  // Nothing is missing relative to itself -- the seed set is exactly what a
  // fresh table's first extend call would add (missingAddresses against an
  // empty existing set returns everything).
  assert.equal(missingAddresses([], seed).length, seed.length);
});

test("latestLiveMarketOutliveDeadline is the max settlement deadline (expiry + grace + staleness) across live markets, not the bare expiry", () => {
  const now = 1_000_000;
  const soon = marketEntry({ code: "15M", expiry: now + 900, settlementGraceSeconds: 900, maxSettlementStalenessSeconds: 86_400 });
  const later = marketEntry({ code: "30D", expiry: now + 2_592_000, settlementGraceSeconds: 900, maxSettlementStalenessSeconds: 86_400 });
  const expired = marketEntry({ code: "gone", expiry: now - 1, settlementGraceSeconds: 900, maxSettlementStalenessSeconds: 86_400 });

  const deadline = latestLiveMarketOutliveDeadline([soon, later, expired], now);
  assert.equal(deadline, later.expiry + 900 + 86_400, "must be the latest live market's full settlement deadline");
  assert.ok(deadline > later.expiry, "the deadline must include the settlement grace/staleness margin, not just bare expiry");
});

test("latestLiveMarketOutliveDeadline falls back to `now` when nothing is live (nothing left to outlive)", () => {
  const now = 1_000_000;
  const expired = marketEntry({ code: "gone", expiry: now - 5 });
  assert.equal(latestLiveMarketOutliveDeadline([expired], now), now);
  assert.equal(latestLiveMarketOutliveDeadline([], now), now);
});

test("isLookupTableSafeToDeactivate is false until the cluster clock passes outliveExpiry, then true", () => {
  const retiring = { outliveExpiry: 2_000_000 };
  assert.equal(isLookupTableSafeToDeactivate(retiring, 1_999_999), false);
  assert.equal(isLookupTableSafeToDeactivate(retiring, 2_000_000), false, "exactly at the deadline is not yet past it");
  assert.equal(isLookupTableSafeToDeactivate(retiring, 2_000_001), true);
});

test("isLookupTableReadyToClose enforces the mandatory onchain deactivation cooldown", () => {
  const deactivationSlot = 500_000n;
  assert.equal(isLookupTableReadyToClose(deactivationSlot, 500_000), false, "no slots have elapsed yet");
  assert.equal(
    isLookupTableReadyToClose(deactivationSlot, Number(deactivationSlot) + ALT_DEACTIVATION_COOLDOWN_SLOTS - 1),
    false,
    "one slot short of the cooldown must still be rejected",
  );
  assert.equal(
    isLookupTableReadyToClose(deactivationSlot, Number(deactivationSlot) + ALT_DEACTIVATION_COOLDOWN_SLOTS),
    true,
    "exactly at the cooldown boundary must be accepted",
  );
  assert.equal(isLookupTableReadyToClose(deactivationSlot, deactivationSlot + BigInt(ALT_DEACTIVATION_COOLDOWN_SLOTS) + 1_000n), true);
});

test("isLookupTableReadyToClose accepts a bigint current slot identically to a number", () => {
  const deactivationSlot = 100n;
  const readySlot = deactivationSlot + BigInt(ALT_DEACTIVATION_COOLDOWN_SLOTS);
  assert.equal(isLookupTableReadyToClose(deactivationSlot, readySlot), true);
  assert.equal(isLookupTableReadyToClose(deactivationSlot, Number(readySlot)), true);
});

test("ALT_NOT_DEACTIVATED_SENTINEL matches @solana/web3.js's AddressLookupTableAccount.isActive() sentinel (u64::MAX)", () => {
  assert.equal(ALT_NOT_DEACTIVATED_SENTINEL, 0xffffffffffffffffn);
});

test("sanity: PublicKey round-trips through liveMarketFillAddresses (guards against silently constructing invalid keys)", () => {
  const now = 0;
  const market = marketEntry({ code: "EOD", expiry: now + 1 });
  const [address, oracle] = liveMarketFillAddresses([market], now);
  assert.ok(address instanceof PublicKey && oracle instanceof PublicKey);
  assert.equal(address.toBase58(), market.address);
  assert.equal(oracle.toBase58(), market.oracle);
});
