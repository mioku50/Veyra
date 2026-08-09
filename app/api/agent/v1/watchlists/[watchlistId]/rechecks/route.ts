import { NextRequest, NextResponse } from "next/server";
import {
  authenticateMachineRequest,
  enforceQuoteCreationPolicy,
  enforceQuoteSpendingPolicy,
} from "@/lib/api/machine-auth";
import { createMachineErrorResponse, handleMachineInternalError } from "@/lib/api/machine-errors";
import {
  resolveMachineIdempotency,
  releaseMachineIdempotency,
  saveMachineIdempotency,
} from "@/lib/api/machine-idempotency";
import {
  createTrustMonitoringQuote,
  requireMachineWatchlist,
  TrustMonitoringError,
} from "@/lib/monitoring/service";

type RouteContext = { params: Promise<{ watchlistId: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await authenticateMachineRequest(request, "quotes:create");
  if (!auth.ok) return auth.response;
  const key = request.headers.get("idempotency-key");
  if (!key) {
    return createMachineErrorResponse(
      "idempotency_key_missing",
      "Missing required Idempotency-Key header.",
      400,
    );
  }
  const { watchlistId } = await params;
  const body = { watchlistId };
  let reservationToken: string | undefined;
  try {
    const policy = await enforceQuoteCreationPolicy(auth.context);
    if (!policy.ok) return policy.response;
    const watchlist = await requireMachineWatchlist({
      publicId: watchlistId,
      ownerWallet: auth.context.ownerWallet,
      byoaAgentId: auth.context.agentId,
      machineCredentialId: auth.context.credential.id,
    });
    const reservation = await resolveMachineIdempotency(
      key,
      auth.context.credential.id,
      body,
      `/api/agent/v1/watchlists/${watchlistId}/rechecks`,
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
        "This Idempotency-Key is already bound to a different recheck request.",
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
    const result = await createTrustMonitoringQuote({
      watchlist,
      trigger: "machine",
      idempotencyKey: key,
      forwardedFor: request.headers.get("x-forwarded-for"),
      userAgent: request.headers.get("user-agent"),
      byoaAgentId: auth.context.agentId,
      machineCredentialId: auth.context.credential.id,
      beforeQuote: async (estimatedProviderCostUsdc) => {
        const spending = await enforceQuoteSpendingPolicy(
          auth.context,
          estimatedProviderCostUsdc,
        );
        if (!spending.ok) {
          throw new TrustMonitoringError(
            "The recheck exceeds the credential spending policy.",
            "spending_limit_exceeded",
            spending.response.status,
          );
        }
      },
    });
    const quote = result.quote;
    const payload = {
      watchlistId,
      recheckId: result.recheck.public_id,
      quoteId: quote.id,
      workflow: quote.workflowType,
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
        chainId: quote.chainId,
      },
    };
    await saveMachineIdempotency(
      key,
      auth.context.credential.id,
      body,
      payload,
      {
        agentId: auth.context.agentId,
        route: `/api/agent/v1/watchlists/${watchlistId}/rechecks`,
        responseStatus: result.created ? 201 : 200,
        resourceType: "quote",
        resourceId: quote.id,
        reservationToken,
      },
    );
    reservationToken = undefined;
    return NextResponse.json(payload, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (reservationToken) {
      await releaseMachineIdempotency(
        key,
        auth.context.credential.id,
        body,
        `/api/agent/v1/watchlists/${watchlistId}/rechecks`,
        reservationToken,
      );
    }
    if (error instanceof TrustMonitoringError) {
      return createMachineErrorResponse(
        error.code as Parameters<typeof createMachineErrorResponse>[0],
        error.message,
        error.status,
        error.retryable,
      );
    }
    return handleMachineInternalError(
      error,
      `/api/agent/v1/watchlists/${watchlistId}/rechecks`,
      auth.context.agentId,
    );
  }
}
