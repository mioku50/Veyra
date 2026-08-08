/**
 * Applies only the approved P5.4.4 production migration.
 * It intentionally does not walk the migration directory.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const VERSION = "20260808120000";
const NAME = "p544_t5_security_closure";
const FILE = `${VERSION}_${NAME}.sql`;

function projectRef(url: URL) {
  const direct = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
  if (direct) return direct[1];
  const database = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (database) return database[1];
  return decodeURIComponent(url.username).match(/^(?:postgres|service_role|anon)\.([a-z0-9]+)$/i)?.[1] || null;
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/[a-z0-9]{12,}\.supabase\.co/gi, "[redacted-supabase-host]")
    .replace(/(?:eyJ|sk-)[A-Za-z0-9._-]{20,}/g, "[redacted-secret]")
    .slice(0, 800);
}

async function main() {
  const runtime = tryGetServerSupabaseConfig();
  assert.ok(runtime, "Production runtime Supabase configuration is required");
  const connectionString =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL_NON_POOLING;
  assert.ok(connectionString, "Production non-pooling PostgreSQL connection is required");
  const connectionUrl = new URL(connectionString);
  assert.equal(
    projectRef(new URL(runtime.url)),
    projectRef(connectionUrl),
    "Vercel Runtime and migration connection target different Supabase projects",
  );
  connectionUrl.searchParams.delete("sslmode");
  connectionUrl.searchParams.delete("sslrootcert");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sql = readFileSync(path.join(root, "supabase", "migrations", FILE), "utf8");
  const client = new Client({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [54420260808]);
    const ledger = await client.query<{ name: string | null }>(
      "select name from supabase_migrations.schema_migrations where version = $1 for update",
      [VERSION],
    );
    if (ledger.rows.length > 0) {
      assert.equal(ledger.rows.length, 1, "P5.4.4 migration ledger entry is duplicated");
      assert.equal(ledger.rows[0].name, NAME, "P5.4.4 migration ledger name differs");
      await client.query("rollback");
      console.log(`[p544-migrate] ${FILE} is already recorded exactly once; no mutation performed.`);
      return;
    }
    await client.query(sql);
    await client.query(
      "insert into supabase_migrations.schema_migrations(version, name) values ($1, $2)",
      [VERSION, NAME],
    );
    await client.query("commit");
    console.log(`[p544-migrate] Applied ${FILE} atomically to the verified Production target.`);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw new Error(safeError(error));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[p544-migrate] FAILED: ${safeError(error)}`);
  process.exit(1);
});
