import "../../../lib/runtime-env-worker";
import { lt } from "drizzle-orm";
import { ensureDb, getDb } from "../../../../db";
import { authNonces } from "../../../../db/schema";
import { json, sameOrigin, sessionSecret } from "../../../lib/session";
import { AUTH_NONCE_TTL_MS } from "../../../lib/session-token";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site sign-in requests are not allowed." }, 403);
  if (!sessionSecret(request)) {
    return json({ error: "Wallet sign-in is unavailable: SESSION_SECRET is not configured on this deployment." }, 503);
  }
  try {
    await ensureDb();
    const db = getDb();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + AUTH_NONCE_TTL_MS;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const nonce = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await db.delete(authNonces).where(lt(authNonces.expiresAt, new Date(issuedAt - 60 * 60 * 1_000)));
    await db.insert(authNonces).values({
      nonce,
      createdAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
      usedAt: null,
    });
    return json({ nonce, issuedAt, expiresAt, domain: new URL(request.url).host }, 200, { "Cache-Control": "private, no-store" });
  } catch (error) {
    console.error("Sign-in nonce issuance failed", { message: error instanceof Error ? error.message : "unknown" });
    return json({ error: "The sign-in service is temporarily unavailable. Retry shortly." }, 503);
  }
}
