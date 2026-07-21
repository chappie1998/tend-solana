// The import attribute keeps this module importable both by the bundler and
// directly by the node:test suite (native ESM requires it for JSON modules),
// matching the convention used by app/lib/vsol.ts.
import deployment from "../../vsol/deployments/devnet.json" with { type: "json" };

export type Market = {
  symbol: string;
  name: string;
  tokenAddress: string;
  tone: string;
  oracleStatus: "Pyth Core";
  pythFeedId: string;
  pythSymbol: string;
  intradayEligible: boolean;
};

export const markets: Market[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    tokenAddress: deployment.underlyingMint,
    tone: "#83e0ba",
    oracleStatus: "Pyth Core",
    pythFeedId: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    pythSymbol: "Equity.US.NVDA/USD",
    intradayEligible: true,
  },
];

export function marketBySymbol(symbol: string) {
  return markets.find((market) => market.symbol === symbol.toUpperCase());
}
