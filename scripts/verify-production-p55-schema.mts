/** Read-only/transaction-rollback Production verifier for P5.5. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const MIGRATIONS = [
  { version: "20260808210000", name: "p55_counterparty_selection" },
  { version: "20260808220000", name: "p55_selection_proof_economic_provenance" },
] as const;
const TABLES = ["counterparty_selections", "counterparty_selection_candidates", "counterparty_selection_proofs", "counterparty_selection_clearances"] as const;
const COLUMNS: Record<(typeof TABLES)[number], string[]> = {
  counterparty_selections: ["selection_id", "public_id", "tenant_key", "requester_agent_id", "requester_wallet", "machine_credential_id", "capability", "task_hash", "requested_budget_usdc", "network", "policy_version", "ranking_version", "recommended_agent_id", "recommended_wallet", "decision", "canonical_hash", "request_hash", "idempotency_key_hash", "selection_payload", "is_public", "created_at", "expires_at"],
  counterparty_selection_candidates: ["selection_id", "candidate_agent_id", "candidate_wallet", "candidate_service_id", "eligibility_status", "trust_decision", "trust_decision_id", "trust_score", "ranking_score", "confidence", "rank", "evidence_hash", "candidate_payload"],
  counterparty_selection_proofs: ["selection_id", "canonical_hash", "proof_tx", "block_number", "proof_status", "evidence_source", "evidence_source_id", "evidence_amount_usdc", "evidence_tx"],
  counterparty_selection_clearances: ["clearance_id", "selection_id", "decision_id", "clearance_digest", "selection_hash", "subject_wallet", "executor_wallet", "counterparty_wallet", "max_amount_usdc", "clearance_message", "signature", "issued_at", "expires_at"],
};

function projectRef(url: URL) {
  return url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i)?.[1]
    || url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1]
    || decodeURIComponent(url.username).match(/^(?:postgres|service_role|anon)\.([a-z0-9]+)$/i)?.[1]
    || null;
}
function safe(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]").replace(/[a-z0-9]{12,}\.supabase\.co/gi, "[redacted-supabase-host]").replace(/(?:eyJ|sk-)[A-Za-z0-9._-]{20,}/g, "[redacted-secret]").slice(0, 800);
}

async function main() {
  const runtime = tryGetServerSupabaseConfig();
  const connection = process.env.AGENT_DB_POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL_NON_POOLING;
  assert.ok(runtime, "Production runtime Supabase configuration is required");
  assert.ok(connection, "Production non-pooling PostgreSQL connection is required");
  const url = new URL(connection);
  assert.equal(projectRef(new URL(runtime.url)), projectRef(url), "Runtime and migration target different Supabase projects");
  url.searchParams.delete("sslmode"); url.searchParams.delete("sslrootcert");
  const postgres = new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
  await postgres.connect();
  try {
    for (const migration of MIGRATIONS) {
      const ledger = await postgres.query<{ name: string }>("select name from supabase_migrations.schema_migrations where version = $1", [migration.version]);
      assert.equal(ledger.rows.length, 1, `${migration.version} is not recorded exactly once`);
      assert.equal(ledger.rows[0].name, migration.name);
    }

    const columns = await postgres.query<{ table_name: string; column_name: string }>("select table_name,column_name from information_schema.columns where table_schema='public' and table_name=any($1::text[])", [TABLES]);
    for (const [table, expected] of Object.entries(COLUMNS)) {
      const actual = new Set(columns.rows.filter((row) => row.table_name === table).map((row) => row.column_name));
      for (const column of expected) assert.ok(actual.has(column), `${table}.${column} is missing`);
    }

    const relations = await postgres.query<{ relname: string; relrowsecurity: boolean }>("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[])", [TABLES]);
    assert.equal(relations.rows.length, TABLES.length);
    assert.ok(relations.rows.every((row) => row.relrowsecurity), "RLS is not enabled on every P5.5 table");
    const policies = await postgres.query<{ tablename: string; roles: string }>("select tablename,array_to_string(roles,',') roles from pg_policies where schemaname='public' and tablename=any($1::text[])", [TABLES]);
    for (const table of TABLES) {
      const rows = policies.rows.filter((row) => row.tablename === table);
      assert.ok(rows.length > 0 && rows.every((row) => row.roles === "service_role"), `${table} has a non-service policy`);
    }
    const privileges = await postgres.query<{ table_name: string; anon: boolean; authenticated: boolean; service: boolean }>("select table_name,has_table_privilege('anon','public.'||quote_ident(table_name),'select') anon,has_table_privilege('authenticated','public.'||quote_ident(table_name),'select') authenticated,has_table_privilege('service_role','public.'||quote_ident(table_name),'select') service from unnest($1::text[]) table_name", [TABLES]);
    assert.ok(privileges.rows.every((row) => !row.anon && !row.authenticated && row.service), "Direct table privilege boundary failed");

    const constraints = await postgres.query<{ table_name: string; definition: string }>("select c.relname table_name,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[])", [TABLES]);
    const text = constraints.rows.map((row) => `${row.table_name}:${row.definition}`).join("\n");
    for (const token of ["tenant_key, idempotency_key_hash", "veyra-counterparty-selection-v1", "eip155:5042002", "trust_decisions", "counterparty_selections", "verified", "expires_at"]) assert.ok(text.includes(token), `Constraint/FK coverage omits ${token}`);

    const indexes = await postgres.query<{ indexname: string }>("select indexname from pg_indexes where schemaname='public' and tablename=any($1::text[])", [TABLES]);
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const name of ["idx_counterparty_selections_tenant_created", "idx_counterparty_selections_public", "idx_counterparty_selection_candidates_selection_rank", "idx_counterparty_selection_candidates_agent"]) assert.ok(indexNames.has(name), `${name} is missing`);

    const triggers = await postgres.query<{ table_name: string; tgname: string; tgenabled: string }>("select c.relname table_name,t.tgname,t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal and c.relname=any($1::text[])", [TABLES]);
    for (const table of TABLES) assert.ok(triggers.rows.some((row) => row.table_name === table && row.tgenabled === "O" && row.tgname.includes("reject_")), `${table} immutable trigger missing`);

    const routines = await postgres.query<{ proname: string; prosecdef: boolean; acl: string }>("select p.proname,p.prosecdef,coalesce(array_to_string(p.proacl,','),'') acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])", [["create_counterparty_selection", "create_counterparty_selection_clearance"]]);
    assert.equal(routines.rows.length, 2);
    assert.ok(routines.rows.every((row) => row.prosecdef && row.acl.includes("service_role") && !row.acl.includes("anon") && !row.acl.includes("authenticated")), "RPC privilege boundary failed");

    const service = createClient(runtime.url, runtime.key, { auth: { persistSession: false, autoRefreshToken: false } });
    const serviceReads = await Promise.all(TABLES.map((table) => service.from(table).select("*", { head: true, count: "exact" }).limit(0)));
    assert.ok(serviceReads.every((result) => !result.error), "Service-role access failed");
    const anonKey = process.env.AGENT_DB_SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_AGENT_DB_SUPABASE_ANON_KEY
      || process.env.AGENT_DB_SUPABASE_PUBLISHABLE_KEY
      || process.env.NEXT_PUBLIC_AGENT_DB_SUPABASE_PUBLISHABLE_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
      || process.env.SUPABASE_ANON_KEY;
    assert.ok(anonKey, "Production anon key is required for anonymous denial verification");
    const anonymous = createClient(runtime.url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const anonReads = await Promise.all(TABLES.map((table) => anonymous.from(table).select("*", { head: true, count: "exact" }).limit(0)));
    assert.ok(anonReads.every((result) => Boolean(result.error)), "Anonymous access unexpectedly reached a P5.5 table");

    console.log("P55_SCHEMA_VERIFICATION", JSON.stringify({ migrations: MIGRATIONS.map((item) => `${item.version}_${item.name}.sql`), tables: TABLES, rlsEnabled: true, serviceRoleAccess: "verified", anonymousAccess: "denied", authenticatedDirectPrivileges: "denied", immutableRecords: true, tenantBinding: "selection FK + tenant-scoped API", rpcAccess: "service_role_only", proofEconomicProvenance: "required" }));
  } finally { await postgres.end(); }
}

main().catch((error) => { console.error(`P5.5 schema verification failed: ${safe(error)}`); process.exit(1); });
