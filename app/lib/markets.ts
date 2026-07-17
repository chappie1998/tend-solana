export type Market = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  iv: number;
  tokenAddress: `0x${string}`;
  tone: string;
  oracleStatus: "Configured" | "Indicative";
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
    tokenAddress: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    tone: "#83e0ba",
    oracleStatus: "Configured",
    marketDataSymbol: "NVDA",
    intradayEligible: true,
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    price: 446.73,
    change: -1.18,
    iv: 57.8,
    tokenAddress: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    tone: "#ff8e79",
    oracleStatus: "Configured",
    marketDataSymbol: "TSLA",
    intradayEligible: true,
  },
  {
    symbol: "SPCX",
    name: "SpaceX exposure",
    price: 288.14,
    change: 0.82,
    iv: 68.9,
    tokenAddress: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
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
    tokenAddress: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
    tone: "#ffd275",
    oracleStatus: "Configured",
    marketDataSymbol: "QQQ",
    intradayEligible: true,
  },
];
