import { createHash } from "node:crypto";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, type Connection } from "@solana/web3.js";
import { liveMarkets } from "./markets.ts";
import {
  deriveConfig,
  deriveCustomPriceFeed,
  HEARTBEAT_MAX_AGE_SECONDS,
  HEARTBEAT_SYMBOL,
  PRICE_SCALE,
} from "../../vsol/sdk/index.ts";
import { decodeConfigAccount, getVsolConnection } from "./vsol-server.ts";
import { VSOL_PROGRAM_ID } from "./vsol.ts";
import { decodeClockUnixTimestamp } from "./solana-clock.ts";

const FEED_DISCRIMINATOR = createHash("sha256").update("account:CustomPriceFeed").digest().subarray(0, 8);
const FEED_SIZE = 89;
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

// --- Runner-liveness readiness ---------------------------------------------
//
// There is deliberately no per-symbol "price is fresh" check any more. The
// continuous pusher that could keep every feed fresh is retired, and fills
// never read the feed (CUSTOM_ORACLE_MAX_STALENESS_SECONDS is enforced only
// by update_custom_price_feed), so freshness was never what a sale depended
// on. Both the quote route's pre-quote gate and the status badge use
// getVsolExecutionReadiness below.
//
// The functions below answer a DIFFERENT question for
// app/api/vsol/status/route.ts's UI badge: not "is every symbol's price
// fresh right now" (only a continuously-running pusher could ever satisfy
// that, which is exactly the process oracle-runner.ts retired), but "is the
// settlement runner that WOULD publish a price alive, and is the plumbing
// each live market needs for a capture to succeed actually wired up". A
// market's own feed can go many minutes without a fresh price under the new
// architecture -- oracle-runner.ts only writes to it right when that market
// is about to expire -- and that is by design, not a degradation.

export type HeartbeatReadiness = {
  ready: boolean;
  observedAt: number | null;
  ageSeconds: number | null;
  reason?: string;
};

/**
 * Readiness of the dedicated HEARTBEAT feed alone: exists, owned by the VSOL
 * program, published by the current `config.oracle_authority`, and no older
 * than `HEARTBEAT_MAX_AGE_SECONDS` (see that constant's doc comment in
 * vsol/sdk/index.ts for why 900s is the right ceiling for a 5-minute publish
 * cadence). This is the runner-liveness half of execution readiness.
 */
export function assessHeartbeatFeed(params: {
  account: AccountInfo<Buffer> | null;
  oracleAuthority: PublicKey;
  now: number;
}): HeartbeatReadiness {
  const fail = (reason: string, observedAt: number | null = null, ageSeconds: number | null = null): HeartbeatReadiness => ({
    ready: false, observedAt, ageSeconds, reason,
  });
  if (!params.account) return fail("Heartbeat feed is not initialized (run init-heartbeat-feed.ts once)");
  if (!params.account.owner.equals(VSOL_PROGRAM_ID)) return fail("Heartbeat feed has the wrong owner");
  let feed;
  try { feed = decodeCustomPriceFeed(Buffer.from(params.account.data)); } catch { return fail("Heartbeat feed layout is invalid"); }
  if (!feed.symbol.equals(symbolBytes(HEARTBEAT_SYMBOL))) return fail("Heartbeat feed symbol does not match");
  if (feed.price <= 0n) return fail("Heartbeat feed has no positive price", feed.observedAt, null);
  if (!feed.publisher.equals(params.oracleAuthority)) return fail("Heartbeat feed publisher does not match current authority", feed.observedAt, null);
  if (feed.observedAt > params.now) return fail("Heartbeat feed timestamp is in the future", feed.observedAt, 0);
  const ageSeconds = params.now - feed.observedAt;
  if (ageSeconds > HEARTBEAT_MAX_AGE_SECONDS) return fail(`Settlement runner heartbeat is ${ageSeconds}s old -- the runner may be down`, feed.observedAt, ageSeconds);
  return { ready: true, observedAt: feed.observedAt, ageSeconds };
}

export type CustomFeedStructuralReadiness = {
  symbol: string;
  ready: boolean;
  reason?: string;
};

