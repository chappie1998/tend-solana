import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/vsol.json" with { type: "json" };
import {
  buildBurnCompleteSetInstruction,
  buildMintCompleteSetInstruction,
  buildRedeemUnresolvedInstruction,
  buildRedeemWinningInstruction,
  calculatePayout,
  calculateDepositShares,
  calculateWithdrawAmount,
  deriveCompleteSetToken,
  deriveCompleteSetVault,
  deriveCustomSettlementObservation,
  deriveConfig,
  deriveDownMint,
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
  deriveUpMint,
  finalSettlementDeadline,
  isPoolUpdatePending,
  isPoolUpdateTightening,
  ladderStrike,
  liquidityPoolId,
  MARKET_SEED,
  MARKET_CLEANUP_BUFFER_SECONDS,
  marketCloseableAfter,
  MAX_POOL_UTILIZATION_BPS,
  PRICE_SCALE,
  STRIKE_LADDER_STEP,
  POOL_UPDATE_TIMELOCK_SECONDS,
  poolUpdateEffectiveAt,
  settlementDeadline,
  POOL_BUYBACK_DOMAIN,
  poolBuybackMessage,
  poolQuoteMessage,
  quoteMessage,
  symbolBytes,
  UP_MINT_SEED,
  DOWN_MINT_SEED,
  COMPLETE_SET_VAULT_SEED,
  COMPLETE_SET_TOKEN_SEED,
  upWins,
  type PoolBuyback,
  type Quote,
  VSOL_PROGRAM_ID,
} from "../sdk/index.ts";

test("custom observation PDA and generated discriminators match Anchor encoding", () => {
  const expiry = 1_800_000_000n;
  const first = deriveCustomSettlementObservation("NVDA", expiry);
  assert.equal(deriveCustomSettlementObservation("NVDA", expiry).toBase58(), first.toBase58());
  assert.notEqual(deriveCustomSettlementObservation("NVDA", expiry + 1n).toBase58(), first.toBase58());

  const instruction = idl.instructions.find((entry) => entry.name === "capture_custom_settlement_observation");
  const account = idl.accounts.find((entry) => entry.name === "CustomSettlementObservation");
  assert.deepEqual(instruction?.discriminator, [...createHash("sha256").update("global:capture_custom_settlement_observation").digest().subarray(0, 8)]);
  assert.deepEqual(account?.discriminator, [...createHash("sha256").update("account:CustomSettlementObservation").digest().subarray(0, 8)]);
  const update = idl.instructions.find((entry) => entry.name === "update_custom_price_feed");
  assert.deepEqual(update?.args.map((arg) => arg.name), ["price", "confidence", "observed_at"]);
  const settlementOracle = idl.types.find((entry) => entry.name === "SettlementOracle");
  assert.deepEqual(settlementOracle?.type.fields?.map((field) => field.name), [
    "bump", "market", "price", "confidence", "observed_at", "published_at",
    "price_update", "feed_id", "exponent", "finalized", "settled_from_stale_price",
  ]);
});

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
  strike: 100_000_000n,
};
const MARKET_ID_KNOWN_ANSWER = "305841fbbb6aaefcf048870bda425066777d12e82d8b74f358f13d43caf66adf";

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
    { strike: MARKET_ID_FIXTURE.strike + 1n },
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

test("marketCloseableAfter mirrors the on-chain close_settled_market deadline", () => {
  // Same formula the Rust program uses (see `close_settled_market` in
  // src/lib.rs): the settlement deadline (expiry + observation window +
  // settlement grace) PLUS MARKET_CLEANUP_BUFFER_SECONDS.
  const expiry = 1_800_000_000n;
  const observationWindowSeconds = 30;
  const settlementGraceSeconds = 900;
  const settlement = settlementDeadline({ expiry, observationWindowSeconds, settlementGraceSeconds });
  assert.equal(settlement, expiry + BigInt(observationWindowSeconds) + BigInt(settlementGraceSeconds));
  assert.equal(settlement, 1_800_000_930n);

  const deadline = marketCloseableAfter({ expiry, observationWindowSeconds, settlementGraceSeconds });
  assert.equal(deadline, settlement + MARKET_CLEANUP_BUFFER_SECONDS);
  assert.equal(deadline, 1_800_605_730n);
});

