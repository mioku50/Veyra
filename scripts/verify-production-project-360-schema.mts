/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient } from "@supabase/supabase-js";
import { Client as PostgresClient } from "pg";
import { getPublicSupabaseConfig } from "../lib/supabase/env.ts";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const TABLES = [
  "project_360_discoveries",
  "project_360_candidates",
  "project_360_quotes",
  "project_360_module_runs",
] as const;

const requireFixture = process.argv.includes("--require-fixture");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function projectRef(url: URL) {
  const direct = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
  if (direct) return direct[1];
  const database = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (database) return database[1];
  const user = decodeURIComponent(url.username).match(
    /^(?:postgres|service_role|anon)\.([a-z0-9]+)$/i,
  );
  return user?.[1] ?? null;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/[a-z0-9]{12,}\.supabase\.co/gi, "[redacted-supabase-host]")
    .replace(/(?:eyJ|sk-)[A-Za-z0-9._-]{20,}/g, "[redacted-secret]")
    .slice(0, 600);
}

async function expectMutationRejected(
  postgres: PostgresClient,
  sql: string,
  values: unknown[],
) {
  await postgres.query("begin");
  try {
    await postgres.query(sql, values);
    await postgres.query("rollback");
    return false;
  } catch {
    await postgres.query("rollback");
    return true;
  }
}

