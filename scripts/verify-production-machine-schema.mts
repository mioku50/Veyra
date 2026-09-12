/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient } from "@supabase/supabase-js";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";
import { getPublicSupabaseConfig } from "../lib/supabase/env.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("fetch failed") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT")
  );
}

async function verifyProductionMachineSchema() {
  console.log("[verify-machine-schema] Starting production database schema verification...");

  // Load server configuration safely without logging secrets or URLs
  const serverConfig = tryGetServerSupabaseConfig();
  if (!serverConfig) {
    throw new Error(
      "Server Supabase configuration is required for production verification.",
    );
  }

  console.log(
    `[verify-machine-schema] Server config loaded. Provider=${serverConfig.diagnostic.provider}, KeyEnv=${serverConfig.diagnostic.keyEnv}`,
  );

  const serverClient = createClient(serverConfig.url, serverConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Check 1: Table public.machine_api_idempotency exists and contains required columns
  console.log("[verify-machine-schema] Check 1: Verifying public.machine_api_idempotency table and columns...");
  const requiredIdempotencyColumns = [
    "id",
    "credential_id",
    "agent_id",
    "route",
    "idempotency_key_hash",
    "request_hash",
    "expires_at",
  ];

  try {
    const { error: idempotencyTableError } = await serverClient
      .from("machine_api_idempotency")
      .select(requiredIdempotencyColumns.join(","))
      .limit(0);

    if (idempotencyTableError) {
      if (isNetworkError(idempotencyTableError.message)) {
        throw new Error(
          "Database host is unreachable; production verification cannot be skipped.",
        );
      }
      throw new Error(
        `Table public.machine_api_idempotency or required columns missing: ${idempotencyTableError.message}`,
      );
    }
  } catch (err) {
    if (isNetworkError(err)) {
      throw new Error(
        "Database host is unreachable; production verification cannot be skipped.",
      );
    }
    throw err;
  }
  console.log("  ✓ public.machine_api_idempotency exists with required columns.");

  // Check 2 & 4: Test unique constraint/index and test reservation probe record creation/cleanup
  console.log("[verify-machine-schema] Check 2 & 4: Verifying unique constraint/index and probe record creation/cleanup...");
  const probeIdempotencyKeyHash = "0000000000000000000000000000000000000000000000000000000000000000";
  const probeRequestHash = "0000000000000000000000000000000000000000000000000000000000000000";
  const probeRecord = {
    credential_id: "verify-schema-probe-cred",
    agent_id: "verify-schema-probe-agent",
    route: "/api/agent/v1/verify-probe",
    idempotency_key_hash: probeIdempotencyKeyHash,
    request_hash: probeRequestHash,
    response_status: 200,
    response_body: { verified: true },
    resource_type: "verification_probe",
    resource_id: "test_verification_probe",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };

  // Upsert record using onConflict on (credential_id, route, idempotency_key_hash)
  const { error: probeUpsertError } = await serverClient
    .from("machine_api_idempotency")
    .upsert(probeRecord, {
      onConflict: "credential_id,route,idempotency_key_hash",
    });

  assert(
    !probeUpsertError,
    `Unique constraint or index verification failed for machine_api_idempotency: ${probeUpsertError?.message}`,
  );
  console.log("  ✓ Unique constraint/index on (credential_id, route, idempotency_key_hash) verified.");

  const { data: reservationProbe, error: reservationProbeError } =
    await serverClient.rpc("reserve_machine_api_idempotency_v1", {
      p_credential_id: probeRecord.credential_id,
      p_agent_id: probeRecord.agent_id,
      p_route: probeRecord.route,
      p_idempotency_key_hash: probeRecord.idempotency_key_hash,
      p_request_hash: probeRecord.request_hash,
      p_expires_at: probeRecord.expires_at,
    });

  const reservationRow = (
    reservationProbe as Array<{
      reservation_outcome?: string;
      cached_status?: number | null;
    }> | null
  )?.[0];
  assert(
    !reservationProbeError &&
      reservationRow?.reservation_outcome === "cached" &&
      reservationRow.cached_status === 200,
    `Atomic reservation RPC verification failed: ${reservationProbeError?.message ?? "unexpected outcome"}`,
  );
  console.log("  ✓ Atomic idempotency reservation RPC verified.");

  // Verify check 4 (test reservation probe record exists)
  const { data: fetchedProbe, error: fetchProbeError } = await serverClient
    .from("machine_api_idempotency")
    .select("id, resource_id, credential_id")
    .eq("resource_id", "test_verification_probe")
    .maybeSingle();

  assert(
    !fetchProbeError && fetchedProbe,
    `Test reservation probe record created but not found: ${fetchProbeError?.message ?? "record missing"}`,
  );

  // Clean up probe record
  const { error: probeCleanupError } = await serverClient
    .from("machine_api_idempotency")
    .delete()
    .eq("resource_id", "test_verification_probe");

  assert(
    !probeCleanupError,
    `Test reservation probe record cleanup failed: ${probeCleanupError?.message}`,
  );
  console.log("  ✓ Test reservation probe record created and cleaned up successfully (resource_id: \"test_verification_probe\").");

  // Check 3: Column machine_credential_id exists in hosted_workflow_quotes and hosted_agent_jobs
  console.log("[verify-machine-schema] Check 3: Verifying column machine_credential_id in target tables...");

  const { error: quotesColError } = await serverClient
    .from("hosted_workflow_quotes")
    .select("id, byoa_agent_id, machine_credential_id, owner_wallet")
    .limit(0);

  assert(
    !quotesColError,
    `Machine ownership columns missing or inaccessible in hosted_workflow_quotes: ${quotesColError?.message}`,
  );
  console.log("  ✓ Machine ownership columns exist in hosted_workflow_quotes.");

  const { error: jobsColError } = await serverClient
    .from("hosted_agent_jobs")
    .select("id, machine_credential_id")
    .limit(0);

  assert(
    !jobsColError,
    `Column machine_credential_id missing or inaccessible in hosted_agent_jobs: ${jobsColError?.message}`,
  );
  console.log("  ✓ Column machine_credential_id exists in hosted_agent_jobs.");

  const { error: credentialColumnsError } = await serverClient
    .from("byoa_agent_credentials")
    .select("id, agent_id, owner_wallet, credential_type, scopes, created_at, expires_at, revoked_at")
    .limit(0);

  assert(
    !credentialColumnsError,
    `Credential type/ownership columns missing or inaccessible: ${credentialColumnsError?.message}`,
  );
  console.log("  ✓ Explicit credential type and owner relation columns exist.");

  console.log("[verify-machine-schema] Check 4: Verifying P2.1/P2.2 seller lifecycle schema...");
  const sellerSchemaChecks = [
    serverClient.from("seller_accounts")
      .select("id,public_id,owner_wallet,status,display_name,onboarding_status,terms_accepted_at,onboarding_completed_at,settlement_mode,created_at,updated_at").limit(0),
    serverClient.from("seller_service_versions")
      .select("id,service_id,seller_id,service_version,health_check_input,fulfillment_url,endpoint_auth_ciphertext,created_at").limit(0),
    serverClient.from("seller_revenue_ledger")
      .select("id,seller_id,service_id,service_version,quote_id,job_id,gross_amount_usdc,platform_fee_usdc,seller_net_amount_usdc,settlement_status,settlement_mode,settlement_reference,destination_wallet").limit(0),
    serverClient.from("store_services")
      .select("id,public_id,seller_id,service_version,review_status,availability_status,last_health_check_at,last_healthy_at,consecutive_health_failures,health_check_input,archived_at").limit(0),
    serverClient.from("hosted_workflow_quotes")
      .select("id,seller_service_id,seller_service_version,seller_id,seller_net_amount_usdc").limit(0),
    serverClient.from("seller_service_reviews")
      .select("id,seller_id,service_id,service_version,status,reviewer_type,checks,reason,created_at").limit(0),
    serverClient.from("seller_service_health_checks")
      .select("id,seller_id,service_id,service_version,status,latency_ms,error_code,checked_at").limit(0),
    serverClient.from("seller_settlements")
      .select("id,public_id,seller_id,ledger_id,payment_event_id,settlement_mode,amount_usdc,destination_wallet,gateway_transaction,status,confirmed_at").limit(0),
    serverClient.from("seller_withdrawal_requests")
      .select("id,public_id,seller_id,idempotency_key_hash,amount_usdc,source_chain,destination_chain,destination_wallet,max_fee_usdc,burn_intent,status,expires_at,confirmed_at").limit(0),
  ];
  const sellerSchemaResults = await Promise.all(sellerSchemaChecks);
  const sellerSchemaFailure = sellerSchemaResults.find((result) => result.error)?.error;
  assert(!sellerSchemaFailure, `P2.1/P2.2 seller lifecycle schema is missing or inaccessible: ${sellerSchemaFailure?.message}`);
  console.log("  ✓ Seller onboarding, immutable versions, reviews, health checks, settlements, and withdrawal intents exist.");

  // Check 5: Verify server role access works and public/anon client cannot access table without auth
  console.log("[verify-machine-schema] Check 5: Verifying RLS protection (public/anon client blocked)...");

  let publicConfig: { url: string; key: string } | null = null;
  try {
    publicConfig = getPublicSupabaseConfig();
  } catch {
    // Public Supabase config not available in this env
  }

  if (publicConfig) {
    const publicClient = createClient(publicConfig.url, publicConfig.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: anonData } = await publicClient
      .from("machine_api_idempotency")
      .select("id")
      .limit(1);

    assert(
      !anonData || anonData.length === 0,
      "Security check failed: public/anon client was able to read machine_api_idempotency table!",
    );

    const { error: anonInsertError } = await publicClient
      .from("machine_api_idempotency")
      .insert({
        credential_id: "unauthorized-anon-probe",
        agent_id: "unauthorized-anon-probe",
        route: "/api/agent/v1/test",
        idempotency_key_hash: "anon-test-key",
        request_hash: "anon-test-hash",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });

    if (!anonInsertError) {
      await serverClient
        .from("machine_api_idempotency")
        .delete()
        .eq("credential_id", "unauthorized-anon-probe");
      throw new Error(
        "Security check failed: public/anon client unexpectedly bypassed machine_api_idempotency write RLS!",
      );
    }
    console.log("  ✓ RLS protection verified: public/anon client blocked from machine_api_idempotency.");

    const [anonVersions, anonRevenue, anonReviews, anonHealth, anonSettlements, anonWithdrawals, legacyWithdrawals, hiddenStoreColumn] = await Promise.all([
      publicClient.from("seller_service_versions").select("id").limit(1),
      publicClient.from("seller_revenue_ledger").select("id").limit(1),
      publicClient.from("seller_service_reviews").select("id").limit(1),
      publicClient.from("seller_service_health_checks").select("id").limit(1),
      publicClient.from("seller_settlements").select("id").limit(1),
      publicClient.from("seller_withdrawal_requests").select("id").limit(1),
      publicClient.from("withdrawals").select("id").limit(1),
      publicClient.from("store_services").select("fulfillment_url").limit(1),
    ]);
    assert(
      (!anonVersions.data || anonVersions.data.length === 0) &&
        (!anonRevenue.data || anonRevenue.data.length === 0) &&
        (!anonReviews.data || anonReviews.data.length === 0) &&
        (!anonHealth.data || anonHealth.data.length === 0) &&
        (!anonSettlements.data || anonSettlements.data.length === 0) &&
        (!anonWithdrawals.data || anonWithdrawals.data.length === 0) &&
        (!legacyWithdrawals.data || legacyWithdrawals.data.length === 0),
      "Security check failed: anonymous access exposed private seller lifecycle tables.",
    );
    assert(
      Boolean(hiddenStoreColumn.error),
      "Security check failed: anonymous access exposed seller fulfillment URLs.",
    );
    console.log("  ✓ Seller versions, revenue, review, health, settlement, withdrawal, endpoint URL, and secret data are denied to anonymous access.");
  } else {
    throw new Error(
      "Public Supabase configuration is required to verify anonymous access denial.",
    );
  }

  console.log("[verify-machine-schema] All production database schema verifications PASSED successfully!");
}

verifyProductionMachineSchema().catch((err) => {
  console.error(
    `[verify-machine-schema] Verification FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