// The whole point of the buffer: a market must NOT become closeable at the
// instant a stranded position first becomes refundable, or cleanup races the
// refund and strands the escrow permanently.
test("a market is not closeable until well after its positions become refundable", () => {
  const params = { expiry: 1_800_000_000n, observationWindowSeconds: 30, settlementGraceSeconds: 900 };
  const settlement = settlementDeadline(params);
  const closeable = marketCloseableAfter(params);
  assert.ok(closeable > settlement, "close deadline must be strictly after the refund deadline");
  assert.equal(closeable - settlement, MARKET_CLEANUP_BUFFER_SECONDS);
});

test("marketCloseableAfter is strictly after expiry whenever either window is positive", () => {
  const expiry = 42n;
  assert.equal(
    marketCloseableAfter({ expiry, observationWindowSeconds: 1, settlementGraceSeconds: 0 }) > expiry,
    true,
  );
  assert.equal(
    marketCloseableAfter({ expiry, observationWindowSeconds: 0, settlementGraceSeconds: 1 }) > expiry,
    true,
  );
});

// ladderStrike is the fixed strike-ladder rounding function: see its doc
// comment in sdk/index.ts for why strike is a listed ladder parameter, not
// something re-derived from live spot on every keeper pass.
test("ladderStrike rounds to the nearest ladder step", () => {
  const step = STRIKE_LADDER_STEP; // $2.50 at PRICE_SCALE
  assert.equal(step, 2_500_000n);
  assert.equal(ladderStrike(100n * PRICE_SCALE), 100n * PRICE_SCALE);
  // $101.24 rounds down to the $100.00 rung (closer than the $102.50 rung).
  assert.equal(ladderStrike(101n * PRICE_SCALE + 240_000n), 100n * PRICE_SCALE);
  // $101.43 -- live SOL spot when the step was resized -- rounds up to $102.50.
  assert.equal(ladderStrike(101n * PRICE_SCALE + 430_000n), 102n * PRICE_SCALE + 500_000n);
  // $101.26 rounds up to the $102.50 rung.
  assert.equal(ladderStrike(101n * PRICE_SCALE + 260_000n), 102n * PRICE_SCALE + 500_000n);
  // Exactly on a half-step boundary rounds up (round-half-up, deterministic).
  assert.equal(ladderStrike(100n * PRICE_SCALE + step / 2n), 102n * PRICE_SCALE + 500_000n);
});

test("ladderStrike clamps to a minimum of one step (create_market requires strike > 0)", () => {
  assert.equal(ladderStrike(0n), STRIKE_LADDER_STEP);
  assert.equal(ladderStrike(-1n), STRIKE_LADDER_STEP);
  assert.equal(ladderStrike(1n), STRIKE_LADDER_STEP); // Nearest rung to a tiny positive price is still the first rung.
  assert.equal(ladderStrike(STRIKE_LADDER_STEP / 2n - 1n), STRIKE_LADDER_STEP);
});

test("ladderStrike ladders on a PER-MARKET step, not one global constant", () => {
  // The step is a market's own configuration (see `strikeLadderStep` in
  // app/lib/markets.ts): roughly 2-3% of THAT asset's spot. A single global
  // step cannot serve two assets three orders of magnitude apart -- SOL's
  // $2.50 is 2.4% of SOL and 0.003% of BTC, which would list a new contract
  // every quarter of a basis point.
  const btcStep = 2_000n * PRICE_SCALE; // $2,000 -- 2.5% at BTC ~$80,016.
  const ethStep = 50n * PRICE_SCALE;    // $50    -- 2.0% at ETH ~$2,473.52.

  // BTC spot $80,016.43 rounds to the $80,000 rung (the $82,000 rung is far).
  assert.equal(ladderStrike(80_016n * PRICE_SCALE + 430_000n, btcStep), 80_000n * PRICE_SCALE);
  // ...and $81,200 is past the midpoint, so it rounds UP to $82,000.
  assert.equal(ladderStrike(81_200n * PRICE_SCALE, btcStep), 82_000n * PRICE_SCALE);

  // ETH spot $2,473.52 rounds to the $2,450 rung ($2,500 is $26.48 away).
  assert.equal(ladderStrike(2_473n * PRICE_SCALE + 520_000n, ethStep), 2_450n * PRICE_SCALE);

  // The default is still SOL's step, so callers with no market in hand are
  // unchanged -- that is the ONLY reason the parameter has a default.
  assert.equal(ladderStrike(80_016n * PRICE_SCALE), ladderStrike(80_016n * PRICE_SCALE, STRIKE_LADDER_STEP));

  // The same spot on two different steps must land on two different rungs;
  // if it did not, the step would not be doing anything.
  assert.notEqual(ladderStrike(2_473n * PRICE_SCALE, ethStep), ladderStrike(2_473n * PRICE_SCALE, STRIKE_LADDER_STEP));

  // A non-positive step is a configuration error, not something to silently
  // fall back from: it would divide by zero or loop on a zero-width ladder.
  assert.throws(() => ladderStrike(100n * PRICE_SCALE, 0n), RangeError);
  assert.throws(() => ladderStrike(100n * PRICE_SCALE, -1n), RangeError);

  // Clamping to one step still holds for any step, not just the default.
  assert.equal(ladderStrike(0n, btcStep), btcStep);
  assert.equal(ladderStrike(1n, ethStep), ethStep);
});

