import assert from "node:assert/strict";
import test from "node:test";
import {
  Ed25519Program,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import nacl from "tweetnacl";

// Pure, offline tests for the mint-on-demand fill flow: a buyer's first fill
// on a not-yet-minted rung mints (create_market) and authorizes
// (set_liquidity_pool_market) its own series ahead of the existing Ed25519 +
// fill_pool_quote pair, so a keeper no longer has to pre-mint every grid rung.
// These tests exercise the real encoders/inspector from app/lib/vsol-server.ts
// against synthetic-but-correctly-shaped instructions -- no RPC calls are made
// (buildCreateMarketInstruction and the inspector's PDA/byte comparisons are
// pure; only account *values* are chosen here for the test, not derived from
// a live cluster).

const root = new URL("../", import.meta.url);

async function loadModules() {
  const [server, resolver, vsol, sdk] = await Promise.all([
    import(new URL("app/lib/vsol-server.ts", root)),
    import(new URL("app/lib/series-resolver.ts", root)),
    import(new URL("app/lib/vsol.ts", root)),
    import(new URL("vsol/sdk/index.ts", root)),
  ]);
  return { server, resolver, vsol, sdk };
}

async function resolveLiveNvda30D(resolver) {
  const available = await resolver.resolveAvailableVsolSeries(["SOL"]);
  const series = available.find((entry) => entry.code === "30D");
  assert.ok(series, "SOL/30D must resolve to a candidate series");
  return series;
}

function buildQuote() {
  return {
    nonce: 123_456_789n,
    direction: 0,
    strike: 250_000_000n,
    width: 20_000_000n,
    premium: 1_500_000n,
    maxPayout: 5_000_000n,
    quoteExpiry: BigInt(Math.floor(Date.now() / 1000) + 30),
  };
}

function buildEd25519Instruction({ realisticMessage = false, sdk, vsol, pool, market, buyer, quote } = {}) {
  const signer = Keypair.generate();
  // The inspector only checks this instruction's program id (matching the
  // already-shipped plain-fill inspector's behavior) -- its embedded content
  // is not cross-checked against the fill's quote_authority, so a throwaway
  // signer is fine even where the *message* is production-shaped.
  const message = realisticMessage
    // The real, fixed-width pool-quote message every production fill signs
    // (app/lib/vsol-server.ts's private poolQuoteMessage mirrors this byte
    // layout exactly) -- always exactly this size, regardless of symbol,
    // expiry, or amount, since every field is fixed-width.
    ? sdk.poolQuoteMessage({
      domainSeparator: new Uint8Array(32),
      domainVersion: 1,
      config: vsol.VSOL_CONFIG,
      pool,
      market,
      buyer,
      quoteAuthority: signer.publicKey,
      quote,
    })
    : Buffer.from("mint-on-demand-test-message-payload-0123456789");
  const signature = nacl.sign.detached(message, signer.secretKey);
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: signer.publicKey.toBytes(),
    message,
    signature,
  });
}

/**
 * Builds a fully-valid 4-instruction mint-and-fill transaction (or an
 * intentionally corrupted variant, via `overrides`) so each rejection test
 * only has to describe what it changes.
 */
