/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicSupabaseConfig } from "../lib/supabase/env.ts";
import {
  getServerDatabaseDiagnostic,
  getServerSupabaseConfig,
} from "../lib/supabase/server-env.ts";

type LaunchRow = {
  job_id: string | null;
  created: boolean;
  reason:
    | "created"
    | "idempotent"
    | "idempotency_conflict"
    | "active_job"
    | "cooldown"
    | "rate_limited";
  retry_after_seconds: number;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function launch(
  client: SupabaseClient,
  input: { idempotency: string; requestHash: string; fingerprint: string },
) {
  const sourceInput = "This is a valid hosted workflow database test input.";
  const inputHash = digest(sourceInput);
  const plannerSnapshot = {
    version: 3,
    workflowType: "sentiment_tone",
    workflowLabel: "Sentiment & Tone Report",
    selectedServices: [
      { slug: "premium-quote", priceUsdc: 0.001 },
      { slug: "text-analyzer", priceUsdc: 0.0003 },
    ],
    estimatedSpendUsdc: 0.0013,
    maxPaidCalls: 3,
    aggregationMode: "deterministic_structured",
    inputPreview: sourceInput,
    inputSha256: inputHash,
    marketSymbol: null,
  };
  const { data, error } = await client.rpc("launch_hosted_agent_workflow_v2", {
    p_idempotency_hash: input.idempotency,
    p_request_hash: input.requestHash,
    p_requester_fingerprint: input.fingerprint,
    p_requester_wallet: null,
    p_workflow_type: "sentiment_tone",
    p_task: "Phase 21 hosted workflow database policy test",
    p_input_preview: sourceInput,
    p_input_hash: inputHash,
    p_budget_usdc: 0.005,
    p_planner_snapshot: plannerSnapshot,
    p_selected_services: plannerSnapshot.selectedServices,
    p_cooldown_seconds: 30,
    p_rate_window_seconds: 3_600,
    p_rate_max_runs: 3,
  });
  if (error) throw new Error(`Hosted launch RPC failed: ${error.message}`);
  const row = (data as LaunchRow[] | null)?.[0];
  assert(row, "Hosted launch RPC returned no row.");
  return row;
}

async function main() {
  const marker = randomUUID();
  const publicConfig = getPublicSupabaseConfig();
  const serverConfig = getServerSupabaseConfig();
  const diagnostic = getServerDatabaseDiagnostic();
  console.log(
    `[hosted-test] provider=${diagnostic.provider} public=${diagnostic.publicClient.configured ? "configured" : "missing"} server=${diagnostic.serverClient.credential ?? "missing"}`,
  );

  const server = createClient(serverConfig.url, serverConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const publicClient = createClient(publicConfig.url, publicConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const createdIds: string[] = [];

  const { data: active, error: activeError } = await server
    .from("hosted_agent_jobs")
    .select("id")
    .in("status", ["queued", "running"])
    .limit(1);
  assert(!activeError, `Unable to check active hosted jobs: ${activeError?.message}`);
  assert((active ?? []).length === 0, "A real hosted job is active; retry tests after it completes.");
  const { count: persistedInputCount, error: persistedInputError } = await server
    .from("hosted_agent_jobs")
    .select("id", { count: "exact", head: true })
    .not("input_text", "is", null);
  assert(
    !persistedInputError && persistedInputCount === 0,
    "At least one hosted job still contains full persisted input text.",
  );

  try {
    const fingerprint = digest(`${marker}:requester`);
    const idempotency = digest(`${marker}:idempotency`);
    const requestHash = digest(`${marker}:request`);
    const first = await launch(server, { idempotency, requestHash, fingerprint });
    assert(first.created && first.reason === "created" && first.job_id, "Initial launch was not created.");
    createdIds.push(first.job_id);

    const repeated = await launch(server, { idempotency, requestHash, fingerprint });
    assert(
      !repeated.created && repeated.reason === "idempotent" && repeated.job_id === first.job_id,
      "Repeated idempotency key did not return the original job.",
    );

    const conflict = await launch(server, {
      idempotency,
      requestHash: digest(`${marker}:different-input-request`),
      fingerprint,
    });
    assert(
      !conflict.created &&
        conflict.reason === "idempotency_conflict" &&
        conflict.job_id === null,
      "Idempotency key reuse with a different workflow/input was not rejected.",
    );

    const { data: persisted, error: persistedError } = await server
      .from("hosted_agent_jobs")
      .select("workflow_type,input_text,input_preview,input_hash,request_hash,planner_snapshot,selected_services,structured_result,receipt_ids,proof_transaction_hashes")
      .eq("id", first.job_id)
      .single();
    assert(!persistedError && persisted, "Unable to read persisted Phase 21 workflow metadata.");
    assert(persisted.workflow_type === "sentiment_tone", "Workflow type was not persisted.");
    assert(persisted.input_text === null, "Full hosted input was persisted unexpectedly.");
    assert(
      persisted.input_preview === "This is a valid hosted workflow database test input." &&
        persisted.input_hash === digest("This is a valid hosted workflow database test input.") &&
        persisted.request_hash === requestHash,
      "Safe input metadata or request-bound idempotency hash was not persisted.",
    );
    assert(
      Array.isArray(persisted.selected_services) && persisted.selected_services.length === 2,
      "Selected service snapshot was not persisted.",
    );
    assert(
      Array.isArray(persisted.receipt_ids) && Array.isArray(persisted.proof_transaction_hashes),
      "Receipt/proof result arrays are not initialized.",
    );

    const blocked = await launch(server, {
      idempotency: digest(`${marker}:blocked`),
      requestHash: digest(`${marker}:blocked-request`),
      fingerprint: digest(`${marker}:other-requester`),
    });
    assert(!blocked.job_id && blocked.reason === "active_job", "Global one-active-job lock failed.");

    const { error: finishError } = await server
      .from("hosted_agent_jobs")
      .update({ status: "completed", progress_stage: "completed", completed_at: new Date().toISOString() })
      .eq("id", first.job_id);
    assert(!finishError, `Unable to complete test job: ${finishError?.message}`);

    const cooldown = await launch(server, {
      idempotency: digest(`${marker}:cooldown`),
      requestHash: digest(`${marker}:cooldown-request`),
      fingerprint,
    });
    assert(!cooldown.job_id && cooldown.reason === "cooldown", "Requester cooldown was not enforced.");

    const rateFingerprint = digest(`${marker}:rate-requester`);
    // Keep synthetic rows comfortably outside the 30-second cooldown while
    // still inside the rolling one-hour rate window. This avoids CI/database
    // clock skew turning the intended rate-limit assertion into a cooldown.
    const rateRows = [91, 92, 93].map((secondsAgo, index) => ({
      idempotency_hash: digest(`${marker}:rate:${index}`),
      requester_fingerprint: rateFingerprint,
      task: "Phase 20 hosted workflow rate-limit test",
      budget_usdc: 0.001,
      status: "completed",
      progress_stage: "completed",
      completed_at: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
      created_at: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
      raw: { phase20_test: marker },
    }));
    const { data: insertedRateRows, error: rateInsertError } = await server
      .from("hosted_agent_jobs")
      .insert(rateRows)
      .select("id");
    assert(!rateInsertError, `Unable to prepare rate-limit test: ${rateInsertError?.message}`);
    createdIds.push(...(insertedRateRows ?? []).map((row) => row.id as string));

    const rateLimited = await launch(server, {
      idempotency: digest(`${marker}:rate:blocked`),
      requestHash: digest(`${marker}:rate:blocked-request`),
      fingerprint: rateFingerprint,
    });
    assert(!rateLimited.job_id && rateLimited.reason === "rate_limited", "Rate limit was not enforced.");

    const { data: failedJob, error: failedInsertError } = await server
      .from("hosted_agent_jobs")
      .insert({
        idempotency_hash: digest(`${marker}:recovery`),
        requester_fingerprint: digest(`${marker}:recovery-requester`),
        task: "Phase 20 hosted workflow failed-job recovery test",
        budget_usdc: 0.001,
        status: "failed",
        progress_stage: "failed",
        error: "Synthetic pre-payment failure",
        raw: { phase20_test: marker },
      })
      .select("id")
      .single();
    assert(!failedInsertError && failedJob, `Unable to prepare recovery test: ${failedInsertError?.message}`);
    createdIds.push(failedJob.id as string);

    const { data: recovered, error: recoveryError } = await server.rpc(
      "requeue_failed_hosted_agent_job",
      { p_job_id: failedJob.id },
    );
    assert(!recoveryError && recovered === true, "Safe failed-job recovery did not requeue the job.");
    const { data: recoveredJob, error: recoveredReadError } = await server
      .from("hosted_agent_jobs")
      .select("status,progress_stage,recovery_count,error")
      .eq("id", failedJob.id)
      .single();
    assert(
      !recoveredReadError &&
        recoveredJob.status === "queued" &&
        recoveredJob.progress_stage === "queued" &&
        recoveredJob.recovery_count === 1 &&
        recoveredJob.error === null,
      "Recovered job metadata is incorrect.",
    );

    const { data: publicRows, error: publicReadError } = await publicClient
      .from("hosted_agent_jobs")
      .select("id")
      .eq("id", first.job_id);
    assert(!publicReadError && (publicRows ?? []).length === 0, "Hosted job table leaked through public RLS.");

    console.log(
      "[hosted-test] passed: privacy-safe workflow persistence, request-bound idempotency replay/conflict, one-active-wallet lock, cooldown, rate-limit, safe failed-job recovery, public RLS",
    );
  } finally {
    if (createdIds.length > 0) {
      const { error } = await server.from("hosted_agent_jobs").delete().in("id", createdIds);
      if (error) console.error("[hosted-test] warning: test job cleanup failed");
    }
  }
}

main().catch((error) => {
  console.error(
    `[hosted-test] failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
