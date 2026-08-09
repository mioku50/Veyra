/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { after, NextRequest, NextResponse } from "next/server.js";
import { BRAND } from "../../../../../lib/brand.ts";
import {
  authenticateMachineRequest,
  enforceRunCreationPolicy,
} from "../../../../../lib/api/machine-auth.ts";
import {
  createMachineErrorResponse,
  handleMachineInternalError,
} from "../../../../../lib/api/machine-errors.ts";
import {
  inspectMachineIdempotency,
  releaseMachineIdempotency,
  resolveMachineIdempotency,
  saveMachineIdempotency,
} from "../../../../../lib/api/machine-idempotency.ts";
import {
  confirmHostedWorkflowQuoteInput,
  confirmHostedWorkflowQuote,
  getHostedWorkflowQuote,
  type HostedWorkflowQuoteRow,
} from "../../../../../lib/commerce/workflow-checkout.ts";
import { getHostedWorkflowCheckoutConfig } from "../../../../../lib/agent/workflow-pricing.ts";
import { getByoaClient } from "../../../../../lib/byoa/service.ts";
import { runHostedAgentJob } from "../../../../../lib/agent/hosted-jobs.ts";
import {
  getHostedRunnerConfig,
  hostedIdempotencyHash,
  hostedIdempotencyRequestHash,
} from "../../../../../lib/agent/hosted-policy.ts";
import {
  hashHostedWorkflowInput,
  validateHostedWorkflowRequest,
} from "../../../../../lib/agent/hosted-workflows.ts";
import type { MachineAuthContext } from "../../../../../lib/api/machine-auth.ts";
import {
  canonicalSellerInput,
  getSellerServiceRowById,
  isSellerWorkflowType,
} from "../../../../../lib/seller/marketplace.ts";
import {
  runSellerAgentJob,
  sellerQuoteRequestHash,
  sellerWorkflowAllowed,
} from "../../../../../lib/seller/workflow.ts";
import {
  bindMachineTrustMonitoringJob,
  executeTrustMonitoringJob,
} from "../../../../../lib/monitoring/service.ts";
import { validatePublicServiceForQualityEvaluation } from "../../../../../lib/providers/api-quality.ts";
import { parseApiQualityJobInput } from "../../../../../lib/reports/api-quality-report.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function launchMachineSellerRun(input: {
  context: MachineAuthContext;
  idempotencyKey: string;
  body: Record<string, unknown>;
  quote: HostedWorkflowQuoteRow;
  paymentAuthorization?: { type?: string; payload?: string };
}) {
  if (
    !isSellerWorkflowType(input.quote.workflow_type) ||
    !sellerWorkflowAllowed(input.context.allowedWorkflows, input.quote.workflow_type) ||
    !input.context.spendingPolicy.allowed_service_types.includes("external_seller") ||
    !input.quote.seller_service_id || !input.quote.seller_service_version
  ) {
    return createMachineErrorResponse("quote_not_found", "The specified workflow quote could not be found.", 404);
  }
  if (!input.body.input || typeof input.body.input !== "object" || Array.isArray(input.body.input)) {
    return createMachineErrorResponse("quote_not_found", "The specified workflow quote could not be found.", 404);
  }
  const service = await getSellerServiceRowById(input.quote.seller_service_id);
  if (!service || service.seller_id !== input.quote.seller_id) {
    return createMachineErrorResponse("quote_not_found", "The specified workflow quote could not be found.", 404);
  }
  const inputText = canonicalSellerInput(input.body.input);
  const expectedRequestHash = sellerQuoteRequestHash({
    workflowType: input.quote.workflow_type,
    payload: input.body.input,
    serviceId: service.id,
    serviceVersion: input.quote.seller_service_version,
    priceUsdc: input.quote.estimated_provider_cost_usdc,
  });
  if (expectedRequestHash !== input.quote.request_hash) {
    return createMachineErrorResponse("quote_not_found", "The specified workflow quote could not be found.", 404);
  }

  const reservation = await resolveMachineIdempotency(
    input.idempotencyKey,
    input.context.credential.id,
    input.body,
    "/api/agent/v1/runs",
    input.context.agentId,
  );
  if (reservation.unavailable) {
    return createMachineErrorResponse("idempotency_store_unavailable", "The request cannot be safely processed right now.", 503, true);
  }
  if (reservation.conflict) {
    return createMachineErrorResponse("idempotency_conflict", "This Idempotency-Key is already bound to a different run request.", 409);
  }
  if (reservation.pending) {
    return createMachineErrorResponse("idempotency_in_progress", "A request with this Idempotency-Key is already being processed.", 409, true);
  }
  if (reservation.cachedResponse?.body) {
    return NextResponse.json(reservation.cachedResponse.body, {
      status: reservation.cachedResponse.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let reservationToken = reservation.reservationToken;
  try {
    let jobId: string | null = null;
    if (input.quote.payment_mode === "sponsored") {
      const checkoutConfig = getHostedWorkflowCheckoutConfig();
      const { data, error } = await getByoaClient().rpc(
        "launch_hosted_workflow_checkout_v1",
        {
          p_quote_id: input.quote.id,
          p_idempotency_hash: input.quote.idempotency_hash,
          p_request_hash: input.quote.request_hash,
          p_payment_mode: "sponsored",
          p_transaction_hash: null,
          p_block_number: null,
          p_settled_at: null,
          p_sponsored_quota: checkoutConfig.sponsoredQuota,
        },
      );
      if (error) {
        throw new Error("Failed to launch sponsored seller workflow checkout.");
      }
      const row = (
        data as Array<{ job_id: string | null; reason: string }> | null
      )?.[0];
      if (!row?.job_id) {
        return createMachineErrorResponse(
          row?.reason === "sponsored_quota_exhausted"
            ? "spending_limit_exceeded"
            : "internal_error",
          "Sponsored seller workflow checkout could not be finalized.",
          row?.reason === "sponsored_quota_exhausted" ? 429 : 500,
        );
      }
      jobId = row.job_id;
    } else {
      const result = await confirmHostedWorkflowQuoteInput({
        quoteId: input.quote.id,
        idempotencyHash: input.quote.idempotency_hash,
        requestHash: input.quote.request_hash,
        inputText,
        transactionHash: input.paymentAuthorization?.payload?.trim() ?? null,
      });
      if (!result.jobId) {
        return createMachineErrorResponse(
          "payment_invalid",
          `Paid seller workflow checkout failed: ${result.reason}`,
          400,
        );
      }
      jobId = result.jobId;
    }

    const ownershipUpdate = await getByoaClient()
      .from("hosted_agent_jobs")
      .update({
        byoa_agent_id: input.context.agentId,
        machine_credential_id: input.context.credential.id,
      })
      .eq("id", jobId);
    if (ownershipUpdate.error) {
      throw new Error(
        `Unable to persist ${BRAND.agentApi} job credential ownership.`,
      );
    }

    const responsePayload = {
      runId: jobId,
      status: "queued",
      pollAfterMs: 2000,
    };
    await saveMachineIdempotency(
      input.idempotencyKey,
      input.context.credential.id,
      input.body,
      responsePayload,
      {
        agentId: input.context.agentId,
        route: "/api/agent/v1/runs",
        responseStatus: 201,
        resourceType: "run",
        resourceId: jobId,
        reservationToken,
      },
    );
    reservationToken = undefined;
    try {
      after(async () => {
        try {
          await runSellerAgentJob(jobId!, input.body.input);
        } catch (error) {
          console.error(
            `[runs/route] Async seller execution failed for job=${jobId}:`,
            error,
          );
        }
      });
    } catch {
      runSellerAgentJob(jobId, input.body.input).catch((error) => {
        console.error(
          `[runs/route] Async seller execution fallback failed for job=${jobId}:`,
          error,
        );
      });
    }
    return NextResponse.json(responsePayload, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    if (reservationToken) {
      await releaseMachineIdempotency(
        input.idempotencyKey,
        input.context.credential.id,
        input.body,
        "/api/agent/v1/runs",
        reservationToken,
      );
    }
  }
}

export async function POST(request: NextRequest) {
  const authResult = await authenticateMachineRequest(request, "runs:create");
  if (!authResult.ok) {
    return authResult.response;
  }
  const { context } = authResult;

  const idempotencyKey =
    request.headers.get("idempotency-key") ||
    request.headers.get("Idempotency-Key");

  if (!idempotencyKey || !idempotencyKey.trim()) {
    return createMachineErrorResponse(
      "idempotency_key_missing",
      "Missing required Idempotency-Key header.",
      400,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return createMachineErrorResponse(
      "invalid_repository",
      "Invalid JSON request body.",
      400,
    );
  }

  const quoteId = body.quoteId;
  if (!quoteId || typeof quoteId !== "string" || !quoteId.trim()) {
    return createMachineErrorResponse(
      "quote_not_found",
      "The specified workflow quote could not be found.",
      404,
    );
  }

  // Check replay state without reserving requests that may still fail quote or
  // payment validation.
  const idempotencyCheck = await inspectMachineIdempotency(
    idempotencyKey,
    context.credential.id,
    body,
    "/api/agent/v1/runs",
    context.agentId,
  );

  if (idempotencyCheck.unavailable) {
    return createMachineErrorResponse(
      "idempotency_store_unavailable",
      "The request cannot be safely processed right now.",
      503,
      true,
    );
  }

  if (idempotencyCheck.conflict) {
    return createMachineErrorResponse(
      "idempotency_conflict",
      "This Idempotency-Key is already bound to a different run request.",
      409,
    );
  }

  if (idempotencyCheck.pending) {
    return createMachineErrorResponse(
      "idempotency_in_progress",
      "A request with this Idempotency-Key is already being processed.",
      409,
      true,
    );
  }

  if (idempotencyCheck.cachedResponse?.body) {
    return NextResponse.json(idempotencyCheck.cachedResponse.body, {
      status: idempotencyCheck.cachedResponse.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const policyResult = await enforceRunCreationPolicy(context);
  if (!policyResult.ok) {
    return policyResult.response;
  }

  // Fetch Quote
  const storedQuote = await getHostedWorkflowQuote(quoteId);
  if (!storedQuote) {
    return createMachineErrorResponse(
      "quote_not_found",
      "The specified workflow quote could not be found.",
      404,
    );
  }

  // Strict Quote Ownership Verification
  const quoteAgentId = storedQuote.byoa_agent_id || (storedQuote.planner_snapshot as any)?.metadata?.byoa_agent_id;
  const quoteCredentialId = storedQuote.machine_credential_id || (storedQuote.planner_snapshot as any)?.metadata?.machine_credential_id;
  const monitoringRecheckId =
    typeof (storedQuote.planner_snapshot as any)?.metadata?.monitoringRecheckId === "string"
      ? (storedQuote.planner_snapshot as any).metadata.monitoringRecheckId
      : null;

  if (
    quoteAgentId !== context.agentId ||
    quoteCredentialId !== context.credential.id
  ) {
    return createMachineErrorResponse(
      "quote_not_found",
      "The specified workflow quote could not be found.",
      404,
    );
  }

  // Check Expiration
  if (
    Date.parse(storedQuote.expires_at) <= Date.now() ||
    storedQuote.status === "expired"
  ) {
    return createMachineErrorResponse(
      "quote_expired",
      "The quote has expired. Please request a new quote.",
      404,
    );
  }

  // Check Quote Reuse
  if (
    storedQuote.status === "consumed" ||
    storedQuote.status === "completed" ||
    storedQuote.job_id != null
  ) {
    return createMachineErrorResponse(
      "quote_already_used",
      "This quote has already been executed.",
      409,
    );
  }

  if (storedQuote.workflow_type === "paid_api_quality") {
    const { targetServices } = parseApiQualityJobInput(
      storedQuote.input_preview,
      storedQuote.planner_snapshot,
    );
    for (const serviceId of targetServices) {
      const validService = await validatePublicServiceForQualityEvaluation(serviceId);
      if (!validService) {
        return createMachineErrorResponse(
          "api_quality_service_not_found",
          "The requested service could not be found or evaluated.",
          404,
        );
      }
    }
  }

  const paymentAuth = body.paymentAuthorization as
    | { type?: string; payload?: string }
    | undefined;

  // Validate Payment Authorization for Paid Mode
  if (storedQuote.payment_mode === "paid") {
    if (!paymentAuth || typeof paymentAuth !== "object") {
      return createMachineErrorResponse(
        "payment_required",
        "Payment authorization is required for paid quotes.",
        402,
      );
    }

    if (
      !paymentAuth.type ||
      !paymentAuth.payload ||
      typeof paymentAuth.payload !== "string"
    ) {
      return createMachineErrorResponse(
        "payment_invalid",
        "Invalid payment authorization type or payload.",
        400,
      );
    }

    const validTypes = ["arc_transaction", "transaction", "arc"];
    if (!validTypes.includes(paymentAuth.type)) {
      return createMachineErrorResponse(
        "payment_invalid",
        `Unsupported payment authorization type '${paymentAuth.type}'.`,
        400,
      );
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentAuth.payload.trim())) {
      return createMachineErrorResponse(
        "payment_invalid",
        "Invalid payment transaction hash format.",
        400,
      );
    }
  }

  if (isSellerWorkflowType(storedQuote.workflow_type)) {
    try {
      return await launchMachineSellerRun({
        context,
        idempotencyKey,
        body,
        quote: storedQuote,
        paymentAuthorization: paymentAuth,
      });
    } catch (error) {
      return handleMachineInternalError(error, "/api/agent/v1/runs", context.agentId);
    }
  }

  // Prepare workflow request reconstruction from stored quote
  const serverEnforcedBody = {
    workflowType: storedQuote.workflow_type,
    inputText:
      storedQuote.workflow_type === "project_360"
        ? JSON.stringify(
            storedQuote.planner_snapshot?.metadata?.project360Input ?? {},
          )
        : storedQuote.workflow_type === "agent_trust_report"
        ? JSON.stringify(
            storedQuote.planner_snapshot?.metadata?.agentTrustInput ?? {},
          )
        : storedQuote.planner_snapshot?.repository?.canonicalUrl ||
          storedQuote.input_preview,
    repositoryUrl: storedQuote.planner_snapshot?.repository?.canonicalUrl,
    agentTrustInput:
      storedQuote.workflow_type === "agent_trust_report"
        ? storedQuote.planner_snapshot?.metadata?.agentTrustInput
        : undefined,
    project360Input:
      storedQuote.workflow_type === "project_360"
        ? storedQuote.planner_snapshot?.metadata?.project360Input
        : undefined,
    marketSymbol: storedQuote.planner_snapshot?.marketSymbol,
    task: storedQuote.task,
    budgetUsdc: storedQuote.budget_usdc,
  };

  let workflowRequest;
  try {
    workflowRequest = validateHostedWorkflowRequest(serverEnforcedBody);
  } catch (err) {
    return createMachineErrorResponse(
      "internal_error",
      err instanceof Error ? err.message : "Failed to reconstruct workflow request.",
      500,
    );
  }

  const runnerConfig = getHostedRunnerConfig();
  const inputSha256 = hashHostedWorkflowInput(workflowRequest.inputText);
  const idempotencyHash = storedQuote.workflow_type === "project_360"
    ? storedQuote.idempotency_hash
    : hostedIdempotencyHash(runnerConfig.rateLimitSecret, idempotencyKey);
  const requestHash = storedQuote.workflow_type === "project_360"
    ? storedQuote.request_hash
    : hostedIdempotencyRequestHash({
        secret: runnerConfig.rateLimitSecret,
        workflowType: workflowRequest.workflowType,
        inputSha256,
        task: workflowRequest.task,
        marketSymbol: workflowRequest.marketSymbol,
        repository: workflowRequest.repository,
        budgetUsdc: workflowRequest.budgetUsdc,
      });

  // Atomically reserve immediately before checkout mutates quote/job state.
  const reservation = await resolveMachineIdempotency(
    idempotencyKey,
    context.credential.id,
    body,
    "/api/agent/v1/runs",
    context.agentId,
  );
  if (reservation.unavailable) {
    return createMachineErrorResponse(
      "idempotency_store_unavailable",
      "The request cannot be safely processed right now.",
      503,
      true,
    );
  }
  if (reservation.conflict) {
    return createMachineErrorResponse(
      "idempotency_conflict",
      "This Idempotency-Key is already bound to a different run request.",
      409,
    );
  }
  if (reservation.pending) {
    return createMachineErrorResponse(
      "idempotency_in_progress",
      "A request with this Idempotency-Key is already being processed.",
      409,
      true,
    );
  }
  if (reservation.cachedResponse?.body) {
    return NextResponse.json(reservation.cachedResponse.body, {
      status: reservation.cachedResponse.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let jobId: string | null = null;
  let reservationToken = reservation.reservationToken;

  try {
    if (storedQuote.payment_mode === "sponsored") {
      const checkoutConfig = getHostedWorkflowCheckoutConfig();
      const client = getByoaClient();
      const { data, error } = await client.rpc(
        "launch_hosted_workflow_checkout_v1",
        {
          p_quote_id: storedQuote.id,
          p_idempotency_hash: idempotencyHash,
          p_request_hash: requestHash,
          p_payment_mode: "sponsored",
          p_transaction_hash: null,
          p_block_number: null,
          p_settled_at: null,
          p_sponsored_quota: checkoutConfig.sponsoredQuota,
        },
      );

      if (error) {
        console.error("[runs/route] Sponsored RPC launch error:", error);
        return createMachineErrorResponse(
          "internal_error",
          "Failed to launch sponsored workflow checkout.",
          500,
        );
      }

      const row = (data as Array<{
        job_id: string | null;
        user_payment_id: string | null;
        created: boolean;
        reason: string;
      }> | null)?.[0];

      if (!row || !row.job_id) {
        if (row?.reason === "quote_expired") {
          return createMachineErrorResponse(
            "quote_expired",
            "Quote expired prior to execution.",
            404,
          );
        }
        if (row?.reason === "sponsored_quota_exhausted") {
          return createMachineErrorResponse(
            "spending_limit_exceeded",
            "Sponsored quota has been exhausted.",
            429,
          );
        }
        return createMachineErrorResponse(
          "internal_error",
          `Sponsored checkout failed: ${row?.reason || "unknown_error"}`,
          400,
        );
      }
      jobId = row.job_id;
    } else {
      // Paid mode
      const txHash = (paymentAuth?.payload ?? "").trim();
      const result = await confirmHostedWorkflowQuote({
        quoteId: storedQuote.id,
        idempotencyHash,
        requestHash,
        request: workflowRequest,
        transactionHash: txHash,
      });

      if (!result.jobId) {
        return createMachineErrorResponse(
          "payment_invalid",
          `Paid workflow checkout failed: ${result.reason}`,
          400,
        );
      }
      jobId = result.jobId;
    }

    // Associate Agent ID and Credential ID with job
    if (jobId) {
      const { error: ownershipUpdateError } = await getByoaClient()
        .from("hosted_agent_jobs")
        .update({
          byoa_agent_id: context.agentId,
          machine_credential_id: context.credential.id,
        })
        .eq("id", jobId);
      if (ownershipUpdateError) {
        throw new Error(
          `Unable to persist ${BRAND.agentApi} job credential ownership.`,
        );
      }
      if (monitoringRecheckId) {
        await bindMachineTrustMonitoringJob({
          recheckId: monitoringRecheckId,
          jobId,
          byoaAgentId: context.agentId,
          machineCredentialId: context.credential.id,
        });
      }
    }

    const responsePayload = {
      runId: jobId,
      status: "queued",
      pollAfterMs: 2000,
    };

    await saveMachineIdempotency(
      idempotencyKey,
      context.credential.id,
      body,
      responsePayload,
      {
        agentId: context.agentId,
        route: "/api/agent/v1/runs",
        responseStatus: 201,
        resourceType: "run",
        resourceId: jobId,
        reservationToken,
      },
    );
    reservationToken = undefined;

    // Launch execution asynchronously
    if (jobId) {
      const inputForRunner = workflowRequest.inputText;
      const monitoredInput =
        monitoringRecheckId && workflowRequest.agentTrustInput
          ? workflowRequest.agentTrustInput
          : null;
      try {
        after(async () => {
          try {
            if (monitoredInput) {
              await executeTrustMonitoringJob({
                jobId: jobId!,
                reportInput: monitoredInput,
              });
            } else {
              await runHostedAgentJob(jobId!, inputForRunner);
            }
          } catch (err) {
            console.error(
              `[runs/route] Async execution failed for job=${jobId}:`,
              err,
            );
          }
        });
      } catch {
        // Fallback for execution outside Next.js request context (e.g. unit tests)
        const execution = monitoredInput
          ? executeTrustMonitoringJob({
              jobId,
              reportInput: monitoredInput,
            })
          : runHostedAgentJob(jobId, inputForRunner);
        execution.catch((err) => {
          console.error(
            `[runs/route] Async execution fallback failed for job=${jobId}:`,
            err,
          );
        });
      }
    }

    return NextResponse.json(responsePayload, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[runs/route] Execution launch error:", error);
    const msg = error instanceof Error ? error.message : "Failed to launch run.";
    if (
      msg.includes("payment") ||
      msg.includes("reverted") ||
      msg.includes("does not match") ||
      msg.includes("transaction")
    ) {
      return createMachineErrorResponse("payment_invalid", msg, 400);
    }
    return handleMachineInternalError(
      error,
      "/api/agent/v1/runs",
      context.agentId,
    );
  } finally {
    if (reservationToken) {
      await releaseMachineIdempotency(
        idempotencyKey,
        context.credential.id,
        body,
        "/api/agent/v1/runs",
        reservationToken,
      );
    }
  }
}
