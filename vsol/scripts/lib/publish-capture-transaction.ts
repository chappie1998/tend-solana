import type { AnchorProvider, Program } from "@anchor-lang/core";
import { PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import type { Vsol } from "../../target/types/vsol.ts";

// Composes the ONE transaction oracle-runner.ts sends per due market:
// `update_custom_price_feed` immediately followed by
// `capture_custom_settlement_observation`, in the same transaction. Bundling
// both is what guarantees the published price lands inside the market's
// observation window AND is captured within
// `CUSTOM_OBSERVATION_MAX_CAPTURE_AGE_SECONDS` (30s, see
// vsol/programs/vsol/src/lib.rs) -- two separate transactions would leave a
// gap (a slow confirmation, a dropped second transaction) where the feed is
// fresh but never captured, exactly the failure mode a continuous
// once-a-minute pusher already exhibited for a 60-second intraday window.
//
// Building instructions via `program.methods....instruction()` performs no
// RPC call by itself (verified: constructing a `Program` against an
// unreachable `Connection` and calling `.instruction()` never touches the
// network, since every account below is supplied explicitly via
// `accountsStrict` -- there is nothing for Anchor to resolve or simulate).
// That is what makes `buildPublishAndCaptureInstructions` below directly
// unit-testable offline, with no fixture RPC server.

export type PublishAndCaptureAccounts = {
  oracleAuthority: PublicKey;
  config: PublicKey;
  market: PublicKey;
  feed: PublicKey;
  observation: PublicKey;
};

export type PublishAndCaptureParams = {
  program: Program<Vsol>;
  accounts: PublishAndCaptureAccounts;
  price: bigint;
  confidence: bigint;
  observedAt: number;
};

/**
 * Returns exactly two instructions, in order: `update_custom_price_feed`
 * (3 accounts: oracleAuthority, config, feed) followed by
 * `capture_custom_settlement_observation` (6 accounts: oracleAuthority,
 * config, market, feed, observation, systemProgram) -- mirroring the account
 * lists `UpdateCustomPriceFeed`/`CaptureCustomSettlementObservation` declare
 * in vsol/programs/vsol/src/lib.rs exactly, via `accountsStrict` so a missing
 * or extra account fails loudly here rather than silently on-chain.
 */
export async function buildPublishAndCaptureInstructions(
  params: PublishAndCaptureParams,
): Promise<[TransactionInstruction, TransactionInstruction]> {
  const { program, accounts } = params;
  const updateInstruction = await program.methods
    .updateCustomPriceFeed(
      new BN(params.price.toString()),
      new BN(params.confidence.toString()),
      new BN(params.observedAt),
    )
    .accountsStrict({
      oracleAuthority: accounts.oracleAuthority,
      config: accounts.config,
      feed: accounts.feed,
    })
    .instruction();

  const captureInstruction = await program.methods
    .captureCustomSettlementObservation()
    .accountsStrict({
      oracleAuthority: accounts.oracleAuthority,
      config: accounts.config,
      market: accounts.market,
      feed: accounts.feed,
      observation: accounts.observation,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return [updateInstruction, captureInstruction];
}

/**
 * Sends the composed transaction through the program's own `AnchorProvider`
 * (which already holds the `oracleAuthority` keypair as its wallet, so no
 * extra signer is passed). Kept as a thin RPC shell separate from
 * `buildPublishAndCaptureInstructions` so the instruction composition itself
 * stays testable without a live connection.
 */
export async function sendPublishAndCaptureTransaction(
  provider: AnchorProvider,
  params: PublishAndCaptureParams,
): Promise<string> {
  const instructions = await buildPublishAndCaptureInstructions(params);
  const transaction = new Transaction().add(...instructions);
  return provider.sendAndConfirm(transaction, []);
}
