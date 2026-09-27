import type { Program } from "@anchor-lang/core";
import type { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { Vsol } from "../../target/types/vsol.ts";
import { deriveCustomPriceFeed, HEARTBEAT_SYMBOL } from "../../sdk/index.ts";

// The heartbeat is a synthetic price, never a real spot: `update_custom_price_feed`
// only requires `price > 0`, so `1` (one PRICE_SCALE atom, i.e. one
// millionth of a dollar at this deployment's scale) is the simplest value
// that satisfies the on-chain check without being mistaken for a real quote
// by anything that might someday scan feed accounts generically. Confidence
// is `0` -- nothing ever runs `capture_custom_settlement_observation` or
// `publish_custom_settlement` against the HEARTBEAT feed (see
// vsol/sdk/index.ts's doc comment on `HEARTBEAT_SYMBOL`), so the on-chain
// confidence-bps check that would otherwise apply to those two instructions
// never runs against this feed either.
export const HEARTBEAT_PRICE_ATOMS = 1n;
export const HEARTBEAT_CONFIDENCE_ATOMS = 0n;

/**
 * Publishes the heartbeat feed's current timestamp. `observedAt` must be the
 * caller's own `now` (in unix seconds): `update_custom_price_feed` requires
 * `observed_at <= clock.unix_timestamp` and strictly increasing per feed
 * (`CustomFeedTimestampNotIncreasing`), so calling this more than once within
 * the same on-chain clock second is a race the caller (oracle-runner.ts's
 * 5-minute lane) never triggers by construction.
 */
export async function publishHeartbeat(params: {
  program: Program<Vsol>;
  authority: Keypair;
  config: PublicKey;
  observedAt: number;
}): Promise<string> {
  const feed = deriveCustomPriceFeed(HEARTBEAT_SYMBOL);
  return params.program.methods
    .updateCustomPriceFeed(new BN(HEARTBEAT_PRICE_ATOMS.toString()), new BN(HEARTBEAT_CONFIDENCE_ATOMS.toString()), new BN(params.observedAt))
    .accountsStrict({
      oracleAuthority: params.authority.publicKey,
      config: params.config,
      feed,
    })
    .rpc();
}
