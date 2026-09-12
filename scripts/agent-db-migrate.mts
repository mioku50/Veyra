/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ConnectionSource = {
  name: string;
  value: string;
  provider: "agent-db" | "legacy";
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(projectRoot, "supabase", "migrations");
const seedPath = path.join(projectRoot, "supabase", "seed.sql");

function resolveConnection(): ConnectionSource {
  const candidates = [
    {
      name: "AGENT_DB_POSTGRES_URL_NON_POOLING",
      value: process.env.AGENT_DB_POSTGRES_URL_NON_POOLING,
      provider: "agent-db" as const,
    },
    {
      name: "POSTGRES_URL_NON_POOLING",
      value: process.env.POSTGRES_URL_NON_POOLING,
      provider: "legacy" as const,
    },
  ];
  const selected = candidates.find((candidate) => Boolean(candidate.value?.trim()));

  if (!selected?.value) {
    throw new Error(
      "Missing AGENT_DB_POSTGRES_URL_NON_POOLING (legacy POSTGRES_URL_NON_POOLING fallback is supported).",
    );
  }

  return selected as ConnectionSource;
}

function decode(value: string) {
  return decodeURIComponent(value);
}

function connectionEnvironment(connection: ConnectionSource) {
  const parsed = new URL(connection.value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${connection.name} must be a PostgreSQL URL.`);
  }
  if (parsed.searchParams.get("pgbouncer") === "true") {
    throw new Error(`${connection.name} must be a non-pooling PostgreSQL URL.`);
  }

  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: decode(parsed.pathname.replace(/^\//, "") || "postgres"),
    PGUSER: decode(parsed.username),
    PGPASSWORD: decode(parsed.password),
    PGSSLMODE: parsed.searchParams.get("sslmode") || "require",
  };
}

function redact(text: string, environment: NodeJS.ProcessEnv) {
  let safe = text;
  for (const value of [
    environment.PGHOST,
    environment.PGUSER,
    environment.PGPASSWORD,
  ]) {
    if (value) safe = safe.split(value).join("[redacted]");
  }
  return safe.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-postgres-url]");
}

function runPsql(
  environment: NodeJS.ProcessEnv,
  args: string[],
  label: string,
  capture = false,
) {
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--no-password", "--set", "ON_ERROR_STOP=1", ...args],
    {
      cwd: projectRoot,
      env: environment,
      encoding: "utf8",
      stdio: capture ? "pipe" : ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    const detail = redact(String(result.stderr || "").trim(), environment);
    throw new Error(`${label} failed${detail ? `: ${detail}` : "."}`);
  }

  return String(result.stdout || "").trim();
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function main() {
  const connection = resolveConnection();
  const environment = connectionEnvironment(connection);
  console.log(
    `[agent-db] provider=${connection.provider} migrationEnv=${connection.name} connection=non-pooling`,
  );

  runPsql(
    environment,
    [
      "--quiet",
      "--command",
      [
        "create schema if not exists supabase_migrations;",
        "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);",
        "alter table supabase_migrations.schema_migrations add column if not exists statements text[];",
        "alter table supabase_migrations.schema_migrations add column if not exists name text;",
      ].join(" "),
    ],
    "Migration ledger setup",
  );

  const applied = new Set(
    runPsql(
      environment,
      [
        "--tuples-only",
        "--no-align",
        "--command",
        "select version from supabase_migrations.schema_migrations order by version;",
      ],
      "Migration ledger read",
      true,
    )
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  const appliedNow: string[] = [];

  for (const migration of migrations) {
    const [version, ...nameParts] = migration.replace(/\.sql$/, "").split("_");
    if (applied.has(version)) continue;

    console.log(`[agent-db] applying ${migration}`);
    runPsql(
      environment,
      [
        "--quiet",
        "--file",
        path.join(migrationsDirectory, migration),
        "--command",
        `insert into supabase_migrations.schema_migrations(version, name) values (${quoteLiteral(version)}, ${quoteLiteral(nameParts.join("_"))}) on conflict (version) do nothing;`,
      ],
      `Migration ${migration}`,
    );
    appliedNow.push(migration);
  }

  console.log("[agent-db] applying idempotent supabase/seed.sql");
  runPsql(
    environment,
    ["--quiet", "--file", seedPath],
    "Database seed",
  );

  console.log(
    `[agent-db] complete applied=${appliedNow.length} alreadyApplied=${migrations.length - appliedNow.length} seed=ok`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[agent-db] migration failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
}
