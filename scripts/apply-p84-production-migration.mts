/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adds nova_signals.refusal, and frees the signals the missing column stranded.
 *
 * A card whose pricing was refused had its status flipped to `investigating`
 * optimistically, and the refusal itself was never written anywhere. So the
 * signal stayed marked as work in progress with no work behind it: the brief
 * kept listing it, and the card rendered the acknowledgement for a proposal
 * that did not exist.
 *
 * Those rows are put back to `seen`, which is the true statement about them --
 * the person was shown this and nothing was priced. They are not given a
 * manufactured refusal: nobody recorded why Veyra declined, and inventing a
 * reason here would put words in its mouth that no probe ever produced. The
 * next attempt records a real one.
 *
 * Only signals with no research row are touched. A signal that was priced is
 * legitimately under investigation and is left exactly as it is.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const FILE = "20260914140000_p84_nova_signal_refusal.sql";

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

    const stranded = await client.query(`
      UPDATE nova_signals AS s
         SET status = 'seen', updated_at = now()
       WHERE s.status = 'investigating'
         AND NOT EXISTS (SELECT 1 FROM nova_research AS r WHERE r.signal_id = s.signal_id)
      RETURNING s.signal_id, s.headline
    `);
    await client.query("COMMIT");

    const column = await client.query(`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'nova_signals' AND column_name = 'refusal'
    `);
    assert.ok(column.rows[0], "the refusal column was not created");
    console.log(`[p84] nova_signals.refusal ${column.rows[0].data_type}, nullable ${column.rows[0].is_nullable}`);

    for (const row of stranded.rows) console.log(`[p84] freed ${row.signal_id.slice(0, 8)}: ${row.headline}`);
    console.log(`[p84] ${stranded.rowCount} signal(s) released from investigating with nothing behind them`);

    const left = await client.query(`
      SELECT count(*)::int AS n FROM nova_signals AS s
       WHERE s.status = 'investigating'
         AND NOT EXISTS (SELECT 1 FROM nova_research AS r WHERE r.signal_id = s.signal_id)
    `);
    assert.equal(left.rows[0].n, 0, "a signal is still marked investigating with no proposal behind it");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(safeError(error));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[p84] failed:", safeError(error));
  process.exit(1);
});
