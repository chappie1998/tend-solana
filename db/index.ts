import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

function bindings() {
  return env as unknown as { DB?: D1Database };
}

export function getDb() {
  const { DB } = bindings();
  if (!DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(DB, { schema });
}

export async function ensureDb() {
  const { DB } = bindings();
  if (!DB) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS positions (
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
      transaction_signature text,
      simulation_id text,
      simulation_status text,
      simulation_slot integer,
      simulation_units_consumed integer,
      simulation_logs_hash text,
      created_at integer NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS positions_user_created_idx ON positions (user_email, created_at)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS positions_wallet_idx ON positions (wallet_address)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS positions_quote_unique_idx ON positions (quote_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS rfq_quotes (
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
      volatility_source text NOT NULL DEFAULT 'legacy',
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
    DB.prepare("CREATE INDEX IF NOT EXISTS rfq_quotes_expiry_idx ON rfq_quotes (expires_at)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS transaction_simulations (
      id text PRIMARY KEY NOT NULL,
      user_email text NOT NULL,
      wallet_address text NOT NULL,
      quote_id text NOT NULL,
      position_address text NOT NULL,
      transaction_hash text NOT NULL,
      status text NOT NULL,
      slot integer,
      units_consumed integer,
      logs_json text NOT NULL,
      logs_hash text NOT NULL,
      error_json text,
      transaction_signature text,
      submission_status text NOT NULL,
      submission_error text,
      created_at integer NOT NULL,
      confirmed_at integer
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS transaction_simulations_user_created_idx ON transaction_simulations (user_email, created_at)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS transaction_simulations_quote_idx ON transaction_simulations (quote_id)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS transaction_simulations_hash_unique_idx ON transaction_simulations (transaction_hash)"),
  ]);

  const ensureColumn = async (table: "positions" | "rfq_quotes", name: string, definition: string) => {
    const info = await DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!info.results.some((column) => column.name === name)) {
      await DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
    }
  };
  for (const table of ["positions", "rfq_quotes"] as const) {
    await ensureColumn(table, "expiry_code", "text NOT NULL DEFAULT '7D'");
    await ensureColumn(table, "option_expiry_at", "integer NOT NULL DEFAULT 0");
    await ensureColumn(table, "observation_window_seconds", "integer NOT NULL DEFAULT 900");
    await ensureColumn(table, "trade_lock_seconds", "integer NOT NULL DEFAULT 300");
  }
  await ensureColumn("positions", "transaction_signature", "text");
  await ensureColumn("positions", "simulation_id", "text");
  await ensureColumn("positions", "simulation_status", "text");
  await ensureColumn("positions", "simulation_slot", "integer");
  await ensureColumn("positions", "simulation_units_consumed", "integer");
  await ensureColumn("positions", "simulation_logs_hash", "text");
  await ensureColumn("rfq_quotes", "volatility_source", "text NOT NULL DEFAULT 'legacy'");
}
