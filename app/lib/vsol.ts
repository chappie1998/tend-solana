import { PublicKey } from "@solana/web3.js";
// The import attribute keeps this module importable both by the bundler and
// directly by the node:test suite (native ESM requires it for JSON modules),
// so app/lib/series-resolver.ts — which depends on the constants below — can
// be unit-tested without a build step.
import deployment from "../../vsol/deployments/devnet.json" with { type: "json" };

type LiquidityDeployment = {
  id: string;
  address: string;
  token: string;
  quoteAuthority: string;
  settlementMint: string;
  maxUtilizationBps: number;
  maxPositionBps: number;
  authorizedMarkets: string[];
  // Optional until the permissionless factory redeploy publishes it.
  manager?: string;
};

// A single retired address lookup table: rotated out of active service by
// vsol/scripts/create-lookup-table.ts (see its rotation path) but not yet
// safe to deactivate/close, because not-yet-settled positions quoted moments
// before rotation may still reference it. vsol/scripts/keeper.ts advances
// each entry toward deactivation and, once its onchain cooldown elapses,
// closure -- see vsol/scripts/lib/lookup-table.ts's RetiringLookupTableEntry
// (the authoritative type both scripts share) for the exact same shape.
type RetiringLookupTableDeployment = {
  address: string;
  // Unix-seconds instant after which every market that was live in this
  // table at rotation time has both expired and cleared its settlement
  // grace/staleness window -- i.e. every position that could reference this
  // table's indices has had a chance to settle onchain.
  outliveExpiry: number;
  // ISO timestamp this table was retired from active service (informational).
  retiredAt: string;
};

// ---------------------------------------------------------------------------
// Manifest shape for the address lookup table (ALT) rotation scheme:
//
//   `addressLookupTable` ALWAYS means "the CURRENT active table" -- the one
//   the app compiles brand-new fill transactions against (see
//   VSOL_ADDRESS_LOOKUP_TABLE and app/lib/vsol-server.ts's
//   getVsolAddressLookupTableAccount). This is unchanged from before rotation
//   existed, so every existing single-table consumer keeps working.
//
//   `retiringLookupTables` lists tables rotated OUT of that role but not yet
//   safe to close: not-yet-settled positions quoted moments before a
//   rotation may still name one of these in a signed transaction the app
//   must still be able to verify/resolve (never compile new fills against).
//   See app/lib/vsol-server.ts's resolveSignedVsolFillTransaction, which
//   accepts the current table OR any published retiring table, and rejects
//   anything else -- a foreign table must never resolve.
//
// An ALT is append-only with a hard 256-address cap (11 stable addresses +
// 2 per minted market fills it in ~120 markets at this grid's mint rate), so
// there is no way to delete individual entries -- rotation to a fresh table
// is the only way forward. See vsol/scripts/lib/lookup-table.ts for the
// rotation threshold and vsol/scripts/keeper.ts for the deactivate/close
// lifecycle.
// ---------------------------------------------------------------------------
type ExtendedDeployment = typeof deployment & {
  liquidityPools?: LiquidityDeployment[];
  // Published once the ALT that collapses VSOL fill transactions (both the
  // plain 2-instruction fill and the 4-instruction mint-on-demand shape)
  // under Solana's 1232-byte packet limit has been created and extended
  // onchain. Absent until then -- see app/lib/vsol-server.ts's
  // getVsolAddressLookupTableAccount, which must keep building legacy
  // transactions exactly as before whenever this is missing.
  addressLookupTable?: string;
  // Absent on manifests that predate rotation, and whenever no table has
  // been rotated out yet -- treated identically to an empty array everywhere
  // this is read (see VSOL_RETIRING_LOOKUP_TABLES below).
  retiringLookupTables?: RetiringLookupTableDeployment[];
};

const deployed = deployment as ExtendedDeployment;