async function buildMintAndFillTransaction({ server, vsol, sdk, series, buyer, overrides = {} }) {
  const liquidity = vsol.VSOL_LIQUIDITY;
  assert.ok(liquidity, "the manifest must publish a V2 liquidity pool for this test to be meaningful");

  const created = await server.buildCreateMarketInstruction({
    creator: buyer.publicKey,
    series,
    expected: { market: series.marketKey, oracle: series.oracleKey },
  });
  let createInstruction = created.instruction;
  if (overrides.corruptCreateMarketData) {
    const data = Buffer.from(createInstruction.data);
    // Flip a byte inside the encoded `expiry` field (offset 8 (disc) + 32
    // (market_id) + 32 (underlying mint) + 16 (symbol) + 8 (price scale) = 96)
    // -- simulates a buyer trying to mint the series on different terms.
    data[96] ^= 0xff;
    createInstruction = new TransactionInstruction({
      programId: createInstruction.programId,
      keys: createInstruction.keys,
      data,
    });
  }

  const poolMarket = sdk.deriveLiquidityPoolMarket(liquidity.poolKey, series.marketKey, vsol.VSOL_PROGRAM_ID);
  const authorizeData = Buffer.concat([server.encodeI64(BigInt(series.lastTradeAt)), Buffer.from([1])]);
  const authorizeInstruction = server.buildVsolIdlInstruction("set_liquidity_pool_market", {
    manager: overrides.authorizeManager ?? liquidity.managerKey,
    config: vsol.VSOL_CONFIG,
    pool: overrides.authorizePool ?? liquidity.poolKey,
    market: overrides.authorizeMarket ?? series.marketKey,
    pool_market: poolMarket,
    system_program: SystemProgram.programId,
  }, authorizeData);

  const quote = buildQuote();
  const signatureInstruction = buildEd25519Instruction({
    realisticMessage: true,
    sdk,
    vsol,
    pool: liquidity.poolKey,
    market: series.marketKey,
    buyer: buyer.publicKey,
    quote,
  });
  const nonceRecord = sdk.derivePoolNonce(liquidity.poolKey, liquidity.quoteAuthorityKey, quote.nonce, vsol.VSOL_PROGRAM_ID);
  const position = sdk.derivePoolPosition(nonceRecord, vsol.VSOL_PROGRAM_ID);
  const positionVault = sdk.derivePoolPositionVault(position, vsol.VSOL_PROGRAM_ID);
  const buyerSource = getAssociatedTokenAddressSync(vsol.VSOL_SETTLEMENT_MINT, buyer.publicKey);
  const quoteData = Buffer.concat([
    server.encodeU64(quote.nonce),
    Buffer.from([quote.direction]),
    server.encodeU64(quote.strike),
    server.encodeU64(quote.width),
    server.encodeU64(quote.premium),
    server.encodeU64(quote.maxPayout),
    server.encodeI64(quote.quoteExpiry),
  ]);
  const fillInstruction = server.buildVsolIdlInstruction("fill_pool_quote", {
    buyer: buyer.publicKey,
    quote_authority: liquidity.quoteAuthorityKey,
    config: vsol.VSOL_CONFIG,
    pool: liquidity.poolKey,
    market: series.marketKey,
    pool_market: poolMarket,
    settlement_mint: vsol.VSOL_SETTLEMENT_MINT,
    pool_token: liquidity.assetVaultKey,
    buyer_source: buyerSource,
    nonce_record: nonceRecord,
    position,
    position_vault: positionVault,
    eligibility: vsol.VSOL_PROGRAM_ID,
    instructions_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  }, quoteData);

  const instructions = overrides.instructions ?? [createInstruction, authorizeInstruction, signatureInstruction, fillInstruction];
  const transaction = new Transaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
  }).add(...instructions);
  return { transaction, createInstruction, authorizeInstruction, signatureInstruction, fillInstruction };
}

// Solana's Transaction.serialize() throws ("Transaction too large") rather
// than returning bytes once a legacy transaction exceeds the 1232-byte packet
// limit, so an honest measurement (including of an over-budget transaction)
// has to go through compileMessage() directly instead.
function measureTransactionBytes(transaction) {
  const compiled = transaction.compileMessage();
  const messageBytes = compiled.serialize();
  // 1-byte compact-array length for <=127 signatures (true for 1-2 signers here) + one 64-byte slot per required signature + the message itself.
  return 1 + compiled.header.numRequiredSignatures * 64 + messageBytes.length;
}

