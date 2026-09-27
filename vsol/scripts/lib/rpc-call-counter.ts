// A one-line-per-pass RPC accounting aid (see oracle-runner.ts's module doc,
// item 5: "log a one-line RPC-call count per pass"). Deliberately a manual
// tally incremented at each call site rather than a `Connection` proxy: every
// call site already knows exactly how many `getProgramAccounts` /
// `getMultipleAccountsInfo` / transaction sends it is about to make (they are
// fixed by which lib/settlement.ts helper is being called), so instrumenting
// the connection object itself would add indirection without adding
// accuracy.
export class RpcCallCounter {
  private readonly counts = new Map<string, number>();

  increment(kind: string, by = 1): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + by);
  }

  total(): number {
    return [...this.counts.values()].reduce((sum, count) => sum + count, 0);
  }

  summary(): string {
    const breakdown = [...this.counts.entries()].map(([kind, count]) => `${kind}=${count}`).join(", ");
    return `${this.total()} RPC call(s)${breakdown ? ` (${breakdown})` : ""}`;
  }
}
