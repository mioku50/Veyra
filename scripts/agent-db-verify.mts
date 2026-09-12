/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { rebuildAgentPassportForWallet } from "../lib/agent/passport-persistence.ts";
import { getPublicSupabaseConfig } from "../lib/supabase/env.ts";
import {
  getServerDatabaseDiagnostic,
  getServerSupabaseConfig,
} from "../lib/supabase/server-env.ts";

const wallet = "0x0000000000000000000000000000000000001711";

function hash(value: string) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const publicConfig = getPublicSupabaseConfig();
  const serverConfig = getServerSupabaseConfig();
  const diagnostic = getServerDatabaseDiagnostic();
  console.log(
    `[agent-db] provider=${diagnostic.provider} public=${diagnostic.publicClient.configured ? "configured" : "missing"} server=${diagnostic.serverClient.credential ?? "missing"}`,
  );

  const publicClient = createClient(publicConfig.url, publicConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const serverClient = createClient(serverConfig.url, serverConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const runId = randomUUID();
  const paymentEventId = randomUUID();
  const stepId = randomUUID();
  const unauthorizedRunId = randomUUID();
  const proofId = hash(`receipt:${paymentEventId}`);

  try {
    const { data: seededService, error: seededServiceError } = await publicClient
      .from("store_services")
      .select("id,slug,status,source_type")
      .eq("slug", "agent-db-demo-summarizer")
      .single();
    assert(!seededServiceError && seededService, "Public client cannot read the seeded demo service.");

    const { error: publicWriteError } = await publicClient.from("agent_runs").insert({
      id: unauthorizedRunId,
      task: "RLS write rejection probe",
      mode: "migration-verification",
      status: "completed",
      base_url: "http://localhost:3000",
      agent_wallet: wallet,
      budget_usdc: "0",
      spent_usdc: "0",
    });
    assert(publicWriteError, "Public client unexpectedly bypassed agent_runs write RLS.");

    const { error: runError } = await serverClient.from("agent_runs").insert({
      id: runId,
      task: "Phase 17.1 AGENT_DB verification",
      mode: "migration-verification",
      status: "completed",
      base_url: "http://localhost:3000",
      agent_wallet: wallet,
      budget_usdc: "0.001",
      spent_usdc: "0.001",
      summary: "Temporary migration verification run",
      raw: { agent_db_verification: true },
    });
    assert(!runError, `Server client could not create a run: ${runError?.message}`);

    const { error: paymentError } = await serverClient.from("payment_events").insert({
      id: paymentEventId,
      endpoint: "/api/premium/quote",
      payer: wallet,
      amount_usdc: "0.001",
      network: "eip155:5042002",
      gateway_tx: null,
      receipt_hash: proofId,
      service_hash: hash("service:/api/premium/quote"),
      request_hash: hash("request:agent-db-verification"),
      response_hash: hash("response:agent-db-verification"),
      onchain_buyer: wallet,
      onchain_seller: "0x0000000000000000000000000000000000001712",
      onchain_amount_atomic: "1000",
      onchain_contract_address: null,
      onchain_chain_id: 5_042_002,
      onchain_tx_hash: null,
      onchain_status: "pending",
      onchain_proof_id: proofId,
      onchain_attester: "0x0000000000000000000000000000000000001713",
      onchain_attempt_count: 0,
      raw: { agent_db_verification: true },
    });
    assert(!paymentError, `Server client could not create proof metadata: ${paymentError?.message}`);

    const { error: stepError } = await serverClient.from("agent_purchase_steps").insert({
      id: stepId,
      run_id: runId,
      step_index: 0,
      service_id: "premium-quote",
      service_slug: "premium-quote",
      service_name: "Premium Quote",
      service_source_type: "static",
      endpoint: "/api/premium/quote",
      method: "GET",
      price_usdc: "0.001",
      status: "paid",
      reasoning: "Temporary AGENT_DB receipt verification",
      request_id: `agent-db-${runId}`,
      payment_event_id: paymentEventId,
      response_preview: { quote: "AGENT_DB verification" },
      raw: { agent_db_verification: true },
    });
    assert(!stepError, `Server client could not create a paid purchase step: ${stepError?.message}`);

    const passport = await rebuildAgentPassportForWallet(wallet);
    assert(passport && passport.profile.total_runs >= 1, "Agent Passport rebuild failed.");

    const [runRead, stepRead, paymentRead, passportRead] = await Promise.all([
      publicClient.from("agent_runs").select("id,status").eq("id", runId).single(),
      publicClient
        .from("agent_purchase_steps")
        .select("id,status,payment_event_id")
        .eq("id", stepId)
        .single(),
      publicClient
        .from("payment_events")
        .select("id,receipt_hash,onchain_chain_id,onchain_status,onchain_proof_id,onchain_attester,onchain_amount_atomic")
        .eq("id", paymentEventId)
        .single(),
      publicClient.from("agent_profiles").select("wallet,total_runs").eq("wallet", wallet).single(),
    ]);

    assert(!runRead.error && runRead.data.status === "completed", "Public run read failed.");
    assert(
      !stepRead.error &&
        stepRead.data.status === "paid" &&
        stepRead.data.payment_event_id === paymentEventId,
      "Public receipt/purchase-step read failed.",
    );
    assert(
      !paymentRead.error &&
        paymentRead.data.onchain_status === "pending" &&
        paymentRead.data.onchain_chain_id === 5_042_002 &&
        paymentRead.data.onchain_proof_id === proofId &&
        paymentRead.data.onchain_amount_atomic === "1000",
      "Public onchain proof metadata read failed.",
    );
    assert(!passportRead.error && passportRead.data.total_runs >= 1, "Public Agent Passport read failed.");

    console.log(
      "[agent-db] verification passed: public-read, public-write-RLS, server-write, run, receipt, passport, proof-metadata, seeded-service",
    );
  } finally {
    await serverClient.from("agent_reputation_events").delete().eq("wallet", wallet);
    await serverClient.from("agent_profiles").delete().eq("wallet", wallet);
    await serverClient.from("agent_runs").delete().in("id", [runId, unauthorizedRunId]);
    await serverClient.from("payment_events").delete().eq("id", paymentEventId);
  }
}

main().catch((error) => {
  console.error(
    `[agent-db] verification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
