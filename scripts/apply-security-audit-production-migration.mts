/** Applies only the approved AI-audit security hardening migration. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const MIGRATION = {
  version: "20260809120000",
  name: "machine_api_distributed_read_rate_limits",
} as const;

function projectRef(url: URL) {
  return url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i)?.[1]
    || url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1]
    || decodeURIComponent(url.username).match(/^(?:postgres|service_role|anon)\.([a-z0-9]+)$/i)?.[1]
    || null;
}

function safe(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/[a-z0-9]{12,}\.supabase\.co/gi, "[redacted-supabase-host]")
    .replace(/(?:eyJ|sk-)[A-Za-z0-9._-]{20,}/g, "[redacted-secret]")
    .slice(0, 800);
}

async function main() {
  const runtime = tryGetServerSupabaseConfig();
  const connection = process.env.AGENT_DB_POSTGRES_URL_NON_POOLING
    || process.env.POSTGRES_URL_NON_POOLING;
  assert.ok(runtime, "Production runtime Supabase configuration is required");
  assert.ok(connection, "Production non-pooling PostgreSQL connection is required");

  const connectionUrl = new URL(connection);
  assert.equal(
    projectRef(new URL(runtime.url)),
    projectRef(connectionUrl),
    "Runtime and migration target different Supabase projects",
  );
  connectionUrl.searchParams.delete("sslmode");
  connectionUrl.searchParams.delete("sslrootcert");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = `${MIGRATION.version}_${MIGRATION.name}.sql`;
  const client = new Client({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 45_000,
  });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [5520260809]);
    const ledger = await client.query<{ name: string | null }>(
      "select name from supabase_migrations.schema_migrations where version = $1 for update",
      [MIGRATION.version],
    );
    let applied = false;
    if (ledger.rows.length > 0) {
      assert.equal(ledger.rows.length, 1, `${file} ledger entry is duplicated`);
      assert.equal(ledger.rows[0].name, MIGRATION.name, `${file} ledger name differs`);
    } else {
      const sql = readFileSync(path.join(root, "supabase", "migrations", file), "utf8");
      await client.query(sql);
      await client.query(
        "insert into supabase_migrations.schema_migrations(version, name) values ($1, $2)",
        [MIGRATION.version, MIGRATION.name],
      );
      applied = true;
    }
    await client.query("commit");
    console.log("SECURITY_AUDIT_MIGRATION", JSON.stringify({
      migration: file,
      result: applied ? "applied" : "already_recorded",
      target: "verified_production",
    }));
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw new Error(safe(error));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[security-audit-migrate] FAILED: ${safe(error)}`);
  process.exit(1);
});
