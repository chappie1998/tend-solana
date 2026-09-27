import assert from "node:assert/strict";
import test from "node:test";
import { Connection, TransactionExpiredBlockheightExceededError, type Commitment, type ConnectionConfig, type RpcResponseAndContext, type SignatureResult, type SignatureStatus, type TransactionSignature } from "@solana/web3.js";
import { classifyHttpStatus, classifyJsonRpcError, parseJsonRpcRequests } from "../sdk/rpc-failover/classify.ts";
import { createFailoverFetch } from "../sdk/rpc-failover/fetch.ts";
import { resolveVsolRpcEndpoints } from "../sdk/rpc-failover/endpoints.ts";
import { redactRpcUrl } from "../sdk/rpc-failover/redact.ts";
import { createFailoverState, isEndpointCoolingDown, isMethodUnavailable, recordEndpointFailure, recordMethodUnavailable } from "../sdk/rpc-failover/state.ts";
import { createFailoverConnectionClass, type ConnectionLike } from "../sdk/rpc-failover/confirm.ts";
import { createVsolConnection } from "../sdk/rpc-failover/index.ts";
import { PUBLIC_DEVNET_RPC_URL, QUOTA_COOLDOWN_MS, TRANSIENT_COOLDOWN_MS } from "../sdk/rpc-failover/constants.ts";

// --- small test helpers --------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rpcRequestBody(method: string, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: [] });
}

function rpcBatchBody(methods: Array<{ method: string; id: number | string }>): string {
  return JSON.stringify(methods.map(({ method, id }) => ({ jsonrpc: "2.0", id, method, params: [] })));
}

type Reactor = () => Response | Promise<Response> | never;

