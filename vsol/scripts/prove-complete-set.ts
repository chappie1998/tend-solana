// On-chain proof of the v2 conditional-token core against a live cluster.
//
// This is step 1 of the v2 sequence (see Documents/tend-v2-design.md): prove
// `mint_complete_set` / `burn_complete_set` end to end on a real market,
// independent of bootstrap.ts's adversarial smoke lifecycle -- which exercises
// the LEGACY pool/position path that v2 retires, and which cannot currently
// complete against the public devnet RPC.
//
// Deliberately read-then-assert at every step rather than trusting the
// program's own internal `require!` checks: this script exists to prove the
// invariant from the outside, the same way the LiteSVM integration tests
// prove it from the inside. The invariant under test is the one the whole
// mechanism rests on --
//
//     collateral_vault.amount == up_mint.supply == down_mint.supply
//
// -- i.e. every conditional token in existence is backed 1:1 by collateral
// that is actually sitting in the vault.
//
// `redeem_winning` is NOT covered here: it requires a finalized oracle, which
// means waiting out a real expiry plus observation window. See
// redeem_winning's own LiteSVM coverage in programs/vsol/tests/instructions.rs
// for that path; this script covers what can be proven against an unexpired
// market.
//
// Usage:  npm --prefix vsol run prove:complete-set
//         VSOL_RPC_URL=... npm --prefix vsol run prove:complete-set

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  buildBurnCompleteSetInstruction,
  buildMintCompleteSetInstruction,
  deriveCompleteSetToken,
  deriveCompleteSetVault,
  deriveConfig,
  deriveDownMint,
  deriveUpMint,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");

// The Market account layout under the conditional-token factory. Offsets are
// the same ones scripts/lib/settlement.ts documents; only the few fields this
// proof needs are read here.
const MARKET_ACCOUNT_SIZE = 289;

const MINT_AMOUNT = 1_000n * 1_000_000n; // 1,000 tUSDC
const BURN_AMOUNT = 400n * 1_000_000n; //    400 tUSDC

type Live = { address: PublicKey; symbol: string; expiry: number; strike: bigint };

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assertEq(label: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  console.log(`  ok  ${label} = ${actual}`);
}

async function loadKeypair(path: string): Promise<Keypair> {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]));
}

/**
 * Picks the longest-dated enabled market for `symbol`. Longest-dated on
 * purpose: this proof mints real collateral into the market's vault, and a
 * short-dated rung could expire mid-run, which would change what the
 * assertions mean rather than failing cleanly.
 */
async function pickMarket(symbol: string): Promise<Live> {
  // VSOL_PROVE_MARKET pins the proof to one specific market instead of the
  // longest-dated rung -- used to stage a short-dated rung for the
  // settle-then-redeem_winning proof, which needs a market that actually
  // expires while the proof is running.
  const pinned = process.env.VSOL_PROVE_MARKET?.trim();
  const accounts = await connection.getProgramAccounts(VSOL_PROGRAM_ID, {
    commitment,
    filters: [{ dataSize: MARKET_ACCOUNT_SIZE }],
  });
  const live: Live[] = [];
  for (const { pubkey, account } of accounts) {
    const data = Buffer.from(account.data);
    const decoded = {
      address: pubkey,
      symbol: data.subarray(169, 185).toString("ascii").replace(/\0+$/, ""),
      expiry: Number(data.readBigInt64LE(193)),
      strike: data.readBigUInt64LE(281),
      enabled: data[244] === 1,
    };
    if (decoded.enabled && decoded.symbol === symbol) live.push(decoded);
  }
  if (live.length === 0) fail(`no enabled ${symbol} market found on ${cluster} (has bootstrap run since the upgrade?)`);
  if (pinned) {
    const match = live.find((entry) => entry.address.toBase58() === pinned);
    if (!match) fail(`VSOL_PROVE_MARKET=${pinned} is not an enabled ${symbol} market on ${cluster}`);
    return match;
  }
  return live.sort((a, b) => b.expiry - a.expiry)[0]!;
}

async function supplyOf(mint: PublicKey): Promise<bigint> {
  try {
    return (await getMint(connection, mint, commitment, TOKEN_PROGRAM_ID)).supply;
  } catch {
    // The mint PDA is created lazily by the first mint_complete_set call.
    return 0n;
  }
}