test("ladderStrike is idempotent on an already-listed rung", () => {
  for (const strike of [STRIKE_LADDER_STEP, 50n * PRICE_SCALE, 1_000n * PRICE_SCALE]) {
    assert.equal(ladderStrike(strike), strike);
  }
});

test("pool share math rounds down and rejects insolvent or dust operations", () => {
  assert.equal(calculateDepositShares(1_000n, 0n, 0n), 1_000n);
  assert.equal(calculateDepositShares(333n, 1_000n, 3_000n), 111n);
  // Pre-virtual-offset this was 333n (111 * 3_001 / 1_000, exact). The +1/+1
  // virtual shares/assets offset (mirrors math.rs's calculate_withdraw_amount,
  // OpenZeppelin ERC-4626 style) makes this 111 * 3_002 / 1_001 = 332n
  // (floor) -- one unit of extra rounding dust, the deliberate cost of
  // closing the first-depositor inflation attack.
  assert.equal(calculateWithdrawAmount(111n, 1_000n, 3_001n), 332n);
  assert.throws(() => calculateDepositShares(1n, 1n, 0n), /insolvent/);
  assert.throws(() => calculateDepositShares(1n, 1n, 10n), /too small/);
});

// MAX_POOL_UTILIZATION_BPS / POOL_UPDATE_TIMELOCK_SECONDS: SDK-side mirrors of
// the on-chain pool-drain fix (see vsol/programs/vsol/src/lib.rs). No pool can
// be configured above 80% utilization, and raising a cap or rotating
// quoteAuthority is timelocked 24h before it can be applied.

test("MAX_POOL_UTILIZATION_BPS mirrors the on-chain protocol ceiling", () => {
  assert.equal(MAX_POOL_UTILIZATION_BPS, 8_000);
  assert.ok(MAX_POOL_UTILIZATION_BPS < 10_000, "must be strictly below 100% -- the whole point of the ceiling");
});

test("poolUpdateEffectiveAt mirrors the on-chain timelock computation", () => {
  const now = 1_800_000_000n;
  assert.equal(POOL_UPDATE_TIMELOCK_SECONDS, 86_400n);
  assert.equal(poolUpdateEffectiveAt(now), now + 86_400n);
});

test("isPoolUpdatePending treats the zero sentinel as no pending change", () => {
  assert.equal(isPoolUpdatePending(0n), false);
  assert.equal(isPoolUpdatePending(1_800_000_000n), true);
});

test("isPoolUpdateTightening: lowering caps with the same authority is immediate", () => {
  const authority = VSOL_PROGRAM_ID;
  assert.equal(
    isPoolUpdateTightening({
      currentQuoteAuthority: authority,
      currentMaxUtilizationBps: 8_000,
      currentMaxPositionBps: 2_000,
      nextQuoteAuthority: authority,
      nextMaxUtilizationBps: 5_000,
      nextMaxPositionBps: 1_000,
    }),
    true,
  );
  // Leaving both caps unchanged (same authority) is trivially safe too.
  assert.equal(
    isPoolUpdateTightening({
      currentQuoteAuthority: authority,
      currentMaxUtilizationBps: 8_000,
      currentMaxPositionBps: 2_000,
      nextQuoteAuthority: authority,
      nextMaxUtilizationBps: 8_000,
      nextMaxPositionBps: 2_000,
    }),
    true,
  );
});