/** A stub `fetch` that dispatches by exact URL, popping one canned reactor per call. Throws if a URL is hit with no queued reactor, or more times than queued -- both signal a wrong failover decision. */
function makeStubFetch(handlers: Map<string, Reactor[]>, calls: string[] = []): { fetchImpl: typeof fetch; calls: string[] } {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const queue = handlers.get(url);
    if (!queue || queue.length === 0) throw new Error(`makeStubFetch: no reactor queued for ${url} (call #${calls.length})`);
    const reactor = queue.shift() as Reactor;
    return await reactor();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const PRIMARY = "https://primary.example/rpc?api-key=super-secret-primary-key";
const BACKUP = "https://backup.example/v2/rpc/super-secret-backup-key";
const TERTIARY = "https://tertiary.example/rpc";

function baseFailoverOptions(state = createFailoverState()) {
  const logs: string[] = [];
  let now = 1_000_000;
  return {
    state,
    logs,
    logger: (line: string) => logs.push(line),
    now: () => now,
    advance: (ms: number) => { now += ms; },
    attemptTimeoutMs: 5_000,
  };
}

// --- classify.ts ----------------------------------------------------------

test("parseJsonRpcRequests decodes single and batch bodies, and fails soft on unparseable JSON", () => {
  assert.deepEqual(parseJsonRpcRequests(rpcRequestBody("getHealth", 7)), [{ id: 7, method: "getHealth" }]);
  assert.deepEqual(
    parseJsonRpcRequests(rpcBatchBody([{ method: "getBlockHeight", id: 1 }, { method: "getTransaction", id: 2 }])),
    [{ id: 1, method: "getBlockHeight" }, { id: 2, method: "getTransaction" }],
  );
  assert.deepEqual(parseJsonRpcRequests("not json"), []);
  assert.deepEqual(parseJsonRpcRequests(undefined), []);
});

test("classifyHttpStatus flags 429 and 5xx, leaves everything else to body inspection", () => {
  assert.deepEqual(classifyHttpStatus(429), { cooldownReason: "HTTP 429" });
  assert.deepEqual(classifyHttpStatus(500), { cooldownReason: "HTTP 500" });
  assert.deepEqual(classifyHttpStatus(503), { cooldownReason: "HTTP 503" });
  assert.equal(classifyHttpStatus(200), null);
  assert.equal(classifyHttpStatus(400), null);
});

test("classifyJsonRpcError recognizes quota, method-unavailable, and ordinary errors", () => {
  assert.deepEqual(classifyJsonRpcError(undefined), { kind: "none" });
  assert.deepEqual(classifyJsonRpcError({ code: -32429, message: "max usage reached" }), { kind: "quota" });
  assert.deepEqual(classifyJsonRpcError({ code: -32000, message: "monthly quota exceeded" }), { kind: "quota" });
  assert.deepEqual(classifyJsonRpcError({ code: -32000, message: "you are being rate limited" }), { kind: "quota" });
  assert.deepEqual(classifyJsonRpcError({ code: -32601, message: "Method not found" }), { kind: "method-unavailable" });
  assert.deepEqual(
    classifyJsonRpcError({ code: -32600, message: "getProgramAccounts is not available on the Free tier" }),
    { kind: "method-unavailable" },
  );
  // An unrelated -32600 (genuinely malformed request) is ordinary, not method-unavailable.
  assert.deepEqual(classifyJsonRpcError({ code: -32600, message: "Invalid request: missing jsonrpc field" }), { kind: "ordinary" });
  assert.deepEqual(classifyJsonRpcError({ code: -32602, message: "invalid params: WrongSize" }), { kind: "ordinary" });
  assert.deepEqual(classifyJsonRpcError({ code: -32002, message: "Transaction simulation failed: custom program error" }), { kind: "ordinary" });
});

// --- redact.ts --------------------------------------------------------------

test("redactRpcUrl reduces a URL to its host, never leaking the path/query (API keys live there)", () => {
  assert.equal(redactRpcUrl(PRIMARY), "primary.example");
  assert.equal(redactRpcUrl(BACKUP), "backup.example");
  assert.equal(redactRpcUrl("not a url"), "[unparseable-endpoint]");
});

// --- endpoints.ts -----------------------------------------------------------

test("resolveVsolRpcEndpoints orders primary, backup, then public devnet -- devnet only", () => {
  const devnet = resolveVsolRpcEndpoints({ rpcUrl: PRIMARY, backupRpcUrl: BACKUP, cluster: "devnet" });
  assert.deepEqual(devnet.map((e) => e.url), [PRIMARY, BACKUP, PUBLIC_DEVNET_RPC_URL]);

  const mainnet = resolveVsolRpcEndpoints({ rpcUrl: PRIMARY, backupRpcUrl: BACKUP, cluster: "mainnet-beta" });
  assert.deepEqual(mainnet.map((e) => e.url), [PRIMARY, BACKUP]);
  assert.ok(!mainnet.some((e) => e.url === PUBLIC_DEVNET_RPC_URL), "must never add the public devnet fallback for a non-devnet cluster");
});

test("resolveVsolRpcEndpoints de-duplicates and drops empty entries", () => {
  const noBackup = resolveVsolRpcEndpoints({ rpcUrl: PRIMARY, cluster: "devnet" });
  assert.deepEqual(noBackup.map((e) => e.url), [PRIMARY, PUBLIC_DEVNET_RPC_URL]);

  const backupSameAsPrimary = resolveVsolRpcEndpoints({ rpcUrl: PRIMARY, backupRpcUrl: PRIMARY, cluster: "devnet" });
  assert.deepEqual(backupSameAsPrimary.map((e) => e.url), [PRIMARY, PUBLIC_DEVNET_RPC_URL]);

  const primaryIsPublicDevnet = resolveVsolRpcEndpoints({ rpcUrl: PUBLIC_DEVNET_RPC_URL, cluster: "devnet" });
  assert.deepEqual(primaryIsPublicDevnet.map((e) => e.url), [PUBLIC_DEVNET_RPC_URL]);
});

// --- state.ts ----------------------------------------------------------------

test("recordEndpointFailure demotes for the cooldown and logs exactly once per fresh demotion", () => {
  const state = createFailoverState();
  const logs: string[] = [];
  let now = 0;

  recordEndpointFailure(state, PRIMARY, TRANSIENT_COOLDOWN_MS, "HTTP 429", now, logs.push.bind(logs));
  assert.equal(isEndpointCoolingDown(state, PRIMARY, now), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /primary\.example/);
  assert.ok(!logs[0].includes("super-secret"), "log line must never contain the raw URL/API key");

  // A second failure while STILL cooling down must not log again (no spam).
  recordEndpointFailure(state, PRIMARY, TRANSIENT_COOLDOWN_MS, "HTTP 429", now + 1, logs.push.bind(logs));
  assert.equal(logs.length, 1);

  // Once the cooldown has fully expired, the NEXT failure is a fresh demotion and logs again.
  now += TRANSIENT_COOLDOWN_MS + 1;
  assert.equal(isEndpointCoolingDown(state, PRIMARY, now), false);
  recordEndpointFailure(state, PRIMARY, TRANSIENT_COOLDOWN_MS, "HTTP 429", now, logs.push.bind(logs));
  assert.equal(logs.length, 2);
});

test("recordMethodUnavailable demotes only the one method, leaving the endpoint healthy for everything else", () => {
  const state = createFailoverState();
  const logs: string[] = [];
  const now = 0;

  recordMethodUnavailable(state, BACKUP, "getProgramAccounts", QUOTA_COOLDOWN_MS, "not available on the Free tier", now, logs.push.bind(logs));
  assert.equal(isMethodUnavailable(state, BACKUP, "getProgramAccounts", now), true);
  assert.equal(isMethodUnavailable(state, BACKUP, "getAccountInfo", now), false);
  assert.equal(isEndpointCoolingDown(state, BACKUP, now), false, "a method-scoped fault must not demote the whole endpoint");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /getProgramAccounts/);
});