export const VSOL_CLUSTER = "devnet" as const;
export const VSOL_RPC_URL = deployment.rpcUrl;
export const VSOL_PROGRAM_ID = new PublicKey(deployment.programId);
export const VSOL_PYTH_UPGRADE_DEPLOYED = deployment.pythUpgradeDeployed;
// The `close_pool_position` instruction landed in the program source and IDL
// (vsol/programs/vsol/src/lib.rs, vsol/target/idl/vsol.json) but the last
// devnet program upgrade predates it. Until the manifest publishes this flag
// as `true` (set only after a redeploy that includes the instruction), the
// close flow must fail closed rather than build transactions the deployed
// program cannot execute.
export const VSOL_CLOSE_POSITION_DEPLOYED = Boolean((deployed as unknown as { closePoolPositionDeployed?: boolean }).closePoolPositionDeployed);
export const VSOL_PYTH_RECEIVER_PROGRAM_ID = new PublicKey(deployment.pythReceiverProgram);
export const VSOL_PYTH_FEED_ID = deployment.pythFeedId;
export const VSOL_CONFIG = new PublicKey(deployment.config);
export const VSOL_MARKET = new PublicKey(deployment.uiMarket);
export const VSOL_ORACLE = new PublicKey(deployment.uiOracle);
export const VSOL_MAKER = new PublicKey(deployment.maker);
export const VSOL_SETTLEMENT_MINT = new PublicKey(deployment.settlementMint);
export const VSOL_WRITER_VAULT = new PublicKey(deployment.writerVault);
export const VSOL_WRITER_TOKEN = new PublicKey(deployment.writerToken);
// The address lookup table that lets fill transactions compile as v0 (see
// app/lib/vsol-server.ts). Null until the manifest publishes it -- every
// caller must keep working with plain legacy transactions in that case.
export const VSOL_ADDRESS_LOOKUP_TABLE = deployed.addressLookupTable
  ? new PublicKey(deployed.addressLookupTable)
  : null;
export type VsolRetiringLookupTable = { address: PublicKey; outliveExpiry: number; retiredAt: string };
// Tables rotated out of active service but not yet closed (see the manifest
// shape comment above). Empty whenever the manifest omits the field or has
// never rotated. app/lib/vsol-server.ts's resolveSignedVsolFillTransaction
// treats every one of these, plus VSOL_ADDRESS_LOOKUP_TABLE, as a trusted
// table a signed v0 transaction may reference -- any other table is rejected.
export const VSOL_RETIRING_LOOKUP_TABLES: readonly VsolRetiringLookupTable[] = Object.freeze(
  (deployed.retiringLookupTables ?? []).map((entry) => ({
    address: new PublicKey(entry.address),
    outliveExpiry: entry.outliveExpiry,
    retiredAt: entry.retiredAt,
  })),
);
// The manifest's own `markets` array (bootstrap-time evidence of the series
// that were minted during setup) is intentionally NOT read here anymore. A
// keeper mints fresh grid rungs continuously, so a checked-in snapshot goes
// stale within minutes; the rolling series catalog is now resolved live from
// chain via deterministic market-id derivation — see app/lib/series-resolver.ts.
// The manifest keeps its other roles: program id, config, pool, mints below.
// `authorizedMarkets` (bootstrap-time evidence of which markets a pool
// authorized) is intentionally NOT turned into a PublicKey allowlist here
// anymore: pool-market authorization is verified live on-chain (see
// getPoolMarketState in app/lib/vsol-server.ts) rather than gated against a
// checked-in manifest snapshot, which would reject any rung the keeper
// authorized after the last bootstrap run. The raw manifest field stays on
// this object (via the spread below) since vsol/scripts/verify-deployment.ts
// still reads it independently.
const liquidity = deployed.liquidityPools?.[0];
export const VSOL_LIQUIDITY = liquidity
  ? Object.freeze({
      ...liquidity,
      poolKey: new PublicKey(liquidity.address),
      assetVaultKey: new PublicKey(liquidity.token),
      quoteAuthorityKey: new PublicKey(liquidity.quoteAuthority),
      settlementMintKey: new PublicKey(liquidity.settlementMint),
      managerKey: liquidity.manager ? new PublicKey(liquidity.manager) : null,
    })
  : null;

export function solanaExplorerUrl(kind: "address" | "tx", value: string) {
  return `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
}

export type SolanaWalletProvider = {
  publicKey?: PublicKey;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect?(): Promise<void>;
  signTransaction<T>(transaction: T): Promise<T>;
  // Optional: not every injected wallet supports message signing. Sign-in
  // degrades gracefully when it is missing.
  signMessage?(message: Uint8Array, encoding?: "utf8"): Promise<{ signature: Uint8Array } | Uint8Array>;
  on?(event: "accountChanged", listener: (publicKey: PublicKey | null) => void): void;
};

export type VsolQuotePayload = {
  transaction: string;
  positionAddress: string;
  nonce: string;
  marketAddress: string;
  explorerUrl: string;
  // True when this fill also mints (create_market) and authorizes
  // (set_liquidity_pool_market) its own series onchain -- the buyer pays that
  // rent as part of signing this same transaction. See app/lib/vsol-server.ts.
  mintOnDemand?: boolean;
};
