/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAddress } from "viem";
import { getPublicSupabaseConfig } from "../lib/supabase/env.ts";
import {
  getServerDatabaseDiagnostic,
  getServerSupabaseConfig,
} from "../lib/supabase/server-env.ts";

type CheckoutLaunch = {
  job_id: string | null;
  user_payment_id: string | null;
  created: boolean;
  reason: string;
  retry_after_seconds: number;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testAddress(marker: string, suffix: string) {
  return getAddress(`0x${digest(`${marker}:${suffix}`).slice(0, 40)}`);
}

function plannerSnapshot(inputText: string) {
  return {
    version: 3,
    workflowType: "sentiment_tone",
    workflowLabel: "Sentiment & Tone Report",
    effectiveTask: "Analyze this checkout database test input.",
    selectedServices: [
      { slug: "premium-quote", name: "Premium Quote", endpoint: "/api/premium/quote", method: "GET", priceUsdc: 0.001, reasoning: "Checkout DB test", presentation: { providerType: "internal_deterministic", providerName: "Veyra", providerStatus: "deterministic", assetSymbol: null, dataFreshness: null, billingLabel: "Internal deterministic" } },
      { slug: "text-analyzer", name: "Text Analyzer", endpoint: "/api/services/text-analyzer", method: "POST", priceUsdc: 0.0003, reasoning: "Checkout DB test", presentation: { providerType: "internal_deterministic", providerName: "Veyra", providerStatus: "deterministic", assetSymbol: null, dataFreshness: null, billingLabel: "Internal deterministic" } },
    ],
    skippedServices: [],
    estimatedSpendUsdc: 0.0013,
    remainingBudgetUsdc: 0.0037,
    maxPaidCalls: 3,
    budgetCapUsdc: 0.005,
    aggregationMode: "deterministic_execution_optional_llm",
    aggregationLabel: "Deterministic paid execution with optional StepFun synthesis",
    inputPreview: inputText,
    inputSha256: digest(inputText),
    marketSymbol: null,
    warnings: [],
  };
}

async function insertQuote(
  client: SupabaseClient,
  input: {
    marker: string;
    name: string;
    wallet: string;
    treasury: string;
    paymentMode: "sponsored" | "paid";
    expiresAt?: string;
  },
) {
  const sourceInput = `Phase 26 ${input.name} checkout database test input.`;
  const idempotencyHash = digest(`${input.marker}:${input.name}:idempotency`);
  const requestHash = digest(`${input.marker}:${input.name}:request`);
  const snapshot = plannerSnapshot(sourceInput);
  const { data, error } = await client
    .from("hosted_workflow_quotes")
    .insert({
      idempotency_hash: idempotencyHash,
      request_hash: requestHash,
      requester_fingerprint: digest(`${input.marker}:${input.name}:fingerprint`),
      requester_wallet: input.wallet,
      workflow_type: "sentiment_tone",
      task: "Phase 26 hosted checkout database test",
      input_preview: sourceInput,
      input_hash: digest(sourceInput),
      budget_usdc: 0.005,
      planner_snapshot: snapshot,
      selected_services: snapshot.selectedServices,
      estimated_provider_cost_usdc: 0.0013,
      platform_fee_usdc: 0.0007,
      list_price_usdc: 0.002,
      payment_mode: input.paymentMode,
      amount_due_usdc: input.paymentMode === "paid" ? 0.002 : 0,
      treasury_address: input.treasury,
      chain_id: 5_042_002,
      asset: "native_usdc",
      expires_at: input.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  assert(!error && data, `Unable to insert ${input.name} quote: ${error?.message}`);
  return { id: data.id as string, idempotencyHash, requestHash };
}

async function insertGitHubQuote(
  client: SupabaseClient,
  input: {
    marker: string;
    name: string;
    wallet: string;
    treasury: string;
    paymentMode: "sponsored" | "paid";
  },
) {
  const sourceInput = "https://github.com/mioku50/magda-agent";
  const idempotencyHash = digest(`${input.marker}:${input.name}:github:idempotency`);
  const requestHash = digest(`${input.marker}:${input.name}:github:request`);
  const snapshot = {
    version: 4,
    workflowType: "github_due_diligence",
    workflowLabel: "GitHub Project Due Diligence",
    effectiveTask: "Analyze mioku50/magda-agent using live GitHub repository intelligence.",
    selectedServices: [
      {
        slug: "github-repository-intelligence",
        name: "GitHub Repository Intelligence",
        endpoint: "/api/provider/github/repository-intelligence",
        method: "POST",
        priceUsdc: 0.0015,
        reasoning: "Collect live public GitHub data.",
        presentation: {
          providerType: "live_provider",
          providerName: "GitHub API",
          providerStatus: "live",
          assetSymbol: null,
          dataFreshness: "5-minute cache",
          billingLabel: "GitHub repository intelligence",
        },
      },
      {
        slug: "github-due-diligence-analysis",
        name: "GitHub Due Diligence Analysis",
        endpoint: "/api/premium/github/due-diligence",
        method: "POST",
        priceUsdc: 0.0005,
        reasoning: "Apply deterministic repository analysis.",
        presentation: {
          providerType: "internal_deterministic",
          providerName: null,
          providerStatus: "deterministic",
          assetSymbol: null,
          dataFreshness: null,
          billingLabel: "Deterministic analysis",
        },
      },
    ],
    skippedServices: [],
    estimatedSpendUsdc: 0.002,
    remainingBudgetUsdc: 0.003,
    maxPaidCalls: 3,
    budgetCapUsdc: 0.005,
    aggregationMode: "deterministic_execution_optional_llm",
    aggregationLabel: "Deterministic execution with optional AI synthesis",
    inputPreview: sourceInput,
    inputSha256: digest(sourceInput),
    marketSymbol: null,
    repository: {
      owner: "mioku50",
      name: "magda-agent",
      fullName: "mioku50/magda-agent",
      canonicalUrl: sourceInput,
    },
    warnings: [],
  };

  const { data, error } = await client
    .from("hosted_workflow_quotes")
    .insert({
      idempotency_hash: idempotencyHash,
      request_hash: requestHash,
      requester_fingerprint: digest(`${input.marker}:${input.name}:github:fingerprint`),
      requester_wallet: input.wallet,
      workflow_type: "github_due_diligence",
      task: "Analyze the selected public GitHub repository using live repository data and deterministic due diligence rules.",
      input_preview: sourceInput,
      input_hash: digest(sourceInput),
      budget_usdc: 0.005,
      planner_snapshot: snapshot,
      selected_services: snapshot.selectedServices,
      estimated_provider_cost_usdc: 0.002,
      platform_fee_usdc: 0,
      list_price_usdc: 0.002,
      payment_mode: input.paymentMode,
      amount_due_usdc: input.paymentMode === "paid" ? 0.002 : 0,
      treasury_address: input.treasury,
      chain_id: 5_042_002,
      asset: "native_usdc",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    .select("id")
    .single();

  assert(!error && data, `Unable to insert GitHub quote: ${error?.message}`);
  return { id: data.id as string, idempotencyHash, requestHash };
}

async function launch(
  client: SupabaseClient,
  quote: { id: string; idempotencyHash: string; requestHash: string },
  paymentMode: "sponsored" | "paid",
  transactionHash: string | null,
) {
  const { data, error } = await client.rpc("launch_hosted_workflow_checkout_v1", {
    p_quote_id: quote.id,
    p_idempotency_hash: quote.idempotencyHash,
    p_request_hash: quote.requestHash,
    p_payment_mode: paymentMode,
    p_transaction_hash: transactionHash,
    p_block_number: transactionHash ? 123456 : null,
    p_settled_at: transactionHash ? new Date().toISOString() : null,
    p_sponsored_quota: 1,
  });
  if (error) throw new Error(`Checkout launch RPC failed: ${error.message}`);
  const row = (data as CheckoutLaunch[] | null)?.[0];
  assert(row, "Checkout launch RPC returned no row.");
  return row;
}

async function main() {
  const marker = randomUUID();
  const serverConfig = getServerSupabaseConfig();
  const publicConfig = getPublicSupabaseConfig();
  const diagnostic = getServerDatabaseDiagnostic();
  console.log(
    `[hosted-checkout-db-test] provider=${diagnostic.provider} public=${diagnostic.publicClient.configured ? "configured" : "missing"} server=${diagnostic.serverClient.credential ?? "missing"}`,
  );
  const server = createClient(serverConfig.url, serverConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const publicClient = createClient(publicConfig.url, publicConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const wallet = testAddress(marker, "wallet");
  const treasury = testAddress(marker, "treasury");
  const jobIds: string[] = [];
  const quoteIds: string[] = [];
  const paymentIds: string[] = [];

  const { data: active, error: activeError } = await server
    .from("hosted_agent_jobs")
    .select("id")
    .in("status", ["queued", "running"])
    .limit(1);
  assert(!activeError, `Unable to check active jobs: ${activeError?.message}`);
  assert((active ?? []).length === 0, "A real hosted workflow is active; retry after it completes.");

  try {
    const sponsoredQuote = await insertQuote(server, {
      marker,
      name: "sponsored",
      wallet,
      treasury,
      paymentMode: "sponsored",
    });
    quoteIds.push(sponsoredQuote.id);
    const sponsored = await launch(server, sponsoredQuote, "sponsored", null);
    assert(sponsored.created && sponsored.reason === "created", "Sponsored checkout did not create a job.");
    assert(sponsored.job_id && sponsored.user_payment_id, "Sponsored checkout artifacts are missing.");
    jobIds.push(sponsored.job_id);
    paymentIds.push(sponsored.user_payment_id);

    const replay = await launch(server, sponsoredQuote, "sponsored", null);
    assert(
      !replay.created && replay.reason === "idempotent" && replay.job_id === sponsored.job_id && replay.user_payment_id === sponsored.user_payment_id,
      "Sponsored checkout replay created duplicate artifacts.",
    );
    const { data: sponsoredRows, error: sponsoredRowsError } = await server
      .from("hosted_workflow_user_payments")
      .select("id,payment_mode,gross_amount_usdc,transaction_hash")
      .eq("quote_id", sponsoredQuote.id);
    assert(!sponsoredRowsError && sponsoredRows?.length === 1, "Sponsored quote did not have exactly one user payment.");
    assert(
      sponsoredRows[0].payment_mode === "sponsored" && Number(sponsoredRows[0].gross_amount_usdc) === 0 && sponsoredRows[0].transaction_hash === null,
      "Sponsored payment accounting is incorrect.",
    );

    const { error: sponsoredFinishError } = await server
      .from("hosted_agent_jobs")
      .update({ status: "completed", progress_stage: "completed", spent_usdc: 0.0013, completed_at: new Date().toISOString() })
      .eq("id", sponsored.job_id);
    assert(!sponsoredFinishError, `Unable to complete sponsored test job: ${sponsoredFinishError?.message}`);
    const { data: sponsoredFinalized, error: sponsoredFinalizeError } = await server.rpc(
      "finalize_hosted_workflow_user_payment_v1",
      { p_job_id: sponsored.job_id, p_provider_cost_usdc: 0.0013, p_succeeded: true, p_failure_reason: null },
    );
    assert(!sponsoredFinalizeError && sponsoredFinalized === true, "Sponsored accounting finalization failed.");

    const quotaQuote = await insertQuote(server, {
      marker,
      name: "sponsored-quota",
      wallet,
      treasury,
      paymentMode: "sponsored",
    });
    quoteIds.push(quotaQuote.id);
    const quota = await launch(server, quotaQuote, "sponsored", null);
    assert(!quota.job_id && quota.reason === "sponsored_quota_exhausted", "Sponsored quota did not stop a second free run.");

    const paidQuote = await insertQuote(server, {
      marker,
      name: "paid",
      wallet,
      treasury,
      paymentMode: "paid",
    });
    quoteIds.push(paidQuote.id);
    const paidTx = `0x${digest(`${marker}:paid-transaction`)}`;
    const paid = await launch(server, paidQuote, "paid", paidTx);
    assert(paid.created && paid.job_id && paid.user_payment_id, "Paid checkout did not create one job and payment.");
    jobIds.push(paid.job_id);
    paymentIds.push(paid.user_payment_id);
    const paidReplay = await launch(server, paidQuote, "paid", paidTx);
    assert(!paidReplay.created && paidReplay.job_id === paid.job_id, "Paid idempotency replay created a second job.");

    const { error: paidFinishError } = await server
      .from("hosted_agent_jobs")
      .update({ status: "completed", progress_stage: "completed", spent_usdc: 0.0013, completed_at: new Date().toISOString() })
      .eq("id", paid.job_id);
    assert(!paidFinishError, `Unable to complete paid test job: ${paidFinishError?.message}`);
    const { data: paidFinalized, error: paidFinalizeError } = await server.rpc(
      "finalize_hosted_workflow_user_payment_v1",
      { p_job_id: paid.job_id, p_provider_cost_usdc: 0.0013, p_succeeded: true, p_failure_reason: null },
    );
    assert(!paidFinalizeError && paidFinalized === true, "Paid accounting finalization failed.");
    const { data: paidPayment, error: paidReadError } = await server
      .from("hosted_workflow_user_payments")
      .select("gross_amount_usdc,provider_cost_usdc,platform_fee_usdc,net_revenue_usdc,credit_amount_usdc,transaction_hash")
      .eq("id", paid.user_payment_id)
      .single();
    assert(!paidReadError && paidPayment, "Unable to read finalized paid accounting.");
    assert(
      Number(paidPayment.gross_amount_usdc) === 0.002 &&
        Number(paidPayment.provider_cost_usdc) === 0.0013 &&
        Number(paidPayment.platform_fee_usdc) === 0.0007 &&
        Number(paidPayment.net_revenue_usdc) === 0.0007 &&
        Number(paidPayment.credit_amount_usdc) === 0 &&
        paidPayment.transaction_hash === paidTx,
      "Paid gross/provider/fee/revenue accounting is incorrect.",
    );
    const { data: terminalFinalize, error: terminalFinalizeError } = await server.rpc(
      "finalize_hosted_workflow_user_payment_v1",
      { p_job_id: paid.job_id, p_provider_cost_usdc: 0, p_succeeded: false, p_failure_reason: "Synthetic replay must not issue credit." },
    );
    assert(!terminalFinalizeError && terminalFinalize === true, "Terminal accounting replay failed.");
    const { data: terminalPayment } = await server
      .from("hosted_workflow_user_payments")
      .select("net_revenue_usdc,credit_amount_usdc,failure_reason")
      .eq("id", paid.user_payment_id)
      .single();
    assert(
      Number(terminalPayment?.net_revenue_usdc) === 0.0007 && Number(terminalPayment?.credit_amount_usdc) === 0 && terminalPayment?.failure_reason === null,
      "Terminal accounting replay mutated a completed payment.",
    );

    const { data: blocker, error: blockerError } = await server
      .from("hosted_agent_jobs")
      .insert({
        idempotency_hash: digest(`${marker}:blocker:idempotency`),
        request_hash: digest(`${marker}:blocker:request`),
        requester_fingerprint: digest(`${marker}:blocker:fingerprint`),
        task: "Phase 26 active checkout blocker test",
        budget_usdc: 0.001,
        status: "queued",
        progress_stage: "queued",
        raw: { phase26_test: marker },
      })
      .select("id")
      .single();
    assert(!blockerError && blocker, `Unable to create active blocker: ${blockerError?.message}`);
    jobIds.push(blocker.id as string);

    const creditedQuote = await insertQuote(server, {
      marker,
      name: "credited",
      wallet: testAddress(marker, "credited-wallet"),
      treasury,
      paymentMode: "paid",
    });
    quoteIds.push(creditedQuote.id);
    const creditedTx = `0x${digest(`${marker}:credited-transaction`)}`;
    const credited = await launch(server, creditedQuote, "paid", creditedTx);
    assert(!credited.job_id && credited.user_payment_id && credited.reason === "credit_issued", "Settled payment was not credited when the job could not start.");
    paymentIds.push(credited.user_payment_id);
    const { data: creditRows, error: creditError } = await server
      .from("hosted_workflow_credits")
      .select("amount_usdc,status")
      .eq("user_payment_id", credited.user_payment_id);
    assert(!creditError && creditRows?.length === 1 && Number(creditRows[0].amount_usdc) === 0.002 && creditRows[0].status === "issued", "Workflow credit was not issued exactly once.");
    const creditedReplay = await launch(server, creditedQuote, "paid", creditedTx);
    assert(!creditedReplay.created && creditedReplay.reason === "credit_issued" && creditedReplay.user_payment_id === credited.user_payment_id, "Credited settlement replay created a duplicate payment or credit.");

    const { data: publicPayments, error: publicPaymentError } = await publicClient
      .from("hosted_workflow_user_payments")
      .select("id")
      .in("id", paymentIds);
    assert(!publicPaymentError && (publicPayments ?? []).length === 0, "User payments leaked through public RLS.");
    const githubQuote = await insertGitHubQuote(server, {
      marker,
      name: "github",
      wallet: testAddress(marker, "github-wallet"),
      treasury,
      paymentMode: "sponsored",
    });
    quoteIds.push(githubQuote.id);

    console.log(
      "[hosted-checkout-db-test] passed: sponsored quota, github_due_diligence quote constraint, one quote/payment/job, paid accounting, terminal replay, credit-on-no-start, transaction idempotency, and public RLS",
    );
  } finally {
    if (jobIds.length) await server.from("hosted_agent_jobs").delete().in("id", jobIds);
    if (paymentIds.length) await server.from("hosted_workflow_credits").delete().in("user_payment_id", paymentIds);
    if (paymentIds.length) await server.from("hosted_workflow_user_payments").delete().in("id", paymentIds);
    if (quoteIds.length) await server.from("hosted_workflow_quotes").delete().in("id", quoteIds);
  }
}

main().catch((error) => {
  console.error(
    `[hosted-checkout-db-test] failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
