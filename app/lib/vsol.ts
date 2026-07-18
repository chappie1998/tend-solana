import { PublicKey } from "@solana/web3.js";
import deployment from "../../vsol/deployments/devnet.json";

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

export function solanaExplorerUrl(kind: "address" | "tx", value: string) {
  return `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
}

export type SolanaWalletProvider = {
  publicKey?: PublicKey;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect?(): Promise<void>;
  signTransaction<T>(transaction: T): Promise<T>;
  on?(event: "accountChanged", listener: (publicKey: PublicKey | null) => void): void;
};

export type VsolQuotePayload = {
  transaction: string;
  positionAddress: string;
  nonce: string;
  marketAddress: string;
  explorerUrl: string;
};
