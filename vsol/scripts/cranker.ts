import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, Program, Wallet as AnchorWallet } from "@anchor-lang/core";
import { HermesClient } from "@pythnetwork/hermes-client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import type { Vsol } from "../target/types/vsol.ts";
import { deriveConfig, VSOL_PROGRAM_ID } from "../sdk/index.ts";
import {
  decideMarketPublishAction,
  decidePositionAction,
  describeSettlementError,
  fetchLatestPythUpdate,
  fetchMarketStates,
  fetchOpenPoolPositions,
  fetchOracleStates,
  filterExpiredOpenPositions,
  groupPositionsByMarket,
  publishSettlementForMarket,
  redact,
  refundPoolPositionOnChain,
  settlePoolPositionOnChain,
  type MarketWindow,
} from "./lib/settlement.ts";

// The settlement cranker is the permissionless liveness layer for expired
// VSOL pool positions: the payoff is fixed entirely by strike + oracle
// price, so the "cranker" signer has no special authority on-chain (settle
// and refund accept any funded signer) and cannot choose outcomes or divert
// funds. Running this on a short interval is a convenience that lets buyers
// get paid without lifting a finger; if it stops running, any buyer can
// still call settle/refund themselves against the same permissionless
// instructions. It is safe to run concurrently with itself and with a
// buyer's own settlement transaction -- every write here is idempotent or
// treated as a skip (see lib/settlement.ts).

const rpcUrl = process.env.VSOL_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "localnet" : "devnet";
const commitment = "confirmed" as const;
const connection = new Connection(rpcUrl, commitment);
const workspace = resolve(import.meta.dirname, "..");
const devnetDir = resolve(workspace, ".devnet");
const hermes = new HermesClient(process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network", {
  accessToken: process.env.PYTH_API_KEY?.trim() || undefined,
  timeout: 20_000,
  httpRetries: 3,
});

