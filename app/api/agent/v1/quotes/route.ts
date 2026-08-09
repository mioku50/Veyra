/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server.js";
import { type Address } from "viem";
import {
  authenticateMachineRequest,
  enforceQuoteCreationPolicy,
  enforceQuoteSpendingPolicy,
  type MachineAuthContext,
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
  getHostedRunnerConfig,
  hostedIdempotencyHash,
  hostedIdempotencyRequestHash,
  hostedRequesterFingerprint,
  HOSTED_AGENT_MAX_BUDGET_USDC,
} from "../../../../../lib/agent/hosted-policy.ts";
import {
  hashHostedWorkflowInput,
  isHostedWorkflowType,
  validateHostedWorkflowRequest,
} from "../../../../../lib/agent/hosted-workflows.ts";
import { previewHostedWorkflow } from "../../../../../lib/agent/hosted-jobs.ts";
import {
  getHostedWorkflowTemplate,
  isCuratedHostedWorkflowType,
} from "../../../../../lib/agent/workflow-templates.ts";
import {
  createHostedWorkflowQuote,
  HostedCheckoutPolicyError,
} from "../../../../../lib/commerce/workflow-checkout.ts";
import { workflowPaymentTransactionRequest } from "../../../../../lib/commerce/workflow-payment.ts";
import {
  parseGitHubRepositoryInput,
  InvalidGitHubRepositoryError,
} from "../../../../../lib/providers/github-repository-ref.ts";
import {
  AgentTrustInputError,
  canonicalAgentTrustInput,
  normalizeAgentTrustInput,
} from "../../../../../lib/agent-trust/input.ts";
import { ARC_TESTNET_CHAIN_ID } from "../../../../../lib/wallet/arc.ts";
import {
  getSellerServiceRowByWorkflowType,
  isSellerServiceRunnable,
  isSellerWorkflowType,
} from "../../../../../lib/seller/marketplace.ts";
import {
  createSellerWorkflowQuote,
  sellerWorkflowAllowed,
} from "../../../../../lib/seller/workflow.ts";
import { validatePublicServiceForQualityEvaluation } from "../../../../../lib/providers/api-quality.ts";
import { parseApiQualityJobInput } from "../../../../../lib/reports/api-quality-report.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function createMachineSellerQuote(input: {
  request: NextRequest;
  context: MachineAuthContext;
  body: Record<string, unknown>;
  workflow: string;
  idempotencyKey: string;
}) {
  if (
    !sellerWorkflowAllowed(input.context.allowedWorkflows, input.workflow) ||
    !input.context.spendingPolicy.allowed_service_types.includes("external_seller")
  ) {
    return createMachineErrorResponse(
      "workflow_disabled",
      `Workflow '${input.workflow}' is not enabled for this credential policy.`,
      403,
    );
  }
  const service = await getSellerServiceRowByWorkflowType(input.workflow);
  if (!service || !isSellerServiceRunnable(service)) {
    return createMachineErrorResponse("provider_unavailable", "Seller workflow is unavailable.", 503, true);
  }
  const payload = input.body.input;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return createMachineErrorResponse("invalid_repository", "Seller workflow input must be a JSON object.", 400);
  }
  const policy = await enforceQuoteCreationPolicy(input.context);
  if (!policy.ok) return policy.response;
  const spend = await enforceQuoteSpendingPolicy(input.context, Number(service.price_usdc));
  if (!spend.ok) return spend.response;

  const reservation = await resolveMachineIdempotency(
    input.idempotencyKey,
    input.context.credential.id,
    input.body,
    "/api/agent/v1/quotes",
    input.context.agentId,
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
    return createMachineErrorResponse("idempotency_conflict", "This Idempotency-Key is already bound to a different workflow input.", 409);
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

  const config = getHostedRunnerConfig();
  try {
    const quoteResult = await createSellerWorkflowQuote({
      service,
      payload,
      idempotencyKey: input.idempotencyKey,
      requesterFingerprint: hostedRequesterFingerprint({
        secret: config.rateLimitSecret,
        forwardedFor: input.request.headers.get("x-forwarded-for"),
        userAgent: input.request.headers.get("user-agent"),
      }),
      requesterWallet: input.context.ownerWallet as Address,
      byoaAgentId: input.context.agentId,
      machineCredentialId: input.context.credential.id,
      ownerWallet: input.context.ownerWallet,
    });
    const quote = quoteResult.quote;
    const responsePayload = {
      quoteId: quote.id,
      workflow: quote.workflowType,
      serviceId: quote.sellerSnapshot?.serviceId,
      serviceVersion: quote.sellerSnapshot?.serviceVersion,
      totalUsdc: quote.pricing.listPriceUsdc,
      sponsored: quote.paymentMode === "sponsored",
      checkout: {
        mode: quote.paymentMode === "sponsored" ? "sponsored" : "arc_transaction",
        asset: "USDC",
        network: "arc-testnet",
      },
      downstreamSettlement: "server_side_x402",
      expiresAt: quote.expiresAt,
      requiredPayment: {
        network: "arc-testnet",
        asset: "USDC",
        amount: quote.pricing.amountDueUsdc,
        treasuryAddress: quote.treasuryAddress,
        chainId: quote.chainId || ARC_TESTNET_CHAIN_ID,
        transaction: workflowPaymentTransactionRequest(quote.payment),
      },
    };
    await saveMachineIdempotency(
      input.idempotencyKey,
      input.context.credential.id,
      input.body,
      responsePayload,
      {
        agentId: input.context.agentId,
        route: "/api/agent/v1/quotes",
        responseStatus: quoteResult.created ? 201 : 200,
        resourceType: "quote",
        resourceId: quote.id,
        reservationToken: reservation.reservationToken,
      },
    );
    return NextResponse.json(responsePayload, {
      status: quoteResult.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    await releaseMachineIdempotency(
      input.idempotencyKey,
      input.context.credential.id,
      input.body,
      "/api/agent/v1/quotes",
      reservation.reservationToken,
    );
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const authResult = await authenticateMachineRequest(request, "quotes:create");
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
  let reservationToken: string | undefined;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return createMachineErrorResponse(
      "invalid_request",
      "Invalid JSON request body.",
      400,
    );
  }

  // A read-only check lets completed retries bypass validation and current
  // policy limits without reserving malformed requests for the full TTL.
  const idempotencyCheck = await inspectMachineIdempotency(
    idempotencyKey,
    context.credential.id,
    body,
    "/api/agent/v1/quotes",
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
      "This Idempotency-Key is already bound to a different workflow input.",
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

  const workflow =
    (body.workflow as string) ||
    (body.workflowType as string) ||
    "github_due_diligence";

  if (workflow === "project_360") {
    return createMachineErrorResponse(
      "invalid_request",
      "Use the free /api/agent/v1/project-360/discoveries endpoint, then create the quote from its confirmed candidate IDs.",
      400,
    );
  }

  if (isSellerWorkflowType(workflow)) {
    try {
      return await createMachineSellerQuote({
        request,
        context,
        body,
        workflow,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof HostedCheckoutPolicyError) {
        return createMachineErrorResponse(
          error.reason === "idempotency_conflict" ? "idempotency_conflict" : "rate_limited",
          error.reason === "idempotency_conflict"
            ? "This Idempotency-Key is already bound to a different workflow input."
            : "Hosted checkout rate policy is temporarily limiting this requester.",
          error.reason === "idempotency_conflict" ? 409 : 429,
        );
      }
      return handleMachineInternalError(error, "/api/agent/v1/quotes", context.agentId);
    }
  }

  if (!isHostedWorkflowType(workflow) || !isCuratedHostedWorkflowType(workflow)) {
    return createMachineErrorResponse(
      "workflow_disabled",
      `Unsupported workflow type '${workflow}'.`,
      400,
    );
  }

  const allowedSet = new Set(context.allowedWorkflows || []);
  if (!allowedSet.has("*") && !allowedSet.has(workflow)) {
    return createMachineErrorResponse(
      "workflow_disabled",
      `Workflow '${workflow}' is not enabled for this credential policy.`,
      403,
    );
  }

  const template = getHostedWorkflowTemplate(workflow);
  if (!template) {
    return createMachineErrorResponse(
      "provider_unavailable",
      "Workflow template is unavailable.",
      503,
    );
  }

  let inputText = "";
  let repositoryRef = null;
  let agentTrustInput = null;
  let marketSymbol: unknown = null;

  if (workflow === "agent_trust_report") {
    try {
      agentTrustInput = normalizeAgentTrustInput(body.input);
      inputText = canonicalAgentTrustInput(agentTrustInput);
      repositoryRef = agentTrustInput.repositoryUrl
        ? parseGitHubRepositoryInput(agentTrustInput.repositoryUrl)
        : null;
    } catch (error) {
      if (error instanceof AgentTrustInputError) {
        return createMachineErrorResponse(error.code, error.message, 400);
      }
      return createMachineErrorResponse(
        "agent_trust_input_required",
        "Provide at least one Agent ID, agent wallet, or public GitHub repository.",
        400,
      );
    }
  } else if (workflow === "github_due_diligence") {
    const rawRepo =
      (body.input as Record<string, unknown>)?.repository ||
      (body.input as Record<string, unknown>)?.repositoryUrl ||
      body.repository ||
      body.repositoryUrl;

    if (!rawRepo || typeof rawRepo !== "string" || !rawRepo.trim()) {
      return createMachineErrorResponse(
        "invalid_repository",
        "Enter a valid GitHub repository in owner/repository format.",
        400,
      );
    }

    try {
      repositoryRef = parseGitHubRepositoryInput(rawRepo);
      inputText = repositoryRef.canonicalUrl;
    } catch (err) {
      const msg =
        err instanceof InvalidGitHubRepositoryError
          ? err.message
          : "Enter a valid GitHub repository in owner/repository format.";
      return createMachineErrorResponse("invalid_repository", msg, 400);
    }
  } else {
    const inputObject =
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : {};
    inputText =
      inputObject.text as string ||
      (body.text as string) ||
      "";
    marketSymbol = inputObject.marketSymbol ?? body.marketSymbol ?? null;
  }

  if (workflow === "paid_api_quality") {
    const { targetServices } = parseApiQualityJobInput(inputText, null, body.input);
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

  let workflowRequest;
  try {
    workflowRequest = validateHostedWorkflowRequest({
      workflowType: workflow,
      inputText,
      repositoryUrl: repositoryRef?.canonicalUrl,
      agentTrustInput,
      marketSymbol,
      task: template.task,
      budgetUsdc: HOSTED_AGENT_MAX_BUDGET_USDC,
    });
  } catch (err) {
    return createMachineErrorResponse(
      workflow === "github_due_diligence"
        ? "invalid_repository"
        : workflow === "agent_trust_report" &&
            err instanceof AgentTrustInputError
          ? err.code
          : "invalid_request",
      err instanceof Error ? err.message : "Invalid workflow request input.",
      400,
    );
  }

  const policyResult = await enforceQuoteCreationPolicy(context);
  if (!policyResult.ok) {
    return policyResult.response;
  }

  try {
    const plan = await previewHostedWorkflow(workflowRequest);

    if (plan.selectedServices.length === 0) {
      return createMachineErrorResponse(
        "provider_unavailable",
        "Required workflow services are temporarily unavailable.",
        503,
      );
    }
    const selected = new Set(
      plan.selectedServices.map((service) => service.slug),
    );

    if (
      workflow === "agent_trust_report" &&
      !selected.has("agent-trust-finalizer")
    ) {
      return createMachineErrorResponse(
        "agent_trust_service_unavailable",
        "Agent Trust Report is temporarily unavailable because canonical Arc report verification is disabled.",
        503,
        true,
      );
    }

    if (
      workflow === "paid_api_quality" &&
      !selected.has("api-quality-finalizer")
    ) {
      return createMachineErrorResponse(
        "provider_unavailable",
        "Paid API Quality Report is temporarily unavailable because API quality finalization is disabled.",
        503,
        true,
      );
    }


    if (
      workflow === "github_due_diligence" ||
      (workflow === "agent_trust_report" && workflowRequest.repository)
    ) {
      const missingRequiredService = [
        "github-repository-intelligence",
        "github-due-diligence-analysis",
      ].some((slug) => !selected.has(slug));
      if (missingRequiredService) {
        return createMachineErrorResponse(
          "provider_unavailable",
          workflow === "agent_trust_report"
            ? "The repository portion of Agent Trust Report is temporarily unavailable because required GitHub analysis services are disabled."
            : "GitHub Project Due Diligence is temporarily unavailable because required analysis services are disabled.",
          503,
          true,
        );
      }
    }

    const spendingPolicyResult = await enforceQuoteSpendingPolicy(
      context,
      plan.estimatedSpendUsdc,
    );
    if (!spendingPolicyResult.ok) {
      return spendingPolicyResult.response;
    }

    // Reserve only after every read-only validation and policy check. The RPC
    // is atomic, so a concurrent request can no longer enter the mutation.
    const reservation = await resolveMachineIdempotency(
      idempotencyKey,
      context.credential.id,
      body,
      "/api/agent/v1/quotes",
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
        "This Idempotency-Key is already bound to a different workflow input.",
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
    reservationToken = reservation.reservationToken;

    const config = getHostedRunnerConfig();
    const inputSha256 = hashHostedWorkflowInput(workflowRequest.inputText);
    const idempotencyHash = hostedIdempotencyHash(
      config.rateLimitSecret,
      idempotencyKey,
    );
    const requestHash = hostedIdempotencyRequestHash({
      secret: config.rateLimitSecret,
      workflowType: workflowRequest.workflowType,
      inputSha256,
      task: workflowRequest.task,
      marketSymbol: workflowRequest.marketSymbol,
      repository: workflowRequest.repository,
      budgetUsdc: workflowRequest.budgetUsdc,
    });

    const quoteResult = await createHostedWorkflowQuote({
      idempotencyHash,
      requestHash,
      requesterFingerprint: hostedRequesterFingerprint({
        secret: config.rateLimitSecret,
        forwardedFor: request.headers.get("x-forwarded-for"),
        userAgent: request.headers.get("user-agent"),
      }),
      requesterWallet: context.ownerWallet as Address,
      request: workflowRequest,
      plan,
      byoaAgentId: context.agentId,
      machineCredentialId: context.credential.id,
      ownerWallet: context.ownerWallet,
    });

    const isSponsored = quoteResult.quote.paymentMode === "sponsored";
    const responsePayload = {
      quoteId: quoteResult.quote.id,
      workflow: quoteResult.quote.workflowType,
      repository: workflowRequest.repository
        ? {
            fullName: workflowRequest.repository.fullName,
            canonicalUrl: workflowRequest.repository.canonicalUrl,
          }
        : null,
      inputSources:
        workflowRequest.workflowType === "agent_trust_report"
          ? {
              agentRegistry: Boolean(
                workflowRequest.agentTrustInput?.agentId ||
                  workflowRequest.agentTrustInput?.agentWallet,
              ),
              github: Boolean(workflowRequest.repository),
              contract: Boolean(
                workflowRequest.agentTrustInput?.contractAddress,
              ),
              endpoint: Boolean(
                workflowRequest.agentTrustInput?.serviceEndpoint,
              ),
            }
          : undefined,
      totalUsdc: quoteResult.quote.pricing.listPriceUsdc,
      sponsored: isSponsored,
      checkout: {
        mode: isSponsored ? "sponsored" : "arc_transaction",
        asset: "USDC",
        network: "arc-testnet",
      },
      downstreamSettlement: "server_side_x402",
      expiresAt: quoteResult.quote.expiresAt,
      requiredPayment: {
        network: "arc-testnet",
        asset: "USDC",
        amount: quoteResult.quote.pricing.amountDueUsdc,
        treasuryAddress: quoteResult.quote.treasuryAddress,
        chainId: quoteResult.quote.chainId || ARC_TESTNET_CHAIN_ID,
        transaction: workflowPaymentTransactionRequest(quoteResult.quote.payment),
      },
    };

    await saveMachineIdempotency(
      idempotencyKey,
      context.credential.id,
      body,
      responsePayload,
      {
        agentId: context.agentId,
        route: "/api/agent/v1/quotes",
        responseStatus: quoteResult.created ? 201 : 200,
        resourceType: "quote",
        resourceId: (responsePayload as any).quoteId,
        reservationToken,
      },
    );
    reservationToken = undefined;

    return NextResponse.json(responsePayload, {
      status: quoteResult.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (reservationToken) {
      await releaseMachineIdempotency(
        idempotencyKey,
        context.credential.id,
        body,
        "/api/agent/v1/quotes",
        reservationToken,
      );
    }
    if (error instanceof HostedCheckoutPolicyError) {
      if (error.reason === "idempotency_conflict") {
        return createMachineErrorResponse(
          "invalid_repository",
          "This Idempotency-Key is already bound to a different workflow input.",
          409,
        );
      }
      if (error.reason === "active_job") {
        return createMachineErrorResponse(
          "rate_limited",
          "The hosted payer is already running another workflow.",
          409,
        );
      }
      return createMachineErrorResponse(
        "rate_limited",
        "Hosted checkout rate policy is temporarily limiting this requester.",
        429,
      );
    }

    return handleMachineInternalError(
      error,
      "/api/agent/v1/quotes",
      context.agentId,
    );
  }
}
