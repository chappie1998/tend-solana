import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Pure, chain-agnostic unit tests for app/lib/series-resolver.ts: the module
// that replaced the checked-in vsol/deployments/devnet.json `markets` array
// as the source of the rolling series catalog. No RPC calls are made here —
// resolveVsolSeries only computes candidate addresses; on-chain verification
// of those candidates is exercised separately (getVsolSeriesState).

const root = new URL("../", import.meta.url);

async function loadModules() {
  const [resolver, launchParams, vsol, sdk] = await Promise.all([
    import(new URL("app/lib/series-resolver.ts", root)),
    import(new URL("app/lib/launch-params.ts", root)),
    import(new URL("app/lib/vsol.ts", root)),
    import(new URL("vsol/sdk/index.ts", root)),
  ]);
  return { resolver, launchParams, vsol, sdk };
}

test("resolveVsolSeries is deterministic: same symbol+code+clock resolves to the same market and oracle PDA", async () => {
  const { resolver } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");
  const first = await resolver.resolveVsolSeries("NVDA", "30D", now);
  const second = await resolver.resolveVsolSeries("NVDA", "30D", now);
  assert.equal(first.available, true);
  assert.equal(second.available, true);
  assert.equal(first.series.marketKey.toBase58(), second.series.marketKey.toBase58());
  assert.equal(first.series.oracleKey.toBase58(), second.series.oracleKey.toBase58());
});

test("resolveVsolSeries binds every series parameter: changing code, symbol, or the clock moves the market id", async () => {
  const { resolver } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");
  const baseline = await resolver.resolveVsolSeries("NVDA", "30D", now);
  assert.equal(baseline.available, true);

  // A different expiry code targets a different grid boundary -> different expiry -> different id.
  const differentCode = await resolver.resolveVsolSeries("NVDA", "7D", now);
  assert.equal(differentCode.available, true);
  assert.notEqual(differentCode.series.marketKey.toBase58(), baseline.series.marketKey.toBase58());

  // Crossing a grid boundary for the SAME code (a later `now`) must also move
  // the resolved market, since the expiry baked into the market id changes.
  const later = await resolver.resolveVsolSeries("NVDA", "30D", now + 40 * 24 * 60 * 60 * 1000);
  assert.equal(later.available, true);
  assert.notEqual(later.series.marketKey.toBase58(), baseline.series.marketKey.toBase58());
  assert.ok(later.series.expiry > baseline.series.expiry);
});

test("launch-params re-exports the exact SDK-shared policy constants (no re-declared literals to drift)", async () => {
  // app/lib/launch-params.ts and vsol/scripts/bootstrap.ts (via
  // vsol/scripts/keeper.ts) both feed these into deriveMarketId. If they ever
  // diverge, the app derives different market addresses than the keeper
  // mints and the UI silently sees nothing -- this test exists to make that
  // failure loud instead of silent.
  const { launchParams, sdk } = await loadModules();

  assert.equal(launchParams.LAUNCH_OBSERVATION_WINDOW_SECONDS, sdk.MARKET_OBSERVATION_WINDOW_SECONDS);
  assert.equal(launchParams.LAUNCH_SETTLEMENT_GRACE_SECONDS, sdk.MARKET_SETTLEMENT_GRACE_SECONDS);
  assert.equal(launchParams.LAUNCH_MAX_CONFIDENCE_BPS, sdk.MARKET_MAX_CONFIDENCE_BPS);
  assert.equal(launchParams.LAUNCH_PRICE_SCALE, sdk.PRICE_SCALE);
  assert.equal(launchParams.LAUNCH_MAX_SETTLEMENT_STALENESS_SECONDS, sdk.MARKET_MAX_SETTLEMENT_STALENESS_SECONDS);

  // Pin the actual values too, so an edit to the SDK constants themselves
  // (not just a re-introduced local literal) is also caught here.
  assert.equal(sdk.MARKET_OBSERVATION_WINDOW_SECONDS, 30);
  assert.equal(sdk.MARKET_SETTLEMENT_GRACE_SECONDS, 900);
  assert.equal(sdk.MARKET_MAX_CONFIDENCE_BPS, 500);
  assert.equal(sdk.PRICE_SCALE, 1_000_000n);
  assert.equal(sdk.MARKET_MAX_SETTLEMENT_STALENESS_SECONDS, 86_400);
});

