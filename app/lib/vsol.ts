import { PublicKey } from "@solana/web3.js";
import deployment from "../../vsol/deployments/devnet.json";
import type { ExpiryCode } from "./expiries";

type DeploymentSeries = {
  code: ExpiryCode;
  symbol?: string;
  address: string;
  oracle: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  lastTradeAt: number;
  // Optional until the permissionless factory redeploy publishes it.
  creator?: string;
};

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

type ExtendedDeployment = typeof deployment & {
  markets?: DeploymentSeries[];
  liquidityPools?: LiquidityDeployment[];
};

const deployed = deployment as ExtendedDeployment;

export const VSOL_CLUSTER = "devnet" as const;
export const VSOL_RPC_URL = deployment.rpcUrl;
export const VSOL_PROGRAM_ID = new PublicKey(deployment.programId);
export const VSOL_PYTH_UPGRADE_DEPLOYED = deployment.pythUpgradeDeployed;
export const VSOL_PYTH_RECEIVER_PROGRAM_ID = new PublicKey(deployment.pythReceiverProgram);
export const VSOL_PYTH_FEED_ID = deployment.pythFeedId;
export const VSOL_CONFIG = new PublicKey(deployment.config);
export const VSOL_MARKET = new PublicKey(deployment.uiMarket);
export const VSOL_ORACLE = new PublicKey(deployment.uiOracle);
export const VSOL_MAKER = new PublicKey(deployment.maker);
export const VSOL_SETTLEMENT_MINT = new PublicKey(deployment.settlementMint);
export const VSOL_WRITER_VAULT = new PublicKey(deployment.writerVault);
export const VSOL_WRITER_TOKEN = new PublicKey(deployment.writerToken);
const deploymentSeries = (deployed.markets ?? []) as DeploymentSeries[];
export const VSOL_SERIES = Object.freeze(deploymentSeries.map((series) => ({
  ...series,
  symbol: (series.symbol ?? "NVDA").toUpperCase(),
  marketKey: new PublicKey(series.address),
  oracleKey: new PublicKey(series.oracle),
})));
const liquidity = deployed.liquidityPools?.[0];
export const VSOL_LIQUIDITY = liquidity
  ? Object.freeze({
      ...liquidity,
      poolKey: new PublicKey(liquidity.address),
      assetVaultKey: new PublicKey(liquidity.token),
      quoteAuthorityKey: new PublicKey(liquidity.quoteAuthority),
      settlementMintKey: new PublicKey(liquidity.settlementMint),
      authorizedMarketKeys: liquidity.authorizedMarkets.map((address) => new PublicKey(address)),
      managerKey: liquidity.manager ? new PublicKey(liquidity.manager) : null,
    })
  : null;

export function vsolSeries(symbol: string, expiryCode: ExpiryCode) {
  return VSOL_SERIES.find((series) => series.symbol === symbol.toUpperCase() && series.code === expiryCode) ?? null;
}

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
};
