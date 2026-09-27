// Shared RPC failover connection factory -- imported by BOTH the Next.js app
// (app/lib/vsol-server.ts, app/lib/series-resolver.ts) and the Node
// operator scripts (vsol/scripts/*.ts). One implementation, one failover
// policy, wired in everywhere a `new Connection(...)` used to be.
//
// # Why this exists
//
// The primary Helius devnet endpoint (VSOL_RPC_URL) ran out of its monthly
// quota on 2026-09-26: every call now returns JSON-RPC -32429 "max usage
// reached", which took production down. A backup endpoint (Alchemy devnet,
// VSOL_RPC_BACKUP_URL) covers most calls, but its free tier flatly refuses
// getProgramAccounts -- which the oracle runner, market discovery and the
// positions panel all depend on. The public `api.devnet.solana.com` DOES
// serve getProgramAccounts (slowly, rate-limited), so it's kept as a last
// resort. No single endpoint serves everything, so this is a per-request
// failover across an ordered list, not a single fallback URL.
//
// # Endpoint order
//
// VSOL_RPC_URL, then VSOL_RPC_BACKUP_URL if configured, then the public
// devnet RPC -- and the public fallback is added ONLY when the resolved
// cluster is "devnet" (see endpoints.ts). De-duplicated.
//
// # Failover classification (see classify.ts + fetch.ts)
//
// Per JSON-RPC request (single object or batch array body), endpoints are
// tried in priority order (healthy/capable ones first, demoted ones as a
// last-resort fallback so a real response/error always comes back -- see
// fetch.ts's computeAttemptOrder). We move to the next endpoint on:
//   - a network error or a per-attempt timeout (DEFAULT_ATTEMPT_TIMEOUT_MS),
//   - HTTP 429 or 5xx,
//   - a JSON-RPC error that means THIS ENDPOINT can't serve the request:
//     -32429 or any "max usage"/quota/rate-limit wording (endpoint-wide,
//     long cooldown -- a monthly quota doesn't come back in seconds), or
//     -32601 "method not found" / a -32600 whose message says the method is
//     "not available" on this plan (method-scoped, long cooldown -- Alchemy
//     stays in rotation for every OTHER method).
// An ORDINARY JSON-RPC error (invalid params, simulation/preflight failure,
// blockhash not found, ...) is returned to the caller unchanged, from
// whichever endpoint produced it, with NO failover -- retrying those against
// a different endpoint would mask real errors or risk re-evaluating a
// transaction simulation against different cluster state. If every endpoint
// in the attempt order fails, the LAST response/error is returned as-is, so
// web3.js's own error handling and its built-in 429 backoff (it retries its
// own `fetch` call up to 5 times with growing delay -- see
// createRpcClient in node_modules/@solana/web3.js/src/connection.ts) still
// apply on top.
//
// Endpoints demoted by a failure are skipped for a cooldown (longer for a
// quota/rate-limit signal than for a bare transient 429/5xx/network error);
// a method-unavailable endpoint is skipped for JUST that method. Every
// demotion is logged once, at the moment it starts, redacted to host only
// (redact.ts) -- never again while the cooldown is still active, so a dead
// endpoint doesn't spam the log on every subsequent request.
//
// # Confirmation
//
// See confirm.ts's module doc: web3.js's own confirmTransaction subscribes
// over a websocket to whichever endpoint the Connection was constructed
// with, entirely bypassing this module's HTTP failover. createVsolConnection
// extends whichever Connection class is injected (see ConnectionClass below
// and confirm.ts's module doc for why that has to be injectable rather than
// hardcoded) with an override that polls getSignatureStatuses/getBlockHeight
// over HTTP instead (so confirmation gets the same failover as everything
// else), preserving return shape, commitment semantics and error types.
import { Connection, type Commitment, type ConnectionConfig, type HttpHeaders } from "@solana/web3.js";
import { DEFAULT_ATTEMPT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS } from "./constants.ts";
import { resolveVsolRpcEndpoints, type ResolveEndpointsOptions } from "./endpoints.ts";
import { createFailoverFetch } from "./fetch.ts";
import { createFailoverState } from "./state.ts";
import { createFailoverConnectionClass, type ConnectionConstructor, type ConnectionLike } from "./confirm.ts";
import type { FailoverState } from "./types.ts";

export type { FailoverEndpoint, FailoverState } from "./types.ts";
export { createFailoverState } from "./state.ts";
export { resolveVsolRpcEndpoints } from "./endpoints.ts";
export { redactRpcUrl } from "./redact.ts";
export { createFailoverConnectionClass, type ConnectionConstructor, type ConnectionLike } from "./confirm.ts";
export {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  TRANSIENT_COOLDOWN_MS,
  QUOTA_COOLDOWN_MS,
  METHOD_UNAVAILABLE_COOLDOWN_MS,
  PUBLIC_DEVNET_RPC_URL,
} from "./constants.ts";

