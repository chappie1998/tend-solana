import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
// Reuses the app's provider-neutral market-data entry point rather than
// writing a second HTTP client here (or hardcoding one provider). Every live
// market on this deployment routes through the SAME per-category dispatch
// the app and the quote path use (see app/lib/market-data.ts's own header):
// crypto reads Coinbase (or Pyth, via MARKET_DATA_PROVIDER), stocks always
// read Hyperliquid's "xyz" dex. This pusher must never call a single provider directly --
// it did that for a while (Coinbase only), which worked fine until NVDA/GOOGL
// went live and every stock tick started asking Coinbase for a symbol
// Coinbase has never listed, throwing every cycle.
import { getMarketSnapshot } from "../../app/lib/market-data.ts";
// The live market set, read from the one shared list (never hardcoded here)
// so this pusher can never drift from what the app/keeper consider tradable.
import { liveMarkets, type Market } from "../../app/lib/markets.ts";
import { deriveConfig, deriveCustomPriceFeed, PRICE_SCALE, VSOL_PROGRAM_ID } from "../sdk/index.ts";

// The custom-oracle pusher is the off-chain half of the backup/demo
// settlement path added alongside `CustomPriceFeed` in
// vsol/programs/vsol/src/lib.rs: on a fixed cadence it fetches each live
// symbol's off-chain spot (via getMarketSnapshot's per-category routing --
// Coinbase/Pyth for crypto, Hyperliquid for stocks), scales it to `PRICE_SCALE`
// atoms, and calls `update_custom_price_feed`. It is intentionally simple
// and centralized --
// see that account's own doc comment for the honest trust-model disclosure
// this script's signer check is the entirety of. This exists only so the
// product can still settle expired markets while Pyth access is
// unavailable; it is NOT a replacement for `publish_pyth_settlement` and
// carries none of its cryptographic verification.
//
// This key (`devnet-custom-oracle-authority`) is dedicated and low-privilege
// by design -- separate from maker/pool-manager/admin -- so compromising it
// can only ever move the custom feed's price, never touch a vault, a
// position, or `config` itself. It is deliberately NOT `config.admin`; it
// must be set as `config.oracle_authority` (via the existing `update_config`
// instruction) before `update_custom_price_feed` will accept its signature.

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");

// "~45-60s" per the design spec for CUSTOM_ORACLE_MAX_STALENESS_SECONDS
// (300s on-chain) -- generous headroom under that ceiling even if a single
// tick is slow or briefly fails.
const PUSH_INTERVAL_MS = 60_000;
const MAX_SOURCE_AGE_SECONDS = 30;
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

