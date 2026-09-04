import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

/**
 * Neon Postgres client for the Vercel deployment.
 *
 * Initialization is deliberately lazy. Next evaluates top-level module code
 * during `next build`, so calling `neon(process.env.DATABASE_URL!)` at module
 * scope would crash the build on any machine or CI runner without the
 * variable set. Nothing here touches `process.env` until a request actually
 * asks for the database.
 *
 * The client is a plain cached value, not a `Proxy`. Proxy-wrapped lazy
 * clients are a common shortcut and they break libraries that introspect the
 * object they are handed.
 */

/** Connection variables we accept, in priority order. */
const CONNECTION_VARS = ["DATABASE_URL", "POSTGRES_URL"] as const;

const MISSING_URL_MESSAGE =
  `No Postgres connection string is configured. Set ${CONNECTION_VARS[0]} ` +
  `(or ${CONNECTION_VARS[1]}) to the Neon pooled connection string. ` +
  "Locally it belongs in .env.local; on Vercel add it to the project's " +
  "Environment Variables for every environment you deploy to. The Neon " +
  "integration provisions both names automatically.";

const MIGRATIONS_MISSING_MESSAGE =
  "The Neon database is reachable but the application tables are missing. " +
  "Apply the Postgres migrations with `npm run db:migrate` (drizzle-kit " +
  "reads .env.local, which Next loads but drizzle-kit does not) before " +
  "serving traffic.";

let cachedDb: NeonHttpDatabase<typeof schema> | undefined;
let cachedUrl: string | undefined;
let schemaChecked: Promise<void> | undefined;

function connectionString(): string {
  for (const name of CONNECTION_VARS) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new Error(MISSING_URL_MESSAGE);
}

export function getDb(): NeonHttpDatabase<typeof schema> {
  const url = connectionString();
  // A changed connection string (branch switch, rotated credentials) must not
  // keep serving the old client.
  if (cachedDb && cachedUrl === url) return cachedDb;

  let client: ReturnType<typeof neon>;
  try {
    client = neon(url);
  } catch (error) {
    throw new Error(
      `${CONNECTION_VARS[0]} is not a usable Neon connection string. Expected ` +
        "a postgresql:// URL from the Neon dashboard.",
      { cause: error },
    );
  }

  cachedDb = drizzle(client, { schema });
  cachedUrl = url;
  return cachedDb;
}

/**
 * Verifies once per process that the database is reachable and migrated.
 *
 * The Cloudflare version of this function issued the full `CREATE TABLE IF NOT
 * EXISTS` batch on every request, because D1 had no migration step in the
 * request path. Postgres schema now comes from `drizzle/pg`, applied
 * out-of-band by `npm run db:migrate`, so this is a single cached probe rather
 * than per-request DDL. It keeps the call-site contract: a misconfigured or
 * unmigrated deployment fails with an actionable message before any query
 * runs, not with a raw driver stack trace.
 */
export async function ensureDb(): Promise<void> {
  if (schemaChecked) return schemaChecked;

  const check = (async () => {
    const db = getDb();
    let present: string | null = null;
    try {
      const result = await db.execute<{ table: string | null }>(
        sql`select to_regclass('public.positions')::text as "table"`,
      );
      present = result.rows[0]?.table ?? null;
    } catch (error) {
      throw new Error(
        "The Neon database is unreachable. Check that " +
          `${CONNECTION_VARS[0]} points at a running Neon branch and that the ` +
          "branch has not been deleted or suspended past its TTL.",
        { cause: error },
      );
    }
    if (!present) throw new Error(MIGRATIONS_MISSING_MESSAGE);
  })();

  // Only a successful probe is memoized; a misconfigured deployment that is
  // later fixed must not stay broken for the life of the process.
  schemaChecked = check.catch((error) => {
    schemaChecked = undefined;
    throw error;
  });
  return schemaChecked;
}
