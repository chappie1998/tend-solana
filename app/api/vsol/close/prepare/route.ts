import "../../../../lib/runtime-env-worker";
import { PublicKey } from "@solana/web3.js";
import { ensureDb, getDb } from "../../../../../db";
import { closeActions } from "../../../../../db/schema";
import { hashHex, json, readSessionWallet, sameOrigin } from "../../../../lib/session";
import { buildVsolCloseTransaction } from "../../../../lib/vsol-close";
import { describeRpcFailure, parsePublicKey } from "../../../../lib/vsol-server";

// Closing a position moves the buyer's money, so this route intentionally
// requires a real wallet session (SIWS) with no ChatGPT header or localhost
// dev fallback. See `/api/positions/chain` for the same pattern.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site close requests are not allowed." }, 403);
  const wallet = await readSessionWallet(request);
  if (!wallet) {
    return json({
      error: "Sign in with your wallet signature to close positions.",
      code: "WALLET_SESSION_REQUIRED",
    }, 401);
  }

  const input = await request.json().catch(() => null) as { positionAddress?: unknown; minProceeds?: unknown } | null;
  const position = parsePublicKey(input?.positionAddress);
  if (!position) return json({ error: "A valid position address is required." }, 422);
  const requestedMinProceedsDecimal = typeof input?.minProceeds === "string" && input.minProceeds.length > 0
    ? input.minProceeds
    : undefined;

  try {
    const buyer = new PublicKey(wallet);
    const quote = await buildVsolCloseTransaction({
      buyer,
      position,
      requestedMinProceedsDecimal,
    });

    const messageHash = await hashHex(quote.transaction.serializeMessage());
    const intentId = crypto.randomUUID();
    await ensureDb();
    await getDb().insert(closeActions).values({
      id: intentId,
      walletAddress: wallet,
      positionAddress: quote.positionAddress,
      poolAddress: quote.poolAddress,
      marketAddress: quote.marketAddress,
      buyerDestinationAddress: quote.buyerDestinationAddress,
      treasuryDestinationAddress: quote.treasuryDestinationAddress,
      buybackAmountAtoms: quote.buybackAmountAtoms.toString(),
      minProceedsAtoms: quote.minProceedsAtoms.toString(),
      fairValueAtoms: quote.fairValueAtoms.toString(),
      spreadBps: quote.spreadBps,
      quoteExpiry: Number(quote.quoteExpiry),
      transactionMessageHash: messageHash,
      transactionHash: null,
      simulationStatus: null,
      simulationSlot: null,
      simulationUnitsConsumed: null,
      simulationLogsJson: null,
      simulationLogsHash: null,
      simulationErrorJson: null,
      transactionSignature: null,
      submissionStatus: "prepared",
      submissionError: null,
      preBuyerAtoms: quote.preBuyerAtoms.toString(),
      postBuyerAtoms: null,
      postStateVerified: null,
      createdAt: new Date(),
      confirmedAt: null,
    });

    return json({
      intentId,
      positionAddress: quote.positionAddress,
      symbol: quote.symbol,
      direction: quote.direction,
      transaction: quote.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      buybackAtoms: quote.buybackAmountAtoms.toString(),
      minProceedsAtoms: quote.minProceedsAtoms.toString(),
      fairValueAtoms: quote.fairValueAtoms.toString(),
      maxPayoutAtoms: quote.maxPayoutAtoms.toString(),
      premiumAtoms: quote.premiumAtoms.toString(),
      settlementDecimals: quote.settlementDecimals,
      spreadBps: quote.spreadBps,
      quoteExpiry: Number(quote.quoteExpiry),
    }, 200, { "Cache-Control": "private, no-store" });
  } catch (error) {
    return json({ error: describeRpcFailure(error, "The close transaction could not be prepared.") }, 422);
  }
}