async function loadRequiredKeypair(name: string): Promise<Keypair> {
  const path = resolve(devnetDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing required signer "${name}" (expected ${path}). Generate it once with ` +
        `"solana-keygen new --no-bip39-passphrase --silent --outfile ${path}" and fund it ` +
        "with devnet SOL, then have an admin rotate config.oracle_authority to its public key " +
        "via the existing update_config instruction, before running this pusher.",
    );
  }
  const secret = Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

function programFor(signer: Keypair): Program<Vsol> {
  const provider = new AnchorProvider(connection, new AnchorWallet(signer), { commitment, preflightCommitment: commitment });
  return new Program<Vsol>(idl, provider);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Rounds a human spot price/confidence to the nearest `PRICE_SCALE` atom -- the same rounding convention `toPoolAtoms` uses in app/lib/vsol-server.ts. */
function toPriceScaleAtoms(humanAmount: number): bigint {
  return BigInt(Math.round(humanAmount * Number(PRICE_SCALE)));
}

export async function pushOneSymbol(params: {
  program: Program<Vsol>;
  authority: Keypair;
  config: PublicKey;
  market: Market;
}): Promise<void> {
  const { program, authority, config, market } = params;
  const feed = deriveCustomPriceFeed(market.symbol);
  const snapshot = await getMarketSnapshot(market);
  if (snapshot.mode !== "live" || snapshot.ageSeconds > MAX_SOURCE_AGE_SECONDS) {
    throw new Error(`${snapshot.source} snapshot is ${snapshot.mode} (${snapshot.ageSeconds}s old)`);
  }
  if (!Number.isSafeInteger(snapshot.publishTime) || snapshot.publishTime <= 0) {
    throw new Error(`${snapshot.source} returned an invalid observation timestamp`);
  }
  const price = toPriceScaleAtoms(snapshot.price);
  // `confidence` is always a non-negative, human-scale dispersion proxy
  // regardless of which provider produced the snapshot -- half the live
  // bid/ask spread for Coinbase, |mark - oracle| for Hyperliquid
  // (see MarketSnapshot's doc comment in app/lib/market-data-types.ts) --
  // never a Pyth-style confidence interval, but always a real, roundable
  // number. The `Math.max(0, ...)` stays defensive rather than provider-
  // specific: neither provider's parser can hand back a negative value
  // today, but nothing here should trust that invariant blindly either.
  const confidence = toPriceScaleAtoms(Math.max(0, snapshot.confidence));
  if (price <= 0n) {
    throw new Error(`${snapshot.source} returned a non-positive price for ${market.symbol} (${snapshot.price})`);
  }

  const signature = await program.methods
    .updateCustomPriceFeed(
      new BN(price.toString()),
      new BN(confidence.toString()),
      new BN(snapshot.publishTime),
    )
    .accountsStrict({
      oracleAuthority: authority.publicKey,
      config,
      feed,
    })
    .rpc();

  console.log(
    `pushed: ${market.symbol} price $${snapshot.price} (${price.toString()} atoms), confidence ${confidence.toString()} atoms (signature ${signature})`,
  );
}

export async function runCustomOraclePushPass(program: Program<Vsol>, authority: Keypair, config: PublicKey): Promise<number> {
  const results = await Promise.all(liveMarkets.map(async (market) => {
    try {
      await pushOneSymbol({ program, authority, config, market });
      return true;
    } catch (error) {
      // Per-symbol isolation: an outage at whichever provider this symbol
      // routes to (Coinbase/Pyth for crypto, Hyperliquid for stocks -- see
      // app/lib/market-data.ts), an un-initialized feed (init_custom_price_feed
      // not yet called for this symbol), or a single failed RPC must cost
      // only that symbol's tick, never the whole pass.
      const failure = classifyPushFailure(error, rpcUrl);
      if (failure.duplicateTimestamp) {
        console.log(`unchanged: ${market.symbol} source timestamp already published`);
        return true;
      }
      console.log(`skip: ${market.symbol} -- ${failure.message}`);
      return false;
    }
  }));
  return results.filter((ok) => !ok).length;
}

export function classifyPushFailure(error: unknown, secret: string): { duplicateTimestamp: boolean; message: string } {
  const code = error && typeof error === "object" && "error" in error
    ? (error as { error?: { errorCode?: { code?: string } } }).error?.errorCode?.code
    : undefined;
  const message = (error instanceof Error ? error.message : String(error)).split(secret).join("[redacted]");
  return { duplicateTimestamp: code === "CustomFeedTimestampNotIncreasing", message };
}

async function main(): Promise<void> {
  console.log(`VSOL custom-oracle pusher on ${cluster} through the configured RPC`);

  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) {
    throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  }
  if (cluster === "devnet" && await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
    throw new Error("Configured RPC is not Solana devnet");
  }

  const authority = await loadRequiredKeypair("devnet-custom-oracle-authority");
  const program = programFor(authority);
  const config = deriveConfig();

  console.log(
    `Pushing ${liveMarkets.length} live symbol(s) every ${Math.round(PUSH_INTERVAL_MS / 1000)}s: ` +
      `${liveMarkets.map((market) => market.symbol).join(", ")} (signer ${authority.publicKey.toBase58()})`,
  );

  // Runs forever. Each pass is fully isolated per symbol (see the try/catch
  // in runOnePass above), so this loop itself never throws in the steady
  // state; only a startup failure (missing key, program not deployed) exits.
  for (;;) {
    await runCustomOraclePushPass(program, authority, config);
    await sleep(PUSH_INTERVAL_MS);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.split(rpcUrl).join("[redacted]"));
    process.exitCode = 1;
  });
}
