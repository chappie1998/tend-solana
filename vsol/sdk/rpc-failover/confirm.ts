// web3.js's own Connection.confirmTransaction subscribes to a signature over
// its RPC websocket, which connects to whichever endpoint the Connection was
// constructed with (see node_modules/@solana/web3.js/src/connection.ts:
// getTransactionConfirmationPromise -> this.onSignature -> the RPC pubsub
// websocket) -- entirely separate from the HTTP `fetch` config our failover
// layer replaces. If the primary endpoint's websocket is as dead as its HTTP
// quota, confirmation would hang (until the blockhash-based strategy's own
// getBlockHeight poll -- itself HTTP, so it DOES fail over -- eventually
// expires it, or forever for the bare-signature legacy strategy, which has
// no failover-aware timeout path at all).
//
// createFailoverConnectionClass below builds a subclass whose
// confirmTransaction never touches the websocket: it polls
// getSignatureStatuses/getBlockHeight over HTTP instead, which flows through
// the very same failover fetch as every other call. It reproduces the two
// confirmation strategies this codebase actually uses (verified by grep --
// see the task's own call-site audit):
//   - the bare TransactionSignature + commitment shape
//     (confirmTransactionUsingLegacyTimeoutStrategy upstream), and
//   - the blockhash/lastValidBlockHeight shape
//     (confirmTransactionUsingBlockHeightExceedanceStrategy upstream), which
//     is what sendAndConfirmTransaction and Anchor's own AnchorProvider both
//     construct whenever the transaction carries a recent blockhash (i.e.
//     always, in this codebase).
// The durable-nonce strategy (DurableNonceTransactionConfirmationStrategy)
// is not exercised anywhere in this codebase (grep turned up no
// nonceAccountPubkey/minNonceContextSlot call sites), so rather than
// reimplement an untested path, it falls back to the base class's original
// websocket-based implementation.
//
// # Why a generic mixin instead of `class X extends Connection`
//
// This monorepo pins two different @solana/web3.js versions (root's
// package.json wants ^1.99.0; vsol/package.json pins 1.98.4 exactly), so npm
// installs two separate copies. TypeScript treats their two `Connection`
// classes as nominally incompatible (private members), and at RUNTIME they
// are two entirely different prototype chains -- an existing test fixture
// (tests/helpers/offline-fill-fixture.mjs) mocks
// `Connection.prototype.getProgramAccounts` using the app's own
// (root-resolved) import, which would silently do nothing for an instance
// built from vsol-local's copy. createFailoverConnectionClass is generic
// over the injected base class specifically so createVsolConnection can
// extend WHICHEVER concrete Connection class the caller supplies --
// app/lib callers inject their own root-resolved class (see index.ts's
// ConnectionClass option), so instances stay real instances of that same
// class, and vsol/scripts callers get vsol-local's by default.
import {
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  type Commitment,
  type ConnectionConfig,
  type RpcResponseAndContext,
  type SignatureResult,
  type SignatureStatus,
  type TransactionConfirmationStatus,
  type TransactionConfirmationStrategy,
  type TransactionSignature,
} from "@solana/web3.js";
import { DEFAULT_POLL_INTERVAL_MS, LEGACY_CONFIRM_TIMEOUT_MS_FINALIZED, LEGACY_CONFIRM_TIMEOUT_MS_LOWER } from "./constants.ts";

/**
 * The structural (no private members) subset of Connection this override
 * needs -- deliberately NOT the `Connection` class type itself (see the
 * module doc above for why). Any real Connection, from either package copy,
 * satisfies this.
 */
export interface ConnectionLike {
  readonly commitment?: Commitment;
  getSignatureStatus(signature: TransactionSignature): Promise<RpcResponseAndContext<SignatureStatus | null>>;
  getBlockHeight(commitmentOrConfig?: Commitment): Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors web3.js's own overloaded confirmTransaction (string | strategy object) with one broad signature so either package copy's Connection structurally satisfies this interface.
  confirmTransaction(strategy: any, commitment?: Commitment): Promise<RpcResponseAndContext<SignatureResult>>;
}

