// Shared server-side request helpers: wallet session resolution, origin
// checks, and the JSON/log utilities that were previously duplicated across
// API routes. Session resolution order is: valid wallet session cookie →
// ChatGPT header identity (optional alternate) → localhost dev fallback.

import { getChatGPTUser } from "../chatgpt-auth";
import { runtimeEnv } from "./runtime-env";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  mintSessionToken,
  parseCookies,
  serializeSessionCookie,
  verifySessionToken,
} from "./session-token";

// Dev-only secret: used exclusively for localhost previews where no real
// user data exists. Production requests fail closed without SESSION_SECRET.
const LOCALHOST_DEV_SECRET = "tend-localhost-dev-session-secret";
export const LOCAL_PREVIEW_USER = "local-preview@tend.local";

export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function isLocalhostRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function sessionSecret(request: Request) {
  const configured = runtimeEnv("SESSION_SECRET");
  if (configured && configured.length >= 16) return configured;
  return isLocalhostRequest(request) ? LOCALHOST_DEV_SECRET : null;
}

export async function readSessionWallet(request: Request) {
  const secret = sessionSecret(request);
  if (!secret) return null;
  const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE_NAME];
  if (!token) return null;
  const claims = await verifySessionToken(token, secret);
  return claims?.wallet ?? null;
}

/**
 * Stable per-user key for rate limiting and provenance rows.
 * Wallet sessions are the primary identity; the ChatGPT header identity is an
 * optional alternate; localhost previews keep the historical dev fallback.
 */
export async function resolveUserKey(request: Request) {
  const wallet = await readSessionWallet(request);
  if (wallet) return `wallet:${wallet}`;
  const user = await getChatGPTUser();
  if (user?.email) return user.email;
  return isLocalhostRequest(request) ? LOCAL_PREVIEW_USER : null;
}

export async function issueSessionCookie(wallet: string, request: Request) {
  const secret = sessionSecret(request);
  if (!secret) throw new Error("SESSION_SECRET is not configured on this deployment");
  const expiresAtMs = Date.now() + SESSION_TTL_SECONDS * 1_000;
  const token = await mintSessionToken({ wallet, expiresAtMs, secret });
  return {
    expiresAtMs,
    cookie: serializeSessionCookie(token, { secure: !isLocalhostRequest(request) }),
  };
}

export function signOutCookie(request: Request) {
  return clearSessionCookie({ secure: !isLocalhostRequest(request) });
}

export async function hashHex(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function boundedLogs(logs: string[] | null | undefined) {
  const bounded: string[] = [];
  let size = 2;
  for (const log of logs?.slice(0, 160) ?? []) {
    const line = log.slice(0, 800);
    if (size + line.length > 30_000) break;
    bounded.push(line);
    size += line.length;
  }
  return bounded;
}

export function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)?.slice(0, 4_000) ?? null;
  } catch {
    return JSON.stringify({ error: "Unserializable error" });
  }
}
