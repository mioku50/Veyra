/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(projectRoot, "supabase", "migrations");

async function main() {
  let poolerConnStr =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL_NON_POOLING;

  if (!poolerConnStr) {
    throw new Error("Missing AGENT_DB_POSTGRES_URL_NON_POOLING");
  }

  // Parse connection string and strip ssl query params
  const connUrl = new URL(poolerConnStr);
  connUrl.searchParams.delete("sslmode");
  connUrl.searchParams.delete("sslrootcert");
  poolerConnStr = connUrl.toString();

  console.log(`[node-db-migrate] connecting to ${connUrl.hostname}:${connUrl.port}...`);

  const client = new Client({
    connectionString: poolerConnStr,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });

  await client.connect();
  console.log("[node-db-migrate] connected successfully!");

  try {
    const files = readdirSync(migrationsDir)
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
      .sort();

    // Check applied migrations
    console.log("[node-db-migrate] checking migration ledger...");
    const { rows: appliedRows } = await client.query(
      "select version from supabase_migrations.schema_migrations order by version"
    );
    const applied = new Set(appliedRows.map((r) => String(r.version)));

    for (const file of files) {
      const [version, ...nameParts] = file.replace(/\.sql$/, "").split("_");
      if (applied.has(version)) {
        console.log(`[node-db-migrate] migration ${file} already applied.`);
        continue;
      }

      console.log(`[node-db-migrate] applying migration ${file}...`);
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      
      // Execute migration statements
      await client.query(sql);
      await client.query(
        "insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing",
        [version, nameParts.join("_")]
      );
      console.log(`[node-db-migrate] successfully applied ${file}.`);
    }

    console.log("[node-db-migrate] ALL MIGRATIONS APPLIED SUCCESSFULLY.");
  } catch (err) {
    console.error("[node-db-migrate] FAILED:", err);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