test("isPoolUpdateTightening: raising a cap or rotating the authority is timelocked", () => {
  const authority = VSOL_PROGRAM_ID;
  const otherAuthority = deriveConfig(); // any distinct pubkey
  // Raising max_position_bps, authority unchanged.
  assert.equal(
    isPoolUpdateTightening({
      currentQuoteAuthority: authority,
      currentMaxUtilizationBps: 8_000,
      currentMaxPositionBps: 2_000,
      nextQuoteAuthority: authority,
      nextMaxUtilizationBps: 8_000,
      nextMaxPositionBps: 3_000,
    }),
    false,
  );
  // Rotating quoteAuthority even while lowering both caps.
  assert.equal(
    isPoolUpdateTightening({
      currentQuoteAuthority: authority,
      currentMaxUtilizationBps: 8_000,
      currentMaxPositionBps: 2_000,
      nextQuoteAuthority: otherAuthority,
      nextMaxUtilizationBps: 1_000,
      nextMaxPositionBps: 500,
    }),
    false,
  );
});

// =====================================================================
// Conditional tokens ("complete sets")
// =====================================================================

test("upWins mirrors the on-chain winner rule, including the tie-goes-to-down case", () => {
  assert.equal(upWins(100n, 100n), false); // exact tie -> DOWN
  assert.equal(upWins(101n, 100n), true); // strictly above -> UP
  assert.equal(upWins(99n, 100n), false); // strictly below -> DOWN
  assert.equal(upWins(0n, 0n), false);
  assert.equal(upWins(1n, 0n), true);
});

test("complete-set PDAs are deterministic and distinct from one another", () => {
  // Any 32-byte value works as the market id here -- this test only checks
  // the PDAs derived FROM a market address are distinct/correct, not the
  // market address's own derivation (covered elsewhere).
  const market = deriveMarket(deriveConfig(), Buffer.alloc(32, 0x55));
  const upMint = deriveUpMint(market);
  const downMint = deriveDownMint(market);
  const vault = deriveCompleteSetVault(market);

  assert.equal(
    upMint.toBase58(),
    PublicKey.findProgramAddressSync([UP_MINT_SEED, market.toBuffer()], VSOL_PROGRAM_ID)[0].toBase58(),
  );
  assert.equal(
    downMint.toBase58(),
    PublicKey.findProgramAddressSync([DOWN_MINT_SEED, market.toBuffer()], VSOL_PROGRAM_ID)[0].toBase58(),
  );
  assert.equal(
    vault.toBase58(),
    PublicKey.findProgramAddressSync([COMPLETE_SET_VAULT_SEED, market.toBuffer()], VSOL_PROGRAM_ID)[0].toBase58(),
  );

  const addresses = [upMint.toBase58(), downMint.toBase58(), vault.toBase58(), market.toBase58()];
  assert.equal(new Set(addresses).size, addresses.length, "every complete-set PDA must be distinct");
});

test("deriveCompleteSetToken is keyed by both mint and owner", () => {
  const mintA = deriveConfig(); // any distinct pubkey stand-in
  const mintB = deriveMarket(deriveConfig(), Buffer.alloc(32, 0x66));
  const ownerA = new PublicKey(Buffer.alloc(32, 0x77));
  const ownerB = new PublicKey(Buffer.alloc(32, 0x88));

  const a = deriveCompleteSetToken(mintA, ownerA);
  assert.equal(
    a.toBase58(),
    PublicKey.findProgramAddressSync(
      [COMPLETE_SET_TOKEN_SEED, mintA.toBuffer(), ownerA.toBuffer()],
      VSOL_PROGRAM_ID,
    )[0].toBase58(),
  );
  assert.notEqual(a.toBase58(), deriveCompleteSetToken(mintB, ownerA).toBase58());
  assert.notEqual(a.toBase58(), deriveCompleteSetToken(mintA, ownerB).toBase58());
});

function fixtureCompleteSetAccounts() {
  const market = deriveMarket(deriveConfig(), Buffer.alloc(32, 0x99));
  const upMint = deriveUpMint(market);
  const downMint = deriveDownMint(market);
  const collateralVault = deriveCompleteSetVault(market);
  const owner = new PublicKey(Buffer.alloc(32, 0xaa));
  const settlementMint = new PublicKey(Buffer.alloc(32, 0xbb));
  const oracle = new PublicKey(Buffer.alloc(32, 0xcc));
  return { market, upMint, downMint, collateralVault, owner, settlementMint, oracle };
}

