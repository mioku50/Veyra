/** Read-only Production verifier for the AI-audit security hardening schema. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const MIGRATION = {
  version: "20260809120000",
  name: "machine_api_distributed_read_rate_limits",
} as const;
const TABLE = "machine_api_read_rate_limits";
const ROUTINES = [
  "reserve_machine_api_idempotency_v1",
  "complete_machine_api_idempotency_v1",
  "release_machine_api_idempotency_v1",
  "consume_machine_api_read_limit_v1",
  "enforce_machine_quote_spending_policy_v1",
] as const;

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

  const postgres = new Client({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  await postgres.connect();
  try {
    const ledger = await postgres.query<{ name: string }>(
      "select name from supabase_migrations.schema_migrations where version = $1",
      [MIGRATION.version],
    );
    assert.equal(ledger.rows.length, 1, "Security migration is not recorded exactly once");
    assert.equal(ledger.rows[0].name, MIGRATION.name);

    const columns = await postgres.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name,column_name,data_type
         from information_schema.columns
        where table_schema='public'
          and ((table_name=$1 and column_name=any($2::text[]))
            or (table_name='machine_api_idempotency' and column_name='reservation_token'))`,
      [TABLE, ["credential_id", "route", "window_started_at", "request_count"]],
    );
    const columnMap = new Map(
      columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
    );
    assert.equal(columnMap.get(`${TABLE}.credential_id`), "uuid");
    assert.equal(columnMap.get(`${TABLE}.route`), "text");
    assert.equal(columnMap.get(`${TABLE}.window_started_at`), "timestamp with time zone");
    assert.equal(columnMap.get(`${TABLE}.request_count`), "integer");
    assert.equal(columnMap.get("machine_api_idempotency.reservation_token"), "uuid");

    const relation = await postgres.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid=$1::regclass",
      [`public.${TABLE}`],
    );
    assert.equal(relation.rows.length, 1);
    assert.equal(relation.rows[0].relrowsecurity, true, `${TABLE} RLS is disabled`);

    const policies = await postgres.query<{ roles: string }>(
      "select array_to_string(roles,',') roles from pg_policies where schemaname='public' and tablename=$1",
      [TABLE],
    );
    assert.ok(
      policies.rows.length > 0 && policies.rows.every((row) => row.roles === "service_role"),
      `${TABLE} has a non-service policy`,
    );

    const privileges = await postgres.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `select
         has_table_privilege('anon',$1,'select') anon,
         has_table_privilege('authenticated',$1,'select') authenticated,
         has_table_privilege('service_role',$1,'select,insert,update,delete') service`,
      [`public.${TABLE}`],
    );
    assert.ok(!privileges.rows[0].anon && !privileges.rows[0].authenticated && privileges.rows[0].service);

    const constraints = await postgres.query<{ contype: string; definition: string }>(
      `select c.contype,pg_get_constraintdef(c.oid) definition
         from pg_constraint c
        where c.conrelid=$1::regclass`,
      [`public.${TABLE}`],
    );
    assert.ok(constraints.rows.some((row) => row.contype === "p" && row.definition.includes("credential_id, route, window_started_at")));
    assert.ok(constraints.rows.some((row) => row.contype === "f" && row.definition.includes("byoa_agent_credentials")));
    assert.ok(constraints.rows.some((row) => row.contype === "c" && row.definition.includes("request_count")));

    const index = await postgres.query<{ exists: boolean }>(
      "select to_regclass('public.machine_api_read_rate_limits_window_idx') is not null exists",
    );
    assert.equal(index.rows[0].exists, true);

    const routines = await postgres.query<{ proname: string; prosecdef: boolean; acl: string; definition: string }>(
      `select p.proname,p.prosecdef,coalesce(array_to_string(p.proacl,','),'') acl,
              pg_get_functiondef(p.oid) definition
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=any($1::text[])`,
      [ROUTINES],
    );
    assert.equal(routines.rows.length, ROUTINES.length);
    assert.ok(
      routines.rows.every((row) => !row.prosecdef && row.acl.includes("service_role") && !row.acl.includes("anon") && !row.acl.includes("authenticated")),
      "Security hardening RPC privilege boundary failed",
    );
    const reserveDefinition = routines.rows.find((row) => row.proname === "reserve_machine_api_idempotency_v1")!.definition;
    assert.ok(reserveDefinition.includes("reservation_token") && reserveDefinition.includes("5 minutes"));
    const quoteDefinition = routines.rows.find((row) => row.proname === "enforce_machine_quote_spending_policy_v1")!.definition;
    assert.ok(quoteDefinition.includes("pg_advisory_xact_lock") && quoteDefinition.includes("daily_spend_limit_usdc"));

    const trigger = await postgres.query<{ tgenabled: string }>(
      `select t.tgenabled
         from pg_trigger t
        where t.tgrelid='public.hosted_workflow_quotes'::regclass
          and t.tgname='enforce_machine_quote_spending_policy'
          and not t.tgisinternal`,
    );
    assert.equal(trigger.rows.length, 1);
    assert.equal(trigger.rows[0].tgenabled, "O");

    const service = createClient(runtime.url, runtime.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const serviceRead = await service.from(TABLE).select("*", { head: true, count: "exact" }).limit(0);
    assert.equal(serviceRead.error, null, "Service-role access failed");

    const anonKey = process.env.AGENT_DB_SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_AGENT_DB_SUPABASE_ANON_KEY
      || process.env.AGENT_DB_SUPABASE_PUBLISHABLE_KEY
      || process.env.NEXT_PUBLIC_AGENT_DB_SUPABASE_PUBLISHABLE_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
      || process.env.SUPABASE_ANON_KEY;
    assert.ok(anonKey, "Production anon key is required for anonymous denial verification");
    const anonymous = createClient(runtime.url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anonRead = await anonymous.from(TABLE).select("*", { head: true, count: "exact" }).limit(0);
    assert.ok(anonRead.error, "Anonymous access unexpectedly reached the rate-limit table");

    console.log("SECURITY_AUDIT_SCHEMA_VERIFICATION", JSON.stringify({
      migration: `${MIGRATION.version}_${MIGRATION.name}.sql`,
      runtimeAndMigratorTarget: "same_verified_production_project",
      idempotencyLeaseOwnership: "reservation_token_verified",
      distributedReadLimit: "verified",
      quoteSpendingLock: "verified",
      rlsEnabled: true,
      serviceRoleAccess: "verified",
      anonymousAccess: "denied",
      authenticatedDirectPrivileges: "denied",
      rpcAccess: "service_role_only",
    }));
  } finally {
    await postgres.end();
  }
}

main().catch((error) => {
  console.error(`[security-audit-verify] FAILED: ${safe(error)}`);
  process.exit(1);
});
