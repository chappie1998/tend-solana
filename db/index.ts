import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

export async function ensureDb() {
  if (!env.DB) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS positions (
      id text PRIMARY KEY NOT NULL,
      user_email text NOT NULL,
      wallet_address text NOT NULL,
      quote_id text NOT NULL,
      maker text NOT NULL,
      symbol text NOT NULL,
      direction text NOT NULL,
      amount real NOT NULL,
      premium real NOT NULL,
      strike real NOT NULL,
      cap_price real NOT NULL,
      expiry_days integer NOT NULL,
      status text NOT NULL,
      created_at integer NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS positions_user_created_idx ON positions (user_email, created_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS positions_wallet_idx ON positions (wallet_address)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS positions_quote_unique_idx ON positions (quote_id)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rfq_quotes (
      id text PRIMARY KEY NOT NULL,
      request_id text NOT NULL,
      maker text NOT NULL,
      symbol text NOT NULL,
      direction text NOT NULL,
      amount real NOT NULL,
      premium real NOT NULL,
      max_payout real NOT NULL,
      strike real NOT NULL,
      cap_price real NOT NULL,
      breakeven real NOT NULL,
      implied_volatility real NOT NULL,
      effective_leverage real NOT NULL,
      latency_ms integer NOT NULL,
      badge text NOT NULL,
      expiry_days integer NOT NULL,
      payoff integer NOT NULL,
      expires_at integer NOT NULL,
      consumed_at integer,
      created_at integer NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS rfq_quotes_expiry_idx ON rfq_quotes (expires_at)"),
  ]);
}
