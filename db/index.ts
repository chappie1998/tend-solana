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
      market_address text NOT NULL DEFAULT '',
      oracle_address text NOT NULL DEFAULT '',
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
      market_address text NOT NULL DEFAULT '',
      oracle_address text NOT NULL DEFAULT '',
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
    DB.prepare(`CREATE TABLE IF NOT EXISTS liquidity_actions (
      id text PRIMARY KEY NOT NULL,
      user_email text NOT NULL,
      wallet_address text NOT NULL,
      pool_address text NOT NULL,
      provider_address text NOT NULL,
      action text NOT NULL,
      amount_atoms text NOT NULL,
      minimum_output_atoms text NOT NULL,
      shares_atoms text,
      deadline integer NOT NULL,
      transaction_message_hash text NOT NULL,
      transaction_hash text,
      simulation_status text,
      simulation_slot integer,
      simulation_units_consumed integer,
      simulation_logs_json text,
      simulation_logs_hash text,
      simulation_error_json text,
      transaction_signature text,
      submission_status text NOT NULL,
      submission_error text,
      pre_wallet_atoms text NOT NULL,
      pre_pool_atoms text NOT NULL,
      pre_shares_atoms text NOT NULL,
      post_wallet_atoms text,
      post_pool_atoms text,
      post_shares_atoms text,
      created_at integer NOT NULL,
      confirmed_at integer
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS close_actions (
      id text PRIMARY KEY NOT NULL,
      wallet_address text NOT NULL,
      position_address text NOT NULL,
      pool_address text NOT NULL,
      market_address text NOT NULL,
      buyer_destination_address text NOT NULL,
      treasury_destination_address text NOT NULL,
      buyback_amount_atoms text NOT NULL,
      min_proceeds_atoms text NOT NULL,
      fair_value_atoms text NOT NULL,
      spread_bps real NOT NULL,
      quote_expiry integer NOT NULL,
      transaction_message_hash text NOT NULL,
      transaction_hash text,
      simulation_status text,
      simulation_slot integer,
      simulation_units_consumed integer,
      simulation_logs_json text,
      simulation_logs_hash text,
      simulation_error_json text,
      transaction_signature text,
      submission_status text NOT NULL,
      submission_error text,
      pre_buyer_atoms text NOT NULL,
      post_buyer_atoms text,
      post_state_verified integer,
      created_at integer NOT NULL,
      confirmed_at integer
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS close_actions_wallet_created_idx ON close_actions (wallet_address, created_at)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS close_actions_position_idx ON close_actions (position_address)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS close_actions_message_unique_idx ON close_actions (transaction_message_hash)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS close_actions_transaction_hash_unique_idx ON close_actions (transaction_hash)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS close_actions_signature_unique_idx ON close_actions (transaction_signature)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS auth_nonces (
      nonce text PRIMARY KEY NOT NULL,
      created_at integer NOT NULL,
      expires_at integer NOT NULL,
      used_at integer
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS auth_nonces_expires_idx ON auth_nonces (expires_at)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS launch_actions (
      id text PRIMARY KEY NOT NULL,
      user_key text NOT NULL,
      wallet_address text NOT NULL,
      kind text NOT NULL,
      params_json text NOT NULL,
      target_address text NOT NULL,
      secondary_address text,
      transaction_message_hash text NOT NULL,
      transaction_hash text,
      simulation_status text,
      simulation_slot integer,
      simulation_units_consumed integer,
      simulation_logs_json text,
      simulation_logs_hash text,
      simulation_error_json text,
      transaction_signature text,
      submission_status text NOT NULL,
      submission_error text,
      post_state_verified integer,
      created_at integer NOT NULL,
      confirmed_at integer
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS launch_actions_user_created_idx ON launch_actions (user_key, created_at)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS launch_actions_wallet_created_idx ON launch_actions (wallet_address, created_at)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS launch_actions_message_unique_idx ON launch_actions (transaction_message_hash)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS launch_actions_transaction_hash_unique_idx ON launch_actions (transaction_hash)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS launch_actions_signature_unique_idx ON launch_actions (transaction_signature)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS liquidity_actions_user_created_idx ON liquidity_actions (user_email, created_at)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS liquidity_actions_wallet_created_idx ON liquidity_actions (wallet_address, created_at)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS liquidity_actions_message_unique_idx ON liquidity_actions (transaction_message_hash)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS liquidity_actions_transaction_hash_unique_idx ON liquidity_actions (transaction_hash)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS liquidity_actions_signature_unique_idx ON liquidity_actions (transaction_signature)"),
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
    await ensureColumn(table, "market_address", "text NOT NULL DEFAULT ''");
    await ensureColumn(table, "oracle_address", "text NOT NULL DEFAULT ''");
  }
  await ensureColumn("positions", "transaction_signature", "text");
  await ensureColumn("positions", "simulation_id", "text");
  await ensureColumn("positions", "simulation_status", "text");
  await ensureColumn("positions", "simulation_slot", "integer");
  await ensureColumn("positions", "simulation_units_consumed", "integer");
  await ensureColumn("positions", "simulation_logs_hash", "text");
  await ensureColumn("rfq_quotes", "volatility_source", "text NOT NULL DEFAULT 'legacy'");
}
