import assert from "node:assert/strict";
import test from "node:test";
import {
  AddressLookupTableAccount,
  Ed25519Program,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import nacl from "tweetnacl";

// Moving VSOL fill transactions to v0 (with an address lookup table) is what
// lets both the plain 2-instruction fill (~1154 bytes) and the 4-instruction
// mint-on-demand shape (~1469 bytes, previously rejected outright by
// buildVsolQuoteTransaction's size guard -- see tests/mint-on-demand.test.mjs)
// fit under Solana's 1232-byte packet limit. These tests exercise the real
// composer/inspector from app/lib/vsol-server.ts with a stub
// AddressLookupTableAccount -- no ALT needs to exist onchain for the pure
// composition/size tests below, since compileToV0Message only ever reads a
// lookup table's `.key` and `.state.addresses`.

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
  const available = await resolver.resolveAvailableVsolSeries(["NVDA"]);
  const series = available.find((entry) => entry.code === "30D");
  assert.ok(series, "NVDA/30D must resolve to a candidate series");
  return series;
}

function buildQuote(nonce) {
  return {
    nonce,
    direction: 0,
    strike: 250_000_000n,
    width: 20_000_000n,
    premium: 1_500_000n,
    maxPayout: 5_000_000n,
    quoteExpiry: BigInt(Math.floor(Date.now() / 1000) + 30),
  };
}

// Mirrors the real, fixed-width pool-quote message every production fill
// signs (app/lib/vsol-server.ts's private poolQuoteMessage, mirrored in
// vsol/sdk's poolQuoteMessage) -- realistic size, throwaway signer (the
// inspector never cross-checks this instruction's embedded pubkey against
// the fill's quote_authority, matching the existing mint-on-demand tests).
function buildEd25519Instruction({ sdk, vsol, pool, market, buyer, quote }) {
  const signer = Keypair.generate();
  const message = sdk.poolQuoteMessage({
    domainSeparator: new Uint8Array(32),
    domainVersion: 1,
    config: vsol.VSOL_CONFIG,
    pool,
    market,
    buyer,
    quoteAuthority: signer.publicKey,
    quote,
  });
  const signature = nacl.sign.detached(message, signer.secretKey);
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: signer.publicKey.toBytes(),
    message,
    signature,
  });
}

async function buildPlainFillInstructions({ server, vsol, sdk, series, buyer, nonce }) {
  const liquidity = vsol.VSOL_LIQUIDITY;
  assert.ok(liquidity, "the manifest must publish a V2 liquidity pool for this test to be meaningful");
  const quote = buildQuote(nonce);
  const signatureInstruction = buildEd25519Instruction({ sdk, vsol, pool: liquidity.poolKey, market: series.marketKey, buyer: buyer.publicKey, quote });
  const poolMarket = sdk.deriveLiquidityPoolMarket(liquidity.poolKey, series.marketKey, vsol.VSOL_PROGRAM_ID);
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
  return { instructions: [signatureInstruction, fillInstruction], position, market: series.marketKey, pool: liquidity.poolKey };
}

async function buildMintAndFillInstructions({ server, vsol, sdk, series, buyer, poolManager, nonce }) {
  const plain = await buildPlainFillInstructions({ server, vsol, sdk, series, buyer, nonce });
  const liquidity = vsol.VSOL_LIQUIDITY;
  const created = await server.buildCreateMarketInstruction({
    creator: buyer.publicKey,
    series,
    expected: { market: series.marketKey, oracle: series.oracleKey },
  });
  const poolMarket = sdk.deriveLiquidityPoolMarket(liquidity.poolKey, series.marketKey, vsol.VSOL_PROGRAM_ID);
  const authorizeData = Buffer.concat([server.encodeI64(BigInt(series.lastTradeAt)), Buffer.from([1])]);
  const authorizeInstruction = server.buildVsolIdlInstruction("set_liquidity_pool_market", {
    manager: poolManager.publicKey,
    config: vsol.VSOL_CONFIG,
    pool: liquidity.poolKey,
    market: series.marketKey,
    pool_market: poolMarket,
    system_program: SystemProgram.programId,
  }, authorizeData);
  return { ...plain, instructions: [created.instruction, authorizeInstruction, ...plain.instructions] };
}