test("MEASURED FINDING: the composed mint-on-demand transaction (create_market + set_liquidity_pool_market + Ed25519 + fill_pool_quote) does NOT fit under Solana's 1232-byte packet limit -- buildVsolQuoteTransaction must (and does) fail closed instead of shipping it", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { transaction, signatureInstruction } = await buildMintAndFillTransaction({ server, vsol, sdk, series, buyer });
  const size = measureTransactionBytes(transaction);

  // Every field in every one of these four instructions is fixed-width (no
  // variable-length strings or vectors), so this size is deterministic --
  // identical for every symbol, expiry code, and order size. This is a real,
  // structural overage, not a rounding/edge-case artifact: the 283-byte real
  // pool-quote message (see app/lib/vsol-server.ts's private poolQuoteMessage,
  // mirrored in vsol/sdk's poolQuoteMessage) costs 395 bytes once wrapped in
  // the Ed25519 native-program instruction format, and the extra
  // create_market (158 data + 7 accounts -- 150 plus the conditional-token
  // `strike: u64` appended to CreateMarketArgs, see
  // vsol/programs/vsol/src/lib.rs) + set_liquidity_pool_market (17 data + 6
  // accounts) instructions add the rest on top of an already-large plain
  // fill (~1154 bytes with the real message).
  assert.equal(signatureInstruction.data.length, 395, "the real Ed25519 instruction wrapping the 283-byte pool-quote message is a fixed 395 bytes");
  assert.ok(
    size > 1232,
    `composed mint-on-demand transaction is only ${size} bytes -- expected it to exceed 1232 given fixed-width encoding; if this ever shrinks below the limit, buildVsolQuoteTransaction's size guard (and this comment) should be revisited`,
  );
  assert.equal(size, 1477, `composed mint-on-demand transaction size drifted to ${size} bytes (previously measured 1477, after the conditional-token strike field added 8 bytes to create_market's data) -- re-verify whether it now fits and update the fail-closed guard/report accordingly`);

  // buildVsolQuoteTransaction's own guard (MAX_TRANSACTION_BYTES = 1232, see
  // app/lib/vsol-server.ts) must reject exactly this size rather than sign
  // and ship it -- confirm the guard's threshold is the same 1232 this test
  // measures against, so the two can never silently drift apart.
  const source = await (await import("node:fs/promises")).readFile(new URL("app/lib/vsol-server.ts", root), "utf8");
  assert.match(source, /const MAX_TRANSACTION_BYTES = 1232;/);
  assert.match(source, /if \(serialized\.length > MAX_TRANSACTION_BYTES\)/);
  assert.match(source, /error\.name = "VsolTransactionTooLarge"/);

  // For contrast: today's already-shipped plain 2-instruction fill (no mint),
  // using this same real message, still fits comfortably under the limit --
  // the size guard only ever needs to fire for the mint-on-demand branch.
  const plain = new Transaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
  }).add(signatureInstruction, (await buildMintAndFillTransaction({ server, vsol, sdk, series, buyer })).fillInstruction);
  assert.ok(measureTransactionBytes(plain) <= 1232, "the ordinary (already-minted) 2-instruction fill must keep fitting");
});

test("inspectVsolFillTransaction accepts the valid 4-instruction mint-and-fill shape", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { transaction } = await buildMintAndFillTransaction({ server, vsol, sdk, series, buyer });
  const inspected = await server.inspectVsolFillTransaction(transaction);
  assert.ok(inspected, "a well-formed mint-and-fill transaction must be accepted");
  assert.equal(inspected.buyer.toBase58(), buyer.publicKey.toBase58());
  assert.equal(inspected.market.toBase58(), series.marketKey.toBase58());
  assert.equal(inspected.pool.toBase58(), vsol.VSOL_LIQUIDITY.poolKey.toBase58());
});

test("inspectVsolFillTransaction rejects the four instructions out of order", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { createInstruction, authorizeInstruction, signatureInstruction, fillInstruction } =
    await buildMintAndFillTransaction({ server, vsol, sdk, series, buyer });
  // Swap create_market and set_liquidity_pool_market.
  const { transaction } = await buildMintAndFillTransaction({
    server, vsol, sdk, series, buyer,
    overrides: { instructions: [authorizeInstruction, createInstruction, signatureInstruction, fillInstruction] },
  });
  assert.equal(await server.inspectVsolFillTransaction(transaction), null);
});

test("inspectVsolFillTransaction rejects a create_market instruction whose args diverge from the resolved grid parameters", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { transaction } = await buildMintAndFillTransaction({
    server, vsol, sdk, series, buyer,
    overrides: { corruptCreateMarketData: true },
  });
  assert.equal(
    await server.inspectVsolFillTransaction(transaction),
    null,
    "a buyer must not be able to mint a market on terms other than the exact resolved grid parameters",
  );
});

test("inspectVsolFillTransaction rejects a set_liquidity_pool_market binding a different pool", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();
  const wrongPool = Keypair.generate().publicKey;

  const { transaction } = await buildMintAndFillTransaction({
    server, vsol, sdk, series, buyer,
    overrides: { authorizePool: wrongPool },
  });
  assert.equal(await server.inspectVsolFillTransaction(transaction), null);
});

test("inspectVsolFillTransaction rejects a set_liquidity_pool_market binding a different market", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();
  const wrongMarket = Keypair.generate().publicKey;

  const { transaction } = await buildMintAndFillTransaction({
    server, vsol, sdk, series, buyer,
    overrides: { authorizeMarket: wrongMarket },
  });
  assert.equal(await server.inspectVsolFillTransaction(transaction), null);
});

test("inspectVsolFillTransaction rejects a transaction missing an instruction (3 of 4)", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { createInstruction, signatureInstruction, fillInstruction } =
    await buildMintAndFillTransaction({ server, vsol, sdk, series, buyer });
  const { transaction } = await buildMintAndFillTransaction({
    server, vsol, sdk, series, buyer,
    overrides: { instructions: [createInstruction, signatureInstruction, fillInstruction] },
  });
  assert.equal(await server.inspectVsolFillTransaction(transaction), null);
});

