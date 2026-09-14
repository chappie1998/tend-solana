import assert from "node:assert/strict";
import test from "node:test";

// Pool-depth pre-check (app/api/quotes/route.ts): the UX-only gap this closes
// is a doomed quote that would revert on chain at fill time for exceeding the
// pool's utilization/position limits. checkVsolPoolDepth mirrors
// fill_pool_quote's on-chain gate (vsol/programs/vsol/src/lib.rs, using
// calculate_bps_limit from math.rs) EXACTLY -- same total_collateral
// derivation, same bps-limit rounding, same three requires in the same
// order -- so these tests pin that the TS and Rust formulas can never
// disagree at a rounding boundary, and that a quote sized to exceed depth is
// rejected with a usable "max fitting payout".
const root = new URL("../", import.meta.url);

async function loadServer() {
  return import(new URL("app/lib/vsol-server.ts", root));
}

test("calculateBpsLimit mirrors calculate_bps_limit in vsol/programs/vsol/src/math.rs exactly: floor(amount * bps / 10_000)", async () => {
  const { calculateBpsLimit } = await loadServer();
  // Pinned to math.rs's own unit test: calculate_bps_limit(10_000, 7_500) == 7_500.
  assert.equal(calculateBpsLimit(10_000n, 7_500), 7_500n);
  assert.equal(calculateBpsLimit(0n, 8_000), 0n);
  assert.equal(calculateBpsLimit(100n, 0), 0n);
  // Floors, never rounds up.
  assert.equal(calculateBpsLimit(3n, 3_333), 0n); // 3 * 3333 / 10000 = 0.9999 -> 0
  assert.equal(calculateBpsLimit(10_000n, 1), 1n); // exactly 1
  assert.equal(calculateBpsLimit(9_999n, 1), 0n); // 0.9999 -> 0
  // A wide (bigint) intermediate, matching the program's u128 checked_mul
  // before checked_div -- this would silently wrap or lose precision if
  // computed in a 64-bit-or-narrower type.
  const huge = 2n ** 60n;
  assert.equal(calculateBpsLimit(huge, 10_000), huge);
  assert.equal(calculateBpsLimit(huge, 5_000), huge / 2n);
  assert.throws(() => calculateBpsLimit(-1n, 100), RangeError);
  assert.throws(() => calculateBpsLimit(100n, -1), RangeError);
});

test("toPoolAtoms/fromPoolAtoms convert at the pool's on-chain 1e6 token scale and round-trip", async () => {
  const { toPoolAtoms, fromPoolAtoms } = await loadServer();
  assert.equal(toPoolAtoms(1_000), 1_000_000_000n);
  assert.equal(toPoolAtoms(0.000001), 1n);
  assert.equal(fromPoolAtoms(1_000_000_000n), 1_000);
  assert.equal(fromPoolAtoms(toPoolAtoms(2_500.5)), 2_500.5);
});

test("checkVsolPoolDepth accepts a quote comfortably within both limits", async () => {
  const { checkVsolPoolDepth, calculateBpsLimit } = await loadServer();
  const pool = {
    poolAssetsAtoms: 100_000_000_000n, // 100,000 tUSDC at 1e6 scale
    lockedCollateralAtoms: 0n,
    maxUtilizationBps: 8_000, // 80%
    maxPositionBps: 2_000, // 20%
  };
  const totalCollateral = pool.poolAssetsAtoms + pool.lockedCollateralAtoms;
  const utilizationLimit = calculateBpsLimit(totalCollateral, pool.maxUtilizationBps);
  const positionLimit = calculateBpsLimit(totalCollateral, pool.maxPositionBps);

  const ok = checkVsolPoolDepth(pool, 1_000_000_000n); // 1,000 tUSDC payout
  assert.equal(ok.ok, true);
  assert.equal(ok.utilizationLimitAtoms, utilizationLimit);
  assert.equal(ok.positionLimitAtoms, positionLimit);

  // Exactly AT the position limit still clears (fill_pool_quote uses <=).
  const atLimit = checkVsolPoolDepth(pool, positionLimit);
  assert.equal(atLimit.ok, true);
});

test("checkVsolPoolDepth rejects one atom past the per-position limit, and reports the exact max fitting payout", async () => {
  const { checkVsolPoolDepth, calculateBpsLimit } = await loadServer();
  const pool = {
    poolAssetsAtoms: 100_000_000_000n,
    lockedCollateralAtoms: 0n,
    maxUtilizationBps: 8_000,
    maxPositionBps: 2_000,
  };
  const positionLimit = calculateBpsLimit(pool.poolAssetsAtoms, pool.maxPositionBps);

  const overPosition = checkVsolPoolDepth(pool, positionLimit + 1n);
  assert.equal(overPosition.ok, false);
  assert.equal(overPosition.reason, "position");
  // Position cap binds tighter than the (much larger) utilization headroom
  // here, so the max fitting payout is exactly the position limit.
  assert.equal(overPosition.maxFittingPayoutAtoms, positionLimit);
});

