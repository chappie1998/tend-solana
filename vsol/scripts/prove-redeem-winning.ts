// On-chain proof of `redeem_winning` against a live cluster -- the payout
// half of the v2 conditional-token core, and the half that cannot be proven
// without a real settled market.
//
// Companion to scripts/prove-complete-set.ts, which proves mint/burn on an
// unexpired market. This script assumes complete sets have ALREADY been
// minted on a market that has since expired and had its oracle finalized
// (run prove-complete-set.ts against a short-dated rung with
// VSOL_PROVE_MARKET, wait out expiry + the observation window, then run the
// cranker to publish settlement).
//
// The invariant under test is the payout rule:
//
//   * UP wins iff  oracle.price > market.strike   (an exact tie goes to DOWN)
//   * the winning side redeems 1:1 for collateral
//   * the losing side is rejected with LosingSideNotRedeemable
//
// Both halves are asserted: the winning redemption must succeed AND move the
// vault/supply by exactly the redeemed amount, and the losing redemption must
// be REJECTED. A proof that only checks the happy path would pass even if the
// program paid out both sides, which is the failure that would drain the
// vault.
//
// Usage:  VSOL_PROVE_MARKET=<market> npm --prefix vsol run prove:redeem

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
  buildRedeemWinningInstruction,
  deriveCompleteSetToken,
  deriveCompleteSetVault,
  deriveConfig,
  deriveDownMint,
  deriveOracle,
  deriveUpMint,
  upWins,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, { commitment, confirmTransactionInitialTimeout: 120_000 });
const workspace = resolve(import.meta.dirname, "..");

const REDEEM_AMOUNT = 250n * 1_000_000n; // 250 tUSDC of the winning side

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