async function loadRequiredKeypair(name: string): Promise<Keypair> {
  const path = resolve(devnetDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing required signer "${name}" (expected ${path}). Run "npm run devnet:bootstrap" at least once before the cranker.`,
    );
  }
  const secret = Uint8Array.from(JSON.parse(await readFile(path, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

function programFor(signer: Keypair): Program<Vsol> {
  const provider = new AnchorProvider(connection, new AnchorWallet(signer), { commitment, preflightCommitment: commitment });
  return new Program<Vsol>(idl, provider);
}

async function clusterUnixTime(): Promise<number> {
  const slot = await connection.getSlot(commitment);
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error(`No block time is available for slot ${slot}`);
  return blockTime;
}

type Counters = { published: number; settled: number; refunded: number; skipped: number };

function logSummary(counters: Counters): void {
  console.log(
    `Cranker summary: published ${counters.published} settlements, settled ${counters.settled} positions, ` +
      `refunded ${counters.refunded}, skipped ${counters.skipped}`,
  );
}

async function main(): Promise<void> {
  console.log(`VSOL cranker on ${cluster} through the configured RPC`);

  const programAccount = await connection.getAccountInfo(VSOL_PROGRAM_ID, commitment);
  if (!programAccount?.executable) {
    throw new Error(`VSOL program ${VSOL_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  }

  // Settlement is permissionless -- the on-chain `cranker` signer carries no
  // authority constraint, so any funded key works. This reuses the same
  // persisted automation key as scripts/keeper.ts ("creator") rather than
  // minting a fresh one, since it is already funded on this deployment. This
  // key (the cranker operator) pays every transaction fee below, plus the
  // Pyth receiver's price-update posting fee when it publishes a settlement.
  const cranker = await loadRequiredKeypair(`${cluster}-creator`);
  const program = programFor(cranker);
  const config = deriveConfig();

  const counters: Counters = { published: 0, settled: 0, refunded: 0, skipped: 0 };
  const positions = await fetchOpenPoolPositions(connection);
  if (positions.length === 0) {
    console.log("No open pool positions found on-chain");
    logSummary(counters);
    return;
  }

  const marketAddresses = [...new Set(positions.map((position) => position.market))].map(
    (address) => new PublicKey(address),
  );
  const marketStates = await fetchMarketStates(program, marketAddresses);

  const positionsWithKnownMarket = positions.filter((position) => marketStates.has(position.market));
  for (const position of positions) {
    if (!marketStates.has(position.market)) {
      console.log(`skip: position ${position.address} references market ${position.market} which is not readable on-chain`);
      counters.skipped += 1;
    }
  }

  const now = await clusterUnixTime();
  const marketExpiries = new Map<string, number>();
  marketStates.forEach((state, address) => marketExpiries.set(address, state.expiry));

  const expiredPositions = filterExpiredOpenPositions(positionsWithKnownMarket, marketExpiries, now);
  const notYetExpiredCount = positionsWithKnownMarket.length - expiredPositions.length;
  if (notYetExpiredCount > 0) {
    console.log(`skip: ${notYetExpiredCount} open position(s) have not reached their market's expiry yet`);
    counters.skipped += notYetExpiredCount;
  }

  if (expiredPositions.length === 0) {
    logSummary(counters);
    return;
  }

  const grouped = groupPositionsByMarket(expiredPositions);
  const oracleAddresses = [...grouped.keys()]
    .map((marketAddress) => marketStates.get(marketAddress)?.oracle)
    .filter((address): address is string => Boolean(address))
    .map((address) => new PublicKey(address));
  const oracleStates = await fetchOracleStates(program, oracleAddresses);
  const configAccount = await program.account.config.fetch(config);

  for (const [marketAddress, marketPositions] of grouped) {
    const marketState = marketStates.get(marketAddress);
    if (!marketState) continue; // already logged above

    const oracleAddress = new PublicKey(marketState.oracle);
    const oracleState = oracleStates.get(marketState.oracle);
    if (!oracleState) {
      console.log(`skip: market ${marketAddress} oracle ${marketState.oracle} is not readable on-chain; deferring settlement`);
      counters.skipped += marketPositions.length;
      continue;
    }
    let finalized = oracleState.finalized;

    const window: MarketWindow = {
      expiry: marketState.expiry,
      observationWindowSeconds: marketState.observationWindowSeconds,
      settlementGraceSeconds: marketState.settlementGraceSeconds,
    };

    const publishDecision = decideMarketPublishAction({ now, oracleFinalized: finalized, ...window });
    if (publishDecision.kind === "skip") {
      console.log(`skip: publish for market ${marketAddress} -- ${publishDecision.reason}`);
    } else {
      try {
        const { update } = await fetchLatestPythUpdate(hermes, marketState.pythFeedId);
        const result = await publishSettlementForMarket({
          connection,
          cranker,
          program,
          config,
          market: new PublicKey(marketAddress),
          oracle: oracleAddress,
          feedId: marketState.pythFeedId,
          update,
        });
        console.log(`published: settlement for market ${marketAddress} (signature ${result.signature})`);
        counters.published += 1;
        finalized = true;
      } catch (error) {
        // Covers: neither settlement tier is satisfiable yet
        // (InvalidObservationTime), a concurrent run already finalized the
        // oracle first (OracleAlreadyFinalized), Hermes has no fresh print,
        // or any other transient failure -- all are skips, never a reason to
        // abort the whole run.
        console.log(`skip: publish for market ${marketAddress} -- ${describeSettlementError(error, rpcUrl)}`);
        counters.skipped += 1;
      }
    }

    for (const position of marketPositions) {
      const decision = decidePositionAction({ now, oracleFinalized: finalized, ...window });
      if (decision.kind === "skip") {
        console.log(`skip: position ${position.address} -- ${decision.reason}`);
        counters.skipped += 1;
        continue;
      }
      try {
        if (decision.kind === "settle") {
          const signature = await settlePoolPositionOnChain({
            program,
            cranker: cranker.publicKey,
            config,
            oracle: oracleAddress,
            treasuryOwner: configAccount.treasuryOwner,
            position,
          });
          console.log(`settled: position ${position.address} (signature ${signature})`);
          counters.settled += 1;
        } else {
          const signature = await refundPoolPositionOnChain({
            program,
            cranker: cranker.publicKey,
            config,
            oracle: oracleAddress,
            position,
          });
          console.log(`refunded: position ${position.address} (signature ${signature})`);
          counters.refunded += 1;
        }
      } catch (error) {
        // A position already settled or refunded (by this cranker's own
        // prior pass, a concurrent cranker run, or the buyer settling
        // themselves) surfaces here as PositionNotOpen or an
        // account-does-not-exist error -- a skip, not a failure.
        console.log(`skip: ${decision.kind} for position ${position.address} -- ${describeSettlementError(error, rpcUrl)}`);
        counters.skipped += 1;
      }
    }
  }

  logSummary(counters);
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error), rpcUrl));
  process.exitCode = 1;
});
