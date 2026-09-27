import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { createVsolConnection } from "../sdk/rpc-failover/index.ts";
import BN from "bn.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { deriveConfig, deriveCustomPriceFeed, HEARTBEAT_SYMBOL, PRICE_SCALE, symbolBytes, VSOL_PROGRAM_ID } from "../sdk/index.ts";

// One-time admin script: creates the dedicated `HEARTBEAT` `CustomPriceFeed`
// PDA that oracle-runner.ts's heartbeat lane publishes to every 5 minutes,
// and app/lib/custom-oracle-readiness.ts reads to answer "is the settlement
// runner alive" (see HEARTBEAT_SYMBOL's doc comment in vsol/sdk/index.ts for
// why this is a SEPARATE feed from every real market symbol, never mixed
// into SOL/BTC/ETH/NVDA/GOOGL's own feeds).
//
// Idempotent: if the feed account already exists, this exits successfully
// without sending a transaction. Safe to run more than once, and safe to run
// before or after `config.oracle_authority` is set -- `init_custom_price_feed`
// itself is `admin`-gated (not `oracle_authority`-gated), matching every
// other config-owned `init` instruction in the program.
//
// NOT run automatically by anything -- this is deliberately a manual,
// operator-run step (see the module doc in oracle-runner.ts and the task
// this was written against: "Write a one-shot admin script ... Do NOT run
// it -- I will.").

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = createVsolConnection({ rpcUrl, backupRpcUrl: process.env.VSOL_RPC_BACKUP_URL, cluster, commitment });
// Same admin keypair convention as bootstrap.ts: SOLANA_WALLET overrides,
// defaulting to the standard Solana CLI keypair.
const walletPath = process.env.SOLANA_WALLET?.replace(/^~/, homedir()) ?? `${homedir()}/.config/solana/id.json`;

async function loadKeypair(path: string): Promise<Keypair> {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]));
}

async function main(): Promise<void> {
  console.log(`VSOL heartbeat feed init on ${cluster} through the configured RPC`);

  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) {
    throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  }

  const admin = await loadKeypair(walletPath);
  const provider = new AnchorProvider(connection, new AnchorWallet(admin), { commitment, preflightCommitment: commitment });
  const program = new Program<Vsol>(idl, provider);
  const config = deriveConfig();
  const feed = deriveCustomPriceFeed(HEARTBEAT_SYMBOL);

  const existing = await connection.getAccountInfo(feed, commitment);
  if (existing) {
    if (!existing.owner.equals(VSOL_PROGRAM_ID)) {
      throw new Error(`Heartbeat feed account ${feed.toBase58()} exists but is owned by ${existing.owner.toBase58()}, not the VSOL program`);
    }
    console.log(`Heartbeat feed ${feed.toBase58()} already exists -- nothing to do`);
    return;
  }

  const signature = await program.methods
    .initCustomPriceFeed(symbolBytes(HEARTBEAT_SYMBOL), new BN(PRICE_SCALE.toString()))
    .accountsStrict({
      admin: admin.publicKey,
      config,
      feed,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`Initialized heartbeat feed ${feed.toBase58()} (signature ${signature})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.split(rpcUrl).join("[redacted]"));
    process.exitCode = 1;
  });
}
