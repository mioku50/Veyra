/**
 * Verifies that the P6.1 database tables and RPC functions are correctly installed.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { Client } from "pg";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

async function main() {
  const runtime = tryGetServerSupabaseConfig();
  if (!runtime) {
    console.log("[verify-p61-schema] No Supabase config present, skipping remote verification.");
    return;
  }
  const connectionString =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL_NON_POOLING;
  if (!connectionString) {
    console.log("[verify-p61-schema] No non-pooling postgres URL, skipping remote verification.");
    return;
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();

  try {
    // Check tables
    const tablesRes = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('execution_mandates', 'execution_mandate_usage', 'execution_attempts');
    `);
    const tables = tablesRes.rows.map((r) => r.table_name);
    assert.ok(tables.includes("execution_mandates"), "Missing table execution_mandates");
    assert.ok(tables.includes("execution_mandate_usage"), "Missing table execution_mandate_usage");
    assert.ok(tables.includes("execution_attempts"), "Missing table execution_attempts");

    // Check functions
    const funcsRes = await client.query<{ routine_name: string }>(`
      SELECT routine_name FROM information_schema.routines 
      WHERE routine_schema = 'public' 
      AND routine_name IN ('reserve_mandate_budget', 'release_mandate_budget', 'settle_mandate_budget');
    `);
    const funcs = funcsRes.rows.map((r) => r.routine_name);
    assert.ok(funcs.includes("reserve_mandate_budget"), "Missing RPC reserve_mandate_budget");
    assert.ok(funcs.includes("release_mandate_budget"), "Missing RPC release_mandate_budget");
    assert.ok(funcs.includes("settle_mandate_budget"), "Missing RPC settle_mandate_budget");

    console.log("✅ P6.1 database schema and atomic budget RPCs verified successfully.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[verify-p61-schema:error]", err.message);
  process.exit(1);
});
