/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Widens execution_attempts.state to the states the machine can actually reach,
 * then repairs the rows the old constraint silently refused.
 *
 * The refusal was invisible by design -- closeBrowserX402Attempt swallows a
 * ledger failure so a purchase the user already signed for is never stranded --
 * so the rows are still sitting in EXECUTING with a null amount and a null
 * transaction while the money is gone. They are repaired from nova_research,
 * which recorded the truth the ledger could not.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const FILE = "20260913230000_p82c_execution_states_after_payment.sql";

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

    /* Every attempt left mid-flight whose ending nova_research knows.
       EXECUTING -> SETTLED_SERVICE_FAILED is a legal transition; the only
       reason it never happened is that the target state was unwritable. */
    const repaired = await client.query(`
      UPDATE execution_attempts AS a
         SET state = 'SETTLED_SERVICE_FAILED',
             failure_code = COALESCE(a.failure_code, 'endpoint_error_after_payment'),
             actual_settled_amount_usdc = r.paid_usdc,
             payment_tx = r.transaction_hash,
             updated_at = NOW()
        FROM nova_research AS r
       WHERE r.execution_public_id = a.execution_id
         AND r.status = 'paid_unverified'
         AND a.state = 'EXECUTING'
      RETURNING a.execution_id, a.actual_settled_amount_usdc, a.payment_tx
    `);

    await client.query("COMMIT");

    console.log("[p82c] constraint widened to every state the machine can reach");
    for (const row of repaired.rows) {
      console.log(`[p82c] repaired ${row.execution_id}: settled ${row.actual_settled_amount_usdc} tx ${row.payment_tx}`);
    }
    if (repaired.rowCount === 0) console.log("[p82c] no stranded attempts to repair");

    const stuck = await client.query(
      "SELECT execution_id, state FROM execution_attempts WHERE state IN ('EXECUTING','AUTHORIZED','PREPARED')",
    );
    for (const row of stuck.rows) {
      console.log(`[p82c] still open: ${row.execution_id} ${row.state}`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(safeError(error));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[p82c] failed:", safeError(error));
  process.exit(1);
});
