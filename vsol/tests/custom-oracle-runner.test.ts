import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { classifyPushFailure, DEVNET_GENESIS_HASH } from "../scripts/custom-oracle-pusher.ts";
import { acquireRunnerLease, runSerializedLane } from "../scripts/custom-settle.ts";
import idl from "../target/idl/vsol.json" with { type: "json" };

test("duplicate source timestamps are harmless and RPC URLs are redacted", () => {
  const duplicate = {
    error: { errorCode: { code: "CustomFeedTimestampNotIncreasing" } },
    message: "already stored",
  };
  assert.equal(classifyPushFailure(duplicate, "secret-rpc").duplicateTimestamp, true);

  const failure = classifyPushFailure(new Error("request to https://private.example/rpc failed"), "https://private.example/rpc");
  assert.equal(failure.duplicateTimestamp, false);
  assert.equal(failure.message, "request to [redacted] failed");
});

test("devnet guard uses the complete 32-byte genesis hash", () => {
  assert.equal(DEVNET_GENESIS_HASH, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
});

test("raw IDL exposes the settlement instruction under its snake-case name", () => {
  assert.ok(idl.instructions.some((instruction) => instruction.name === "settle_pool_position"));
});

test("runner lease rejects overlap and releases cleanly", async () => {
  const port = 48_000 + Math.floor(Math.random() * 1_000);
  const release = await acquireRunnerLease(port);
  await assert.rejects(() => acquireRunnerLease(port), /already active/);
  await release();
  const releaseAgain = await acquireRunnerLease(port);
  await releaseAgain();
});

test("runner lease is released by the OS after a process crash", async () => {
  const port = 49_000 + Math.floor(Math.random() * 1_000);
  const moduleUrl = new URL("../scripts/custom-settle.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--import", "tsx",
    "--input-type=module",
    "-e", `const { acquireRunnerLease } = await import(${JSON.stringify(moduleUrl)}); await acquireRunnerLease(${port}); console.log("READY"); await new Promise(() => {});`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  while (!output.includes("READY")) {
    const winner = await Promise.race([once(child.stdout, "data"), once(child, "exit")]);
    if (winner.length > 1 || child.exitCode !== null) throw new Error("lease child exited before acquiring the port");
  }
  child.kill("SIGKILL");
  await once(child, "exit");
  const release = await acquireRunnerLease(port);
  await release();
});

test("a stalled symbol lane cannot starve another symbol's capture", async () => {
  let releaseStalled!: () => void;
  const stalledGate = new Promise<void>((resolve) => { releaseStalled = resolve; });
  let stopStalled = false;
  let healthyCaptured = false;
  let stopHealthy = false;

  const stalled = runSerializedLane(
    () => stalledGate,
    () => stopStalled,
    async () => {},
    (error) => { throw error; },
  );
  const healthy = runSerializedLane(
    async () => { healthyCaptured = true; stopHealthy = true; },
    () => stopHealthy,
    async () => {},
    (error) => { throw error; },
  );

  await healthy;
  assert.equal(healthyCaptured, true);
  stopStalled = true;
  releaseStalled();
  await stalled;
});