// --- fetch.ts: the failover fetch itself ------------------------------------

test("failover fetch moves to the next endpoint on a network error, and demotes the failed one", async () => {
  const opts = baseFailoverOptions();
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [() => { throw new Error("getaddrinfo ENOTFOUND primary.example"); }]],
    [BACKUP, [() => jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" })]],
  ]));
  const failoverFetch = createFailoverFetch(
    [{ url: PRIMARY }, { url: BACKUP }],
    { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state },
  );

  const res = await failoverFetch(PRIMARY, { method: "POST", body: rpcRequestBody("getHealth") });
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 1, result: "ok" });
  assert.deepEqual(calls, [PRIMARY, BACKUP]);
  assert.equal(isEndpointCoolingDown(opts.state, PRIMARY, opts.now()), true);
  assert.match(opts.logs.join("\n"), /primary\.example/);
});

test("failover fetch moves to the next endpoint on a bare HTTP 429", async () => {
  const opts = baseFailoverOptions();
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [() => jsonResponse({ error: "rate limited" }, 429)]],
    [BACKUP, [() => jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" })]],
  ]));
  const failoverFetch = createFailoverFetch([{ url: PRIMARY }, { url: BACKUP }], { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state });

  const res = await failoverFetch(PRIMARY, { method: "POST", body: rpcRequestBody("getHealth") });
  assert.equal((await res.json() as { result: string }).result, "ok");
  assert.deepEqual(calls, [PRIMARY, BACKUP]);
});

test("failover fetch moves to the next endpoint on an HTTP 200 body carrying -32429 'max usage reached'", async () => {
  const opts = baseFailoverOptions();
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [() => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "max usage reached" } })]],
    [BACKUP, [() => jsonResponse({ jsonrpc: "2.0", id: 1, result: 123 })]],
  ]));
  const failoverFetch = createFailoverFetch([{ url: PRIMARY }, { url: BACKUP }], { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state });

  const res = await failoverFetch(PRIMARY, { method: "POST", body: rpcRequestBody("getBlockHeight") });
  assert.equal((await res.json() as { result: number }).result, 123);
  assert.deepEqual(calls, [PRIMARY, BACKUP]);
  assert.equal(isEndpointCoolingDown(opts.state, PRIMARY, opts.now()), true, "a quota signal must demote the whole endpoint, not just the method");
});

test("method-unavailable skips that endpoint for THAT method only -- other methods still use it", async () => {
  const opts = baseFailoverOptions();
  const { fetchImpl, calls } = makeStubFetch(new Map([
    // First request: getProgramAccounts on the backup is refused by its free tier.
    [BACKUP, [
      () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "getProgramAccounts is not available on the Free tier. Upgrade." } }),
      // Second request: a DIFFERENT method on the SAME backup still succeeds directly (no failover needed).
      () => jsonResponse({ jsonrpc: "2.0", id: 2, result: "confirmed" }),
    ]],
    [TERTIARY, [() => jsonResponse({ jsonrpc: "2.0", id: 1, result: [] })]],
  ]));
  const endpoints = [{ url: BACKUP }, { url: TERTIARY }];
  const failoverFetch = createFailoverFetch(endpoints, { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state });

  const first = await failoverFetch(BACKUP, { method: "POST", body: rpcRequestBody("getProgramAccounts", 1) });
  assert.deepEqual((await first.json() as { result: unknown[] }).result, []);
  assert.equal(isMethodUnavailable(opts.state, BACKUP, "getProgramAccounts", opts.now()), true);
  assert.equal(isEndpointCoolingDown(opts.state, BACKUP, opts.now()), false, "the endpoint itself must stay healthy for every OTHER method");

  const second = await failoverFetch(BACKUP, { method: "POST", body: rpcRequestBody("getSlot", 2) });
  assert.equal((await second.json() as { result: string }).result, "confirmed");
  assert.deepEqual(calls, [BACKUP, TERTIARY, BACKUP], "the second request (a different method) must go straight back to the backup, not the tertiary endpoint");
});

