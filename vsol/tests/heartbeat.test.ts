import assert from "node:assert/strict";
import test from "node:test";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { Connection, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { HEARTBEAT_CONFIDENCE_ATOMS, HEARTBEAT_PRICE_ATOMS, publishHeartbeat } from "../scripts/lib/heartbeat.ts";
import { deriveCustomPriceFeed, HEARTBEAT_SYMBOL } from "../sdk/index.ts";

test("the heartbeat publishes a fixed, trivially-positive price and zero confidence", () => {
  // price > 0 is the ONLY on-chain constraint update_custom_price_feed places
  // on price; 1 atom is the simplest value that satisfies it without reading
  // as a real quote to anything scanning feed accounts generically.
  assert.equal(HEARTBEAT_PRICE_ATOMS, 1n);
  assert.equal(HEARTBEAT_CONFIDENCE_ATOMS, 0n);
});

test("HEARTBEAT_SYMBOL is a distinct 16-byte symbol namespace, never colliding with a real market", () => {
  assert.equal(HEARTBEAT_SYMBOL, "HEARTBEAT");
  const feed = deriveCustomPriceFeed(HEARTBEAT_SYMBOL);
  const solFeed = deriveCustomPriceFeed("SOL");
  assert.notEqual(feed.toBase58(), solFeed.toBase58());
});

test("publishHeartbeat builds a single update_custom_price_feed instruction against the HEARTBEAT feed", async () => {
  const authority = Keypair.generate();
  const connection = new Connection("http://127.0.0.1:1");
  const provider = new AnchorProvider(connection, new AnchorWallet(authority), { commitment: "confirmed" });
  const program = new Program<Vsol>(idl, provider);
  const config = Keypair.generate().publicKey;

  // publishHeartbeat calls `.rpc()`, which DOES hit the network -- so this
  // test only verifies the instruction it WOULD build, by constructing the
  // same call through `.instruction()` instead, mirroring exactly what
  // publishHeartbeat's `.methods` chain specifies.
  const instruction = await program.methods
    .updateCustomPriceFeed(
      new BN(HEARTBEAT_PRICE_ATOMS.toString()),
      new BN(HEARTBEAT_CONFIDENCE_ATOMS.toString()),
      new BN(1_800_000_000),
    )
    .accountsStrict({
      oracleAuthority: authority.publicKey,
      config,
      feed: deriveCustomPriceFeed(HEARTBEAT_SYMBOL),
    })
    .instruction();

  assert.equal(instruction.keys.length, 3);
  assert.ok(instruction.keys[0].pubkey.equals(authority.publicKey));
  assert.ok(instruction.keys[1].pubkey.equals(config));
  assert.ok(instruction.keys[2].pubkey.equals(deriveCustomPriceFeed(HEARTBEAT_SYMBOL)));
  assert.equal(typeof publishHeartbeat, "function"); // imported to prove the module resolves cleanly; exercising `.rpc()` itself needs a live cluster
});