test("resolveVsolSeries parity: the derived market matches an independent deriveMarketId call built from the shared launch-params constants", async () => {
  const { resolver, launchParams, vsol, sdk } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");

  for (const code of ["15M", "1H", "EOD", "7D", "30D"]) {
    const resolution = await resolver.resolveVsolSeries("NVDA", code, now);
    assert.equal(resolution.available, true, `${code} should resolve for NVDA`);

    // Independently recompute the params and market id using the exact same
    // shared constants module (app/lib/launch-params.ts) the resolver itself
    // is supposed to consume. If a future edit makes series-resolver.ts drift
    // from these constants (e.g. hardcoding a different confidence bps or
    // price scale), this assertion fails loudly.
    const params = launchParams.deriveLaunchSeriesParams(code, "NVDA", now);
    assert.equal(params.observationWindowSeconds, launchParams.LAUNCH_OBSERVATION_WINDOW_SECONDS);
    assert.equal(params.settlementGraceSeconds, launchParams.LAUNCH_SETTLEMENT_GRACE_SECONDS);
    assert.equal(params.maxConfidenceBps, launchParams.LAUNCH_MAX_CONFIDENCE_BPS);
    assert.equal(params.priceScale, launchParams.LAUNCH_PRICE_SCALE);
    assert.equal(params.maxSettlementStalenessSeconds, launchParams.LAUNCH_MAX_SETTLEMENT_STALENESS_SECONDS);

    const expectedMarketId = await sdk.deriveMarketId({
      pythFeedId: Buffer.from(vsol.VSOL_PYTH_FEED_ID, "hex"),
      settlementMint: vsol.VSOL_SETTLEMENT_MINT,
      expiry: BigInt(params.expiry),
      observationWindowSeconds: params.observationWindowSeconds,
      settlementGraceSeconds: params.settlementGraceSeconds,
      priceScale: params.priceScale,
      maxConfidenceBps: params.maxConfidenceBps,
      symbol: sdk.symbolBytes(params.symbol),
      maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
      // TODO(v2-strike-ladder): resolveVsolSeries has no real listed strike
      // to give either -- see series-resolver.ts's module-level TODO. This
      // must use the exact same known-not-trustworthy placeholder the
      // resolver itself defaults to (PLACEHOLDER_STRIKE_DO_NOT_TRUST) so
      // this parity check still means what it says: "the resolver's
      // internal derivation matches an independent one," not "the
      // placeholder happens to cancel out."
      strike: resolver.PLACEHOLDER_STRIKE_DO_NOT_TRUST,
    });
    const expectedMarket = sdk.deriveMarket(vsol.VSOL_CONFIG, expectedMarketId, vsol.VSOL_PROGRAM_ID);
    const expectedOracle = sdk.deriveOracle(expectedMarket, vsol.VSOL_PROGRAM_ID);

    assert.equal(resolution.series.marketKey.toBase58(), expectedMarket.toBase58(), `${code} market PDA must match the independent derivation`);
    assert.equal(resolution.series.oracleKey.toBase58(), expectedOracle.toBase58(), `${code} oracle PDA must match the independent derivation`);
    assert.equal(resolution.series.observationWindowSeconds, params.observationWindowSeconds);
    assert.equal(resolution.series.settlementGraceSeconds, params.settlementGraceSeconds);
    assert.equal(resolution.series.maxSettlementStalenessSeconds, params.maxSettlementStalenessSeconds);
    assert.equal(resolution.series.expiry, params.expiry);
    assert.equal(resolution.series.lastTradeAt, params.lastTradeAt);
  }
});