test("checkVsolPoolDepth rejects a quote that would push locked collateral past the utilization limit", async () => {
  const { checkVsolPoolDepth, calculateBpsLimit } = await loadServer();
  // total_collateral (and so utilization_limit) is itself a function of
  // lockedCollateralAtoms, not just poolAssetsAtoms -- so this pool is
  // chosen to be self-consistent: at these two numbers, utilizationLimit
  // (recomputed from BOTH fields, exactly like fill_pool_quote) lands 10
  // atoms above lockedCollateralAtoms, isolating the utilization check with
  // an exact, known headroom.
  const pool = {
    poolAssetsAtoms: 1_000_000n,
    lockedCollateralAtoms: 999_980n,
    maxUtilizationBps: 5_000, // 50%
    maxPositionBps: 10_000, // 100% -- no separate position cap, isolates the utilization check
  };
  const totalCollateral = pool.poolAssetsAtoms + pool.lockedCollateralAtoms;
  const utilizationLimit = calculateBpsLimit(totalCollateral, pool.maxUtilizationBps);
  assert.equal(utilizationLimit - pool.lockedCollateralAtoms, 10n, "test setup: expected exactly 10 atoms of utilization headroom");

  const withinHeadroom = checkVsolPoolDepth(pool, 10n);
  assert.equal(withinHeadroom.ok, true);

  const overUtilization = checkVsolPoolDepth(pool, 11n);
  assert.equal(overUtilization.ok, false);
  assert.equal(overUtilization.reason, "utilization");
  assert.equal(overUtilization.maxFittingPayoutAtoms, 10n);
});

test("checkVsolPoolDepth's insufficient-writer-liquidity branch: a real finding -- unreachable as the FIRST-failing reason at any valid (<=100%) utilization bps", async () => {
  const { checkVsolPoolDepth, calculateBpsLimit } = await loadServer();
  // utilization_limit = floor(bps/10_000 * (poolAssets + locked)) <=
  // poolAssets + locked for any bps <= 10_000, so headroom
  // (= utilization_limit - locked) can never exceed poolAssets. That means
  // whenever poolAssets < maxPayoutAtoms, headroom < maxPayoutAtoms too, so
  // the utilization check ALWAYS fails at the same time as (or strictly
  // before) the raw-liquidity check -- at any bps a correctly configured
  // pool can actually hold (validate_pool_risk_limits in lib.rs caps
  // max_utilization_bps <= MAX_POOL_UTILIZATION_BPS, itself <= 10_000).
  // Confirmed here at the boundary (100%, locked = 0, so headroom == assets
  // exactly): the reported reason is "utilization", not
  // "insufficient_writer_liquidity", even though both conditions trip at
  // the identical payout.
  const boundaryPool = { poolAssetsAtoms: 5n, lockedCollateralAtoms: 0n, maxUtilizationBps: 10_000, maxPositionBps: 10_000 };
  const boundary = checkVsolPoolDepth(boundaryPool, 6n);
  assert.equal(boundary.ok, false);
  assert.equal(boundary.reason, "utilization");
  assert.equal(boundary.maxFittingPayoutAtoms, 5n);

  // Reaching "insufficient_writer_liquidity" as the reported reason at all
  // therefore requires bps > 10_000 -- an out-of-range pool snapshot no
  // validly configured pool can produce on chain. Exercised here purely to
  // confirm the branch itself is implemented correctly (defense-in-depth,
  // exactly mirroring why fill_pool_quote keeps the redundant on-chain
  // `pool.total_assets >= quote.max_payout` require even though the
  // utilization require above it already implies it for any valid bps).
  const pathologicalPool = { poolAssetsAtoms: 5n, lockedCollateralAtoms: 0n, maxUtilizationBps: 20_000, maxPositionBps: 20_000 };
  const utilizationLimit = calculateBpsLimit(pathologicalPool.poolAssetsAtoms, pathologicalPool.maxUtilizationBps);
  assert.ok(utilizationLimit > pathologicalPool.poolAssetsAtoms, "test setup: bps > 100% must push the limit above raw assets");
  const rejected = checkVsolPoolDepth(pathologicalPool, 6n);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "insufficient_writer_liquidity");
  assert.equal(rejected.maxFittingPayoutAtoms, 5n);

  const atLimit = checkVsolPoolDepth(pathologicalPool, 5n);
  assert.equal(atLimit.ok, true);
});

test("checkVsolPoolDepth's maxFittingPayoutAtoms is the tightest of all three on-chain constraints, whichever binds", async () => {
  const { checkVsolPoolDepth, calculateBpsLimit } = await loadServer();
  const pool = {
    poolAssetsAtoms: 1_000n,
    lockedCollateralAtoms: 200n,
    maxUtilizationBps: 5_000, // 50%
    maxPositionBps: 3_000, // 30%
  };
  const totalCollateral = pool.poolAssetsAtoms + pool.lockedCollateralAtoms; // 1,200
  const utilizationLimit = calculateBpsLimit(totalCollateral, pool.maxUtilizationBps); // 600
  const positionLimit = calculateBpsLimit(totalCollateral, pool.maxPositionBps); // 360
  const utilizationHeadroom = utilizationLimit - pool.lockedCollateralAtoms; // 400
  const expectedMax = [utilizationHeadroom, positionLimit, pool.poolAssetsAtoms].reduce((a, b) => (a < b ? a : b));

  const rejected = checkVsolPoolDepth(pool, expectedMax + 1n);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.maxFittingPayoutAtoms, expectedMax);

  const accepted = checkVsolPoolDepth(pool, expectedMax);
  assert.equal(accepted.ok, true);
});
