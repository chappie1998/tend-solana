// Server-side builder and inspector for the buyer "sell before expiry" flow:
// close_pool_position lets a buyer exit an open pool position early by
// selling it back to the pool at a price this server's quote authority
// quotes and signs one-shot (the same Ed25519 pattern fills use), and the
// buyer countersigns by submitting the transaction. This server never holds
// the buyer's keys -- only the pool's quote authority, exactly like fills.

import {
  Connection,
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  deriveLiquidityPoolToken,
  deriveOracle,
  derivePoolPositionVault,
  poolBuybackMessage,
} from "../../vsol/sdk";
import { VSOL_CLOSE_POSITION_DEPLOYED, VSOL_CONFIG, VSOL_LIQUIDITY, VSOL_PROGRAM_ID, VSOL_SETTLEMENT_MINT } from "./vsol";
import {
  buildVsolIdlInstruction,
  decodeConfigAccount,
  decodeMarketAccount,
  decodeOracleAccount,
  encodeI64,
  encodeU64,
  getVsolClusterTime,
  getVsolConnection,
  vsolInstructionDiscriminator,
  vsolQuoteAuthority,
} from "./vsol-server";
import {
  decodePoolPositionAccount,
  POOL_POSITION_STATUS_OPEN,
  priceScaleDecimals,
  type DecodedPoolPosition,
} from "./pool-position";
import { marketBySymbol } from "./markets";
import { getPythSnapshot } from "./pyth-market-data";
import { buybackFor } from "./options";

const CLOSE_POOL_POSITION_ACCOUNT_COUNT = 14;
const CLOSE_POOL_POSITION_DATA_LENGTH = 8 + 8 + 8 + 8;

function parseDecimalAtoms(value: string, decimals: number) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("Enter a non-negative decimal amount.");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const atoms = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
  if (atoms < 0n || atoms > 0xffff_ffff_ffff_ffffn) throw new Error("The amount is outside the supported range.");
  return atoms;
}

function atomsToNumber(atoms: bigint, decimals: number) {
  return Number(atoms) / 10 ** decimals;
}

function numberToAtoms(value: number, decimals: number) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Cannot convert a negative or non-finite value to atoms");
  return BigInt(Math.round(value * 10 ** decimals));
}

async function fetchOpenPoolPosition(position: PublicKey, connection: Connection): Promise<DecodedPoolPosition> {
  const account = await connection.getAccountInfo(position, "confirmed");
  if (!account || !account.owner.equals(VSOL_PROGRAM_ID)) {
    throw new Error("This position was not found onchain.");
  }
  const decoded = decodePoolPositionAccount(Buffer.from(account.data));
  if (decoded.status !== POOL_POSITION_STATUS_OPEN) throw new Error("This position is no longer open.");
  return decoded;
}

export type VsolCloseQuote = {
  transaction: Transaction;
  positionAddress: string;
  poolAddress: string;
  marketAddress: string;
  buyerDestinationAddress: string;
  treasuryDestinationAddress: string;
  buybackAmountAtoms: bigint;
  minProceedsAtoms: bigint;
  fairValueAtoms: bigint;
  maxPayoutAtoms: bigint;
  premiumAtoms: bigint;
  settlementDecimals: number;
  spreadBps: number;
  quoteExpiry: bigint;
  preBuyerAtoms: bigint;
  direction: "up" | "down";
  symbol: string;
};

/**
 * Builds the Ed25519 + `close_pool_position` instruction pair for a buyer to
 * sell an open pool position back to the pool before expiry. Fetches the
 * position, market, config, and oracle onchain; prices the buyback with
 * `buybackFor`; signs the one-shot quote with this server's pool quote
 * authority; and returns the unsigned transaction plus the priced quote.
 */