test("buildMintCompleteSetInstruction matches the program's discriminator, account order, and data layout", async () => {
  const f = fixtureCompleteSetAccounts();
  const source = new PublicKey(Buffer.alloc(32, 0xdd));
  const upToken = deriveCompleteSetToken(f.upMint, f.owner);
  const downToken = deriveCompleteSetToken(f.downMint, f.owner);
  const amount = 12_345n;

  const ix = await buildMintCompleteSetInstruction(
    {
      minter: f.owner,
      config: deriveConfig(),
      market: f.market,
      settlementMint: f.settlementMint,
      upMint: f.upMint,
      downMint: f.downMint,
      collateralVault: f.collateralVault,
      minterSource: source,
      minterUpToken: upToken,
      minterDownToken: downToken,
    },
    amount,
  );

  assert.equal(ix.programId.toBase58(), VSOL_PROGRAM_ID.toBase58());
  // The 8-byte Anchor discriminator: sha256("global:mint_complete_set")[..8],
  // pinned against the program's own generated IDL
  // (target/idl/vsol.json) at implementation time.
  assert.deepEqual([...ix.data.subarray(0, 8)], [70, 222, 130, 148, 234, 103, 137, 61]);
  assert.equal(ix.data.length, 16); // 8-byte discriminator + u64 amount
  assert.equal(ix.data.readBigUInt64LE(8), amount);

  assert.equal(ix.keys.length, 13);
  assert.equal(ix.keys[0].pubkey.toBase58(), f.owner.toBase58());
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[0].isWritable, true);
  assert.equal(ix.keys[4].pubkey.toBase58(), f.upMint.toBase58());
  assert.equal(ix.keys[4].isWritable, true);
  assert.equal(ix.keys[5].pubkey.toBase58(), f.downMint.toBase58());
  assert.equal(ix.keys[6].pubkey.toBase58(), f.collateralVault.toBase58());
  assert.equal(ix.keys[9].pubkey.toBase58(), downToken.toBase58());
});

test("buildBurnCompleteSetInstruction matches the program's discriminator and account order", async () => {
  const f = fixtureCompleteSetAccounts();
  const upToken = deriveCompleteSetToken(f.upMint, f.owner);
  const downToken = deriveCompleteSetToken(f.downMint, f.owner);
  const destination = new PublicKey(Buffer.alloc(32, 0xee));

  const ix = await buildBurnCompleteSetInstruction(
    {
      burner: f.owner,
      config: deriveConfig(),
      market: f.market,
      settlementMint: f.settlementMint,
      upMint: f.upMint,
      downMint: f.downMint,
      collateralVault: f.collateralVault,
      burnerUpToken: upToken,
      burnerDownToken: downToken,
      burnerDestination: destination,
    },
    500n,
  );

  assert.deepEqual([...ix.data.subarray(0, 8)], [183, 36, 119, 130, 123, 198, 110, 211]);
  assert.equal(ix.data.readBigUInt64LE(8), 500n);
  assert.equal(ix.keys.length, 11);
  // burner is a signer but NOT writable -- matches `pub burner: Signer<'info>`
  // (no `#[account(mut)]`) in the `BurnCompleteSet` Anchor context.
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[0].isWritable, false);
  assert.equal(ix.keys[9].pubkey.toBase58(), destination.toBase58());
});

test("buildRedeemWinningInstruction matches the program's discriminator and account order", async () => {
  const f = fixtureCompleteSetAccounts();
  const redeemerToken = deriveCompleteSetToken(f.upMint, f.owner);
  const destination = new PublicKey(Buffer.alloc(32, 0xff));

  const ix = await buildRedeemWinningInstruction(
    {
      redeemer: f.owner,
      config: deriveConfig(),
      market: f.market,
      oracle: f.oracle,
      settlementMint: f.settlementMint,
      upMint: f.upMint,
      downMint: f.downMint,
      collateralVault: f.collateralVault,
      redeemerToken,
      redeemerDestination: destination,
    },
    77n,
  );

  assert.deepEqual([...ix.data.subarray(0, 8)], [191, 44, 57, 7, 31, 46, 190, 162]);
  assert.equal(ix.data.readBigUInt64LE(8), 77n);
  assert.equal(ix.keys.length, 11);
  assert.equal(ix.keys[3].pubkey.toBase58(), f.oracle.toBase58());
  assert.equal(ix.keys[8].pubkey.toBase58(), redeemerToken.toBase58());
});

