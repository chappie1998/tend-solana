import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { MAX_ADDRESSES_PER_EXTEND, missingAddresses, stableFillAddresses } from "./lib/lookup-table.ts";

// Idempotent ALT provisioning for the fill path. The fill transaction sits at
// ~1154 of Solana's 1232-byte limit, and the four-instruction mint-on-demand
// fill (1469 bytes) cannot be submitted at all -- an address lookup table
// (ALT) replaces repeated 32-byte account keys with 1-byte indices in v0
// transactions, which fixes both. This script only creates/extends the
// table; it never builds or sends fill transactions itself.
//
// Safe to run repeatedly and concurrently with itself: it either creates a
// brand-new table once, or verifies and extends the one already recorded in
// the manifest. It never creates a second table for a deployment that
// already has one.

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");
const deploymentPath = resolve(workspace, "deployments", `${cluster}.json`);

async function loadRequiredKeypair(name: string): Promise<Keypair> {
  const path = resolve(devnetDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing required signer "${name}" (expected ${path}). Run "npm run devnet:bootstrap" at least once before creating the lookup table.`,
    );
  }
  const secret = Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

async function extendInChunks(authority: Keypair, lookupTable: PublicKey, addresses: PublicKey[]): Promise<void> {
  for (let offset = 0; offset < addresses.length; offset += MAX_ADDRESSES_PER_EXTEND) {
    const chunk = addresses.slice(offset, offset + MAX_ADDRESSES_PER_EXTEND);
    const instruction = AddressLookupTableProgram.extendLookupTable({
      payer: authority.publicKey,
      authority: authority.publicKey,
      lookupTable,
      addresses: chunk,
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [authority], { commitment });
  }
}

async function main(): Promise<void> {
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as Record<string, unknown>;
  // Reuse the same persisted creator key the keeper signs market creation
  // with, so authority over the table always matches a signer the keeper
  // already has on disk.
  const authority = await loadRequiredKeypair(`${cluster}-creator`);

  const stable = stableFillAddresses(deployment);
  const stableAddresses = stable.map((entry) => entry.address);

  const existingTableAddress = typeof deployment.addressLookupTable === "string" ? deployment.addressLookupTable : undefined;

  let lookupTable: PublicKey;
  let existingAddresses: PublicKey[] = [];
  let manifestChanged = false;

  if (existingTableAddress) {
    const tableKey = new PublicKey(existingTableAddress);
    const accountInfo = await connection.getAccountInfo(tableKey, commitment);
    const isOwnedByAltProgram = accountInfo?.owner.equals(AddressLookupTableProgram.programId) ?? false;
    const lookup = isOwnedByAltProgram
      ? await connection.getAddressLookupTable(tableKey, { commitment })
      : { value: null };
    const table = lookup.value;
    if (!accountInfo || !isOwnedByAltProgram || !table || !table.state.authority?.equals(authority.publicKey)) {
      throw new Error(
        `deployments/${cluster}.json already publishes addressLookupTable ${existingTableAddress}, but the on-chain account is ` +
          `missing, not owned by the AddressLookupTable program, or its authority does not match the persisted creator key ` +
          `${authority.publicKey.toBase58()}. Refusing to create a second table; fix or clear the manifest field manually first.`,
      );
    }
    lookupTable = tableKey;
    existingAddresses = table.state.addresses;
    console.log(`Found existing ALT ${lookupTable.toBase58()} with ${existingAddresses.length} stored address(es); verifying contents`);
  } else {
    // A "recent" slot must be finalized at submission time or the on-chain
    // derivation can reject it; "finalized" commitment keeps this well clear
    // of that edge.
    const recentSlot = await connection.getSlot("finalized");
    const [createInstruction, createdTable] = AddressLookupTableProgram.createLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      recentSlot,
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(createInstruction), [authority], { commitment });
    lookupTable = createdTable;
    manifestChanged = true;
    console.log(`Created ALT ${lookupTable.toBase58()} (recent slot ${recentSlot})`);
  }

  const toAdd = missingAddresses(existingAddresses, stableAddresses);
  if (toAdd.length > 0) {
    await extendInChunks(authority, lookupTable, toAdd);
    console.log(`Extended ALT with ${toAdd.length} missing stable address(es): ${toAdd.map((address) => address.toBase58()).join(", ")}`);
  } else {
    console.log("ALT already contains every stable address; nothing to extend");
  }

  if (manifestChanged || deployment.addressLookupTable !== lookupTable.toBase58()) {
    deployment.addressLookupTable = lookupTable.toBase58();
    await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  }

  console.log(`Address lookup table: ${lookupTable.toBase58()}`);
  console.log(`Stored addresses: ${existingAddresses.length + toAdd.length}`);

  // Freshly extended addresses only become usable by v0 transactions one
  // slot after the extend lands on-chain -- callers building fill
  // transactions right after this script runs should tolerate a brief
  // warm-up window (retry for a slot or two) rather than treating a
  // "table contains an uninitialized index" style failure as fatal.
  if (toAdd.length > 0) {
    console.log("Note: newly added addresses need ~1 slot to warm up before v0 transactions can reference them.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
