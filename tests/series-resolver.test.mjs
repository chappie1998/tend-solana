import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildMarketAccountBuffer, stubConnection } from "./helpers/vsol-market-fixture.mjs";

// Unit tests for app/lib/series-resolver.ts, the source of the rolling series
// catalog.
//
// The module no longer derives a market address by formula. `strike` is
// hashed into the market id and is a LISTED ladder rung, so a grid slot maps
// to a LIST of markets, not one computable address -- resolution is now chain
// discovery. These tests therefore inject a stub connection (and a stub spot
// price) rather than hitting devnet, and assert the matching and
// at-the-money selection logic directly. The surviving pure derivation,
// `deriveVsolSeriesCandidate`, still takes an explicit strike and is tested
// as such.

const root = new URL("../", import.meta.url);

async function loadModules() {
  const [resolver, launchParams, vsol, sdk] = await Promise.all([
    import(new URL("app/lib/series-resolver.ts", root)),
    import(new URL("app/lib/launch-params.ts", root)),
    import(new URL("app/lib/vsol.ts", root)),
    import(new URL("vsol/sdk/index.ts", root)),
  ]);
  const accounts = await import(new URL("app/lib/vsol-market-accounts.ts", root));
  return { resolver, launchParams, vsol, sdk, accounts };
}

const STRIKE = 210_000_000n;

test("deriveVsolSeriesCandidate is deterministic: same symbol+code+clock+strike gives the same market and oracle PDA", async () => {
  const { resolver } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");
  const first = await resolver.deriveVsolSeriesCandidate("NVDA", "30D", now, STRIKE);
  const second = await resolver.deriveVsolSeriesCandidate("NVDA", "30D", now, STRIKE);
  assert.equal(first.marketKey.toBase58(), second.marketKey.toBase58());
  assert.equal(first.oracleKey.toBase58(), second.oracleKey.toBase58());
});

test("deriveVsolSeriesCandidate binds every series parameter, strike included: changing code, the clock, or the strike moves the market id", async () => {
  const { resolver } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");
  const baseline = await resolver.deriveVsolSeriesCandidate("NVDA", "30D", now, STRIKE);

  // A different expiry code targets a different grid boundary -> different expiry -> different id.
  const differentCode = await resolver.deriveVsolSeriesCandidate("NVDA", "7D", now, STRIKE);
  assert.notEqual(differentCode.marketKey.toBase58(), baseline.marketKey.toBase58());

  // Crossing a grid boundary for the SAME code must also move the market.
  const later = await resolver.deriveVsolSeriesCandidate("NVDA", "30D", now + 40 * 24 * 60 * 60 * 1000, STRIKE);
  assert.notEqual(later.marketKey.toBase58(), baseline.marketKey.toBase58());
  assert.ok(later.expiry > baseline.expiry);

  // And the strike itself is part of the id -- one ladder rung apart is a
  // DIFFERENT contract, not the same market at a different price.
  const otherStrike = await resolver.deriveVsolSeriesCandidate("NVDA", "30D", now, STRIKE + 5_000_000n);
  assert.notEqual(otherStrike.marketKey.toBase58(), baseline.marketKey.toBase58());
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

test("deriveVsolSeriesCandidate parity: the derived market matches an independent deriveMarketId call built from the shared launch-params constants", async () => {
  const { resolver, launchParams, vsol, sdk } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");

  for (const code of ["15M", "1H", "EOD", "7D", "30D"]) {
    const candidate = await resolver.deriveVsolSeriesCandidate("NVDA", code, now, STRIKE);

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
      // The strike is part of the id, so parity has to pin the same one the
      // candidate was derived at -- an explicit value on both sides, never a
      // default that could cancel itself out.
      strike: STRIKE,
    });
    const expectedMarket = sdk.deriveMarket(vsol.VSOL_CONFIG, expectedMarketId, vsol.VSOL_PROGRAM_ID);
    const expectedOracle = sdk.deriveOracle(expectedMarket, vsol.VSOL_PROGRAM_ID);

    assert.equal(candidate.marketKey.toBase58(), expectedMarket.toBase58(), `${code} market PDA must match the independent derivation`);
    assert.equal(candidate.oracleKey.toBase58(), expectedOracle.toBase58(), `${code} oracle PDA must match the independent derivation`);
    assert.equal(candidate.observationWindowSeconds, params.observationWindowSeconds);
    assert.equal(candidate.settlementGraceSeconds, params.settlementGraceSeconds);
    assert.equal(candidate.maxSettlementStalenessSeconds, params.maxSettlementStalenessSeconds);
    assert.equal(candidate.expiry, params.expiry);
    assert.equal(candidate.lastTradeAt, params.lastTradeAt);
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

test("resolveVsolSeriesCatalog and resolveAvailableVsolSeries never throw, and separate listed rungs from unlisted ones", async () => {
  const { resolver, launchParams, vsol, accounts } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");

  // Stub a chain that has listed exactly the NVDA rungs and nothing for TSLA.
  const entries = [];
  for (const code of ["15M", "1H", "EOD", "7D", "30D"]) {
    const params = launchParams.deriveLaunchSeriesParams(code, "NVDA", now);
    const candidate = await resolver.deriveVsolSeriesCandidate("NVDA", code, now, STRIKE);
    entries.push({
      address: candidate.marketKey,
      data: buildMarketAccountBuffer({
        discriminator: accounts.MARKET_ACCOUNT_DISCRIMINATOR,
        config: vsol.VSOL_CONFIG,
        settlementMint: vsol.VSOL_SETTLEMENT_MINT,
        oracle: candidate.oracleKey,
        symbol: "NVDA",
        priceScale: params.priceScale,
        expiry: params.expiry,
        observationWindowSeconds: params.observationWindowSeconds,
        settlementGraceSeconds: params.settlementGraceSeconds,
        maxConfidenceBps: params.maxConfidenceBps,
        pythFeedId: vsol.VSOL_PYTH_FEED_ID,
        maxSettlementStalenessSeconds: params.maxSettlementStalenessSeconds,
        strike: STRIKE,
      }),
    });
  }
  const deps = { connection: stubConnection(entries), fetchSpot: async () => 210 };

  const catalog = await resolver.resolveVsolSeriesCatalog(["NVDA", "TSLA"], now, deps);
  assert.equal(catalog.length, 10); // 5 codes x 2 symbols
  const nvdaEntries = catalog.filter((entry) => entry.symbol === "NVDA");
  const tslaEntries = catalog.filter((entry) => entry.symbol === "TSLA");
  assert.equal(nvdaEntries.length, 5);
  assert.equal(tslaEntries.length, 5);
  assert.ok(nvdaEntries.every((entry) => entry.available), "every listed NVDA rung must resolve");
  // Nothing was listed for TSLA, so every TSLA rung is unavailable -- with a
  // reason, never a throw.
  assert.ok(tslaEntries.every((entry) => !entry.available));
  assert.ok(tslaEntries.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0));

  const available = await resolver.resolveAvailableVsolSeries(["NVDA", "TSLA"], now, deps);
  assert.equal(available.length, 5);
  assert.ok(available.every((series) => series.marketKey && series.oracleKey));
  assert.ok(available.every((series) => series.strike === STRIKE), "the resolved series must carry the strike read back from chain");
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