test("an ordinary JSON-RPC error (simulation failure) is returned unchanged, with NO failover", async () => {
  const opts = baseFailoverOptions();
  const simulationError = { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1" } };
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [() => jsonResponse(simulationError)]],
    [BACKUP, [() => { throw new Error("must never be called"); }]],
  ]));
  const failoverFetch = createFailoverFetch([{ url: PRIMARY }, { url: BACKUP }], { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state });

  const res = await failoverFetch(PRIMARY, { method: "POST", body: rpcRequestBody("sendTransaction") });
  assert.deepEqual(await res.json(), simulationError);
  assert.deepEqual(calls, [PRIMARY], "an ordinary error must never trigger a retry against another endpoint");
  assert.equal(isEndpointCoolingDown(opts.state, PRIMARY, opts.now()), false, "the endpoint is healthy -- the error was about the request, not the endpoint");
});

test("batch payloads: any sub-item signalling a quota fault fails the whole batch over to the next endpoint", async () => {
  const opts = baseFailoverOptions();
  const batchBody = rpcBatchBody([{ method: "getTransaction", id: 1 }, { method: "getTransaction", id: 2 }]);
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [() => jsonResponse([
      { jsonrpc: "2.0", id: 1, result: { slot: 1 } },
      { jsonrpc: "2.0", id: 2, error: { code: -32429, message: "max usage reached" } },
    ])]],
    [BACKUP, [() => jsonResponse([
      { jsonrpc: "2.0", id: 1, result: { slot: 1 } },
      { jsonrpc: "2.0", id: 2, result: { slot: 2 } },
    ])]],
  ]));
  const failoverFetch = createFailoverFetch([{ url: PRIMARY }, { url: BACKUP }], { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state });

  const res = await failoverFetch(PRIMARY, { method: "POST", body: batchBody });
  const body = await res.json() as Array<{ id: number; result?: unknown }>;
  assert.equal(body.length, 2);
  assert.deepEqual(calls, [PRIMARY, BACKUP]);
  assert.equal(isEndpointCoolingDown(opts.state, PRIMARY, opts.now()), true);
});

test("batch payloads: a batch with only ORDINARY per-item errors is returned unchanged, no failover", async () => {
  const opts = baseFailoverOptions();
  const batchBody = rpcBatchBody([{ method: "getTransaction", id: 1 }, { method: "getTransaction", id: 2 }]);
  const mixedBatch = [
    { jsonrpc: "2.0", id: 1, result: { slot: 1 } },
    { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "invalid params" } },
  ];
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [() => jsonResponse(mixedBatch)]],
    [BACKUP, [() => { throw new Error("must never be called"); }]],
  ]));
  const failoverFetch = createFailoverFetch([{ url: PRIMARY }, { url: BACKUP }], { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state });

  const res = await failoverFetch(PRIMARY, { method: "POST", body: batchBody });
  assert.deepEqual(await res.json(), mixedBatch);
  assert.deepEqual(calls, [PRIMARY]);
});

