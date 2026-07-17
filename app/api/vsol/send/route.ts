import { Transaction } from "@solana/web3.js";
import { decodeSignedTransaction, isVsolFillTransaction, VSOL_CONNECTION } from "../../../lib/vsol-server";
import { getChatGPTUser } from "../../../chatgpt-auth";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function authorized(request: Request) {
  if (await getChatGPTUser()) return true;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-site transaction requests are not allowed." }, { status: 403 });
  if (!(await authorized(request))) return Response.json({ error: "Sign in to submit transactions." }, { status: 401 });
  const input = await request.json().catch(() => null) as { transaction?: unknown } | null;
  if (typeof input?.transaction !== "string") return Response.json({ error: "A signed transaction is required." }, { status: 422 });
  try {
    const raw = decodeSignedTransaction(input.transaction);
    const transaction = Transaction.from(raw);
    if (!transaction.verifySignatures()) return Response.json({ error: "The wallet signature is invalid." }, { status: 422 });
    if (!isVsolFillTransaction(transaction)) {
      return Response.json({ error: "Only maker-signed VSOL fill transactions are accepted." }, { status: 422 });
    }
    const signature = await VSOL_CONNECTION.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
    const confirmation = await VSOL_CONNECTION.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    return Response.json({ signature });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transaction failed";
    return Response.json({ error: `Devnet rejected the transaction: ${message.slice(0, 220)}` }, { status: 422 });
  }
}