// =====================================================================
// redeem_unresolved (FINDING 2: the escape hatch for an oracle that never
// finalizes)
// =====================================================================

test("buildRedeemUnresolvedInstruction matches the program's discriminator, account order, and data layout", async () => {
  const f = fixtureCompleteSetAccounts();
  // Deliberately the DOWN side here (unlike buildRedeemWinningInstruction's
  // own test, which uses UP) -- redeemUnresolved accepts either.
  const redeemerToken = deriveCompleteSetToken(f.downMint, f.owner);
  const destination = new PublicKey(Buffer.alloc(32, 0x12));
  const amount = 12_345_678_901n;

  const ix = await buildRedeemUnresolvedInstruction(
    {
      redeemer: f.owner,
      config: deriveConfig(),
      market: f.market,
      oracle: f.oracle,
      settlementMint: f.settlementMint,
      upMint: f.upMint,
      downMint: f.downMint,
      collateralVault: f.collateralVault,
      redeemerToken,
      redeemerDestination: destination,
    },
    amount,
  );

  assert.equal(ix.programId.toBase58(), VSOL_PROGRAM_ID.toBase58());
  // sha256("global:redeem_unresolved")[..8], pinned against the program's
  // own generated IDL (target/idl/vsol.json) at implementation time.
  assert.deepEqual([...ix.data.subarray(0, 8)], [94, 144, 129, 29, 214, 131, 149, 78]);
  assert.equal(ix.data.length, 16); // 8-byte discriminator + u64 amount
  assert.equal(ix.data.readBigUInt64LE(8), amount);

  // Same account order as buildRedeemWinningInstruction (see
  // `RedeemUnresolved`'s doc comment in src/lib.rs: modeled directly on
  // `RedeemWinning`).
  assert.equal(ix.keys.length, 11);
  assert.equal(ix.keys[0].pubkey.toBase58(), f.owner.toBase58());
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[0].isWritable, false);
  assert.equal(ix.keys[1].pubkey.toBase58(), deriveConfig().toBase58());
  assert.equal(ix.keys[2].pubkey.toBase58(), f.market.toBase58());
  assert.equal(ix.keys[3].pubkey.toBase58(), f.oracle.toBase58());
  assert.equal(ix.keys[4].pubkey.toBase58(), f.settlementMint.toBase58());
  assert.equal(ix.keys[5].pubkey.toBase58(), f.upMint.toBase58());
  assert.equal(ix.keys[5].isWritable, true);
  assert.equal(ix.keys[6].pubkey.toBase58(), f.downMint.toBase58());
  assert.equal(ix.keys[6].isWritable, true);
  assert.equal(ix.keys[7].pubkey.toBase58(), f.collateralVault.toBase58());
  assert.equal(ix.keys[7].isWritable, true);
  assert.equal(ix.keys[8].pubkey.toBase58(), redeemerToken.toBase58());
  assert.equal(ix.keys[8].isWritable, true);
  assert.equal(ix.keys[9].pubkey.toBase58(), destination.toBase58());
  assert.equal(ix.keys[9].isWritable, true);
  assert.equal(ix.keys[10].isWritable, false); // token_program
});

test("finalSettlementDeadline is settlementDeadline plus maxSettlementStalenessSeconds", () => {
  const params = {
    expiry: 1_800_000_000n,
    observationWindowSeconds: 30,
    settlementGraceSeconds: 900,
    maxSettlementStalenessSeconds: 86_400,
  };
  const settlement = settlementDeadline(params);
  assert.equal(settlement, 1_800_000_930n);
  assert.equal(finalSettlementDeadline(params), settlement + 86_400n);
  assert.equal(finalSettlementDeadline(params), 1_800_087_330n);
});

// redeemUnresolved's own gate (finalSettlementDeadline) must never collapse
// onto the plain refund/settlement deadline -- see redeem_unresolved's doc
// comment in src/lib.rs for the insolvency that becomes possible if it does
// (a pro-rata redemption and a later real winner could both draw on the
// same collateral).
test("finalSettlementDeadline is strictly after the bare settlementDeadline whenever staleness is positive", () => {
  const params = {
    expiry: 1_800_000_000n,
    observationWindowSeconds: 30,
    settlementGraceSeconds: 900,
    maxSettlementStalenessSeconds: 1,
  };
  assert.ok(finalSettlementDeadline(params) > settlementDeadline(params));
});
