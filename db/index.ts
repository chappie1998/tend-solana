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
      expiry_code text NOT NULL DEFAULT '7D',
      option_expiry_at integer NOT NULL DEFAULT 0,
      observation_window_seconds integer NOT NULL DEFAULT 900,
      trade_lock_seconds integer NOT NULL DEFAULT 300,
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
      expiry_code text NOT NULL DEFAULT '7D',
      option_expiry_at integer NOT NULL DEFAULT 0,
      observation_window_seconds integer NOT NULL DEFAULT 900,
      trade_lock_seconds integer NOT NULL DEFAULT 300,
      payoff integer NOT NULL,
      expires_at integer NOT NULL,
      consumed_at integer,
      created_at integer NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS rfq_quotes_expiry_idx ON rfq_quotes (expires_at)"),
  ]);

  const ensureColumn = async (table: "positions" | "rfq_quotes", name: string, definition: string) => {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!info.results.some((column) => column.name === name)) {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
    }
  };
  for (const table of ["positions", "rfq_quotes"] as const) {
    await ensureColumn(table, "expiry_code", "text NOT NULL DEFAULT '7D'");
    await ensureColumn(table, "option_expiry_at", "integer NOT NULL DEFAULT 0");
    await ensureColumn(table, "observation_window_seconds", "integer NOT NULL DEFAULT 900");
    await ensureColumn(table, "trade_lock_seconds", "integer NOT NULL DEFAULT 300");
  }
}
