import { createServer } from "node:net";

// Generic runner concurrency primitives, factored out of the old
// custom-settle.ts so oracle-runner.ts's three independent lanes (boundary
// capture/settle/refund, heartbeat, hourly cleanup) can each run on their own
// schedule without one slow lane blocking another -- exactly the isolation
// custom-settle.ts already relied on for its per-symbol capture lanes.

/**
 * Exclusive local lease so two runner processes never race each other
 * against the same cluster (double-spending RPC budget and, worse, both
 * racing the same publish/capture/settle/refund/cleanup transactions).
 * Binding a TCP port is a simple, dependency-free mutex: the OS releases it
 * automatically if the process crashes, unlike a lock file, which can be left
 * behind stale.
 */
export async function acquireRunnerLease(port: number): Promise<() => Promise<void>> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      rejectListen(error.code === "EADDRINUSE"
        ? new Error(`Custom oracle runner is already active on localhost port ${port}`)
        : error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolveListen);
  });
  return () => new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

/**
 * Runs `iteration` repeatedly until `shouldStop()`, pausing via `pause()`
 * between iterations and reporting a thrown error via `onFailure` without
 * stopping the lane -- the crash-proofing contract every lane in
 * oracle-runner.ts relies on (see its module doc: only a startup failure may
 * exit the process). Pulling this into its own tiny, pure-ish function (it
 * takes its side effects as injected closures) is what makes "a stalled lane
 * cannot starve another lane" directly unit-testable without real timers or
 * real RPC -- see vsol/tests/custom-oracle-runner.test.ts.
 */
export async function runSerializedLane(
  iteration: () => Promise<void>,
  shouldStop: () => boolean,
  pause: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  while (!shouldStop()) {
    try {
      await iteration();
    } catch (error) {
      onFailure(error);
    }
    if (!shouldStop()) await pause();
  }
}
