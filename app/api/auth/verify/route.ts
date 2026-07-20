import "../../../lib/runtime-env-worker";
import { and, eq, isNull } from "drizzle-orm";
import nacl from "tweetnacl";
import { ensureDb, getDb } from "../../../../db";
import { authNonces } from "../../../../db/schema";
import { parsePublicKey } from "../../../lib/vsol-server";
import { issueSessionCookie, json, sameOrigin, sessionSecret } from "../../../lib/session";
import { siwsMessageBytes } from "../../../lib/siws";

const NONCE_HEX = /^[0-9a-f]{64}$/;
const MAX_SIGNATURE_BASE64 = 128;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site sign-in requests are not allowed." }, 403);
  if (!sessionSecret(request)) {
    return json({ error: "Wallet sign-in is unavailable: SESSION_SECRET is not configured on this deployment." }, 503);
  }
  const input = await request.json().catch(() => null) as {
    walletAddress?: unknown;
    nonce?: unknown;
    signature?: unknown;
  } | null;
  const wallet = parsePublicKey(input?.walletAddress);
  const nonce = typeof input?.nonce === "string" && NONCE_HEX.test(input.nonce) ? input.nonce : null;
  const encodedSignature = typeof input?.signature === "string" && input.signature.length <= MAX_SIGNATURE_BASE64
    ? input.signature
    : null;
  if (!wallet || !nonce || !encodedSignature) {
    return json({ error: "A wallet address, sign-in nonce, and signature are required." }, 422);
  }
  let signature: Uint8Array;
  try {
    signature = new Uint8Array(Buffer.from(encodedSignature, "base64"));
  } catch {
    return json({ error: "The sign-in signature is not valid base64." }, 422);
  }
  if (signature.length !== 64) return json({ error: "The sign-in signature must be a 64-byte ed25519 signature." }, 422);

  await ensureDb();
  const db = getDb();
  const [record] = await db.select().from(authNonces).where(eq(authNonces.nonce, nonce)).limit(1);
  const now = Date.now();
  if (!record || record.usedAt || record.expiresAt.getTime() <= now) {
    return json({ error: "The sign-in nonce is missing, used, or expired. Request a fresh one." }, 401);
  }

  const message = siwsMessageBytes({
    domain: new URL(request.url).host,
    walletAddress: wallet.toBase58(),
    nonce,
    issuedAtMs: record.createdAt.getTime(),
    expiresAtMs: record.expiresAt.getTime(),
  });
  if (!nacl.sign.detached.verify(message, signature, wallet.toBytes())) {
    return json({ error: "The wallet signature does not match the sign-in message." }, 401);
  }

  // Single use: only the first verification of a nonce may mint a session.
  const consumed = await db
    .update(authNonces)
    .set({ usedAt: new Date(now) })
    .where(and(eq(authNonces.nonce, nonce), isNull(authNonces.usedAt)))
    .returning({ nonce: authNonces.nonce });
  if (!consumed.length) return json({ error: "The sign-in nonce was already used. Request a fresh one." }, 409);

  const session = await issueSessionCookie(wallet.toBase58(), request);
  return json(
    { wallet: wallet.toBase58(), expiresAt: session.expiresAtMs },
    200,
    { "Set-Cookie": session.cookie, "Cache-Control": "private, no-store" },
  );
}
