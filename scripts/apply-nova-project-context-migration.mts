/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import "./verify-production-db-target.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const migrations = [["20260921180000", "nova_project_context"]] as const;
const connection = new URL((process.env.AGENT_DB_POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL_NON_POOLING)!);
// Match the existing migration clients' scoped TLS configuration. pg URL SSL
// options otherwise replace the explicit ssl object below.
connection.searchParams.delete("sslmode");
const client = new Client({
  connectionString: connection.toString(),
  ssl: { rejectUnauthorized: false },
});
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SELECT pg_advisory_xact_lock(2026092118)");
  for (const [version, name] of migrations) {
    const applied = await client.query("SELECT version FROM supabase_migrations.schema_migrations WHERE version = $1", [version]);
    if (!applied.rowCount) {
      const sql = readFileSync(new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ($1, $2)", [version, name]);
    }
  }
  const secured = await client.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.nova_project_context'::regclass");
  assert.equal(secured.rows[0]?.relrowsecurity, true);
  /* A confirmation has to be recorded as one. Without this the table could
     hold a statement that is treated as the owner's and has no moment at
     which the owner made it theirs. */
  const recorded = await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'nova_project_context_confirmation_is_recorded' AND connamespace = 'public'::regnamespace");
  assert.equal(recorded.rowCount, 1);
  assert.match(recorded.rows[0].definition, /confirmed_at IS NOT NULL/);
  const goals = await client.query("SELECT count(*)::int AS total FROM public.nova_agents WHERE goal IS NOT NULL");
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  console.log(`PASS: nova_project_context created with RLS enabled and confirmation recorded; ${goals.rows[0].total} existing goal(s) untouched.`);
} catch (error) {
  console.error("Migration error code:", (error as { code?: string }).code ?? "unknown");
  console.error("Migration reason:", (error as Error).message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection]").replace(/[a-z0-9]{12,}\.supabase\.co/gi, "[database-host]"));
  await client.query("ROLLBACK").catch(() => {});
  console.error("Nova project-context migration failed; transaction rolled back. Verify database connectivity and schema before retrying.");
  process.exitCode = 1;
} finally {
  await client.end();
}