test("inspectVsolFillTransaction rejects a transaction with an extra instruction (5 of 4)", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { createInstruction, authorizeInstruction, signatureInstruction, fillInstruction } =
    await buildMintAndFillTransaction({ server, vsol, sdk, series, buyer });
  const extra = buildEd25519Instruction();
  const { transaction } = await buildMintAndFillTransaction({
    server, vsol, sdk, series, buyer,
    overrides: { instructions: [createInstruction, authorizeInstruction, extra, signatureInstruction, fillInstruction] },
  });
  assert.equal(await server.inspectVsolFillTransaction(transaction), null);
});

test("vsolPoolManager fails closed with a clear message when VSOL_POOL_MANAGER_SECRET_KEY is absent, and rejects a mismatched key", async () => {
  const { server } = await loadModules();
  const original = process.env.VSOL_POOL_MANAGER_SECRET_KEY;
  try {
    delete process.env.VSOL_POOL_MANAGER_SECRET_KEY;
    assert.throws(() => server.vsolPoolManager(), /VSOL_POOL_MANAGER_SECRET_KEY is not configured/);

    const wrongKeypair = Keypair.generate();
    process.env.VSOL_POOL_MANAGER_SECRET_KEY = JSON.stringify(Array.from(wrongKeypair.secretKey));
    assert.throws(() => server.vsolPoolManager(), /does not match the published V2 liquidity pool/);
  } finally {
    if (original === undefined) delete process.env.VSOL_POOL_MANAGER_SECRET_KEY;
    else process.env.VSOL_POOL_MANAGER_SECRET_KEY = original;
  }
});

test("buildVsolQuoteTransaction wraps a missing/mismatched pool manager key into an honest, distinctly-named fail-closed error for the mint-on-demand path", async () => {
  const server = await import(new URL("app/lib/vsol-server.ts", root));
  const source = await (await import("node:fs/promises")).readFile(new URL("app/lib/vsol-server.ts", root), "utf8");
  // vsolPoolManager() is only ever reached from listVsolSeriesOnChain, which
  // buildVsolQuoteTransaction calls only inside the `seriesState.mintOnDemand`
  // branch -- so ordinary fills on already-listed series never call it, and
  // any failure there is re-thrown as a clearly-named, honest error rather
  // than silently proceeding without pool-manager authorization.
  // Runs unconditionally BEFORE the state read: the states it repairs (an
  // unlisted rung, and a half-listed one whose authorization never landed)
  // are exactly the ones that read rejects, so reading first would 503 the
  // quote before the repair could be attempted. It is a no-op otherwise.
  assert.match(source, /await listVsolSeriesOnChain\(series, connection\);\n\n  const \[core, seriesState\]/);
  assert.match(source, /poolManager = vsolPoolManager\(\)/);
  assert.match(source, /Listing this series is unavailable: \$\{message\}/);
  assert.match(source, /wrapped\.name = "VsolPoolManagerUnavailable"/);
  assert.ok(typeof server.buildVsolQuoteTransaction === "function");
});

// --- the not-yet-minted case ------------------------------------------------
//
// Every test above resolves an ALREADY-LISTED series (resolveLiveNvda30D), so
// they exercise the mint-and-fill SHAPE but never its premise: that the market
// does not exist on chain yet. That gap hid a real bug --
// inspectVsolFillTransaction matched the signed market against
// resolveAvailableVsolSeries (discovery) alone, which misses by construction
// for a market being minted by the very transaction under inspection, so every
// genuine mint-and-fill was rejected. These two tests pin the fallback that
// makes the branch reachable.

test("findVsolSeriesCandidateForMarket resolves a market that chain discovery cannot see, and rejects one off the grid", async () => {
  const { resolver, sdk } = await loadModules();
  const now = Date.parse("2026-07-21T14:00:00Z");
  const spot = 210;
  const deps = { fetchSpot: async () => spot };

  // The rung a brand-new SOL 15M listing would bind to right now. Nothing is
  // listed here -- this address exists only as a prediction.
  const strike = sdk.ladderStrike(BigInt(Math.round(spot * Number(sdk.PRICE_SCALE))), sdk.STRIKE_LADDER_STEP);
  const candidate = await resolver.deriveVsolSeriesCandidate("SOL", "15M", now, strike);

  const found = await resolver.findVsolSeriesCandidateForMarket(["SOL"], candidate.marketKey, now, deps);
  assert.ok(found, "the grid's own would-be candidate must be resolvable by its predicted market pubkey");
  assert.equal(found.marketKey.toBase58(), candidate.marketKey.toBase58());
  assert.equal(found.code, "15M");
  assert.equal(found.strike, strike);

  // An address that is not any grid slot's candidate must NOT resolve -- this
  // fallback widens what verification accepts, so it has to stay tight.
  const offGrid = await resolver.deriveVsolSeriesCandidate("SOL", "15M", now, strike + 1n);
  assert.equal(
    await resolver.findVsolSeriesCandidateForMarket(["SOL"], offGrid.marketKey, now, deps),
    null,
    "a market one atom off the ladder rung is not a grid candidate and must be rejected",
  );
});

