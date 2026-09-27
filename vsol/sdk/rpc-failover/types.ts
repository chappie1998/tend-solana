// Shared types for the RPC failover layer. Kept in one small file so
// state.ts, classify.ts, fetch.ts and index.ts can all depend on the shapes
// without importing each other's implementation.

/** One candidate JSON-RPC HTTP endpoint, in priority order. */
export type FailoverEndpoint = {
  url: string;
};

/** Per-endpoint bookkeeping: a global cooldown plus per-method cooldowns. */
export type EndpointFailureState = {
  // ms epoch until which this endpoint is skipped for EVERY method. 0 means
  // "not cooling down".
  cooldownUntil: number;
  // ms epoch this endpoint's cooldown was last (re)logged at, so a demotion
  // that is still in effect doesn't re-log on every subsequent request.
  cooldownLoggedUntil: number;
  // method name -> ms epoch until which THIS endpoint is skipped for THAT
  // method only (e.g. Alchemy's free tier rejecting getProgramAccounts,
  // while everything else on Alchemy keeps working).
  methodCooldownUntil: Map<string, number>;
  methodCooldownLoggedUntil: Map<string, number>;
};

/**
 * All the mutable bookkeeping the failover fetch needs, shared across
 * however many requests flow through one createVsolConnection() call (or,
 * for the default production singleton, across every call sharing the same
 * resolved endpoint list within this process). Create with
 * createFailoverState(); tests should always construct their own so runs
 * never share cooldown state with each other.
 */
export type FailoverState = {
  endpoints: Map<string, EndpointFailureState>;
};

/** One decoded {id, method} pair pulled out of a JSON-RPC request payload. */
export type JsonRpcRequestMeta = {
  id: unknown;
  method?: string;
};

export type JsonRpcErrorClassification =
  | { kind: "none" }
  | { kind: "quota" }
  | { kind: "method-unavailable" }
  | { kind: "ordinary" };

/** Injectable seams so tests never touch the real network or real clock. */
export type FailoverRuntimeOptions = {
  // Underlying transport used for each real attempt. Defaults to
  // globalThis.fetch. Tests provide a stub here instead of monkeypatching
  // globalThis.fetch, so runs never leak into each other.
  fetchImpl?: typeof fetch;
  // Defaults to Date.now. Tests use a fake clock to make cooldown-expiry
  // deterministic without real sleeps.
  now?: () => number;
  // Defaults to console.error. Tests capture log lines instead of asserting
  // against real stderr.
  logger?: (line: string) => void;
  // Per-attempt timeout in ms before an endpoint is treated as a network
  // failure. Defaults to DEFAULT_ATTEMPT_TIMEOUT_MS.
  attemptTimeoutMs?: number;
  // Shared cooldown/method-availability bookkeeping. Production call sites
  // omit this and get the module-level singleton for their resolved
  // endpoint list; tests always pass their own via createFailoverState().
  state?: FailoverState;
};