test("cooldown expiry brings a demoted endpoint back into the preferred rotation", async () => {
  const opts = baseFailoverOptions();
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [
      () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "max usage reached" } }),
      // After the cooldown expires, primary is tried again FIRST and succeeds.
      () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok-again" }),
    ]],
    [BACKUP, [() => jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" })]],
  ]));
  const failoverFetch = createFailoverFetch([{ url: PRIMARY }, { url: BACKUP }], { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state });

  await failoverFetch(PRIMARY, { method: "POST", body: rpcRequestBody("getHealth") });
  assert.deepEqual(calls, [PRIMARY, BACKUP]);
  assert.equal(isEndpointCoolingDown(opts.state, PRIMARY, opts.now()), true);

  opts.advance(QUOTA_COOLDOWN_MS + 1);
  assert.equal(isEndpointCoolingDown(opts.state, PRIMARY, opts.now()), false);

  const res = await failoverFetch(PRIMARY, { method: "POST", body: rpcRequestBody("getHealth") });
  assert.equal((await res.json() as { result: string }).result, "ok-again");
  assert.deepEqual(calls, [PRIMARY, BACKUP, PRIMARY], "primary must be tried FIRST again once its cooldown has expired");
});

test("if every endpoint fails, the last response/error is returned as-is", async () => {
  const opts = baseFailoverOptions();
  const { fetchImpl } = makeStubFetch(new Map([
    [PRIMARY, [() => jsonResponse({ error: "still rate limited" }, 429)]],
    [BACKUP, [() => jsonResponse({ error: "also rate limited" }, 429)]],
  ]));
  const failoverFetch = createFailoverFetch([{ url: PRIMARY }, { url: BACKUP }], { fetchImpl, now: opts.now, logger: opts.logger, attemptTimeoutMs: opts.attemptTimeoutMs, state: opts.state });

  const res = await failoverFetch(PRIMARY, { method: "POST", body: rpcRequestBody("getHealth") });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: "also rate limited" });
});

// --- confirm.ts: HTTP-polling confirmTransaction ----------------------------

class FakeBaseConnection implements ConnectionLike {
  commitment?: Commitment;
  signatureStatusQueue: Array<SignatureStatus | null> = [];
  blockHeightQueue: number[] = [];

