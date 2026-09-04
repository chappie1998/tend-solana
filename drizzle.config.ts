import { defineConfig } from "drizzle-kit";

// Postgres migrations live in `drizzle/pg`. The SQLite migrations still in
// `drizzle/*.sql` are the retired Cloudflare D1 history: they are not applied
// to Neon and are kept only because the test suite asserts against them.
//
// `drizzle-kit` does not read `.env.local` (only Next does), so run it through
// `npm run db:generate` / `npm run db:migrate`, which load the file explicitly.
export default defineConfig({
  out: "./drizzle/pg",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    // DDL goes over the direct (unpooled) endpoint. Neon's pooler is meant for
    // short application queries, not schema migrations.
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  },
});
