import "../../../../lib/runtime-env-worker";
import { ensureDb, getDb } from "../../../../../db";
import { launchActions } from "../../../../../db/schema";
import { expiryCodes, type ExpiryCode } from "../../../../lib/expiries";
import {
  DEFAULT_POOL_MAX_POSITION_BPS,
  DEFAULT_POOL_MAX_UTILIZATION_BPS,
} from "../../../../lib/launch-params";
import {
  hashHex,
  json,
  readSessionWallet,
  resolveUserKey,
  sameOrigin,
} from "../../../../lib/session";
import {
  buildAuthorizeMarketTransaction,
  buildCreateMarketTransaction,
  buildInitializePoolTransaction,
  type LaunchKind,
} from "../../../../lib/vsol-launch";
import { parsePublicKey } from "../../../../lib/vsol-server";

const KINDS: LaunchKind[] = ["create_market", "create_pool", "authorize_market"];

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site launch requests are not allowed." }, 403);
  const userKey = await resolveUserKey(request);
  if (!userKey) return json({ error: "Sign in to prepare launch transactions." }, 401);
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  const wallet = parsePublicKey(input?.walletAddress);
  const kind = KINDS.includes(input?.kind as LaunchKind) ? input?.kind as LaunchKind : null;
  if (!wallet || !kind) return json({ error: "A valid wallet and launch action are required." }, 422);
  const sessionWallet = await readSessionWallet(request);
  if (sessionWallet && sessionWallet !== wallet.toBase58()) {
    return json({ error: "The signed-in wallet does not match this launch request." }, 403);
  }

  try {
    let transaction;
    let targetAddress: string;
    let secondaryAddress: string | null = null;
    let params: Record<string, unknown>;
    let summary: Record<string, unknown>;
    if (kind === "create_market") {
      const code = typeof input?.expiryCode === "string" && expiryCodes.includes(input.expiryCode as ExpiryCode)
        ? input.expiryCode as ExpiryCode
        : null;
      if (!code) return json({ error: "Choose a supported expiry from the published grid." }, 422);
      const built = await buildCreateMarketTransaction({ creator: wallet, code });
      transaction = built.transaction;
      targetAddress = built.marketAddress;
      secondaryAddress = built.oracleAddress;
      params = {
        code,
        marketId: built.marketId,
        expiry: built.series.expiry,
        lastTradeAt: built.series.lastTradeAt,
        observationWindowSeconds: built.series.observationWindowSeconds,
        settlementGraceSeconds: built.series.settlementGraceSeconds,
        maxConfidenceBps: built.series.maxConfidenceBps,
        maxSettlementStalenessSeconds: built.series.maxSettlementStalenessSeconds,
        symbol: built.series.symbol,
      };
      summary = { marketAddress: built.marketAddress, oracleAddress: built.oracleAddress, marketId: built.marketId, expiry: built.series.expiry, detail: built.series.detail };
    } else if (kind === "create_pool") {
      const quoteAuthority = input?.quoteAuthority === undefined || input?.quoteAuthority === ""
        ? wallet
        : parsePublicKey(input?.quoteAuthority);
      if (!quoteAuthority) return json({ error: "The pool quote authority must be a valid Solana address." }, 422);
      const maxUtilizationBps = input?.maxUtilizationBps === undefined ? DEFAULT_POOL_MAX_UTILIZATION_BPS : Number(input.maxUtilizationBps);
      const maxPositionBps = input?.maxPositionBps === undefined ? DEFAULT_POOL_MAX_POSITION_BPS : Number(input.maxPositionBps);
      const built = await buildInitializePoolTransaction({ creator: wallet, quoteAuthority, maxUtilizationBps, maxPositionBps });
      transaction = built.transaction;
      targetAddress = built.poolAddress;
      secondaryAddress = built.poolTokenAddress;
      params = {
        poolId: built.poolId,
        quoteAuthority: quoteAuthority.toBase58(),
        maxUtilizationBps,
        maxPositionBps,
      };
      summary = { poolAddress: built.poolAddress, poolTokenAddress: built.poolTokenAddress, quoteAuthority: quoteAuthority.toBase58(), maxUtilizationBps, maxPositionBps };
    } else {
      const pool = parsePublicKey(input?.poolAddress);
      const market = parsePublicKey(input?.marketAddress);
      if (!pool || !market) return json({ error: "A valid pool and market address are required." }, 422);
      const built = await buildAuthorizeMarketTransaction({ manager: wallet, pool, market });
      transaction = built.transaction;
      targetAddress = built.poolMarketAddress;
      secondaryAddress = market.toBase58();
      params = {
        poolAddress: pool.toBase58(),
        marketAddress: market.toBase58(),
        lastTradeAt: built.lastTradeAt,
        enabled: true,
      };
      summary = { poolMarketAddress: built.poolMarketAddress, poolAddress: pool.toBase58(), marketAddress: market.toBase58(), lastTradeAt: built.lastTradeAt };
    }

    const messageHash = await hashHex(transaction.serializeMessage());
    const intentId = crypto.randomUUID();
    await ensureDb();
    await getDb().insert(launchActions).values({
      id: intentId,
      userKey,
      walletAddress: wallet.toBase58(),
      kind,
      paramsJson: JSON.stringify(params),
      targetAddress,
      secondaryAddress,
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
      postStateVerified: null,
      createdAt: new Date(),
      confirmedAt: null,
    });
    return json({
      intentId,
      kind,
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      ...summary,
    }, 200, { "Cache-Control": "private, no-store" });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "The launch transaction could not be prepared." }, 422);
  }
}
