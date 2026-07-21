import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  calculatePayout,
  calculateDepositShares,
  calculateWithdrawAmount,
  deriveConfig,
  deriveLiquidityPool,
  deriveLiquidityPoolMarket,
  deriveLiquidityPoolToken,
  deriveLiquidityProvider,
  deriveMarket,
  deriveMarketId,
  deriveNonce,
  derivePoolNonce,
  derivePoolPosition,
  derivePoolPositionVault,
  derivePosition,
  derivePositionVault,
  liquidityPoolId,
  MARKET_SEED,
  POOL_BUYBACK_DOMAIN,
  poolBuybackMessage,
  poolQuoteMessage,
  quoteMessage,
  symbolBytes,
  type PoolBuyback,
  type Quote,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";

const MARKET_ID_FIXTURE = {
  pythFeedId: new Uint8Array(32).fill(0x11),
  settlementMint: new PublicKey(Buffer.alloc(32, 0x22)),
  expiry: 1_800_000_000n,
  observationWindowSeconds: 30,
  settlementGraceSeconds: 900,
  priceScale: 1_000_000n,
  maxConfidenceBps: 100,
  symbol: symbolBytes("NVDA"),
  maxSettlementStalenessSeconds: 86_400,
};
const MARKET_ID_KNOWN_ANSWER = "37cb5a119ad74934cd1d9254aef808898eefa3240e1862b9ce89df67dcb86c86";

const quote: Quote = {
  nonce: 7n,
  direction: 0,
  strike: 100_000_000n,
  width: 20_000_000n,
  premium: 1_000_000n,
  maxPayout: 5_000_000n,
  quoteExpiry: 1_900_000_000n,
};

test("quote serialization is fixed-width and domain-separated", () => {
  const message = quoteMessage({
    domainSeparator: new Uint8Array(32).fill(9),
    domainVersion: 1,
    config: new PublicKey("11111111111111111111111111111111"),
    market: new PublicKey("SysvarC1ock11111111111111111111111111111111"),
    buyer: new PublicKey("SysvarRent111111111111111111111111111111111"),
    maker: VSOL_PROGRAM_ID,
    quote,
  });
  assert.equal(message.length, 251);
  assert.equal(message.subarray(0, 8).toString("ascii"), "VSOLRFQ1");
});

test("nonce and position PDAs are deterministic and one-shot", () => {
  const config = deriveConfig();
  const maker = new PublicKey("SysvarRent111111111111111111111111111111111");
  const nonce = deriveNonce(config, maker, 42n);
  assert.equal(deriveNonce(config, maker, 42n).toBase58(), nonce.toBase58());
  const position = derivePosition(nonce);
  assert.notEqual(position.toBase58(), derivePositionVault(position).toBase58());
});

test("buyer payout is directional, linear, and capped", () => {
  assert.equal(calculatePayout(quote, 90_000_000n), 0n);
  assert.equal(calculatePayout(quote, 110_000_000n), 2_500_000n);
  assert.equal(calculatePayout(quote, 150_000_000n), quote.maxPayout);
});

test("pool quote serialization binds pool, market, buyer, and quote authority", () => {
  const config = deriveConfig();
  const pool = deriveLiquidityPool(config, VSOL_PROGRAM_ID, liquidityPoolId("test"));
  const message = poolQuoteMessage({
    domainSeparator: new Uint8Array(32).fill(4),
    domainVersion: 2,
    config,
    pool,
    market: new PublicKey("SysvarC1ock11111111111111111111111111111111"),
    buyer: new PublicKey("SysvarRent111111111111111111111111111111111"),
    quoteAuthority: VSOL_PROGRAM_ID,
    quote,
  });
  assert.equal(message.length, 283);
  assert.equal(message.subarray(0, 8).toString("ascii"), "VSOLPLP1");
});

const POOL_BUYBACK_KNOWN_ANSWER =
  "56534f4c434c5331070707070707070707070707070707070707070707070707070707070707070705001570683178d1dc41d13a545d59af13f8577f6e7511f2f103b1f718085a25a0d901010101010101010101010101010101010101010101010101010101010101010202020202020202020202020202020202020202020202020202020202020202030303030303030303030303030303030303030303030303030303030303030304040404040404040404040404040404040404040404040404040404040404040505050505050505050505050505050505050505050505050505050505050505060606060606060606060606060606060606060606060606060606060606060687d612000000000040420f000000000000d2496b00000000";

const buyback: PoolBuyback = {
  buybackAmount: 1_234_567n,
  minProceeds: 1_000_000n,
  quoteExpiry: 1_800_000_000n,
};

