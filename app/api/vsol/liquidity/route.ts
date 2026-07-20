import "../../../lib/runtime-env-worker";
import { resolveUserKey } from "../../../lib/session";
import { describeRpcFailure, getVsolLiquidityState, parsePublicKey } from "../../../lib/vsol-server";

export async function GET(request: Request) {
  if (!(await resolveUserKey(request))) return Response.json({ error: "Sign in to read liquidity balances." }, { status: 401 });
  const wallet = parsePublicKey(new URL(request.url).searchParams.get("walletAddress"));
  if (!wallet) return Response.json({ error: "Connect a valid Solana wallet." }, { status: 422 });
  try {
    return Response.json(await getVsolLiquidityState(wallet), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const reason = describeRpcFailure(error, "The V2 liquidity pool could not be verified.");
    return Response.json({ ready: false, reason, checkedAt: new Date().toISOString(), error: reason }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
