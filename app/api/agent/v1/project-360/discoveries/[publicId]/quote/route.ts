import { NextRequest, NextResponse } from "next/server";
import { type Address } from "viem";
import {
  authenticateMachineRequest,
  enforceQuoteCreationPolicy,
  enforceQuoteSpendingPolicy,
} from "@/lib/api/machine-auth";
import {
  createMachineErrorResponse,
  handleMachineInternalError,
  type MachineErrorCode,
} from "@/lib/api/machine-errors";
import {
  resolveMachineIdempotency,
  releaseMachineIdempotency,
  saveMachineIdempotency,
} from "@/lib/api/machine-idempotency";
import {
  ARC_CONTRACT_ANALYSIS_FINALIZER_PRICE_USDC,
  API_QUALITY_FINALIZER_PRICE_USDC,
  PROJECT_360_FINALIZER_PRICE_USDC,
  TREASURY_HEALTH_FINALIZER_PRICE_USDC,
} from "@/lib/services/constants";
import { createBrowserProject360Quote, Project360Error } from "@/lib/project-360/service";
import { PROJECT_360_MODULES, type Project360Module } from "@/lib/project-360/types";
import { Project360InputError } from "@/lib/project-360/input";

type RouteContext = { params: Promise<{ publicId: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function estimatedModuleCost(modules: Project360Module[]) {
  return Number((
    (modules.includes("github_due_diligence") ? 0.002 : 0) +
    (modules.includes("agent_trust_report") ? 0.0001 : 0) +
    (modules.includes("treasury_health") ? Number(TREASURY_HEALTH_FINALIZER_PRICE_USDC) : 0) +
    (modules.includes("paid_api_quality") ? Number(API_QUALITY_FINALIZER_PRICE_USDC) : 0) +
    (modules.includes("arc_contract_analysis") ? Number(ARC_CONTRACT_ANALYSIS_FINALIZER_PRICE_USDC) : 0) +
    Number(PROJECT_360_FINALIZER_PRICE_USDC)
  ).toFixed(6));
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await authenticateMachineRequest(request, "quotes:create");
  if (!auth.ok) return auth.response;
  if (
    !auth.context.allowedWorkflows.includes("*") &&
    !auth.context.allowedWorkflows.includes("project_360")
  ) {
    return createMachineErrorResponse(
      "workflow_disabled",
      "Project 360 is not enabled for this credential policy.",
      403,
    );
  }
  const key = request.headers.get("idempotency-key");
  if (!key) {
    return createMachineErrorResponse(
      "idempotency_key_missing",
      "Missing required Idempotency-Key header.",
      400,
    );
  }
  let body: Record<string, unknown>;
  let reservationToken: string | undefined;
  try {
    body = await request.json();
  } catch {
    return createMachineErrorResponse("invalid_request", "Request body must be valid JSON.", 400);
  }
  try {
    const requestedModules = Array.isArray(body.modules) ? body.modules : [];
    const modules = PROJECT_360_MODULES.filter((module) =>
      requestedModules.includes(module),
    );
    if (modules.length < 1) {
      return createMachineErrorResponse(
        "project_modules_invalid",
        "Select at least one Project 360 module.",
        400,
      );
    }
    const policy = await enforceQuoteCreationPolicy(auth.context);
    if (!policy.ok) return policy.response;
    const spend = await enforceQuoteSpendingPolicy(
      auth.context,
      estimatedModuleCost(modules),
    );
    if (!spend.ok) return spend.response;
    const reservation = await resolveMachineIdempotency(
      key,
      auth.context.credential.id,
      body,
      "/api/agent/v1/project-360/discoveries/[publicId]/quote",
      auth.context.agentId,
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
        "This Idempotency-Key is already bound to a different Project 360 selection.",
        409,
      );
    }
    if (reservation.pending) {
      return createMachineErrorResponse(
        "idempotency_in_progress",
        "A quote with this Idempotency-Key is already being processed.",
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
    const { publicId } = await params;
    const result = await createBrowserProject360Quote({
      ownerWallet: auth.context.ownerWallet as Address,
      publicDiscoveryId: publicId,
      discoveryRevision: body.revision,
      selectedCandidateIds: body.selectedCandidateIds,
      modules,
      idempotencyKey: key,
      forwardedFor: request.headers.get("x-forwarded-for"),
      userAgent: request.headers.get("user-agent"),
      byoaAgentId: auth.context.agentId,
      machineCredentialId: auth.context.credential.id,
    });
    const payload = {
      quoteId: result.quote.id,
      workflow: "project_360",
      repository: null,
      project360: result.project360,
      totalUsdc: result.quote.pricing.listPriceUsdc,
      sponsored: result.quote.paymentMode === "sponsored",
      checkout: {
        mode: result.quote.paymentMode === "sponsored" ? "sponsored" : "arc_transaction",
        asset: "USDC",
        network: "arc-testnet",
      },
      requiredPayment: {
        network: "arc-testnet",
        asset: "USDC",
        amount: result.quote.pricing.amountDueUsdc,
        treasuryAddress: result.quote.treasuryAddress,
        chainId: result.quote.chainId,
      },
      expiresAt: result.quote.expiresAt,
    };
    const status = result.created ? 201 : 200;
    await saveMachineIdempotency(
      key,
      auth.context.credential.id,
      body,
      payload,
      {
        agentId: auth.context.agentId,
        route: "/api/agent/v1/project-360/discoveries/[publicId]/quote",
        responseStatus: status,
        resourceType: "quote",
        resourceId: result.quote.id,
        reservationToken,
      },
    );
    reservationToken = undefined;
    return NextResponse.json(payload, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (reservationToken) {
      await releaseMachineIdempotency(
        key,
        auth.context.credential.id,
        body,
        "/api/agent/v1/project-360/discoveries/[publicId]/quote",
        reservationToken,
      );
    }
    if (error instanceof Project360Error || error instanceof Project360InputError) {
      return createMachineErrorResponse(
        error.code as MachineErrorCode,
        error.message,
        error.status,
        error instanceof Project360Error ? error.retryable : false,
      );
    }
    return handleMachineInternalError(
      error,
      "/api/agent/v1/project-360/discoveries/[publicId]/quote",
      auth.context.agentId,
    );
  }
}