export async function buildVsolCloseTransaction(params: {
  buyer: PublicKey;
  position: PublicKey;
  requestedMinProceedsDecimal?: string;
  connection?: Connection;
}): Promise<VsolCloseQuote> {
  if (!VSOL_CLOSE_POSITION_DEPLOYED) {
    throw new Error(
      "Early close is not yet live: the devnet program has not been redeployed with close_pool_position.",
    );
  }
  if (!VSOL_LIQUIDITY) throw new Error("The verified VSOL V2 liquidity pool is not published");
  const connection = params.connection ?? getVsolConnection();

  const position = await fetchOpenPoolPosition(params.position, connection);
  if (!position.buyer.equals(params.buyer)) {
    throw new Error("This position does not belong to the signed-in wallet.");
  }
  if (!position.pool.equals(VSOL_LIQUIDITY.poolKey) || !position.quoteAuthority.equals(VSOL_LIQUIDITY.quoteAuthorityKey)) {
    throw new Error("This position's pool is not the verified V2 liquidity pool this server can quote for.");
  }
  if (!position.settlementMint.equals(VSOL_SETTLEMENT_MINT)) {
    throw new Error("This position's settlement mint does not match the verified deployment.");
  }

  const [marketAccount, configAccount, oracleAddress, now] = await Promise.all([
    connection.getAccountInfo(position.market, "confirmed"),
    connection.getAccountInfo(VSOL_CONFIG, "confirmed"),
    Promise.resolve(deriveOracle(position.market)),
    getVsolClusterTime(connection),
  ]);
  if (!marketAccount || !marketAccount.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The market for this position is unavailable onchain.");
  if (!configAccount || !configAccount.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The VSOL config is unavailable onchain.");
  const market = decodeMarketAccount(Buffer.from(marketAccount.data));
  const config = decodeConfigAccount(Buffer.from(configAccount.data));
  if (!market.settlementMint.equals(VSOL_SETTLEMENT_MINT)) throw new Error("The market's settlement mint does not match the verified deployment.");
  if (now >= market.expiry) throw new Error("This series has already expired onchain; settle the position instead of closing it.");

  const oracleAccount = await connection.getAccountInfo(oracleAddress, "confirmed");
  if (!oracleAccount || !oracleAccount.owner.equals(VSOL_PROGRAM_ID)) throw new Error("The settlement oracle for this position is unavailable onchain.");
  const oracle = decodeOracleAccount(Buffer.from(oracleAccount.data));
  if (oracle.finalized) throw new Error("This series has already settled onchain; the position must settle instead of closing.");

  const marketDefinition = marketBySymbol(market.symbol);
  if (!marketDefinition) throw new Error(`No supported pricing feed is published for ${market.symbol || "this market"}.`);
  // Only the spot price and its staleness matter here: `buybackFor` anchors
  // time value to the premium already paid rather than re-deriving it from
  // volatility (volatility is already priced into that premium by `quoteFor`
  // at inception), so realized volatility is not needed for a close quote.
  const snapshot = await getPythSnapshot(marketDefinition);

  const priceDecimals = priceScaleDecimals(market.priceScale);
  const strikeFloat = atomsToNumber(position.strike, priceDecimals);
  const capAtoms = position.direction === "up"
    ? position.strike + position.width
    : position.strike > position.width ? position.strike - position.width : 0n;
  const capFloat = atomsToNumber(capAtoms, priceDecimals);
  const settlementDecimals = market.settlementDecimals;
  const maxPayoutFloat = atomsToNumber(position.maxPayout, settlementDecimals);
  const premiumFloat = atomsToNumber(position.premium, settlementDecimals);

  const minutesRemaining = Math.max(0, (market.expiry - now) / 60);
  const originalMinutes = Math.max(1, (market.expiry - position.openedAt) / 60);

  const economics = buybackFor({
    direction: position.direction,
    spot: snapshot.price,
    strike: strikeFloat,
    cap: capFloat,
    maxPayout: maxPayoutFloat,
    premium: premiumFloat,
    minutesRemaining,
    originalMinutes,
    referenceAgeSeconds: snapshot.ageSeconds,
  });

  const fairValueAtoms = numberToAtoms(economics.fairValue, settlementDecimals);
  const quotedBuybackAtoms = (() => {
    const raw = numberToAtoms(economics.buyback, settlementDecimals);
    return raw > position.maxPayout ? position.maxPayout : raw;
  })();

  const minProceedsAtoms = params.requestedMinProceedsDecimal === undefined
    ? quotedBuybackAtoms
    : (() => {
      const requested = parseDecimalAtoms(params.requestedMinProceedsDecimal!, settlementDecimals);
      if (requested > quotedBuybackAtoms) {
        throw new Error("The requested minimum proceeds are above the quoted buyback. Refresh the quote and try again.");
      }
      return requested;
    })();

  const quoteExpiry = BigInt(Math.min(now + 30, market.expiry - 1));
  if (quoteExpiry <= BigInt(now)) throw new Error("This series is too close to expiry to quote an early close.");

  const buyerDestination = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, params.buyer);
  const buyerDestinationInfo = await connection.getAccountInfo(buyerDestination, "confirmed");
  if (!buyerDestinationInfo) {
    throw new Error("Claim devnet test USDC (or otherwise create your tUSDC account) before closing a position.");
  }
  const buyerToken = await getAccount(connection, buyerDestination, "confirmed", TOKEN_PROGRAM_ID);
  const preBuyerAtoms = buyerToken.amount;

  const treasuryDestination = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, config.treasuryOwner);
  const treasuryDestinationInfo = await connection.getAccountInfo(treasuryDestination, "confirmed");
  if (!treasuryDestinationInfo) throw new Error("The protocol treasury token account is not initialized on devnet.");

  const poolToken = deriveLiquidityPoolToken(VSOL_LIQUIDITY.poolKey);
  const positionVault = derivePoolPositionVault(params.position);
  const authority = vsolQuoteAuthority();

  const message = poolBuybackMessage({
    domainSeparator: config.domainSeparator,
    domainVersion: config.domainVersion,
    config: VSOL_CONFIG,
    pool: VSOL_LIQUIDITY.poolKey,
    market: position.market,
    position: params.position,
    buyer: params.buyer,
    quoteAuthority: authority.publicKey,
    buyback: {
      buybackAmount: quotedBuybackAtoms,
      minProceeds: minProceedsAtoms,
      quoteExpiry,
    },
  });
  const signature = nacl.sign.detached(message, authority.secretKey);
  const signatureInstruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: authority.publicKey.toBytes(),
    message,
    signature,
  });

  const data = Buffer.concat([encodeU64(quotedBuybackAtoms), encodeU64(minProceedsAtoms), encodeI64(quoteExpiry)]);
  const closeInstruction = buildVsolIdlInstruction("close_pool_position", {
    buyer: params.buyer,
    config: VSOL_CONFIG,
    pool: VSOL_LIQUIDITY.poolKey,
    market: position.market,
    oracle: oracleAddress,
    position: params.position,
    position_vault: positionVault,
    settlement_mint: VSOL_SETTLEMENT_MINT,
    buyer_destination: buyerDestination,
    pool_token: poolToken,
    treasury_destination: treasuryDestination,
    rent_recipient: params.buyer,
    instructions_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    token_program: TOKEN_PROGRAM_ID,
  }, data);

  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: params.buyer,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(signatureInstruction, closeInstruction);

  return {
    transaction,
    positionAddress: params.position.toBase58(),
    poolAddress: VSOL_LIQUIDITY.poolKey.toBase58(),
    marketAddress: position.market.toBase58(),
    buyerDestinationAddress: buyerDestination.toBase58(),
    treasuryDestinationAddress: treasuryDestination.toBase58(),
    buybackAmountAtoms: quotedBuybackAtoms,
    minProceedsAtoms,
    fairValueAtoms,
    maxPayoutAtoms: position.maxPayout,
    premiumAtoms: position.premium,
    settlementDecimals,
    spreadBps: economics.spreadBps,
    quoteExpiry,
    preBuyerAtoms,
    direction: position.direction,
    symbol: market.symbol,
  };
}

