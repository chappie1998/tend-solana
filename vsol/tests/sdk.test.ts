import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  calculatePayout,
  deriveConfig,
  deriveNonce,
  derivePosition,
  derivePositionVault,
  quoteMessage,
  type Quote,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";

const quote: Quote = {
  nonce: 7n,
  direction: 0,
  strike: 100_000_000n,
  width: 20_000_000n,
  premium: 1_000_000n,
  maxPayout: 5_000_000n,
  quoteExpiry: 1_900_000_000n,
};

test("quote serialization is fixed-width and domain-separated", () => {
  const message = quoteMessage({
    domainSeparator: new Uint8Array(32).fill(9),
    domainVersion: 1,
    config: new PublicKey("11111111111111111111111111111111"),
    market: new PublicKey("SysvarC1ock11111111111111111111111111111111"),
    buyer: new PublicKey("SysvarRent111111111111111111111111111111111"),
    maker: VSOL_PROGRAM_ID,
    quote,
  });
  assert.equal(message.length, 251);
  assert.equal(message.subarray(0, 8).toString("ascii"), "VSOLRFQ1");
});

test("nonce and position PDAs are deterministic and one-shot", () => {
  const config = deriveConfig();
  const maker = new PublicKey("SysvarRent111111111111111111111111111111111");
  const nonce = deriveNonce(config, maker, 42n);
  assert.equal(deriveNonce(config, maker, 42n).toBase58(), nonce.toBase58());
  const position = derivePosition(nonce);
  assert.notEqual(position.toBase58(), derivePositionVault(position).toBase58());
});

test("buyer payout is directional, linear, and capped", () => {
  assert.equal(calculatePayout(quote, 90_000_000n), 0n);
  assert.equal(calculatePayout(quote, 110_000_000n), 2_500_000n);
  assert.equal(calculatePayout(quote, 150_000_000n), quote.maxPayout);
});