// Collects every account key referenced anywhere in the instruction set
// (including program ids) into a stub lookup table. compileToV0Message only
// ever extracts the subset that is actually eligible (non-signer, and not
// itself invoked as a program id) -- everything else in this list is simply
// ignored, so over-including here is harmless and keeps this helper generic.
function collectCandidateLookupAddresses(instructions) {
  const seen = new Map();
  for (const instruction of instructions) {
    if (!seen.has(instruction.programId.toBase58())) seen.set(instruction.programId.toBase58(), instruction.programId);
    for (const key of instruction.keys) {
      if (!seen.has(key.pubkey.toBase58())) seen.set(key.pubkey.toBase58(), key.pubkey);
    }
  }
  return [...seen.values()];
}

function buildStubLookupTable(key, addresses) {
  return new AddressLookupTableAccount({
    key,
    state: {
      deactivationSlot: 18446744073709551615n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses,
    },
  });
}

test("MEASURED FINDING: composeVsolFillTransaction with a stub lookup table brings the plain 2-instruction fill under Solana's 1232-byte packet limit", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { instructions } = await buildPlainFillInstructions({ server, vsol, sdk, series, buyer, nonce: 111_111_111n });
  const stubTable = buildStubLookupTable(Keypair.generate().publicKey, collectCandidateLookupAddresses(instructions));

  const legacySize = server.serializeVsolTransaction(server.composeVsolFillTransaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
    instructions,
    lookupTableAccount: null,
  })).length;

  const versionedTransaction = server.composeVsolFillTransaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
    instructions,
    lookupTableAccount: stubTable,
  });
  assert.ok(versionedTransaction instanceof VersionedTransaction, "supplying a lookup table must compile a v0 transaction");
  const versionedSize = server.serializeVsolTransaction(versionedTransaction).length;

  assert.ok(legacySize <= 1232, `sanity check: the plain legacy fill (${legacySize} bytes) was already known to fit`);
  assert.ok(versionedSize < legacySize, `the v0 encoding (${versionedSize} bytes) must be smaller than the legacy encoding (${legacySize} bytes)`);
  assert.ok(versionedSize <= 1232, `MEASURED: v0 plain fill is ${versionedSize} bytes -- must stay under 1232`);
});

test("MEASURED FINDING: composeVsolFillTransaction with a stub lookup table brings the 4-instruction mint-on-demand fill under Solana's 1232-byte packet limit (previously 1469 bytes, over budget -- see tests/mint-on-demand.test.mjs)", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();
  const poolManager = Keypair.generate();

  const { instructions } = await buildMintAndFillInstructions({ server, vsol, sdk, series, buyer, poolManager, nonce: 222_222_222n });
  const stubTable = buildStubLookupTable(Keypair.generate().publicKey, collectCandidateLookupAddresses(instructions));

  const legacyTransaction = new Transaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
  }).add(...instructions);
  // Transaction.serialize() throws ("Transaction too large") once a legacy
  // transaction exceeds 1232 bytes -- exactly like tests/mint-on-demand.test.mjs,
  // measure via compileMessage() directly instead of serialize().
  const compiledLegacy = legacyTransaction.compileMessage();
  const legacySize = 1 + compiledLegacy.header.numRequiredSignatures * 64 + compiledLegacy.serialize().length;
  // Matches the previously-measured, structurally-fixed size from
  // tests/mint-on-demand.test.mjs -- confirms this test builds the exact
  // same 4-instruction shape before checking what the ALT does to it.
  assert.equal(legacySize, 1469, `expected the unmodified legacy mint-and-fill size to match the known 1469-byte measurement, got ${legacySize}`);

  const versionedTransaction = server.composeVsolFillTransaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
    instructions,
    lookupTableAccount: stubTable,
  });
  assert.ok(versionedTransaction instanceof VersionedTransaction);
  const versionedSize = server.serializeVsolTransaction(versionedTransaction).length;

  assert.ok(versionedSize < legacySize, `the v0 encoding (${versionedSize} bytes) must be smaller than the legacy encoding (${legacySize} bytes)`);
  assert.ok(versionedSize <= 1232, `MEASURED: v0 mint-on-demand fill is ${versionedSize} bytes (down from ${legacySize}) -- must fit under 1232`);
});