async function verifyProductionProject360Schema() {
  console.log("[verify-project-360-schema] Starting read-only production verification...");
  const serverConfig = tryGetServerSupabaseConfig();
  assert(serverConfig, "Server Supabase configuration is required.");
  const postgresUrl =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL_NON_POOLING;
  assert(postgresUrl, "A non-pooling PostgreSQL connection is required.");

  const runtimeRef = projectRef(new URL(serverConfig.url));
  const connectionUrl = new URL(postgresUrl);
  const migrationRef = projectRef(connectionUrl);
  assert(
    runtimeRef && migrationRef && runtimeRef === migrationRef,
    "Vercel Runtime and the migration connection do not target the same Supabase project.",
  );
  console.log("  ✓ Runtime and migration connection target the same Production Supabase project.");

  const server = createClient(serverConfig.url, serverConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  connectionUrl.searchParams.delete("sslmode");
  connectionUrl.searchParams.delete("sslrootcert");
  const postgres = new PostgresClient({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await postgres.connect();

  try {
    const ledger = await postgres.query<{ version: string; name: string | null }>(`
      select version, name
      from supabase_migrations.schema_migrations
      where version = '20260801120000'
    `);
    assert(
      ledger.rows.length === 1 && ledger.rows[0].name === "p42_project_360",
      "The P4.2 Project 360 migration is not recorded exactly once in the Production ledger.",
    );
    const hardeningLedger = await postgres.query<{ version: string; name: string | null }>(`
      select version, name
      from supabase_migrations.schema_migrations
      where version = '20260801190000'
    `);
    assert(
      hardeningLedger.rows.length === 1 &&
        hardeningLedger.rows[0].name === "p421_project_360_budget_constraints",
      "The P4.2.1 Project 360 budget migration is not recorded exactly once in the Production ledger.",
    );
    const executionLedger = await postgres.query<{ version: string; name: string | null }>(`
      select version, name
      from supabase_migrations.schema_migrations
      where version = '20260801193000'
    `);
    assert(
      executionLedger.rows.length === 1 &&
        executionLedger.rows[0].name === "p421_project_360_execution_constraints",
      "The P4.2.1 Project 360 execution migration is not recorded exactly once in the Production ledger.",
    );
    const reliabilityLedger = await postgres.query<{ version: string; name: string | null }>(`
      select version, name
      from supabase_migrations.schema_migrations
      where version = '20260802120000'
    `);
    assert(
      reliabilityLedger.rows.length === 1 &&
        reliabilityLedger.rows[0].name === "p422_project_360_module_reliability",
      "The P4.2.2 module reliability migration is not recorded exactly once in the Production ledger.",
    );

    const tableChecks = await Promise.all([
      server
        .from("project_360_discoveries")
        .select("id,public_id,owner_wallet,machine_credential_id,status,revision,primary_type,primary_value,primary_value_hash,idempotency_hash,request_hash,candidates_hash,warnings,error_code,expires_at,created_at,started_at,completed_at,updated_at")
        .limit(0),
      server
        .from("project_360_candidates")
        .select("id,public_id,discovery_id,source_type,module,canonical_value,value_hash,origin_kind,origin_repository,file_path,line_start,line_end,safe_excerpt,confidence,confidence_score,reason_code,validation_status,origin_fingerprint,created_at,validated_at")
        .limit(0),
      server
        .from("project_360_quotes")
        .select("quote_id,discovery_id,discovery_revision,candidates_hash,selection_hash,selected_candidate_ids,confirmed_sources,module_price_snapshot,expected_coverage_count,warnings,created_at")
        .limit(0),
      server
        .from("project_360_module_runs")
        .select("id,job_id,module,status,input_hash,attempt_count,child_report_hash,score,confidence,result_snapshot,error_code,provider,retryable,public_reason,duration_ms,execution_telemetry,started_at,completed_at,updated_at")
        .limit(0),
    ]);
    const tableError = tableChecks.find((result) => result.error)?.error;
    assert(!tableError, "A Project 360 table or required column is missing.");
    console.log("  ✓ All Project 360 tables and required columns exist; service-role access works.");

    const relations = await postgres.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(`
      select relation.relname, relation.relrowsecurity
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = any($1::text[])
      order by relation.relname
    `, [TABLES]);
    assert(
      relations.rows.length === TABLES.length &&
        relations.rows.every((row) => row.relrowsecurity),
      "RLS is not enabled on every Project 360 table.",
    );

    const indexes = await postgres.query<{ indexname: string }>(`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname = any($1::text[])
    `, [[
      "project_360_discoveries_browser_idem_idx",
      "project_360_discoveries_machine_idem_idx",
      "project_360_discoveries_owner_created_idx",
      "project_360_discoveries_machine_created_idx",
      "project_360_candidates_discovery_idx",
      "project_360_quotes_discovery_idx",
      "project_360_module_runs_job_status_idx",
      "project_360_module_runs_retry_idx",
    ]]);
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const name of [
      "project_360_discoveries_browser_idem_idx",
      "project_360_discoveries_machine_idem_idx",
      "project_360_discoveries_owner_created_idx",
      "project_360_discoveries_machine_created_idx",
      "project_360_candidates_discovery_idx",
      "project_360_quotes_discovery_idx",
      "project_360_module_runs_job_status_idx",
      "project_360_module_runs_retry_idx",
    ]) {
      assert(indexNames.has(name), `A required Project 360 index is missing: ${name}`);
    }

    const constraints = await postgres.query<{
      conname: string;
      contype: string;
      definition: string;
    }>(`
      select constraint_row.conname,
             constraint_row.contype,
             pg_get_constraintdef(constraint_row.oid) as definition
      from pg_constraint constraint_row
      join pg_class relation on relation.oid = constraint_row.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and (
          relation.relname = any($1::text[])
          or constraint_row.conname = any($2::text[])
        )
    `, [TABLES, [
      "hosted_workflow_quotes_workflow_type_check",
      "hosted_agent_jobs_workflow_type_check",
      "byoa_agent_policies_allowed_workflows_check",
      "hosted_workflow_quotes_budget_usdc_check",
      "hosted_agent_jobs_budget_usdc_check",
      "hosted_workflow_quotes_selected_services_check",
      "hosted_agent_jobs_selected_services_check",
      "hosted_agent_jobs_selected_services_array_check",
      "hosted_agent_jobs_spent_usdc_check",
    ]]);
    const definitions = new Map(
      constraints.rows.map((row) => [row.conname, row.definition]),
    );
    for (const name of [
      "hosted_workflow_quotes_workflow_type_check",
      "hosted_agent_jobs_workflow_type_check",
      "byoa_agent_policies_allowed_workflows_check",
    ]) {
      assert(definitions.get(name)?.includes("project_360"), `${name} does not allow project_360.`);
    }
    for (const name of [
      "hosted_workflow_quotes_budget_usdc_check",
      "hosted_agent_jobs_budget_usdc_check",
    ]) {
      assert(
        /0\.0*10?\b/.test(definitions.get(name) ?? ""),
        `${name} does not allow the approved 0.010000 USDC Project 360 budget.`,
      );
    }
    for (const name of [
      "hosted_workflow_quotes_selected_services_check",
      "hosted_agent_jobs_selected_services_check",
      "hosted_agent_jobs_selected_services_array_check",
    ]) {
      assert(
        /7\)?/.test(definitions.get(name) ?? ""),
        `${name} does not allow the seven bounded Project 360 steps.`,
      );
    }
    assert(
      /0\.0*10?\b/.test(definitions.get("hosted_agent_jobs_spent_usdc_check") ?? ""),
      "hosted_agent_jobs_spent_usdc_check does not allow the approved Project 360 spend ceiling.",
    );
    for (const name of [
      "project_360_discoveries_public_id_key",
      "project_360_candidates_public_id_key",
      "project_360_candidates_provenance_key",
      "project_360_module_runs_job_module_key",
      "project_360_quotes_selection_count_check",
    ]) {
      assert(definitions.has(name), `A Project 360 unique/check constraint is missing: ${name}`);
    }
    for (const [name, target] of [
      ["project_360_discoveries_machine_credential_id_fkey", "byoa_agent_credentials"],
      ["project_360_candidates_discovery_id_fkey", "project_360_discoveries"],
      ["project_360_quotes_quote_id_fkey", "hosted_workflow_quotes"],
      ["project_360_quotes_discovery_id_fkey", "project_360_discoveries"],
      ["project_360_module_runs_job_id_fkey", "hosted_agent_jobs"],
    ] as const) {
      assert(
        definitions.get(name)?.includes(target),
        `A required Project 360 foreign key is missing: ${name}`,
      );
    }
    const discoveryStatus = definitions.get("project_360_discoveries_status_check") ?? "";
    for (const status of ["queued", "running", "ready", "failed", "expired"]) {
      assert(discoveryStatus.includes(status), `Discovery status constraint omits ${status}.`);
    }
    const moduleStatus = definitions.get("project_360_module_runs_status_check") ?? "";
    for (const status of [
      "not_provided",
      "not_selected",
      "pending",
      "running",
      "completed",
      "insufficient_data",
      "provider_unavailable",
      "failed",
    ]) {
      assert(moduleStatus.includes(status), `Module-run status constraint omits ${status}.`);
    }
    assert(!moduleStatus.includes("unsupported"), "Module-run status constraint still allows unsupported.");
    const moduleErrorCode = definitions.get("project_360_module_runs_error_code_check") ?? "";
    for (const code of [
      "invalid_wallet",
      "policy_denial",
      "insufficient_data",
      "treasury_provider_unavailable",
      "treasury_provider_malformed_response",
    ]) {
      assert(moduleErrorCode.includes(code), `Module-run error constraint omits ${code}.`);
    }
    console.log("  ✓ Indexes, FK, unique, status, idempotency, and workflow constraints are active.");

    const triggers = await postgres.query<{ tgname: string; tgenabled: string }>(`
      select trigger_row.tgname, trigger_row.tgenabled
      from pg_trigger trigger_row
      join pg_class relation on relation.oid = trigger_row.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and not trigger_row.tgisinternal
        and trigger_row.tgname = any($1::text[])
    `, [[
      "validate_project_360_discovery_tenant",
      "validate_project_360_quote_binding",
      "reject_project_360_quote_mutation",
      "reject_quoted_project_360_candidate_mutation",
      "reject_quoted_project_360_discovery_mutation",
      "validate_project_360_module_run_tenant",
    ]]);
    const triggerNames = new Map(triggers.rows.map((row) => [row.tgname, row.tgenabled]));
    for (const name of [
      "validate_project_360_discovery_tenant",
      "validate_project_360_quote_binding",
      "reject_project_360_quote_mutation",
      "reject_quoted_project_360_candidate_mutation",
      "reject_quoted_project_360_discovery_mutation",
      "validate_project_360_module_run_tenant",
    ]) {
      assert(triggerNames.get(name) === "O", `Project 360 protection trigger is missing or disabled: ${name}`);
    }

    const tenantViolations = await postgres.query<{ violations: string }>(`
      select count(*)::text as violations
      from public.project_360_quotes quote_snapshot
      join public.project_360_discoveries discovery
        on discovery.id = quote_snapshot.discovery_id
      join public.hosted_workflow_quotes workflow_quote
        on workflow_quote.id = quote_snapshot.quote_id
      where workflow_quote.workflow_type <> 'project_360'
         or lower(coalesce(workflow_quote.owner_wallet, workflow_quote.requester_wallet)) <>
            lower(discovery.owner_wallet)
         or coalesce(workflow_quote.machine_credential_id, '') <>
            coalesce(discovery.machine_credential_id::text, '')
    `);
    const runTenantViolations = await postgres.query<{ violations: string }>(`
      select count(*)::text as violations
      from public.project_360_module_runs module_run
      left join public.hosted_agent_jobs job on job.id = module_run.job_id
      left join public.project_360_quotes quote_snapshot
        on quote_snapshot.quote_id = job.workflow_quote_id
      left join public.project_360_discoveries discovery
        on discovery.id = quote_snapshot.discovery_id
      where job.id is null
         or quote_snapshot.quote_id is null
         or discovery.id is null
         or job.workflow_type <> 'project_360'
         or job.requester_wallet is null
         or lower(job.requester_wallet) <> lower(discovery.owner_wallet)
         or coalesce(job.machine_credential_id, '') <>
            coalesce(discovery.machine_credential_id::text, '')
    `);
    assert(
      tenantViolations.rows[0]?.violations === "0" &&
        runTenantViolations.rows[0]?.violations === "0",
      "Stored Project 360 resources cross owner or credential tenant boundaries.",
    );
    console.log("  ✓ Discovery, quote, and execution tenant bindings are fail-closed.");

    const grants = await postgres.query<{ table_name: string; grantee: string }>(`
      select table_name, grantee
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = any($1::text[])
        and grantee in ('PUBLIC', 'anon', 'authenticated')
    `, [TABLES]);
    assert(grants.rows.length === 0, "PUBLIC, anonymous, or authenticated table grants are present.");

    const privileges = await postgres.query<{
      table_name: string;
      service_access: boolean;
      anon_access: boolean;
      authenticated_access: boolean;
    }>(`
      select table_name,
        has_table_privilege('service_role', format('%I.%I', table_schema, table_name), 'SELECT')
          and has_table_privilege('service_role', format('%I.%I', table_schema, table_name), 'INSERT')
          and has_table_privilege('service_role', format('%I.%I', table_schema, table_name), 'UPDATE')
          and has_table_privilege('service_role', format('%I.%I', table_schema, table_name), 'DELETE')
          as service_access,
        has_table_privilege('anon', format('%I.%I', table_schema, table_name), 'SELECT') as anon_access,
        has_table_privilege('authenticated', format('%I.%I', table_schema, table_name), 'SELECT') as authenticated_access
      from information_schema.tables
      where table_schema = 'public' and table_name = any($1::text[])
    `, [TABLES]);
    assert(
      privileges.rows.length === TABLES.length &&
        privileges.rows.every(
          (row) =>
            row.service_access &&
            !row.anon_access &&
            !row.authenticated_access,
        ),
      "Project 360 table role privileges are not fail-closed.",
    );

    const policies = await postgres.query<{ roles: string[] }>(`
      select roles
      from pg_policies
      where schemaname = 'public' and tablename = any($1::text[])
    `, [TABLES]);
    assert(
      policies.rows.every((row) =>
        !row.roles.some((role) => ["public", "anon", "authenticated"].includes(role)),
      ),
      "A Project 360 RLS policy grants direct public, anon, or authenticated access.",
    );

    const publicConfig = getPublicSupabaseConfig();
    const anonymous = createClient(publicConfig.url, publicConfig.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anonymousReads = await Promise.all([
      anonymous.from("project_360_discoveries").select("id").limit(1),
      anonymous.from("project_360_candidates").select("id").limit(1),
      anonymous.from("project_360_quotes").select("quote_id").limit(1),
      anonymous.from("project_360_module_runs").select("id").limit(1),
    ]);
    assert(
      anonymousReads.every((result) => Boolean(result.error)),
      "Anonymous REST access was not denied for every Project 360 table.",
    );
    console.log("  ✓ RLS, service-role access, and PUBLIC/anon/authenticated denial are verified.");

    const fixture = await postgres.query<{
      quote_id: string;
      candidate_id: string | null;
    }>(`
      select quote_snapshot.quote_id::text,
             candidate.id::text as candidate_id
      from public.project_360_quotes quote_snapshot
      join public.hosted_agent_jobs job
        on job.workflow_quote_id = quote_snapshot.quote_id
      left join lateral (
        select candidate_row.id
        from public.project_360_candidates candidate_row
        where candidate_row.discovery_id = quote_snapshot.discovery_id
          and candidate_row.public_id in (
            select jsonb_array_elements_text(quote_snapshot.selected_candidate_ids)
          )
        limit 1
      ) candidate on true
      order by job.created_at desc
      limit 1
    `);
    if (fixture.rows[0]) {
      assert(
        await expectMutationRejected(
          postgres,
          "update public.project_360_quotes set warnings = warnings where quote_id = $1::uuid",
          [fixture.rows[0].quote_id],
        ),
        "An executed Project 360 quote snapshot can still be mutated.",
      );
      assert(fixture.rows[0].candidate_id, "The executed quote has no selected candidate fixture.");
      assert(
        await expectMutationRejected(
          postgres,
          "update public.project_360_candidates set canonical_value = canonical_value where id = $1::uuid",
          [fixture.rows[0].candidate_id],
        ),
        "A selected discovery candidate can still be substituted after quote creation.",
      );
      console.log("  ✓ Live executed quote and selected-candidate immutability guards reject mutation.");
    } else {
      assert(
        !requireFixture,
        "No executed Project 360 fixture exists for the required live immutability test.",
      );
      console.log("  ✓ Immutability triggers are active; live fixture check deferred until E2E execution.");
    }

    console.log("[verify-project-360-schema] PASS");
  } finally {
    await postgres.end();
  }
}

verifyProductionProject360Schema().catch((error) => {
  console.error(`[verify-project-360-schema] FAIL: ${safeError(error)}`);
  process.exitCode = 1;
});
