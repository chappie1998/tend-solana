import deployment from "../../deployments/devnet.json" with { type: "json" };
import { PUBLIC_DEVNET_RPC_URL } from "./constants.ts";
import type { FailoverEndpoint } from "./types.ts";

export type ResolveEndpointsOptions = {
  // Primary RPC URL. Defaults to process.env.VSOL_RPC_URL, then the checked-in
  // manifest's own rpcUrl (which is itself the public devnet endpoint --
  // harmless as a final default since it'll simply de-dupe with the public
  // fallback below when no private endpoint is configured at all).
  rpcUrl?: string;
  // Backup RPC URL (e.g. Alchemy devnet). Defaults to
  // process.env.VSOL_RPC_BACKUP_URL. Omitted entirely when neither is set.
  backupRpcUrl?: string;
  // Cluster this connection targets. Defaults to the manifest's own
  // `cluster` field ("devnet" today). The public devnet fallback below is
  // only ever appended when this resolves to "devnet" -- never for any other
  // cluster.
  cluster?: string;
};

function normalize(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Builds the ordered, de-duplicated list of endpoints createVsolConnection's
 * failover fetch will try, in priority order: primary, then backup (if
 * configured), then the public devnet RPC as a last resort -- and only for
 * the devnet cluster (see the module doc in index.ts for why: it doesn't
 * serve getProgramAccounts usefully anywhere else, and mainnet/testnet
 * traffic should never silently fail over to a public devnet node).
 */
export function resolveVsolRpcEndpoints(options: ResolveEndpointsOptions = {}): FailoverEndpoint[] {
  const primary = normalize(options.rpcUrl ?? process.env.VSOL_RPC_URL ?? String(deployment.rpcUrl ?? ""));
  const backup = normalize(options.backupRpcUrl ?? process.env.VSOL_RPC_BACKUP_URL);
  const cluster = normalize(options.cluster ?? String(deployment.cluster ?? "devnet")) || "devnet";
  const candidates = [primary, backup, cluster === "devnet" ? PUBLIC_DEVNET_RPC_URL : ""];

  const seen = new Set<string>();
  const endpoints: FailoverEndpoint[] = [];
  for (const url of candidates) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    endpoints.push({ url });
  }
  return endpoints;
}