test("resolveSignedVsolFillTransaction rejects a v0 transaction whose addressTableLookups reference a table other than the manifest-pinned one", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { instructions } = await buildPlainFillInstructions({ server, vsol, sdk, series, buyer, nonce: 333_333_333n });
  const foreignTableKey = Keypair.generate().publicKey;
  assert.ok(!foreignTableKey.equals(vsol.VSOL_ADDRESS_LOOKUP_TABLE), "the foreign table's key must actually differ from the pinned one");
  const foreignTable = buildStubLookupTable(foreignTableKey, collectCandidateLookupAddresses(instructions));

  const versionedTransaction = server.composeVsolFillTransaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
    instructions,
    lookupTableAccount: foreignTable,
  });
  versionedTransaction.sign([buyer]);
  const raw = Buffer.from(versionedTransaction.serialize());

  // A connection whose getAddressLookupTable must never be reached: the
  // foreign-table check has to fail closed before any resolution is
  // attempted, since resolving indices against the client's own named table
  // is exactly the vulnerability this pin exists to prevent.
  const connectionThatMustNotBeQueried = {
    getAddressLookupTable: async () => {
      throw new Error("SECURITY REGRESSION: resolveSignedVsolFillTransaction queried a non-pinned lookup table");
    },
  };

  const resolved = await server.resolveSignedVsolFillTransaction(raw, connectionThatMustNotBeQueried);
  assert.equal(resolved, null, "a v0 transaction naming a foreign lookup table must be rejected outright");
});

test("resolveSignedVsolFillTransaction and inspectVsolFillTransaction accept and fully validate a correct v0 fill compiled against the pinned lookup table", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  assert.ok(vsol.VSOL_ADDRESS_LOOKUP_TABLE, "this deployment must publish a pinned ALT for this test to be meaningful");
  const buyer = Keypair.generate();

  const { instructions, position, market, pool } = await buildPlainFillInstructions({ server, vsol, sdk, series, buyer, nonce: 444_444_444n });
  const pinnedTable = buildStubLookupTable(vsol.VSOL_ADDRESS_LOOKUP_TABLE, collectCandidateLookupAddresses(instructions));

  const versionedTransaction = server.composeVsolFillTransaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
    instructions,
    lookupTableAccount: pinnedTable,
  });
  assert.ok(versionedTransaction.message.addressTableLookups.length > 0, "the composed transaction must actually reference the pinned table");
  versionedTransaction.sign([buyer]);
  const raw = Buffer.from(versionedTransaction.serialize());

  let queriedAddress = null;
  const connection = {
    getAddressLookupTable: async (address) => {
      queriedAddress = address;
      return { value: pinnedTable };
    },
  };

  const resolved = await server.resolveSignedVsolFillTransaction(raw, connection);
  assert.ok(resolved, "a correctly-signed v0 fill referencing only the pinned table must resolve");
  assert.ok(queriedAddress.equals(vsol.VSOL_ADDRESS_LOOKUP_TABLE), "resolution must fetch exactly the manifest-pinned table");
  assert.equal(resolved.feePayer.toBase58(), buyer.publicKey.toBase58());
  assert.equal(resolved.instructions.length, 2, "resolved v0 instructions must match the original 2-instruction plain-fill shape");

  const inspected = await server.inspectVsolFillTransaction(resolved);
  assert.ok(inspected, "a well-formed, fully-resolved v0 fill must be accepted by the same strict inspector as a legacy fill");
  assert.equal(inspected.buyer.toBase58(), buyer.publicKey.toBase58());
  assert.equal(inspected.position.toBase58(), position.toBase58());
  assert.equal(inspected.market.toBase58(), market.toBase58());
  assert.equal(inspected.pool.toBase58(), pool.toBase58());
});

