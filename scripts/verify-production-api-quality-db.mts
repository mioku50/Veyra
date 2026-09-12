/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const { Client: PostgresClient } = pg;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("[verify-api-quality-db] Starting live DB nullable observation probe...");

  const postgresConnStr =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL_NON_POOLING;

  const serverConfig = tryGetServerSupabaseConfig();
  assert(
    serverConfig || postgresConnStr,
    "Live database configuration is required for DB probe. Do NOT use memory store fallback.",
  );

  const testObservationId = randomUUID();
  const testServiceId = `probe-service-${testObservationId.substring(0, 8)}`;
  const startedAt = new Date().toISOString();

  // Construct probe timeout observation record with all 8 optional fields set to null
  const probeRecord = {
    observation_id: testObservationId,
    service_id: testServiceId,
    seller_public_id: null,
    started_at: startedAt,
    completed_at: null,
    quoted_price_usdc: null,
    paid_amount_usdc: null,
    latency_ms: null,
    http_status_class: "timeout",
    endpoint_reached: false,
    response_schema_valid: null,
    response_within_size_limit: null,
    payment_required: false,
    payment_authorized: null,
    payment_settled: null,
    execution_completed: false,
    arc_proof_verified: false,
    error_category: "timeout",
    source: "scheduled_probe",
    created_at: startedAt,
  };

  let useSupabaseJs = false;
  let supabaseClient: ReturnType<typeof createClient> | null = null;

  if (serverConfig) {
    try {
      supabaseClient = createClient(serverConfig.url, serverConfig.key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // Quick test read to verify supabase-js client key validity
      const { error: testErr } = await supabaseClient
        .from("api_quality_observations")
        .select("observation_id")
        .limit(0);
      if (!testErr) {
        useSupabaseJs = true;
      }
    } catch {
      useSupabaseJs = false;
    }
  }

  if (useSupabaseJs && supabaseClient) {
    console.log("[verify-api-quality-db] Executing live DB probe via Supabase JS service role client...");
    try {
      console.log(`[verify-api-quality-db] Inserting probe record observation_id=${testObservationId}...`);
      const { error: insertError } = await supabaseClient
        .from("api_quality_observations")
        .insert(probeRecord);

      assert(!insertError, `Failed to insert timeout observation into DB: ${insertError?.message}`);

      console.log(`[verify-api-quality-db] Reading back observation record ${testObservationId}...`);
      const { data: readRecord, error: readError } = await supabaseClient
        .from("api_quality_observations")
        .select("*")
        .eq("observation_id", testObservationId)
        .single();

      assert(!readError && readRecord, `Failed to read back inserted observation: ${readError?.message}`);

      console.log("[verify-api-quality-db] Verifying null preservation across all optional columns...");
      assert(readRecord.completed_at === null, "completed_at was not preserved as null");
      assert(readRecord.quoted_price_usdc === null, "quoted_price_usdc was not preserved as null");
      assert(readRecord.paid_amount_usdc === null, "paid_amount_usdc was not preserved as null");
      assert(readRecord.latency_ms === null, "latency_ms was not preserved as null");
      assert(readRecord.response_schema_valid === null, "response_schema_valid was not preserved as null");
      assert(readRecord.response_within_size_limit === null, "response_within_size_limit was not preserved as null");
      assert(readRecord.payment_authorized === null, "payment_authorized was not preserved as null");
      assert(readRecord.payment_settled === null, "payment_settled was not preserved as null");

      console.log("[verify-api-quality-db] All 8 null fields successfully preserved in DB!");
    } finally {
      console.log(`[verify-api-quality-db] Cleaning up test record ${testObservationId}...`);
      await supabaseClient
        .from("api_quality_observations")
        .delete()
        .eq("observation_id", testObservationId);
    }
  } else {
    console.log("[verify-api-quality-db] Executing live DB probe via direct PostgreSQL service role connection...");
    assert(postgresConnStr, "PostgreSQL connection string is required when Supabase JS client key is unconfigured.");
    
    const connUrl = new URL(postgresConnStr);
    connUrl.searchParams.delete("sslmode");
    connUrl.searchParams.delete("sslrootcert");

    const pgClient = new PostgresClient({
      connectionString: connUrl.toString(),
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });

    await pgClient.connect();

    try {
      console.log(`[verify-api-quality-db] Inserting probe record observation_id=${testObservationId}...`);
      await pgClient.query(
        `insert into public.api_quality_observations (
          observation_id, service_id, seller_public_id, started_at, completed_at,
          quoted_price_usdc, paid_amount_usdc, latency_ms, http_status_class,
          endpoint_reached, response_schema_valid, response_within_size_limit,
          payment_required, payment_authorized, payment_settled, execution_completed,
          arc_proof_verified, error_category, source, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          probeRecord.observation_id,
          probeRecord.service_id,
          probeRecord.seller_public_id,
          probeRecord.started_at,
          probeRecord.completed_at,
          probeRecord.quoted_price_usdc,
          probeRecord.paid_amount_usdc,
          probeRecord.latency_ms,
          probeRecord.http_status_class,
          probeRecord.endpoint_reached,
          probeRecord.response_schema_valid,
          probeRecord.response_within_size_limit,
          probeRecord.payment_required,
          probeRecord.payment_authorized,
          probeRecord.payment_settled,
          probeRecord.execution_completed,
          probeRecord.arc_proof_verified,
          probeRecord.error_category,
          probeRecord.source,
          probeRecord.created_at,
        ],
      );

      console.log(`[verify-api-quality-db] Reading back observation record ${testObservationId}...`);
      const { rows } = await pgClient.query(
        `select * from public.api_quality_observations where observation_id = $1`,
        [testObservationId],
      );

      assert(rows.length === 1, "Failed to read back inserted observation record from DB.");
      const readRecord = rows[0];

      console.log("[verify-api-quality-db] Verifying null preservation across all optional columns...");
      assert(readRecord.completed_at === null, "completed_at was not preserved as null");
      assert(readRecord.quoted_price_usdc === null, "quoted_price_usdc was not preserved as null");
      assert(readRecord.paid_amount_usdc === null, "paid_amount_usdc was not preserved as null");
      assert(readRecord.latency_ms === null, "latency_ms was not preserved as null");
      assert(readRecord.response_schema_valid === null, "response_schema_valid was not preserved as null");
      assert(readRecord.response_within_size_limit === null, "response_within_size_limit was not preserved as null");
      assert(readRecord.payment_authorized === null, "payment_authorized was not preserved as null");
      assert(readRecord.payment_settled === null, "payment_settled was not preserved as null");

      console.log("[verify-api-quality-db] All 8 null fields successfully preserved in DB!");
    } finally {
      console.log(`[verify-api-quality-db] Cleaning up test record ${testObservationId}...`);
      await pgClient.query(
        `delete from public.api_quality_observations where observation_id = $1`,
        [testObservationId],
      );
      await pgClient.end();
    }
  }

  console.log("[verify-api-quality-db] PASSED: Live DB nullable probe completed successfully.");
}

main().catch((error) => {
  console.error(`[verify-api-quality-db] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