export type ConnectionConstructor<T extends ConnectionLike = ConnectionLike> = new (
  endpoint: string,
  commitmentOrConfig?: Commitment | ConnectionConfig,
) => T;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors web3.js's own getTransactionConfirmationPromise commitment gate (see connection.ts) exactly: which confirmationStatus values are "good enough" to resolve at a given requested commitment. */
function commitmentSatisfied(commitment: Commitment | undefined, confirmationStatus: TransactionConfirmationStatus | null | undefined): boolean {
  switch (commitment) {
    case "confirmed":
    case "single":
    case "singleGossip":
      return confirmationStatus !== "processed";
    case "finalized":
    case "max":
    case "root":
      return confirmationStatus === "finalized";
    default:
      // "processed" / "recent" / undefined: any reported status is enough.
      return true;
  }
}

/** Mirrors confirmTransactionUsingLegacyTimeoutStrategy's timeout selection. */
function legacyTimeoutMs(commitment: Commitment | undefined, initialTimeoutMs: number | undefined): number {
  switch (commitment) {
    case "finalized":
    case "max":
    case "root":
      return initialTimeoutMs || LEGACY_CONFIRM_TIMEOUT_MS_FINALIZED;
    default:
      return initialTimeoutMs || LEGACY_CONFIRM_TIMEOUT_MS_LOWER;
  }
}

/**
 * Builds a subclass of `Base` (whichever concrete Connection class the
 * caller injects -- see the module doc above) whose confirmTransaction
 * polls over HTTP instead of subscribing to a websocket.
 */
export function createFailoverConnectionClass<TBase extends ConnectionConstructor>(
  Base: TBase,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): TBase {
  class FailoverConnection extends (Base as ConnectionConstructor) {
    private readonly confirmInitialTimeoutMs: number | undefined;

    constructor(...args: ConstructorParameters<ConnectionConstructor>) {
      super(...args);
      const config = args[1];
      this.confirmInitialTimeoutMs = typeof config === "object" && config != null ? config.confirmTransactionInitialTimeout : undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see ConnectionLike's own signature.
    async confirmTransaction(strategy: any, commitment?: Commitment): Promise<RpcResponseAndContext<SignatureResult>> {
      if (typeof strategy === "string") {
        return this.pollForSignatureStatus({
          signature: strategy,
          commitment: commitment ?? this.commitment,
          timeoutMs: legacyTimeoutMs(commitment ?? this.commitment, this.confirmInitialTimeoutMs),
        });
      }

      const typed = strategy as TransactionConfirmationStrategy;
      if (typed.abortSignal?.aborted) {
        return Promise.reject(typed.abortSignal.reason);
      }

      if ("lastValidBlockHeight" in typed) {
        return this.pollForSignatureStatus({
          signature: typed.signature,
          commitment: commitment ?? this.commitment,
          lastValidBlockHeight: typed.lastValidBlockHeight,
          abortSignal: typed.abortSignal,
        });
      }

      // Durable-nonce strategy: unused by this codebase (see module doc
      // above) -- defer to the base class's original websocket-based
      // implementation rather than reimplement an untested path.
      return super.confirmTransaction(strategy, commitment);
    }

    private async pollForSignatureStatus(opts: {
      signature: TransactionSignature;
      commitment?: Commitment;
      lastValidBlockHeight?: number;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    }): Promise<RpcResponseAndContext<SignatureResult>> {
      const { signature, commitment, lastValidBlockHeight, timeoutMs, abortSignal } = opts;
      const deadline = lastValidBlockHeight == null && timeoutMs != null ? Date.now() + timeoutMs : undefined;

      for (;;) {
        if (abortSignal?.aborted) throw abortSignal.reason;

        const { context, value } = await this.getSignatureStatus(signature);
        if (value != null) {
          if (value.err) {
            // Matches the upstream websocket path exactly: reject with the
            // raw TransactionError value, never wrapped.
            throw value.err;
          }
          if (commitmentSatisfied(commitment, value.confirmationStatus)) {
            return { context, value };
          }
        }

        if (lastValidBlockHeight != null) {
          const blockHeight = await this.getBlockHeight(commitment).catch(() => -1);
          if (blockHeight > lastValidBlockHeight) {
            throw new TransactionExpiredBlockheightExceededError(signature);
          }
        } else if (deadline != null && Date.now() > deadline) {
          throw new TransactionExpiredTimeoutError(signature, (timeoutMs ?? LEGACY_CONFIRM_TIMEOUT_MS_LOWER) / 1000);
        }

        await sleep(pollIntervalMs);
      }
    }
  }

  return FailoverConnection as unknown as TBase;
}
