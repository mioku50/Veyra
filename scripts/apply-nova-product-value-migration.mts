/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import "./verify-production-db-target.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const migrations = [["20260920220000", "nova_product_value"], ["20260921093000", "nova_value_feedback"]] as const;
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
  await client.query("SELECT pg_advisory_xact_lock(2026092022)");
  for (const [version, name] of migrations) {
    const applied = await client.query("SELECT version FROM supabase_migrations.schema_migrations WHERE version = $1", [version]);
    if (!applied.rowCount) {
      const sql = readFileSync(new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ($1, $2)", [version, name]);
    }
  }
  const feedback = await client.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.nova_value_feedback'::regclass");
  assert.equal(feedback.rows[0]?.relrowsecurity, true);
  const column = await client.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='nova_agents' AND column_name='goal'");
  assert.equal(column.rows[0]?.is_nullable, "YES");
  const constraints = await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname IN ('nova_subjects_kind_check','nova_signals_kind_check') AND connamespace = 'public'::regnamespace");
  assert.equal(constraints.rowCount, 2);
  for (const row of constraints.rows) assert.match(row.definition, /official_publication/);
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  console.log("PASS: Nova Product Value schema and feedback RLS verified; existing goals, histories and mandates were not modified.");
} catch (error) {
  console.error("Migration error code:", (error as { code?: string }).code ?? "unknown");
  console.error("Migration reason:", (error as Error).message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection]").replace(/[a-z0-9]{12,}\.supabase\.co/gi, "[database-host]"));
  await client.query("ROLLBACK").catch(() => {});
  console.error("Nova Product Value migration failed; transaction rolled back. Verify database connectivity and schema before retrying.");
  process.exitCode = 1;
} finally {
  await client.end();
}
