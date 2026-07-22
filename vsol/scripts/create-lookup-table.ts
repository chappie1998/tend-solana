import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  type ManifestMarketEntry,
  MAX_ADDRESSES_PER_EXTEND,
  missingAddresses,
  type RetiringLookupTableEntry,
  liveMarketFillAddresses,
  latestLiveMarketOutliveDeadline,
  shouldRotateLookupTable,
  stableFillAddresses,
} from "./lib/lookup-table.ts";

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
// already has one -- EXCEPT when the active table has grown to within
// ROTATION_ADDRESS_THRESHOLD of the ALT program's hard 256-address cap
// (which has no way to delete individual entries): at that point this script
// rotates by creating a brand-new table seeded with the stable addresses plus
// every currently-live (unexpired) market+oracle, publishes it as the new
// `addressLookupTable`, and moves the old table's address into
// `retiringLookupTables` for vsol/scripts/keeper.ts to deactivate and close
// once its positions have settled. See app/lib/vsol.ts's ExtendedDeployment
// comment for the full manifest-shape documentation.

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

async function clusterUnixTime(): Promise<number> {
  const slot = await connection.getSlot(commitment);
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error(`No block time is available for slot ${slot}`);
  return blockTime;
}

async function createTable(authority: Keypair): Promise<{ table: PublicKey; recentSlot: number }> {
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
  return { table: createdTable, recentSlot };
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
  const manifestMarkets = Array.isArray(deployment.markets) ? (deployment.markets as ManifestMarketEntry[]) : [];
  const retiringTables = Array.isArray(deployment.retiringLookupTables)
    ? (deployment.retiringLookupTables as RetiringLookupTableEntry[])
    : [];

  const existingTableAddress = typeof deployment.addressLookupTable === "string" ? deployment.addressLookupTable : undefined;

  let lookupTable: PublicKey;
  let existingAddresses: PublicKey[] = [];
  let manifestChanged = false;
  // Only set when this run rotates: the new table starts empty and must be
  // seeded with every currently-live market up front (the keeper only appends
  // NEWLY created markets going forward, so it will never backfill markets
  // that already existed before rotation).
  let liveMarketsAtRotation: PublicKey[] = [];
  let rotatedFrom: RetiringLookupTableEntry | undefined;

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
    console.log(`Found existing ALT ${tableKey.toBase58()} with ${table.state.addresses.length} stored address(es)`);

    if (shouldRotateLookupTable(table.state.addresses.length)) {
      const now = await clusterUnixTime();
      const outliveExpiry = latestLiveMarketOutliveDeadline(manifestMarkets, now);
      console.log(
        `Rotating: ALT ${tableKey.toBase58()} holds ${table.state.addresses.length} address(es), at/above the rotation threshold. ` +
          `Creating a fresh table; ${tableKey.toBase58()} moves to retiringLookupTables and must outlive until ${new Date(outliveExpiry * 1000).toISOString()}.`,
      );
      const created = await createTable(authority);
      lookupTable = created.table;
      existingAddresses = [];
      liveMarketsAtRotation = liveMarketFillAddresses(manifestMarkets, now);
      manifestChanged = true;
      rotatedFrom = { address: tableKey.toBase58(), outliveExpiry, retiredAt: new Date().toISOString() };
      console.log(`Created rotation ALT ${lookupTable.toBase58()} (recent slot ${created.recentSlot})`);
    } else {
      lookupTable = tableKey;
      existingAddresses = table.state.addresses;
      console.log("Verifying contents");
    }
  } else {
    const created = await createTable(authority);
    lookupTable = created.table;
    manifestChanged = true;
    console.log(`Created ALT ${lookupTable.toBase58()} (recent slot ${created.recentSlot})`);
  }

  const seedAddresses = [...stableAddresses, ...liveMarketsAtRotation];

  const toAdd = missingAddresses(existingAddresses, seedAddresses);
  if (toAdd.length > 0) {
    await extendInChunks(authority, lookupTable, toAdd);
    console.log(`Extended ALT with ${toAdd.length} missing address(es): ${toAdd.map((address) => address.toBase58()).join(", ")}`);
  } else {
    console.log("ALT already contains every required address; nothing to extend");
  }

  if (rotatedFrom) {
    deployment.retiringLookupTables = [...retiringTables, rotatedFrom];
    manifestChanged = true;
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
