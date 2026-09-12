/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client as PostgresClient } from "pg";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const TARGET_FILES = [
  "20260801120000_p42_project_360.sql",
  "20260801190000_p421_project_360_budget_constraints.sql",
  "20260801193000_p421_project_360_execution_constraints.sql",
  "20260801223000_p421_project_360_legacy_service_constraint.sql",
  "20260802120000_p422_project_360_module_reliability.sql",
] as const;
const TARGET_VERSIONS = TARGET_FILES.map((file) => file.split("_", 1)[0]);
const BASE_VERSION = TARGET_VERSIONS[0];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function projectRef(url: URL) {
  const direct = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
  if (direct) return direct[1];
  const database = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (database) return database[1];
  return decodeURIComponent(url.username).match(
    /^(?:postgres|service_role|anon)\.([a-z0-9]+)$/i,
  )?.[1] ?? null;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const migrationsDirectory = path.join(root, "supabase", "migrations");
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  assert(
    migrations.at(-1) === TARGET_FILES.at(-1),
    "The final Project 360 hardening migration is not the latest ordered local migration.",
  );
  const versions = migrations.map((name) => name.split("_", 1)[0]);
  for (const targetVersion of TARGET_VERSIONS) {
    assert(
      versions.filter((version) => version === targetVersion).length === 1,
      `Project 360 migration version ${targetVersion} is not unique.`,
    );
  }
  const historicalDuplicateVersions = [...new Set(
    versions.filter((version, index) => versions.indexOf(version) !== index),
  )].filter((version) => !TARGET_VERSIONS.includes(version));
  const sql = readFileSync(path.join(migrationsDirectory, TARGET_FILES[0]), "utf8");
  for (const pattern of [
    /^\s*begin;/im,
    /commit;\s*$/i,
    /create table if not exists public\.project_360_discoveries/i,
    /create unique index if not exists project_360_discoveries_browser_idem_idx/i,
    /create or replace function public\.validate_project_360_quote_binding/i,
    /drop trigger if exists reject_project_360_quote_mutation/i,
  ]) {
    assert(pattern.test(sql), "Project 360 migration is missing an atomic/idempotent DDL guard.");
  }
  for (const targetFile of TARGET_FILES.slice(1)) {
    const hardeningSql = readFileSync(path.join(migrationsDirectory, targetFile), "utf8");
    assert(
      /^\s*begin;/im.test(hardeningSql) && /commit;\s*$/i.test(hardeningSql),
      `${targetFile} is missing its atomic transaction guard.`,
    );
  }

  const runtime = tryGetServerSupabaseConfig();
  const connection =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL_NON_POOLING;
  assert(runtime && connection, "Production Runtime and migration configuration are required.");
  const connectionUrl = new URL(connection);
  assert(
    projectRef(new URL(runtime.url)) &&
      projectRef(new URL(runtime.url)) === projectRef(connectionUrl),
    "Production Runtime and migration Supabase targets do not match.",
  );
  connectionUrl.searchParams.delete("sslmode");
  connectionUrl.searchParams.delete("sslrootcert");
  const postgres = new PostgresClient({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await postgres.connect();
  try {
    const ledger = await postgres.query<{ version: string }>(`
      select version
      from supabase_migrations.schema_migrations
      order by version
    `);
    const applied = new Set(ledger.rows.map((row) => row.version));
    const missingPredecessors = [...new Set(versions)]
      .filter((version) => version < BASE_VERSION)
      .filter((version) => !applied.has(version));
    assert(
      missingPredecessors.length === 0,
      "Production is missing one or more predecessor migrations; refusing an out-of-order apply.",
    );
    const targetApplication = TARGET_VERSIONS.map((version) => applied.has(version));
    const firstMissingTarget = targetApplication.indexOf(false);
    assert(
      firstMissingTarget === -1 ||
        targetApplication.slice(firstMissingTarget).every((isApplied) => !isApplied),
      "Production contains an out-of-order Project 360 follow-up migration.",
    );
    const relationState = await postgres.query<{ present: string | null }>(`
      select to_regclass(name)::text as present
      from unnest(array[
        'public.project_360_discoveries',
        'public.project_360_candidates',
        'public.project_360_quotes',
        'public.project_360_module_runs'
      ]) as name
    `);
    const presentCount = relationState.rows.filter((row) => row.present).length;
    if (applied.has(BASE_VERSION)) {
      assert(presentCount === 4, "Migration ledger is applied but Project 360 schema is incomplete.");
      console.log(
        `[project-360-readiness] PASS: ${targetApplication.filter(Boolean).length}/${TARGET_FILES.length} ordered Project 360 migration(s) are applied and schema is present.`,
      );
    } else {
      assert(presentCount === 0, "Project 360 has a partial unrecorded Production migration.");
      console.log("[project-360-readiness] PASS: predecessors are applied; Project 360 is the single pending migration.");
    }
    if (historicalDuplicateVersions.length > 0) {
      console.log(
        `[project-360-readiness] NOTE: ${historicalDuplicateVersions.length} historical duplicate version(s) predate P4.2; target version is unique.`,
      );
    }
  } finally {
    await postgres.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[project-360-readiness] FAIL: ${message
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
      .replace(/[a-z0-9]{12,}\.supabase\.co/gi, "[redacted-supabase-host]")}`,
  );
  process.exitCode = 1;
});