test("pool buyback message matches the pinned Rust known-answer vector byte for byte", () => {
  const message = poolBuybackMessage({
    domainSeparator: new Uint8Array(32).fill(0x07),
    domainVersion: 5,
    config: new PublicKey(Buffer.alloc(32, 0x01)),
    pool: new PublicKey(Buffer.alloc(32, 0x02)),
    market: new PublicKey(Buffer.alloc(32, 0x03)),
    position: new PublicKey(Buffer.alloc(32, 0x04)),
    buyer: new PublicKey(Buffer.alloc(32, 0x05)),
    quoteAuthority: new PublicKey(Buffer.alloc(32, 0x06)),
    buyback,
  });
  assert.equal(message.length, 290);
  assert.equal(message.subarray(0, 8).toString("ascii"), "VSOLCLS1");
  assert.equal(message.subarray(0, 8).toString("hex"), POOL_BUYBACK_DOMAIN.toString("hex"));
  assert.equal(message.toString("hex"), POOL_BUYBACK_KNOWN_ANSWER);
});

test("pool buyback message binds the exact position pubkey", () => {
  const base = {
    domainSeparator: new Uint8Array(32).fill(4),
    domainVersion: 2,
    config: deriveConfig(),
    pool: new PublicKey("SysvarC1ock11111111111111111111111111111111"),
    market: new PublicKey("SysvarRent111111111111111111111111111111111"),
    buyer: VSOL_PROGRAM_ID,
    quoteAuthority: VSOL_PROGRAM_ID,
    buyback,
  };
  const messageA = poolBuybackMessage({ ...base, position: new PublicKey("11111111111111111111111111111111") });
  const messageB = poolBuybackMessage({ ...base, position: deriveConfig() });
  assert.notEqual(messageA.toString("hex"), messageB.toString("hex"));
});

test("pool PDAs are deterministic and use isolated namespaces", () => {
  const config = deriveConfig();
  const id = liquidityPoolId("devnet:tUSDC:main");
  const pool = deriveLiquidityPool(config, VSOL_PROGRAM_ID, id);
  const token = deriveLiquidityPoolToken(pool);
  const provider = new PublicKey("SysvarRent111111111111111111111111111111111");
  const providerPosition = deriveLiquidityProvider(pool, provider);
  const market = new PublicKey("SysvarC1ock11111111111111111111111111111111");
  const poolMarket = deriveLiquidityPoolMarket(pool, market);
  const nonce = derivePoolNonce(pool, VSOL_PROGRAM_ID, 99n);
  const position = derivePoolPosition(nonce);
  assert.notEqual(pool.toBase58(), token.toBase58());
  assert.notEqual(providerPosition.toBase58(), poolMarket.toBase58());
  assert.notEqual(position.toBase58(), derivePoolPositionVault(position).toBase58());
});

test("deriveMarketId matches the Rust known-answer vector byte for byte", async () => {
  const id = await deriveMarketId(MARKET_ID_FIXTURE);
  assert.equal(id.length, 32);
  assert.equal(id.toString("hex"), MARKET_ID_KNOWN_ANSWER);
});

test("deriveMarketId binds every series parameter", async () => {
  const baseline = await deriveMarketId(MARKET_ID_FIXTURE);
  const variants: Array<Partial<typeof MARKET_ID_FIXTURE>> = [
    { pythFeedId: new Uint8Array(32).fill(0x12) },
    { settlementMint: new PublicKey(Buffer.alloc(32, 0x23)) },
    { expiry: MARKET_ID_FIXTURE.expiry + 1n },
    { observationWindowSeconds: 31 },
    { settlementGraceSeconds: 901 },
    { priceScale: MARKET_ID_FIXTURE.priceScale + 1n },
    { maxConfidenceBps: 101 },
    { symbol: symbolBytes("NVDA2") },
    { maxSettlementStalenessSeconds: 86_401 },
  ];
  for (const variant of variants) {
    const changed = await deriveMarketId({ ...MARKET_ID_FIXTURE, ...variant });
    assert.notEqual(changed.toString("hex"), baseline.toString("hex"));
  }
});

test("factory market PDA derives from the deterministic market id", async () => {
  const config = deriveConfig();
  const id = await deriveMarketId(MARKET_ID_FIXTURE);
  const market = deriveMarket(config, id);
  const expected = PublicKey.findProgramAddressSync(
    [MARKET_SEED, config.toBuffer(), id],
    VSOL_PROGRAM_ID,
  )[0];
  assert.equal(market.toBase58(), expected.toBase58());
});

test("pool share math rounds down and rejects insolvent or dust operations", () => {
  assert.equal(calculateDepositShares(1_000n, 0n, 0n), 1_000n);
  assert.equal(calculateDepositShares(333n, 1_000n, 3_000n), 111n);
  assert.equal(calculateWithdrawAmount(111n, 1_000n, 3_001n), 333n);
  assert.throws(() => calculateDepositShares(1n, 1n, 0n), /insolvent/);
  assert.throws(() => calculateDepositShares(1n, 1n, 10n), /too small/);
});
