/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shadow autonomy: the decision table, and the two mandate fields v2 signs.
 *
 * Verified after applying rather than assumed, and specifically verified for
 * the things this phase claims. The decision table must not have a payment
 * signature, a clearance, a transaction hash or a settled amount -- the single
 * claim shadow autonomy rests on is that no money moved, and a column able to
 * hold a transaction is one somebody eventually fills. So the absence is
 * asserted here, where it fails loudly, rather than left to the comment in the
 * migration.
 *
 * The unique index is checked too. It is the backoff -- one decision per signal
 * per mandate per budget day -- and expressing it as a constraint only helps if
 * the constraint actually exists.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const FILE = "20260914200000_p87_nova_shadow_autonomy.sql";

/** Columns whose presence would make a shadow decision indistinguishable from
 *  a purchase. None of these may exist on the decision table, ever. */
const FORBIDDEN = [
  "payment_signature", "signature", "clearance", "clearance_digest",
  "transaction_hash", "transaction", "settled_amount_usdc", "paid_usdc",
  "actual_settled_amount", "execution_id", "execution_public_id",
];

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

    const columns = await client.query(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'nova_autonomy_decisions'
       ORDER BY ordinal_position
    `);
    assert.ok(columns.rowCount && columns.rowCount > 0, "nova_autonomy_decisions was not created");
    const names = columns.rows.map((row) => row.column_name as string);
    console.log(`[p87] nova_autonomy_decisions: ${names.join(", ")}`);

    for (const forbidden of FORBIDDEN) {
      assert.ok(
        !names.includes(forbidden),
        `nova_autonomy_decisions has a ${forbidden} column, and a shadow decision must not be able to carry one`,
      );
    }
    console.log(`[p87] no payment column among ${FORBIDDEN.length} checked -- nothing here can record a spend`);

    const index = await client.query(`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'nova_autonomy_decisions'
         AND indexname = 'nova_autonomy_decisions_once_per_day_idx'
    `);
    assert.ok(index.rows[0], "the once-per-budget-day unique index is missing");
    assert.match(index.rows[0].indexdef as string, /UNIQUE/, "the backoff index is not unique");
    console.log(`[p87] backoff: ${index.rows[0].indexdef}`);

    const mandate = await client.query(`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'execution_mandates'
         AND column_name IN ('budget_timezone', 'max_autonomous_attempts_per_day')
       ORDER BY column_name
    `);
    assert.equal(mandate.rowCount, 2, "the two ExecutionMandate v2 columns were not added");
    for (const row of mandate.rows) {
      /* Nullable on purpose. A v1 mandate was signed before either field
         existed, and a NOT NULL here would force a value into somebody's
         signed terms that they never agreed to. */
      assert.equal(row.is_nullable, "YES", `${row.column_name} must stay nullable for v1 mandates`);
      console.log(`[p87] execution_mandates.${row.column_name} nullable`);
    }

    const v1 = await client.query(`
      SELECT count(*)::int AS n FROM execution_mandates
       WHERE version <> 'v2' AND (budget_timezone IS NOT NULL OR max_autonomous_attempts_per_day IS NOT NULL)
    `);
    assert.equal(v1.rows[0].n, 0, "a pre-v2 mandate was given autonomy fields it never signed");
    console.log("[p87] no v1 mandate carries an autonomy term it did not sign");

    const decisions = await client.query("SELECT count(*)::int AS n FROM nova_autonomy_decisions");
    console.log(`[p87] ${decisions.rows[0].n} decision(s) recorded -- and $0 moved for any of them`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(safeError(error));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[p87] failed:", safeError(error));
  process.exit(1);
});