async function balanceOf(token: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, token, commitment, TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function main(): Promise<void> {
  const deployment = JSON.parse(await readFile(resolve(workspace, "deployments", `${cluster}.json`), "utf8")) as Record<string, string>;
  const settlementMint = new PublicKey(deployment.settlementMint!);
  const minter = await loadKeypair(resolve(workspace, ".devnet", `${cluster}-buyer.json`));

  const market = await pickMarket("NVDA");
  const config = deriveConfig();
  const upMint = deriveUpMint(market.address);
  const downMint = deriveDownMint(market.address);
  const collateralVault = deriveCompleteSetVault(market.address);
  const minterUpToken = deriveCompleteSetToken(upMint, minter.publicKey);
  const minterDownToken = deriveCompleteSetToken(downMint, minter.publicKey);

  // The minter's settlement-token source: their standard ATA, which is the
  // account bootstrap funds via ensureTokenBalance. Derived rather than read
  // from the manifest, which records the writer/treasury token accounts but
  // not the buyer's.
  const minterSource = getAssociatedTokenAddressSync(settlementMint, minter.publicKey, false, TOKEN_PROGRAM_ID);

  console.log(`Proving the conditional-token core on ${cluster} via ${rpcUrl}`);
  console.log(`  market   ${market.address.toBase58()}`);
  console.log(`  symbol   ${market.symbol}  strike $${(Number(market.strike) / 1e6).toFixed(2)}  expiry ${new Date(market.expiry * 1000).toISOString()}`);
  console.log(`  minter   ${minter.publicKey.toBase58()}`);
  console.log(`  up/down  ${upMint.toBase58()} / ${downMint.toBase58()}`);
  console.log(`  vault    ${collateralVault.toBase58()}`);

  const before = {
    vault: await balanceOf(collateralVault),
    up: await supplyOf(upMint),
    down: await supplyOf(downMint),
    minterUp: await balanceOf(minterUpToken),
    minterDown: await balanceOf(minterDownToken),
    source: await balanceOf(minterSource),
  };
  console.log(`\nbefore: vault=${before.vault} upSupply=${before.up} downSupply=${before.down} source=${before.source}`);
  if (before.source < MINT_AMOUNT) fail(`minter source ${minterSource.toBase58()} holds ${before.source}, needs ${MINT_AMOUNT}`);

  // --- mint_complete_set ---------------------------------------------------
  console.log(`\nmint_complete_set(${MINT_AMOUNT})`);
  const mintIx = await buildMintCompleteSetInstruction(
    { minter: minter.publicKey, config, market: market.address, settlementMint, upMint, downMint, collateralVault, minterSource, minterUpToken, minterDownToken },
    MINT_AMOUNT,
  );
  const mintSig = await sendAndConfirmTransaction(connection, new Transaction().add(mintIx), [minter], { commitment });
  console.log(`  tx ${mintSig}`);

  const afterMint = {
    vault: await balanceOf(collateralVault),
    up: await supplyOf(upMint),
    down: await supplyOf(downMint),
    minterUp: await balanceOf(minterUpToken),
    minterDown: await balanceOf(minterDownToken),
    source: await balanceOf(minterSource),
  };
  assertEq("vault", afterMint.vault, before.vault + MINT_AMOUNT);
  assertEq("up supply", afterMint.up, before.up + MINT_AMOUNT);
  assertEq("down supply", afterMint.down, before.down + MINT_AMOUNT);
  assertEq("minter UP balance", afterMint.minterUp, before.minterUp + MINT_AMOUNT);
  assertEq("minter DOWN balance", afterMint.minterDown, before.minterDown + MINT_AMOUNT);
  assertEq("minter collateral debited", afterMint.source, before.source - MINT_AMOUNT);
  assertEq("INVARIANT vault == up supply", afterMint.vault, afterMint.up);
  assertEq("INVARIANT vault == down supply", afterMint.vault, afterMint.down);

  // --- burn_complete_set ---------------------------------------------------
  console.log(`\nburn_complete_set(${BURN_AMOUNT})`);
  const burnIx = await buildBurnCompleteSetInstruction(
    { burner: minter.publicKey, config, market: market.address, settlementMint, upMint, downMint, collateralVault, burnerUpToken: minterUpToken, burnerDownToken: minterDownToken, burnerDestination: minterSource },
    BURN_AMOUNT,
  );
  const burnSig = await sendAndConfirmTransaction(connection, new Transaction().add(burnIx), [minter], { commitment });
  console.log(`  tx ${burnSig}`);

  const afterBurn = {
    vault: await balanceOf(collateralVault),
    up: await supplyOf(upMint),
    down: await supplyOf(downMint),
    minterUp: await balanceOf(minterUpToken),
    minterDown: await balanceOf(minterDownToken),
    source: await balanceOf(minterSource),
  };
  assertEq("vault", afterBurn.vault, afterMint.vault - BURN_AMOUNT);
  assertEq("up supply", afterBurn.up, afterMint.up - BURN_AMOUNT);
  assertEq("down supply", afterBurn.down, afterMint.down - BURN_AMOUNT);
  assertEq("minter UP balance", afterBurn.minterUp, afterMint.minterUp - BURN_AMOUNT);
  assertEq("minter DOWN balance", afterBurn.minterDown, afterMint.minterDown - BURN_AMOUNT);
  assertEq("minter collateral returned", afterBurn.source, afterMint.source + BURN_AMOUNT);
  assertEq("INVARIANT vault == up supply", afterBurn.vault, afterBurn.up);
  assertEq("INVARIANT vault == down supply", afterBurn.vault, afterBurn.down);

  console.log(`\nPASS: mint_complete_set and burn_complete_set verified on ${cluster}.`);
  console.log(`  net outstanding sets on this market: ${afterBurn.vault} atoms, fully collateralized.`);
}

await main();
