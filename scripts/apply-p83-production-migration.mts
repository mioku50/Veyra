/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adds nova_research.reading: the words a verified purchase is turned into.
 *
 * Additive and nullable. Nothing existing is rewritten, and the column stays
 * nullable on purpose -- the model can be down, unconfigured, or answer in a
 * shape nothing can be made of, and none of that may cost somebody the purchase
 * they already paid for.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const FILE = "20260914120000_p83_nova_reading.sql";

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/[a-z0-9]{12,}\.supabase\.co/gi, "[redacted-supabase-host]")
    .replace(/(?:eyJ|sk-)[A-Za-z0-9._-]{20,}/g, "[redacted-secret]")
    .slice(0, 800);
}

async function main() {
  const connectionString =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL_NON_POOLING;
  assert.ok(connectionString, "A non-pooling PostgreSQL connection is required");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sql = readFileSync(path.join(root, "supabase", "migrations", FILE), "utf8");

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");

    const check = await client.query(`
      SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
       WHERE table_name = 'nova_research' AND column_name = 'reading'
    `);
    const row = check.rows[0];
    assert.ok(row, "the reading column was not created");
    console.log(`[p83] nova_research.reading ${row.data_type}, nullable ${row.is_nullable}`);

    const counts = await client.query(
      "SELECT status, count(*)::int AS n FROM nova_research GROUP BY status ORDER BY status",
    );
    for (const r of counts.rows) console.log(`[p83] existing rows: ${r.status} ${r.n}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(safeError(error));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[p83] failed:", safeError(error));
  process.exit(1);
});
