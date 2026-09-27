import assert from "node:assert/strict";
import test from "node:test";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { buildPublishAndCaptureInstructions } from "../scripts/lib/publish-capture-transaction.ts";
import { VSOL_PROGRAM_ID } from "../sdk/index.ts";

// `program.methods....instruction()` performs no RPC call: every account
// below is supplied explicitly via `accountsStrict`, so Anchor has nothing to
// resolve or simulate against the network. This lets the transaction shape
// be verified fully offline against an intentionally unreachable connection.
function offlineProgram(): { program: Program<Vsol>; authority: Keypair } {
  const authority = Keypair.generate();
  const connection = new Connection("http://127.0.0.1:1");
  const provider = new AnchorProvider(connection, new AnchorWallet(authority), { commitment: "confirmed" });
  return { program: new Program<Vsol>(idl, provider), authority };
}

test("buildPublishAndCaptureInstructions returns exactly two instructions, in order: update_custom_price_feed then capture_custom_settlement_observation", async () => {
  const { program, authority } = offlineProgram();
  const config = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;
  const feed = Keypair.generate().publicKey;
  const observation = Keypair.generate().publicKey;

  const instructions = await buildPublishAndCaptureInstructions({
    program,
    accounts: { oracleAuthority: authority.publicKey, config, market, feed, observation },
    price: 103_500_000n,
    confidence: 12_000n,
    observedAt: 1_800_000_000,
  });

  assert.equal(instructions.length, 2);
  const [updateIx, captureIx] = instructions;

  assert.ok(updateIx.programId.equals(VSOL_PROGRAM_ID));
  assert.ok(captureIx.programId.equals(VSOL_PROGRAM_ID));

  // update_custom_price_feed: exactly 3 accounts (oracleAuthority, config, feed).
  assert.equal(updateIx.keys.length, 3);
  assert.ok(updateIx.keys[0].pubkey.equals(authority.publicKey));
  assert.ok(updateIx.keys[1].pubkey.equals(config));
  assert.ok(updateIx.keys[2].pubkey.equals(feed));
  // 8-byte discriminator + u64 price + u64 confidence + i64 observed_at.
  assert.equal(updateIx.data.length, 32);

  // capture_custom_settlement_observation: exactly 6 accounts, in the order
  // CaptureCustomSettlementObservation declares them in
  // vsol/programs/vsol/src/lib.rs.
  assert.equal(captureIx.keys.length, 6);
  assert.ok(captureIx.keys[0].pubkey.equals(authority.publicKey));
  assert.ok(captureIx.keys[1].pubkey.equals(config));
  assert.ok(captureIx.keys[2].pubkey.equals(market));
  assert.ok(captureIx.keys[3].pubkey.equals(feed));
  assert.ok(captureIx.keys[4].pubkey.equals(observation));
  assert.ok(captureIx.keys[5].pubkey.equals(SystemProgram.programId));
  // 8-byte discriminator, no args.
  assert.equal(captureIx.data.length, 8);
});

test("buildPublishAndCaptureInstructions binds a DIFFERENT market/feed/observation to a different transaction, never reusing the first market's accounts", async () => {
  const { program, authority } = offlineProgram();
  const config = Keypair.generate().publicKey;

  const first = await buildPublishAndCaptureInstructions({
    program,
    accounts: {
      oracleAuthority: authority.publicKey,
      config,
      market: Keypair.generate().publicKey,
      feed: Keypair.generate().publicKey,
      observation: Keypair.generate().publicKey,
    },
    price: 100n,
    confidence: 0n,
    observedAt: 1,
  });
  const second = await buildPublishAndCaptureInstructions({
    program,
    accounts: {
      oracleAuthority: authority.publicKey,
      config,
      market: Keypair.generate().publicKey,
      feed: Keypair.generate().publicKey,
      observation: Keypair.generate().publicKey,
    },
    price: 200n,
    confidence: 0n,
    observedAt: 2,
  });

  assert.notEqual(first[1].keys[2].pubkey.toBase58(), second[1].keys[2].pubkey.toBase58());
  assert.notEqual(first[1].keys[3].pubkey.toBase58(), second[1].keys[3].pubkey.toBase58());
  assert.notEqual(first[1].keys[4].pubkey.toBase58(), second[1].keys[4].pubkey.toBase58());
});

test("PublicKey import sanity: the program id embedded in every built instruction matches the deployed VSOL program", async () => {
  const { program, authority } = offlineProgram();
  const [updateIx] = await buildPublishAndCaptureInstructions({
    program,
    accounts: {
      oracleAuthority: authority.publicKey,
      config: Keypair.generate().publicKey,
      market: Keypair.generate().publicKey,
      feed: Keypair.generate().publicKey,
      observation: Keypair.generate().publicKey,
    },
    price: 1n,
    confidence: 0n,
    observedAt: 0,
  });
  assert.equal(updateIx.programId.toBase58(), new PublicKey(VSOL_PROGRAM_ID).toBase58());
});
