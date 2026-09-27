import type { JsonRpcErrorClassification, JsonRpcRequestMeta } from "./types.ts";

// A quota/rate-limit signal, independent of JSON-RPC error code: Helius uses
// -32429 specifically, but other providers phrase the same condition as a
// plain -32600/-32000 with wording like "monthly quota exceeded" or "rate
// limit exceeded" -- match the wording too, not just Helius's exact code.
const QUOTA_MESSAGE_PATTERN = /max usage|quota|rate.?limit/i;

// Tier-restriction wording providers use for a -32600 "Invalid Request" that
// really means "your plan doesn't get this method" (e.g. Alchemy's free tier
// on getProgramAccounts), as opposed to an actually-malformed request.
const TIER_RESTRICTION_MESSAGE_PATTERN = /not available/i;

/** Parses a JSON-RPC request body (single object or batch array) into {id, method} pairs. Returns [] if it isn't parseable JSON -- callers then skip method-based classification entirely rather than guessing. */
export function parseJsonRpcRequests(bodyText: string | undefined | null): JsonRpcRequestMeta[] {
  if (!bodyText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    const record = item as Record<string, unknown> | null;
    const method = record != null && typeof record.method === "string" ? record.method : undefined;
    return { id: record?.id, method };
  });
}

/** HTTP-level classification, checked before any body parsing. Returns a cooldown bucket, or null when the body still needs inspecting. */
export function classifyHttpStatus(status: number): { cooldownReason: string } | null {
  if (status === 429) return { cooldownReason: "HTTP 429" };
  if (status >= 500) return { cooldownReason: `HTTP ${status}` };
  return null;
}

/** Classifies a single JSON-RPC response item's `error` field (undefined when the item succeeded). */
export function classifyJsonRpcError(error: { code?: number; message?: string } | null | undefined): JsonRpcErrorClassification {
  if (error == null) return { kind: "none" };
  const message = typeof error.message === "string" ? error.message : "";
  if (error.code === -32429 || QUOTA_MESSAGE_PATTERN.test(message)) return { kind: "quota" };
  if (error.code === -32601) return { kind: "method-unavailable" };
  if (error.code === -32600 && TIER_RESTRICTION_MESSAGE_PATTERN.test(message)) return { kind: "method-unavailable" };
  return { kind: "ordinary" };
}
