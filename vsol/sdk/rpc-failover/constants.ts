// Tunable defaults for the RPC failover layer (see index.ts's module doc for
// the overall design). Every value here is overridable per-call through
// createVsolConnection's options -- these are just the defaults that apply
// when a caller (an app route, or a vsol/scripts/*.ts entrypoint) doesn't
// need anything unusual.

// How long a single attempt against one endpoint may take before we treat it
// as a network failure and move on to the next endpoint. Solana RPC calls are
// normally sub-second; this only bites when an endpoint is actually hanging.
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;

// A transient failure -- a network error, a timed-out attempt, a bare HTTP
// 429/5xx with no quota signal in the body -- demotes an endpoint briefly.
// Short, because the next request (often milliseconds later) should get to
// try it again rather than pile onto a single bad endpoint's cooldown.
export const TRANSIENT_COOLDOWN_MS = 5_000;

// A quota/rate-limit signal (JSON-RPC -32429, or a message mentioning "max
// usage"/quota/rate limiting) means the endpoint is out of budget for a
// while, not just momentarily busy -- Helius's devnet quota resets monthly,
// so there is no value in retrying it every few seconds. Five minutes keeps
// us from hammering a dead endpoint for the life of a long-running process
// while still recovering automatically if the quota comes back sooner than
// expected (e.g. a plan upgrade mid-incident).
export const QUOTA_COOLDOWN_MS = 5 * 60_000;

// A JSON-RPC "method not found" (-32601) or a tier-restriction "not
// available" (-32600) is structural, not transient -- the endpoint's plan
// genuinely does not serve this method (e.g. Alchemy's free tier rejecting
// getProgramAccounts). It won't start working again on its own, but we still
// bound the cooldown (rather than remembering it forever) so a plan upgrade
// or provider change is picked up automatically within an hour.
export const METHOD_UNAVAILABLE_COOLDOWN_MS = 60 * 60_000;

// How often the confirmTransaction override polls getSignatureStatuses /
// getBlockHeight over HTTP. Matches the interval web3.js's own block-height
// confirmation strategy already polls at.
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

// Mirrors web3.js's own confirmTransactionUsingLegacyTimeoutStrategy default
// timeouts (see node_modules/@solana/web3.js/src/connection.ts), used only
// for the bare-signature confirmTransaction(signature, commitment) call
// shape, which carries no lastValidBlockHeight to poll against instead.
export const LEGACY_CONFIRM_TIMEOUT_MS_FINALIZED = 60_000;
export const LEGACY_CONFIRM_TIMEOUT_MS_LOWER = 30_000;

// The public devnet fallback -- last resort, devnet-cluster only, added
// after the primary and backup endpoints. Slow and rate-limited, but it does
// serve getProgramAccounts, which some free-tier backup providers refuse.
export const PUBLIC_DEVNET_RPC_URL = "https://api.devnet.solana.com";

/**
 * Absolute ceiling for a blockhash-strategy confirmation. A devnet blockhash
 * lives ~60-90s; 3 minutes leaves room for the post-expiry "processed but not
 * yet confirmed" wait while guaranteeing the poll always terminates.
 */
export const BLOCKHASH_CONFIRM_HARD_CEILING_MS = 180_000;