test("inspectVsolFillTransaction's mint-and-fill branch falls back to the grid candidate when discovery misses", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("app/lib/vsol-server.ts", root), "utf8");
  const branch = source.slice(source.indexOf("if (isVsolMintAndFillTransaction(transaction))"));

  // Discovery alone cannot verify a market that does not exist yet. If this
  // fallback is ever dropped, mint-on-fill silently stops working: quotes are
  // issued and then every submission is rejected.
  assert.match(branch, /findVsolSeriesCandidateForMarket\(allMarketSymbols\(\), market\)/);
  // And it must remain a FALLBACK, not a replacement -- an already-listed
  // market has to verify against the real chain state first.
  assert.match(branch, /resolveAvailableVsolSeries\(allMarketSymbols\(\)\)/);
});

test("an unlisted rung is listed in its OWN server-signed transaction, keeping the buyer's fill at two instructions", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("app/lib/vsol-server.ts", root), "utf8");

  // The bug this pins: folding create_market + set_liquidity_pool_market into
  // the BUYER's fill made a 4-instruction transaction that measured 1265 bytes
  // against the real published lookup table -- 33 over the 1232-byte packet
  // limit -- so every 15M/1H/EOD quote failed closed and those rungs could
  // never trade. Extending the table cannot fix it: 7 of the 8 uncovered
  // static keys are per-series, per-trade or per-user.
  //
  // So the listing is hoisted into its own server-signed transaction and the
  // buyer keeps the plain 2-instruction fill that has always fit.
  assert.match(source, /instructions: \[signatureInstruction, fillInstruction\],/);
  assert.doesNotMatch(source, /instructions: \[\.\.\.mintInstructions/);
  assert.match(source, /async function listVsolSeriesOnChain\(/);

  // The listing must stay atomic — a market created without its pool-market
  // authorization is a rung that exists but can never be quoted.
  const listing = source.slice(source.indexOf("async function listVsolSeriesOnChain("));
  assert.match(listing, /\.add\(\.\.\.instructions\)/);
  // Each half is repaired independently, so a HALF-listed rung is fixable too.
  assert.match(listing, /const needsMarket = !marketAccount;/);
  assert.match(listing, /const needsAuthorization = !poolMarketAccount;/);
  // But authorization is only ever CREATED, never re-sent: a pool_market that
  // exists with enabled=false is a deliberate pool decision, and re-sending
  // set_liquidity_pool_market with enabled=true would silently override it.
  assert.doesNotMatch(listing, /poolMarketAccount && .*enabled/);

  // Idempotency must be decided by READING the chain, never by matching the
  // error text: two concurrent quotes on the same unlisted rung race, and the
  // loser's "already in use" is success — but a genuine failure must not be.
  assert.match(listing, /getMultipleAccountsInfo\(\[series\.marketKey, poolMarketKey\], "confirmed"\)/);
  assert.match(listing, /const listed = market\?\.owner\.equals\(VSOL_PROGRAM_ID\) && poolMarket\?\.owner\.equals\(VSOL_PROGRAM_ID\);/);
  assert.match(listing, /if \(!listed\) throw error;/);

  // Availability and the reason must move together, so the catalog can never
  // advertise a rung the quote path would refuse.
  assert.match(source, /const MINT_ON_FILL_IS_EXECUTABLE = (true|false);/);
  assert.match(source, /available: MINT_ON_FILL_IS_EXECUTABLE,/);

  // The wiring that makes these rungs reachable at all must stay in place.
  assert.match(source, /resolveOrPlanVsolSeriesCatalog/);
  assert.match(source, /findVsolSeriesCandidateForMarket\(allMarketSymbols\(\), market\)/);
  // And the fail-closed size guard remains the backstop.
  assert.match(source, /VsolTransactionTooLarge/);
  assert.match(source, /const MAX_TRANSACTION_BYTES = 1232;/);
});