  constructor(_endpoint: string, config?: Commitment | ConnectionConfig) {
    this.commitment = typeof config === "object" ? config?.commitment : config;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature required to satisfy ConnectionLike; the queue drives the response instead.
  async getSignatureStatus(_signature: TransactionSignature): Promise<RpcResponseAndContext<SignatureStatus | null>> {
    const value = this.signatureStatusQueue.length > 0 ? (this.signatureStatusQueue.shift() as SignatureStatus | null) : null;
    return { context: { slot: 1 }, value };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature required to satisfy ConnectionLike; the queue drives the response instead.
  async getBlockHeight(_commitmentOrConfig?: Commitment): Promise<number> {
    return this.blockHeightQueue.length > 0 ? (this.blockHeightQueue.shift() as number) : 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- unused: this fallback path is never exercised (see the thrown Error below).
  async confirmTransaction(_strategy: any, _commitment?: Commitment): Promise<RpcResponseAndContext<SignatureResult>> {
    throw new Error("FakeBaseConnection.confirmTransaction (the durable-nonce fallback path) is not exercised by these tests");
  }
}

test("confirmTransaction (blockheight strategy) resolves once the signature reaches a confirmed status", async () => {
  const Patched = createFailoverConnectionClass(FakeBaseConnection, 1);
  const connection = new Patched("http://fake", { commitment: "confirmed" });
  connection.signatureStatusQueue = [
    null,
    { slot: 1, confirmations: 1, err: null, confirmationStatus: "processed" },
    { slot: 2, confirmations: 5, err: null, confirmationStatus: "confirmed" },
  ];

  const result = await connection.confirmTransaction({ signature: "sig1", blockhash: "bh1", lastValidBlockHeight: 100 }, "confirmed");
  // Declared return type is RpcResponseAndContext<SignatureResult> (just
  // `.err`), matching web3.js's own confirmTransaction -- but the resolved
  // value is literally the SignatureStatus object underneath (same as
  // upstream's own getTransactionConfirmationPromise), so confirmationStatus
  // is present at runtime even though the type doesn't advertise it.
  assert.equal((result.value as unknown as SignatureStatus).confirmationStatus, "confirmed");
  assert.equal(result.value.err, null);
});

test("confirmTransaction rejects with the raw transaction error, not a wrapped Error", async () => {
  const Patched = createFailoverConnectionClass(FakeBaseConnection, 1);
  const connection = new Patched("http://fake", { commitment: "confirmed" });
  const err = { InstructionError: [0, { Custom: 1 }] };
  connection.signatureStatusQueue = [{ slot: 1, confirmations: 0, err, confirmationStatus: "processed" }];

  await assert.rejects(
    connection.confirmTransaction({ signature: "sig1", blockhash: "bh1", lastValidBlockHeight: 100 }, "confirmed"),
    (rejected: unknown) => { assert.deepEqual(rejected, err); return true; },
  );
});

test("confirmTransaction throws TransactionExpiredBlockheightExceededError once block height passes lastValidBlockHeight", async () => {
  const Patched = createFailoverConnectionClass(FakeBaseConnection, 1);
  const connection = new Patched("http://fake", { commitment: "confirmed" });
  connection.signatureStatusQueue = [null, null, null];
  connection.blockHeightQueue = [50, 100, 101];

  await assert.rejects(
    connection.confirmTransaction({ signature: "sig1", blockhash: "bh1", lastValidBlockHeight: 100 }, "confirmed"),
    TransactionExpiredBlockheightExceededError,
  );
});

test("confirmTransaction respects finalized commitment: a merely-confirmed status does not resolve, only finalized does", async () => {
  const Patched = createFailoverConnectionClass(FakeBaseConnection, 1);
  const connection = new Patched("http://fake", { commitment: "finalized" });
  connection.signatureStatusQueue = [
    { slot: 1, confirmations: 5, err: null, confirmationStatus: "confirmed" },
    { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" },
  ];
  connection.blockHeightQueue = [10, 10];

  const result = await connection.confirmTransaction({ signature: "sig1", blockhash: "bh1", lastValidBlockHeight: 1_000 }, "finalized");
  assert.equal((result.value as unknown as SignatureStatus).confirmationStatus, "finalized");
});

// --- index.ts: createVsolConnection end to end ------------------------------

test("createVsolConnection extends the injected ConnectionClass, so Connection.prototype mocks (as used by tests/helpers/offline-fill-fixture.mjs) still apply", () => {
  const connection = createVsolConnection({
    rpcUrl: PRIMARY,
    cluster: "devnet",
    fetchImpl: (async () => jsonResponse({ jsonrpc: "2.0", id: "1", result: "ok" })) as unknown as typeof fetch,
    state: createFailoverState(),
    ConnectionClass: Connection,
  });
  assert.ok(connection instanceof Connection, "the returned instance must be a real instance of the injected class, not an unrelated lookalike");
});

test("createVsolConnection fails over end to end through a real Connection, and only reaches the public devnet endpoint for the devnet cluster", async () => {
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [() => jsonResponse({ jsonrpc: "2.0", id: "1", error: { code: -32429, message: "max usage reached" } })]],
    [BACKUP, [() => jsonResponse({ jsonrpc: "2.0", id: "1", error: { code: -32429, message: "max usage reached" } })]],
    [PUBLIC_DEVNET_RPC_URL, [() => jsonResponse({ jsonrpc: "2.0", id: "1", result: "devnet-genesis-hash" })]],
  ]));
  const connection = createVsolConnection({
    rpcUrl: PRIMARY,
    backupRpcUrl: BACKUP,
    cluster: "devnet",
    fetchImpl,
    state: createFailoverState(),
    ConnectionClass: Connection,
    logger: () => {}, // demotion logging is covered separately by the state.ts tests
  });

  const hash = await connection.getGenesisHash();
  assert.equal(hash, "devnet-genesis-hash");
  assert.deepEqual(calls, [PRIMARY, BACKUP, PUBLIC_DEVNET_RPC_URL]);
});

test("createVsolConnection never adds the public devnet fallback for a non-devnet cluster", async () => {
  const { fetchImpl, calls } = makeStubFetch(new Map([
    [PRIMARY, [() => jsonResponse({ jsonrpc: "2.0", id: "1", error: { code: -32429, message: "max usage reached" } })]],
    [BACKUP, [() => jsonResponse({ jsonrpc: "2.0", id: "1", error: { code: -32429, message: "max usage reached" } })]],
  ]));
  const connection = createVsolConnection({
    rpcUrl: PRIMARY,
    backupRpcUrl: BACKUP,
    cluster: "mainnet-beta",
    fetchImpl,
    state: createFailoverState(),
    ConnectionClass: Connection,
    logger: () => {},
  });

  await assert.rejects(connection.getGenesisHash());
  assert.deepEqual(calls, [PRIMARY, BACKUP]);
  assert.ok(!calls.includes(PUBLIC_DEVNET_RPC_URL));
});