export type CreateVsolConnectionOptions<T extends ConnectionLike = Connection> = ResolveEndpointsOptions & {
  commitment?: Commitment;
  confirmTransactionInitialTimeout?: number;
  disableRetryOnRateLimit?: boolean;
  httpHeaders?: HttpHeaders;
  // Per-attempt HTTP timeout before an endpoint is treated as failed.
  attemptTimeoutMs?: number;
  // How often confirmTransaction's HTTP polling checks signature status.
  confirmPollIntervalMs?: number;
  // The Connection class to extend. Defaults to THIS module's own
  // vsol-local @solana/web3.js Connection -- correct for vsol/scripts, which
  // resolve @solana/web3.js the same way (vsol/package.json pins 1.98.4
  // exactly). app/lib callers MUST pass their own root-resolved Connection
  // here instead (root's package.json wants ^1.99.0): see confirm.ts's
  // module doc for why a single hardcoded base class can't satisfy both --
  // TypeScript treats the two copies' Connection classes as nominally
  // different (private members), and at runtime they are genuinely
  // different prototype chains, which matters for anything (including
  // tests) that mocks Connection.prototype methods.
  ConnectionClass?: ConnectionConstructor<T>;
  // --- test-only seams, never used by production call sites ---
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: (line: string) => void;
  // Shared cooldown/method-availability bookkeeping. Omit in production to
  // use the module-level singleton for the resolved endpoint list (so
  // cooldowns and their one-time log line persist across the many
  // createVsolConnection() calls a single process makes over its lifetime).
  // Tests should always pass their own via createFailoverState(), so runs
  // never share state with each other.
  state?: FailoverState;
};

// One shared FailoverState per distinct resolved endpoint list, so cooldown
// bookkeeping (and its "log once" behavior) persists across the many
// createVsolConnection() calls a single long-lived process makes -- e.g.
// app/lib/vsol-server.ts's getVsolConnection() is called fresh on nearly
// every request. Keyed on the endpoint URLs themselves (not on the request
// options), so two calls that resolve to the same endpoints share bookkeeping
// even if one passed rpcUrl explicitly and the other relied on the default.
const sharedStatesByEndpointKey = new Map<string, FailoverState>();

function sharedState(endpointKey: string): FailoverState {
  let state = sharedStatesByEndpointKey.get(endpointKey);
  if (!state) {
    state = createFailoverState();
    sharedStatesByEndpointKey.set(endpointKey, state);
  }
  return state;
}

// One patched class per (Base class, poll interval) pair, so repeated
// createVsolConnection() calls with the default options don't redefine a
// fresh class on every call.
const connectionClassCache = new Map<ConnectionConstructor, Map<number, ConnectionConstructor>>();

function patchedConnectionClass<T extends ConnectionLike>(Base: ConnectionConstructor<T>, pollIntervalMs: number): ConnectionConstructor<T> {
  let byInterval = connectionClassCache.get(Base as ConnectionConstructor);
  if (!byInterval) {
    byInterval = new Map();
    connectionClassCache.set(Base as ConnectionConstructor, byInterval);
  }
  let patched = byInterval.get(pollIntervalMs);
  if (!patched) {
    patched = createFailoverConnectionClass(Base as ConnectionConstructor, pollIntervalMs);
    byInterval.set(pollIntervalMs, patched);
  }
  return patched as ConnectionConstructor<T>;
}

/**
 * Returns a Connection that fails over across VSOL_RPC_URL / VSOL_RPC_BACKUP_URL
 * / (devnet only) the public devnet RPC, per-request, and whose
 * confirmTransaction polls over that same failover HTTP path instead of a
 * single endpoint's websocket. Drop-in replacement for `new Connection(url,
 * commitmentOrConfig)` -- every existing call site's commitment/options keep
 * working the same way. app/lib callers must pass `ConnectionClass` (see
 * CreateVsolConnectionOptions's doc comment); vsol/scripts callers can omit
 * it.
 */
export function createVsolConnection<T extends ConnectionLike = Connection>(options: CreateVsolConnectionOptions<T> = {}): T {
  const endpoints = resolveVsolRpcEndpoints({
    rpcUrl: options.rpcUrl,
    backupRpcUrl: options.backupRpcUrl,
    cluster: options.cluster,
  });
  if (endpoints.length === 0) {
    throw new Error("createVsolConnection: no RPC endpoint configured (VSOL_RPC_URL is unset and the manifest has no rpcUrl)");
  }

  const state = options.state ?? sharedState(endpoints.map((e) => e.url).join("|"));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? ((line: string) => console.error(line));
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;

  const failoverFetch = createFailoverFetch(endpoints, { fetchImpl, now, logger, attemptTimeoutMs, state });

  const config: ConnectionConfig = {
    commitment: options.commitment,
    confirmTransactionInitialTimeout: options.confirmTransactionInitialTimeout,
    disableRetryOnRateLimit: options.disableRetryOnRateLimit,
    httpHeaders: options.httpHeaders,
    fetch: failoverFetch,
  };

  const Base = (options.ConnectionClass ?? (Connection as unknown as ConnectionConstructor<T>)) as ConnectionConstructor<T>;
  const ConnectionClass = patchedConnectionClass(Base, options.confirmPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  // The primary endpoint's URL is what Connection's constructor stores as
  // `rpcEndpoint` and uses to build a (never-used -- see confirm.ts) default
  // ws endpoint; the actual HTTP target per request is entirely decided by
  // failoverFetch above, which ignores this argument.
  return new ConnectionClass(endpoints[0].url, config);
}