async function balanceOf(token: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, token, commitment, TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function supplyOf(mint: PublicKey): Promise<bigint> {
  try {
    return (await getMint(connection, mint, commitment, TOKEN_PROGRAM_ID)).supply;
  } catch {
    return 0n;
  }
}

async function main(): Promise<void> {
  const target = process.env.VSOL_PROVE_MARKET?.trim();
  if (!target) fail("set VSOL_PROVE_MARKET to the settled market's address");
  const marketKey = new PublicKey(target);

  const deployment = JSON.parse(await readFile(resolve(workspace, "deployments", `${cluster}.json`), "utf8")) as Record<string, string>;
  const settlementMint = new PublicKey(deployment.settlementMint!);
  const redeemer = await loadKeypair(resolve(workspace, ".devnet", `${cluster}-buyer.json`));

  const marketInfo = await connection.getAccountInfo(marketKey, commitment);
  if (!marketInfo) fail(`market ${target} does not exist`);
  const marketData = Buffer.from(marketInfo.data);
  if (marketData.length !== 289) fail(`market ${target} is ${marketData.length} bytes, expected 289`);
  const strike = marketData.readBigUInt64LE(281);
  const symbol = marketData.subarray(169, 185).toString("ascii").replace(/\0+$/, "");
  const expiry = Number(marketData.readBigInt64LE(193));

  const oracleKey = deriveOracle(marketKey);
  const oracleInfo = await connection.getAccountInfo(oracleKey, commitment);
  if (!oracleInfo) fail(`oracle ${oracleKey.toBase58()} does not exist`);
  const oracleData = Buffer.from(oracleInfo.data);
  // SettlementOracle: 8 disc, 8 bump, 9 market, 41 price(u64), 49 confidence,
  // 57 observed_at, 65 published_at, 73 price_update, 105 feed_id,
  // 137 exponent(i32), 141 finalized(bool), 142 settled_from_stale_price.
  const settlementPrice = oracleData.readBigUInt64LE(41);
  const finalized = oracleData[141] === 1;
  const fromStale = oracleData[142] === 1;

  console.log(`Proving redeem_winning on ${cluster} via ${rpcUrl}`);
  console.log(`  market   ${marketKey.toBase58()}  (${symbol}, expiry ${new Date(expiry * 1000).toISOString()})`);
  console.log(`  strike   ${strike}  ($${(Number(strike) / 1e6).toFixed(2)})`);
  console.log(`  oracle   finalized=${finalized} price=${settlementPrice} ($${(Number(settlementPrice) / 1e6).toFixed(2)}) fromStalePrice=${fromStale}`);

  if (!finalized) {
    fail(
      `oracle is not finalized yet -- wait past expiry + the observation window, then run the cranker `
      + `(npm --prefix vsol run cranker) to publish settlement, then re-run this proof`,
    );
  }

  const upWon = upWins(settlementPrice, strike);
  console.log(`  winner   ${upWon ? "UP" : "DOWN"}  (settlementPrice ${upWon ? ">" : "<="} strike)`);

  const config = deriveConfig();
  const upMint = deriveUpMint(marketKey);
  const downMint = deriveDownMint(marketKey);
  const collateralVault = deriveCompleteSetVault(marketKey);
  const winningToken = deriveCompleteSetToken(upWon ? upMint : downMint, redeemer.publicKey);
  const losingToken = deriveCompleteSetToken(upWon ? downMint : upMint, redeemer.publicKey);
  const destination = getAssociatedTokenAddressSync(settlementMint, redeemer.publicKey, false, TOKEN_PROGRAM_ID);

  const before = {
    vault: await balanceOf(collateralVault),
    winningSupply: await supplyOf(upWon ? upMint : downMint),
    losingSupply: await supplyOf(upWon ? downMint : upMint),
    winningHeld: await balanceOf(winningToken),
    losingHeld: await balanceOf(losingToken),
    destination: await balanceOf(destination),
  };
  console.log(`\nbefore: vault=${before.vault} winningSupply=${before.winningSupply} losingSupply=${before.losingSupply}`);
  console.log(`        redeemer holds ${before.winningHeld} winning / ${before.losingHeld} losing`);
  if (before.winningHeld < REDEEM_AMOUNT) fail(`redeemer holds ${before.winningHeld} of the winning side, needs ${REDEEM_AMOUNT}`);

  // --- the losing side must be REJECTED ------------------------------------
  // Asserted FIRST and deliberately: a proof that only exercised the happy
  // path would still pass if the program paid out both sides, which is
  // exactly the bug that would drain the vault.
  console.log(`\nredeem_winning(${REDEEM_AMOUNT}) with the LOSING side -- must be rejected`);
  const losingIx = await buildRedeemWinningInstruction(
    { redeemer: redeemer.publicKey, config, market: marketKey, oracle: oracleKey, settlementMint, upMint, downMint, collateralVault, redeemerToken: losingToken, redeemerDestination: destination },
    REDEEM_AMOUNT,
  );
  let losingRejected = false;
  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(losingIx), [redeemer], { commitment });
  } catch (error) {
    losingRejected = true;
    const description = error instanceof Error ? error.message : String(error);
    const expected = /LosingSideNotRedeemable|custom program error/i.test(description);
    if (!expected) fail(`losing side was rejected, but not for the expected reason: ${description}`);
    console.log(`  ok  losing side rejected by the program`);
  }
  if (!losingRejected) fail("the LOSING side was redeemed -- the program paid out both sides");

  // --- the winning side must succeed 1:1 -----------------------------------
  console.log(`\nredeem_winning(${REDEEM_AMOUNT}) with the WINNING side`);
  const winningIx = await buildRedeemWinningInstruction(
    { redeemer: redeemer.publicKey, config, market: marketKey, oracle: oracleKey, settlementMint, upMint, downMint, collateralVault, redeemerToken: winningToken, redeemerDestination: destination },
    REDEEM_AMOUNT,
  );
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(winningIx), [redeemer], { commitment });
  console.log(`  tx ${signature}`);

  const after = {
    vault: await balanceOf(collateralVault),
    winningSupply: await supplyOf(upWon ? upMint : downMint),
    losingSupply: await supplyOf(upWon ? downMint : upMint),
    winningHeld: await balanceOf(winningToken),
    destination: await balanceOf(destination),
  };
  assertEq("vault debited 1:1", after.vault, before.vault - REDEEM_AMOUNT);
  assertEq("winning supply burned 1:1", after.winningSupply, before.winningSupply - REDEEM_AMOUNT);
  assertEq("redeemer winning balance burned", after.winningHeld, before.winningHeld - REDEEM_AMOUNT);
  assertEq("redeemer paid 1:1 in collateral", after.destination, before.destination + REDEEM_AMOUNT);
  assertEq("losing supply untouched", after.losingSupply, before.losingSupply);

  console.log(`\nPASS: redeem_winning verified on ${cluster}.`);
  console.log(`  ${upWon ? "UP" : "DOWN"} won at settlement price ${settlementPrice} against strike ${strike}.`);
  console.log(`  winning side paid 1.00 per token; losing side rejected. Vault now ${after.vault} atoms.`);
}

await main();
