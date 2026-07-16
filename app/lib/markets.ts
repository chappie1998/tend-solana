export type Market = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  tokenAddress: `0x${string}`;
  tone: string;
  oracleStatus: "Live" | "Indicative";
};

export const markets: Market[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    price: 171.86,
    change: 2.41,
    tokenAddress: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    tone: "#83e0ba",
    oracleStatus: "Live",
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    price: 446.73,
    change: -1.18,
    tokenAddress: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    tone: "#ff8e79",
    oracleStatus: "Live",
  },
  {
    symbol: "SPCX",
    name: "SpaceX exposure",
    price: 288.14,
    change: 0.82,
    tokenAddress: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
    tone: "#9aaeff",
    oracleStatus: "Indicative",
  },
  {
    symbol: "QQQ",
    name: "Invesco QQQ",
    price: 638.27,
    change: 0.37,
    tokenAddress: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
    tone: "#ffd275",
    oracleStatus: "Live",
  },
];

export const chartPaths: Record<string, string> = {
  NVDA: "M0 114 C28 106,44 91,70 98 S112 76,136 82 S174 56,202 68 S246 42,274 49 S316 24,350 31 S394 12,430 18 S472 4,520 10",
  TSLA: "M0 72 C30 64,55 77,84 68 S126 87,156 78 S202 91,234 80 S274 96,304 84 S352 99,390 88 S452 102,520 94",
  SPCX: "M0 102 C42 98,55 82,94 87 S145 72,178 79 S230 60,270 66 S322 52,360 56 S410 42,450 48 S488 34,520 39",
  QQQ: "M0 98 C34 92,62 84,96 86 S143 70,180 74 S224 62,266 66 S312 52,350 55 S402 40,442 45 S486 29,520 34",
};