/**
 * STRUCTURAL readiness of one live market's OWN feed account: it exists, is
 * owned by the VSOL program, decodes, carries the right symbol and price
 * scale, and is published by the current `config.oracle_authority` -- i.e.
 * everything `capture_custom_settlement_observation` checks about the feed
 * account ITSELF (`feed.publisher == config.oracle_authority`,
 * `feed.symbol == market.symbol`, `feed.price_scale == market.price_scale`;
 * see vsol/programs/vsol/src/lib.rs) other than the price/timestamp fields a
 * capture actually WRITES fresh at settlement time. Deliberately does NOT
 * check `feed.price > 0`, confidence, or `feed.published_at`'s age -- a
 * feed that has gone untouched for hours because nothing has expired for
 * that symbol yet is completely healthy under this runner's design, not a
 * degradation to report.
 */
export function assessCustomFeedStructure(params: {
  symbol: string;
  account: AccountInfo<Buffer> | null;
  oracleAuthority: PublicKey;
}): CustomFeedStructuralReadiness {
  const fail = (reason: string): CustomFeedStructuralReadiness => ({ symbol: params.symbol, ready: false, reason });
  if (!params.account) return fail("Custom oracle feed is not initialized");
  if (!params.account.owner.equals(VSOL_PROGRAM_ID)) return fail("Custom oracle feed has the wrong owner");
  let feed;
  try { feed = decodeCustomPriceFeed(Buffer.from(params.account.data)); } catch { return fail("Custom oracle feed layout is invalid"); }
  if (!feed.symbol.equals(symbolBytes(params.symbol))) return fail("Custom oracle feed symbol does not match");
  if (feed.priceScale !== PRICE_SCALE) return fail("Custom oracle feed price scale does not match");
  if (!feed.publisher.equals(params.oracleAuthority) && !feed.publisher.equals(PublicKey.default)) {
    // A feed that has never been published to yet (publisher still the
    // all-zero default from init_custom_price_feed) is structurally fine --
    // it simply has not been written to. Only a MISMATCHED real publisher
    // (a stale authority from before a rotation) is unready.
    return fail("Custom oracle feed publisher does not match current authority");
  }
  return { symbol: params.symbol, ready: true };
}

export type VsolExecutionReadiness = {
  ok: boolean;
  heartbeat: HeartbeatReadiness;
  feeds: CustomFeedStructuralReadiness[];
  reason?: string;
};

/**
 * The combined readiness app/api/vsol/status/route.ts's "Execution
 * unavailable" badge is judged on: the settlement runner's own heartbeat,
 * AND every live market's feed plumbing being structurally correct (so a
 * capture CAN succeed the next time that market expires) -- never each
 * symbol's price freshness, which the new architecture no longer maintains
 * continuously by design. Reasons stay human-readable, matching the
 * per-symbol readiness this replaces.
 */
export async function getVsolExecutionReadiness(
  symbols: readonly string[] = liveMarkets.map((market) => market.symbol),
  connection: Connection = getVsolConnection(),
): Promise<VsolExecutionReadiness> {
  const configKey = deriveConfig();
  const heartbeatFeedKey = deriveCustomPriceFeed(HEARTBEAT_SYMBOL);
  const feedKeys = symbols.map((symbol) => deriveCustomPriceFeed(symbol));
  const [configAccount, clockAccount, heartbeatAccount, ...feedAccounts] = await connection.getMultipleAccountsInfo(
    [configKey, SYSVAR_CLOCK_PUBKEY, heartbeatFeedKey, ...feedKeys],
    "confirmed",
  );
  if (!configAccount?.owner.equals(VSOL_PROGRAM_ID)) throw new Error("VSOL config is unavailable or has the wrong owner");
  const config = decodeConfigAccount(Buffer.from(configAccount.data));
  const blockTime = decodeClockUnixTimestamp(clockAccount);

  const heartbeat = assessHeartbeatFeed({ account: heartbeatAccount, oracleAuthority: config.oracleAuthority, now: blockTime });
  const feeds = symbols.map((symbol, index) => assessCustomFeedStructure({
    symbol,
    account: feedAccounts[index],
    oracleAuthority: config.oracleAuthority,
  }));

  const firstFeedFailure = feeds.find((feed) => !feed.ready);
  const ok = heartbeat.ready && feeds.every((feed) => feed.ready);
  const reason = ok ? undefined : !heartbeat.ready ? heartbeat.reason : `${firstFeedFailure?.symbol}: ${firstFeedFailure?.reason}`;

  return { ok, heartbeat, feeds, reason };
}
