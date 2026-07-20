// Wallet session tokens: HMAC-SHA256 signed, HTTP-only cookie payloads.
// Pure module (WebCrypto + Buffer only) so both the Cloudflare worker runtime
// and the node:test suite can exercise the exact same code path.

export const SESSION_COOKIE_NAME = "tend_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const AUTH_NONCE_TTL_MS = 5 * 60 * 1_000;

const TOKEN_VERSION = "v1";
const BASE58_WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type SessionClaims = {
  wallet: string;
  expiresAtMs: number;
};

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

async function hmacSha256(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function mintSessionToken(params: { wallet: string; expiresAtMs: number; secret: string }) {
  if (!BASE58_WALLET.test(params.wallet)) throw new Error("Session wallet must be a base58 Solana address");
  if (!Number.isSafeInteger(params.expiresAtMs) || params.expiresAtMs <= 0) throw new Error("Session expiry is invalid");
  if (!params.secret || params.secret.length < 16) throw new Error("Session secret must be at least 16 characters");
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ w: params.wallet, e: params.expiresAtMs })));
  const signature = await hmacSha256(params.secret, `${TOKEN_VERSION}.${payload}`);
  return `${TOKEN_VERSION}.${payload}.${base64Url(signature)}`;
}

export async function verifySessionToken(token: string, secret: string, nowMs = Date.now()): Promise<SessionClaims | null> {
  if (typeof token !== "string" || token.length > 512 || !secret) return null;
  const segments = token.split(".");
  if (segments.length !== 3 || segments[0] !== TOKEN_VERSION) return null;
  const [, payload, providedSignature] = segments;
  let expected: Uint8Array;
  try {
    expected = await hmacSha256(secret, `${TOKEN_VERSION}.${payload}`);
  } catch {
    return null;
  }
  const provided = new Uint8Array(Buffer.from(providedSignature, "base64url"));
  if (!constantTimeEqual(expected, provided)) return null;
  let claims: { w?: unknown; e?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { w?: unknown; e?: unknown };
  } catch {
    return null;
  }
  if (typeof claims.w !== "string" || !BASE58_WALLET.test(claims.w)) return null;
  if (typeof claims.e !== "number" || !Number.isSafeInteger(claims.e) || claims.e <= nowMs) return null;
  return { wallet: claims.w, expiresAtMs: claims.e };
}

export function parseCookies(header: string | null) {
  const cookies: Record<string, string> = {};
  if (!header || header.length > 8_192) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

export function serializeSessionCookie(token: string, options: { secure: boolean; maxAgeSeconds?: number }) {
  const maxAge = options.maxAgeSeconds ?? SESSION_TTL_SECONDS;
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(options: { secure: boolean }) {
  return serializeSessionCookie("", { secure: options.secure, maxAgeSeconds: 0 });
}
