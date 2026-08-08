/**
 * Read-only Production verifier for the P5.4.4 durable trust and RLS closure.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const VERSION = "20260808120000";
const NAME = "p544_t5_security_closure";
const TABLES = [
  "payment_events",
  "erc8183_evaluations",
  "erc8004_validation_links",
  "agent_reputation_evidence",
  "agent_reputation_snapshots",
  "trust_decisions",
] as const;

const TRUST_COLUMNS = [
  "decision_id",
  "subject_agent_id",
  "subject_wallet",
  "executor_wallet",
  "counterparty_agent_id",
  "counterparty_wallet",
  "action",
  "service_id",
  "workflow_type",
  "requested_value_usdc",
  "decision",
  "max_value_usdc",
  "snapshot_hash",
  "trust_score",
  "confidence",
  "coverage",
  "snapshot_age_seconds",
  "policy_version",
  "evaluator",
  "evaluator_required",
  "reasons",
  "risk_signals",
  "canonical_hash",
  "issued_at",
  "expires_at",
  "created_at",
] as const;

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

  const postgres = new Client({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await postgres.connect();
  try {
    const ledger = await postgres.query<{ name: string | null }>(
      "select name from supabase_migrations.schema_migrations where version = $1",
      [VERSION],
    );
    assert.equal(ledger.rows.length, 1, "P5.4.4 migration is not recorded exactly once");
    assert.equal(ledger.rows[0].name, NAME, "P5.4.4 migration ledger name differs");

    const columns = await postgres.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'trust_decisions'
    `);
    const columnSet = new Set(columns.rows.map((row) => row.column_name));
    for (const column of TRUST_COLUMNS) {
      assert.ok(columnSet.has(column), `trust_decisions.${column} is missing`);
    }

    const relations = await postgres.query<{ relname: string; relrowsecurity: boolean }>(`
      select relation.relname, relation.relrowsecurity
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relname = any($1::text[])
    `, [TABLES]);
    assert.equal(relations.rows.length, TABLES.length, "A protected T5 table is missing");
    assert.ok(relations.rows.every((row) => row.relrowsecurity), "RLS is not enabled on every protected table");

    const policies = await postgres.query<{ tablename: string; roles_csv: string }>(`
      select tablename, array_to_string(roles, ',') as roles_csv
      from pg_policies
      where schemaname = 'public' and tablename = any($1::text[])
    `, [TABLES]);
    for (const table of TABLES) {
      const tablePolicies = policies.rows.filter((row) => row.tablename === table);
      assert.ok(tablePolicies.length > 0, `${table} has no service-role policy`);
      assert.ok(
        tablePolicies.every((row) => row.roles_csv === "service_role"),
        `${table} exposes a policy to a non-service role`,
      );
    }

    const privileges = await postgres.query<{
      table_name: string;
      anon_select: boolean;
      authenticated_select: boolean;
      service_select: boolean;
    }>(`
      select table_name,
             has_table_privilege('anon', 'public.' || quote_ident(table_name), 'select') as anon_select,
             has_table_privilege('authenticated', 'public.' || quote_ident(table_name), 'select') as authenticated_select,
             has_table_privilege('service_role', 'public.' || quote_ident(table_name), 'select') as service_select
      from unnest($1::text[]) as table_name
    `, [TABLES]);
    for (const row of privileges.rows) {
      assert.equal(row.anon_select, false, `${row.table_name} grants SELECT to anon`);
      assert.equal(row.authenticated_select, false, `${row.table_name} grants SELECT to authenticated`);
      assert.equal(row.service_select, true, `${row.table_name} denies service-role SELECT`);
    }
    const publicGrants = await postgres.query<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name = any($1::text[])
        and grantee = 'PUBLIC'
    `, [TABLES]);
    assert.equal(publicGrants.rows.length, 0, "A protected table grants direct privileges to PUBLIC");

    const constraints = await postgres.query<{ conname: string; definition: string }>(`
      select constraint_row.conname, pg_get_constraintdef(constraint_row.oid) as definition
      from pg_constraint constraint_row
      join pg_class relation on relation.oid = constraint_row.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relname = 'trust_decisions'
    `);
    const definitions = constraints.rows.map((row) => `${row.conname}:${row.definition}`).join("\n");
    for (const token of ["decision_id", "canonical_hash", "ALLOW_WITH_LIMITS", "service_purchase", "expires_at"]) {
      assert.ok(definitions.includes(token), `trust_decisions constraint coverage omits ${token}`);
    }

    const indexes = await postgres.query<{ indexname: string }>(`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'trust_decisions'
    `);
    const indexSet = new Set(indexes.rows.map((row) => row.indexname));
    assert.ok(indexSet.has("idx_trust_decisions_subject_created"));
    assert.ok(indexSet.has("idx_trust_decisions_expires_at"));

    const triggers = await postgres.query<{ tgname: string; tgenabled: string }>(`
      select trigger_row.tgname, trigger_row.tgenabled
      from pg_trigger trigger_row
      join pg_class relation on relation.oid = trigger_row.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and not trigger_row.tgisinternal
        and trigger_row.tgname = any($1::text[])
    `, [[
      "enforce_erc8004_validation_link_immutability",
      "reject_trust_decision_update",
      "reject_trust_decision_delete",
    ]]);
    const triggerMap = new Map(triggers.rows.map((row) => [row.tgname, row.tgenabled]));
    for (const trigger of [
      "enforce_erc8004_validation_link_immutability",
      "reject_trust_decision_update",
      "reject_trust_decision_delete",
    ]) {
      assert.equal(triggerMap.get(trigger), "O", `${trigger} is missing or disabled`);
    }

    const service = createClient(runtime.url, runtime.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const serviceQueries = await Promise.all(
      TABLES.map((table) => service.from(table).select("*", { head: true, count: "exact" }).limit(0)),
    );
    assert.ok(serviceQueries.every((result) => !result.error), "Service-role access failed for a protected table");

    console.log("P544_SCHEMA_VERIFICATION", JSON.stringify({
      migration: `${VERSION}_${NAME}.sql`,
      protectedTables: TABLES,
      rlsEnabled: true,
      directAnonAccess: "denied",
      directAuthenticatedAccess: "denied",
      serviceRoleAccess: "verified",
    }));
  } finally {
    await postgres.end();
  }
}

main().catch((error) => {
  console.error(`P5.4.4 schema verification failed: ${safeError(error)}`);
  process.exit(1);
});