function isVsolCloseTransaction(transaction: Transaction) {
  if (transaction.instructions.length !== 2 || !VSOL_LIQUIDITY) return false;
  const [signatureInstruction, closeInstruction] = transaction.instructions;
  return signatureInstruction.programId.equals(Ed25519Program.programId)
    && closeInstruction.programId.equals(VSOL_PROGRAM_ID)
    && Buffer.from(closeInstruction.data).subarray(0, 8).equals(vsolInstructionDiscriminator("close_pool_position"));
}

/**
 * Strict shape check for a signed close transaction, mirroring
 * `inspectVsolFillTransaction`: verifies the exact instruction pair,
 * discriminator, and account list before the send route trusts anything in
 * it. The static accounts (config/pool/settlement mint/position vault/pool
 * token/sysvars) are checked here; the dynamic ones (buyer, market, buyer
 * destination, treasury destination, and the quoted amounts) are returned
 * for the caller to cross-check against the prepared intent row.
 */
export function inspectVsolCloseTransaction(transaction: Transaction) {
  if (!isVsolCloseTransaction(transaction) || !VSOL_LIQUIDITY) return null;
  const close = transaction.instructions[1];
  if (close.keys.length !== CLOSE_POOL_POSITION_ACCOUNT_COUNT || close.data.length !== CLOSE_POOL_POSITION_DATA_LENGTH) return null;
  const [
    buyer, config, pool, market, oracle, position, positionVault,
    settlementMint, buyerDestination, poolToken, treasuryDestination,
    rentRecipient, instructionsSysvar, tokenProgram,
  ] = close.keys;
  if (!buyer.isSigner) return null;
  if (!rentRecipient.pubkey.equals(buyer.pubkey) || !rentRecipient.isWritable) return null;
  if (!config.pubkey.equals(VSOL_CONFIG)) return null;
  if (!pool.pubkey.equals(VSOL_LIQUIDITY.poolKey) || !pool.isWritable) return null;
  if (!settlementMint.pubkey.equals(VSOL_SETTLEMENT_MINT)) return null;
  if (!oracle.pubkey.equals(deriveOracle(market.pubkey))) return null;
  if (!position.isWritable) return null;
  if (!positionVault.pubkey.equals(derivePoolPositionVault(position.pubkey)) || !positionVault.isWritable) return null;
  if (!poolToken.pubkey.equals(deriveLiquidityPoolToken(VSOL_LIQUIDITY.poolKey)) || !poolToken.isWritable) return null;
  if (!buyerDestination.pubkey.equals(getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, buyer.pubkey)) || !buyerDestination.isWritable) return null;
  if (!treasuryDestination.isWritable) return null;
  if (!instructionsSysvar.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)) return null;
  if (!tokenProgram.pubkey.equals(TOKEN_PROGRAM_ID)) return null;

  const data = Buffer.from(close.data);
  const buybackAmount = data.readBigUInt64LE(8);
  const minProceeds = data.readBigUInt64LE(16);
  const quoteExpiry = data.readBigInt64LE(24);
  return {
    buyer: buyer.pubkey,
    market: market.pubkey,
    position: position.pubkey,
    buyerDestination: buyerDestination.pubkey,
    treasuryDestination: treasuryDestination.pubkey,
    buybackAmount,
    minProceeds,
    quoteExpiry,
  };
}
