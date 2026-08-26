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
    // Settlement and display are deliberately the SAME feed. Showing the
    // equity price while settling on the tokenized one would mean users see
    // one number and get settled on another.
    pythFeedId: "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f",
    pythSymbol: "Crypto.NVDAX/USD",
    intradayEligible: true,
  },
];

export function marketBySymbol(symbol: string) {
  return markets.find((market) => market.symbol === symbol.toUpperCase());
}
