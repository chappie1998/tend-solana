import assert from "node:assert/strict";
import test from "node:test";
import { BackoffController, isRateLimitedError, isTransientNetworkError } from "../scripts/lib/backoff.ts";

test("isRateLimitedError recognizes HTTP 429 and the -32429 JSON-RPC quota code", () => {
  assert.equal(isRateLimitedError(new Error("429 Too Many Requests")), true);
  assert.equal(isRateLimitedError(new Error("-32429 max usage reached")), true);
  assert.equal(isRateLimitedError(new Error("rate limited, try again")), true);
  assert.equal(isRateLimitedError(new Error("market has not expired yet")), false);
});

test("isTransientNetworkError recognizes dropped-connection failures", () => {
  assert.equal(isTransientNetworkError(new Error("fetch failed")), true);
  assert.equal(isTransientNetworkError(new Error("connect ETIMEDOUT 1.2.3.4:443")), true);
  assert.equal(isTransientNetworkError(new TypeError("fetch failed")), true);
  assert.equal(isTransientNetworkError(new Error("OracleAlreadyFinalized")), false);
});

test("BackoffController grows exponentially on rate-limit errors up to its cap", () => {
  const controller = new BackoffController(1_000, 8_000);
  const rateLimited = new Error("429 Too Many Requests");
  assert.equal(controller.onFailure(rateLimited), 1_000);
  assert.equal(controller.onFailure(rateLimited), 2_000);
  assert.equal(controller.onFailure(rateLimited), 4_000);
  assert.equal(controller.onFailure(rateLimited), 8_000);
  // Capped: does not keep doubling past maxMs.
  assert.equal(controller.onFailure(rateLimited), 8_000);
});

test("BackoffController resets to the base delay on an unrelated error, and on success", () => {
  const controller = new BackoffController(1_000, 60_000);
  const rateLimited = new Error("429 Too Many Requests");
  controller.onFailure(rateLimited);
  controller.onFailure(rateLimited);
  const grown = controller.onFailure(rateLimited);
  assert.ok(grown > 1_000);

  // A genuine application error (not rate/network) resets rather than compounding.
  assert.equal(controller.onFailure(new Error("MathOverflow")), 1_000);

  controller.onFailure(rateLimited); // grow again
  controller.onSuccess();
  assert.equal(controller.onFailure(rateLimited), 1_000);
});
