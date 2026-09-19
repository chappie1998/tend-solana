import { createHash } from "node:crypto";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, type Connection } from "@solana/web3.js";
import { liveMarkets } from "./markets.ts";
import { deriveConfig, deriveCustomPriceFeed, MARKET_MAX_CONFIDENCE_BPS, PRICE_SCALE } from "../../vsol/sdk/index.ts";
import { decodeConfigAccount, getVsolConnection } from "./vsol-server.ts";
import { VSOL_PROGRAM_ID } from "./vsol.ts";
import { decodeClockUnixTimestamp } from "./solana-clock.ts";

const FEED_DISCRIMINATOR = createHash("sha256").update("account:CustomPriceFeed").digest().subarray(0, 8);
const FEED_SIZE = 89;
export const CUSTOM_ORACLE_READY_MAX_AGE_SECONDS = 30;

export type CustomOracleReadiness = {
  symbol: string;
  ready: boolean;
  source: "Coinbase Exchange" | "Hyperliquid xyz mark";
  observedAt: number | null;
  ageSeconds: number | null;
  reason?: string;
};

function symbolBytes(symbol: string): Buffer {
  const result = Buffer.alloc(16);
  result.write(symbol, "ascii");
  return result;
}

export function decodeCustomPriceFeed(data: Buffer) {
  if (data.length !== FEED_SIZE || !data.subarray(0, 8).equals(FEED_DISCRIMINATOR)) {
    throw new Error("The custom price feed account discriminator or size is invalid");
  }
  return {
    symbol: data.subarray(9, 25),
    priceScale: data.readBigUInt64LE(25),
    price: data.readBigUInt64LE(33),
    confidence: data.readBigUInt64LE(41),
    observedAt: Number(data.readBigInt64LE(49)),
    publisher: new PublicKey(data.subarray(57, 89)),
  };
}

export function assessCustomPriceFeed(params: {
  symbol: string;
  account: AccountInfo<Buffer> | null;
  oracleAuthority: PublicKey;
  now: number;
}): CustomOracleReadiness {
  const source = params.symbol === "SOL" || params.symbol === "BTC" || params.symbol === "ETH"
    ? "Coinbase Exchange" as const
    : "Hyperliquid xyz mark" as const;
  const fail = (reason: string, observedAt: number | null = null, ageSeconds: number | null = null): CustomOracleReadiness => ({
    symbol: params.symbol, source, ready: false, observedAt, ageSeconds, reason,
  });
  if (!params.account) return fail("Custom oracle feed is not initialized");
  if (!params.account.owner.equals(VSOL_PROGRAM_ID)) return fail("Custom oracle feed has the wrong owner");
  let feed;
  try { feed = decodeCustomPriceFeed(Buffer.from(params.account.data)); } catch { return fail("Custom oracle feed layout is invalid"); }
  if (!feed.symbol.equals(symbolBytes(params.symbol))) return fail("Custom oracle feed symbol does not match");
  if (feed.priceScale !== PRICE_SCALE) return fail("Custom oracle feed price scale does not match");
  if (feed.price <= 0n) return fail("Custom oracle feed has no positive price", feed.observedAt, null);
  if (feed.confidence * 10_000n > feed.price * BigInt(MARKET_MAX_CONFIDENCE_BPS)) {
    return fail("Custom oracle confidence exceeds the market limit", feed.observedAt, null);
  }
  if (!feed.publisher.equals(params.oracleAuthority)) return fail("Custom oracle publisher does not match current authority", feed.observedAt, null);
  if (feed.observedAt > params.now) return fail("Custom oracle timestamp is in the future", feed.observedAt, 0);
  const ageSeconds = params.now - feed.observedAt;
  if (ageSeconds > CUSTOM_ORACLE_READY_MAX_AGE_SECONDS) return fail(`Custom oracle feed is ${ageSeconds}s old`, feed.observedAt, ageSeconds);
  return { symbol: params.symbol, source, ready: true, observedAt: feed.observedAt, ageSeconds };
}

export async function getCustomOracleReadiness(
  symbols: readonly string[] = liveMarkets.map((market) => market.symbol),
  connection: Connection = getVsolConnection(),
): Promise<CustomOracleReadiness[]> {
  const configKey = deriveConfig();
  const feedKeys = symbols.map((symbol) => deriveCustomPriceFeed(symbol));
  const [configAccount, clockAccount, ...feedAccounts] = await connection.getMultipleAccountsInfo(
    [configKey, SYSVAR_CLOCK_PUBKEY, ...feedKeys],
    "confirmed",
  );
  if (!configAccount?.owner.equals(VSOL_PROGRAM_ID)) throw new Error("VSOL config is unavailable or has the wrong owner");
  const config = decodeConfigAccount(Buffer.from(configAccount.data));
  const blockTime = decodeClockUnixTimestamp(clockAccount);
  return symbols.map((symbol, index) => assessCustomPriceFeed({
    symbol,
    account: feedAccounts[index],
    oracleAuthority: config.oracleAuthority,
    now: blockTime,
  }));
}
