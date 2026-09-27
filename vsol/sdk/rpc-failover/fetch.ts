// The custom `fetch` handed to `new Connection(url, { fetch })`. web3.js
// always calls this with the SAME url (whatever the Connection was
// constructed with) and the JSON-RPC payload in `init.body` -- it has no
// concept of multiple endpoints. This function is what actually adds
// failover: it ignores the incoming `info` argument's host and instead
// tries each of `endpoints`, in priority order, reusing `init`'s method/
// headers/body against each one in turn.
//
// See index.ts's module doc for the full failover contract this
// implements; this file is just the mechanism.

import { classifyHttpStatus, classifyJsonRpcError, parseJsonRpcRequests } from "./classify.ts";
import { METHOD_UNAVAILABLE_COOLDOWN_MS, QUOTA_COOLDOWN_MS, TRANSIENT_COOLDOWN_MS } from "./constants.ts";
import { isEndpointCoolingDown, isMethodUnavailable, recordEndpointFailure, recordMethodUnavailable } from "./state.ts";
import type { FailoverEndpoint, FailoverState } from "./types.ts";

export type CreateFailoverFetchOptions = {
  fetchImpl: typeof fetch;
  now: () => number;
  logger: (line: string) => void;
  attemptTimeoutMs: number;
  state: FailoverState;
};

/** Orders `endpoints` for one request: endpoints that are neither globally cooling down nor demoted for any of `methods` come first (in their configured priority order); everything else follows, in the same relative order, as a fallback so we ALWAYS make at least one real attempt and can hand back a real response/error rather than synthesizing one. */
function computeAttemptOrder(
  state: FailoverState,
  endpoints: FailoverEndpoint[],
  methods: Set<string>,
  now: number,
): FailoverEndpoint[] {
  const preferred: FailoverEndpoint[] = [];
  const fallback: FailoverEndpoint[] = [];
  for (const endpoint of endpoints) {
    const coolingDown = isEndpointCoolingDown(state, endpoint.url, now);
    const methodBlocked = !coolingDown && [...methods].some((method) => isMethodUnavailable(state, endpoint.url, method, now));
    if (!coolingDown && !methodBlocked) preferred.push(endpoint);
    else fallback.push(endpoint);
  }
  return [...preferred, ...fallback];
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`vsol rpc-failover: attempt timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Builds the `fetch` function to pass as `new Connection(url, { fetch }).` */
export function createFailoverFetch(endpoints: FailoverEndpoint[], options: CreateFailoverFetchOptions): typeof fetch {
  const { fetchImpl, now, logger, attemptTimeoutMs, state } = options;

  return async function failoverFetch(_info: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const requests = parseJsonRpcRequests(bodyText);
    const idToMethod = new Map(requests.map((r) => [String(r.id), r.method]));
    const methods = new Set(requests.map((r) => r.method).filter((m): m is string => Boolean(m)));

    const order = computeAttemptOrder(state, endpoints, methods, now());
    let lastResponse: Response | undefined;
    let lastError: unknown;

    for (let i = 0; i < order.length; i++) {
      const endpoint = order[i];
      const isLast = i === order.length - 1;

      let res: Response;
      try {
        res = await fetchWithTimeout(fetchImpl, endpoint.url, init, attemptTimeoutMs);
      } catch (err) {
        recordEndpointFailure(state, endpoint.url, TRANSIENT_COOLDOWN_MS, `network error: ${describeError(err)}`, now(), logger);
        lastError = err;
        if (isLast) throw err;
        continue;
      }

      const httpFault = classifyHttpStatus(res.status);
      if (httpFault) {
        recordEndpointFailure(state, endpoint.url, TRANSIENT_COOLDOWN_MS, httpFault.cooldownReason, now(), logger);
        lastResponse = res;
        if (isLast) return res;
        continue;
      }

      // Inspect the body for a JSON-RPC-level endpoint fault. Clone first --
      // the real Response body can only be consumed once, and we must still
      // hand back an unconsumed Response to the caller (web3.js) either way.
      let parsedBody: unknown;
      try {
        parsedBody = await res.clone().json();
      } catch {
        // Not JSON (or empty body) -- nothing more we can classify. Return
        // as-is rather than guessing.
        return res;
      }

      const items = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
      let quotaHit = false;
      const methodFaults: Array<{ method: string; message: string }> = [];
      for (const item of items) {
        const error = item && typeof item === "object" ? (item as { error?: { code?: number; message?: string } }).error : undefined;
        const classification = classifyJsonRpcError(error);
        if (classification.kind === "quota") {
          quotaHit = true;
        } else if (classification.kind === "method-unavailable") {
          const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
          const method = idToMethod.get(String(id)) ?? "unknown-method";
          methodFaults.push({ method, message: error?.message ?? "" });
        }
      }

      if (quotaHit) {
        recordEndpointFailure(state, endpoint.url, QUOTA_COOLDOWN_MS, "quota/rate-limit JSON-RPC error", now(), logger);
        lastResponse = res;
        if (isLast) return res;
        continue;
      }

      if (methodFaults.length > 0) {
        for (const fault of methodFaults) {
          recordMethodUnavailable(state, endpoint.url, fault.method, METHOD_UNAVAILABLE_COOLDOWN_MS, fault.message || "method unavailable", now(), logger);
        }
        lastResponse = res;
        if (isLast) return res;
        continue;
      }

      // Fully successful, or carrying only ORDINARY JSON-RPC errors (invalid
      // params, simulation failure, blockhash not found, ...) -- those are
      // about the request, not the endpoint, so hand the response back
      // unchanged instead of masking them by trying another endpoint.
      return res;
    }

    if (lastResponse) return lastResponse;
    throw lastError ?? new Error("vsol rpc-failover: no endpoints configured");
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