test("resolveSignedVsolFillTransaction and inspectVsolFillTransaction still accept a legacy fill transaction end to end (the ALT is an addition, never a requirement)", async () => {
  const { server, resolver, vsol, sdk } = await loadModules();
  const series = await resolveLiveNvda30D(resolver);
  const buyer = Keypair.generate();

  const { instructions, position, market, pool } = await buildPlainFillInstructions({ server, vsol, sdk, series, buyer, nonce: 555_555_555n });
  const legacyTransaction = new Transaction({
    feePayer: buyer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
  }).add(...instructions);
  legacyTransaction.partialSign(buyer);
  const raw = legacyTransaction.serialize({ requireAllSignatures: true, verifySignatures: true });

  // Legacy resolution must never even look at a lookup table -- confirmed
  // both structurally (this connection stub would throw if queried) and by
  // the resulting inspection succeeding.
  const connectionThatMustNotBeQueried = {
    getAddressLookupTable: async () => {
      throw new Error("the legacy path must never fetch a lookup table, published or not");
    },
  };

  const resolved = await server.resolveSignedVsolFillTransaction(raw, connectionThatMustNotBeQueried);
  assert.ok(resolved, "a correctly-signed legacy fill must still resolve exactly as before the ALT existed");
  const inspected = await server.inspectVsolFillTransaction(resolved);
  assert.ok(inspected);
  assert.equal(inspected.position.toBase58(), position.toBase58());
  assert.equal(inspected.market.toBase58(), market.toBase58());
  assert.equal(inspected.pool.toBase58(), pool.toBase58());

  // Structural guarantee that this isn't an accident of this particular
  // stub: the legacy branch of resolveSignedVsolFillTransaction is defined
  // entirely in terms of Transaction.from/verifySignatures, with no
  // reference to VSOL_ADDRESS_LOOKUP_TABLE or getVsolAddressLookupTableAccount
  // anywhere in that branch.
  const source = await (await import("node:fs/promises")).readFile(new URL("app/lib/vsol-server.ts", root), "utf8");
  const legacyBranch = source.match(/if \(!isVersionedVsolTransactionBytes\(raw\)\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(legacyBranch, "resolveSignedVsolFillTransaction's legacy branch must be present");
  assert.doesNotMatch(legacyBranch, /VSOL_ADDRESS_LOOKUP_TABLE|getVsolAddressLookupTableAccount/);
});

test("signSerializedSolanaTransaction detects and signs both legacy and v0 payloads", async () => {
  const wallet = await import(new URL("app/lib/solana-wallet.ts", root));

  const payer = Keypair.generate();
  const destination = Keypair.generate().publicKey;
  const instruction = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: destination, lamports: 1 });
  const stubProvider = {
    signTransaction: async (transaction) => {
      if (transaction instanceof VersionedTransaction) transaction.sign([payer]);
      else transaction.partialSign(payer);
      return transaction;
    },
  };

  // Legacy round trip.
  const legacyUnsigned = new Transaction({
    feePayer: payer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000_000,
  }).add(instruction);
  const legacyEncoded = Buffer.from(
    legacyUnsigned.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString("base64");
  const legacySignedEncoded = await wallet.signSerializedSolanaTransaction(legacyEncoded, stubProvider);
  const legacyRoundTrip = Transaction.from(Buffer.from(legacySignedEncoded, "base64"));
  assert.ok(legacyRoundTrip.verifySignatures(), "the legacy round trip must be fully and validly signed");

  // v0 round trip.
  const v0Message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction],
  }).compileToV0Message([]);
  const versionedUnsigned = new VersionedTransaction(v0Message);
  const versionedEncoded = Buffer.from(versionedUnsigned.serialize()).toString("base64");
  const versionedSignedEncoded = await wallet.signSerializedSolanaTransaction(versionedEncoded, stubProvider);
  const versionedRoundTrip = VersionedTransaction.deserialize(Buffer.from(versionedSignedEncoded, "base64"));
  assert.equal(versionedRoundTrip.message.version, 0, "the v0 round trip must stay a versioned (not legacy) transaction");
  const messageBytes = versionedRoundTrip.message.serialize();
  assert.ok(
    nacl.sign.detached.verify(messageBytes, versionedRoundTrip.signatures[0], payer.publicKey.toBytes()),
    "the v0 round trip must be validly signed by the payer",
  );
});
