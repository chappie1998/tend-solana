export type Market = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  iv: number;
  tokenAddress: string;
  tone: string;
  oracleStatus: "Devnet" | "Indicative";
  marketDataSymbol: string | null;
  intradayEligible: boolean;
};

export const markets: Market[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    price: 171.86,
    change: 2.41,
    iv: 46.2,
    tokenAddress: deployment.underlyingMint,
    tone: "#83e0ba",
    oracleStatus: "Devnet",
    marketDataSymbol: "NVDA",
    intradayEligible: true,
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    price: 446.73,
    change: -1.18,
    iv: 57.8,
    tokenAddress: deployment.underlyingMint,
    tone: "#ff8e79",
    oracleStatus: "Devnet",
    marketDataSymbol: "TSLA",
    intradayEligible: true,
  },
  {
    symbol: "SPCX",
    name: "SpaceX exposure",
    price: 288.14,
    change: 0.82,
    iv: 68.9,
    tokenAddress: deployment.underlyingMint,
    tone: "#9aaeff",
    oracleStatus: "Indicative",
    marketDataSymbol: null,
    intradayEligible: false,
  },
  {
    symbol: "QQQ",
    name: "Invesco QQQ",
    price: 638.27,
    change: 0.37,
    iv: 24.6,
    tokenAddress: deployment.underlyingMint,
    tone: "#ffd275",
    oracleStatus: "Devnet",
    marketDataSymbol: "QQQ",
    intradayEligible: true,
  },
];
import deployment from "../../vsol/deployments/devnet.json";