test("a code with no viable on-chain market resolves to unavailable with a clear reason, never throws", async () => {
  const { resolver } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");

  // TSLA has no verified intraday Pyth feed (see app/lib/expiries.ts), so an
  // intraday code must resolve to unavailable rather than deriving a market
  // (or throwing) for a symbol the grid does not support intraday.
  const resolution = await resolver.resolveVsolSeries("TSLA", "15M", now);
  assert.equal(resolution.available, false);
  assert.match(resolution.reason, /intraday/i);
  assert.equal(resolution.symbol, "TSLA");
  assert.equal(resolution.code, "15M");

  // Case-insensitive symbol handling, matching vsolSeries's historical contract.
  const lowercase = await resolver.resolveVsolSeries("tsla", "1H", now);
  assert.equal(lowercase.available, false);
  assert.equal(lowercase.symbol, "TSLA");
});

test("resolveVsolSeriesCatalog and resolveAvailableVsolSeries never throw and separate available rungs from unavailable ones", async () => {
  const { resolver } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");

  const catalog = await resolver.resolveVsolSeriesCatalog(["NVDA", "TSLA"], now);
  assert.equal(catalog.length, 10); // 5 codes x 2 symbols
  const nvdaEntries = catalog.filter((entry) => entry.symbol === "NVDA");
  const tslaEntries = catalog.filter((entry) => entry.symbol === "TSLA");
  assert.equal(nvdaEntries.length, 5);
  assert.equal(tslaEntries.length, 5);
  assert.ok(nvdaEntries.every((entry) => entry.available));
  // TSLA has no intraday feed, so at least the intraday codes must be unavailable.
  assert.ok(tslaEntries.some((entry) => !entry.available));

  const available = await resolver.resolveAvailableVsolSeries(["NVDA", "TSLA"], now);
  assert.ok(available.length >= 5);
  assert.ok(available.every((series) => series.marketKey && series.oracleKey));
});

test("callers resolve series from chain, not the retired manifest lookup, and isolate per-rung failures", async () => {
  const [server, quotesRoute, sendRoute, chainPositions, chainCatalog, vsolSource] = await Promise.all([
    readFile(new URL("app/lib/vsol-server.ts", root), "utf8"),
    readFile(new URL("app/api/quotes/route.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/send/route.ts", root), "utf8"),
    readFile(new URL("app/lib/chain-positions.ts", root), "utf8"),
    readFile(new URL("app/lib/chain-catalog.ts", root), "utf8"),
    readFile(new URL("app/lib/vsol.ts", root), "utf8"),
  ]);

  // The retired manifest-backed catalog (VSOL_SERIES / vsolSeries) must be
  // fully gone from every former consumer — only chain resolution remains.
  assert.doesNotMatch(vsolSource, /VSOL_SERIES|export function vsolSeries/);
  assert.doesNotMatch(server, /VSOL_SERIES/);
  assert.doesNotMatch(chainPositions, /VSOL_SERIES/);
  assert.doesNotMatch(chainCatalog, /VSOL_SERIES/);
  assert.doesNotMatch(quotesRoute, /vsolSeries\(/);

  assert.match(server, /resolveVsolSeriesCatalog/);
  assert.match(server, /resolveAvailableVsolSeries/);
  assert.match(chainPositions, /resolveAvailableVsolSeries/);
  assert.match(chainCatalog, /resolveAvailableVsolSeries/);
  assert.match(quotesRoute, /resolveVsolSeries/);
  assert.match(sendRoute, /await inspectVsolFillTransaction/);

  // A not-yet-minted market must surface as an honest, non-crashing reason —
  // never an unhandled throw and never a silent fallback to a stale entry.
  assert.match(server, /This series has not been minted yet\./);
  // getVsolSeriesStates must catch per-rung failures rather than letting a
  // single bad/unminted rung reject the whole Promise.all batch.
  assert.match(server, /try\s*{\s*return await getVsolSeriesState/);

  // The manifest keeps its other roles (program id, config, pool, mints):
  // these exports must still be present and still manifest-sourced.
  assert.match(vsolSource, /export const VSOL_PROGRAM_ID = new PublicKey\(deployment\.programId\)/);
  assert.match(vsolSource, /export const VSOL_CONFIG = new PublicKey\(deployment\.config\)/);
  assert.match(vsolSource, /export const VSOL_LIQUIDITY/);
  assert.match(vsolSource, /export const VSOL_SETTLEMENT_MINT = new PublicKey\(deployment\.settlementMint\)/);
});
