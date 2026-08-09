import { NextRequest, NextResponse } from "next/server";
import { authenticateMachineRequest } from "@/lib/api/machine-auth";
import { createMachineErrorResponse, handleMachineInternalError } from "@/lib/api/machine-errors";
import {
  resolveMachineIdempotency,
  releaseMachineIdempotency,
  saveMachineIdempotency,
} from "@/lib/api/machine-idempotency";
import {
  createTrustWatchlist,
  listMachineTrustWatchlists,
  TrustMonitoringError,
  validateTrustWatchlistDraft,
} from "@/lib/monitoring/service";

export const dynamic = "force-dynamic";

function monitoringMachineError(error: unknown) {
  if (error instanceof TrustMonitoringError) {
    return createMachineErrorResponse(
      error.code as Parameters<typeof createMachineErrorResponse>[0],
      error.message,
      error.status,
      error.retryable,
    );
  }
  return handleMachineInternalError(error, "/api/agent/v1/watchlists");
}

export async function GET(request: NextRequest) {
  const auth = await authenticateMachineRequest(request, "results:read");
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({
      watchlists: await listMachineTrustWatchlists({
        ownerWallet: auth.context.ownerWallet,
        byoaAgentId: auth.context.agentId,
        machineCredentialId: auth.context.credential.id,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return monitoringMachineError(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateMachineRequest(request, "runs:create");
  if (!auth.ok) return auth.response;
  const key = request.headers.get("idempotency-key");
  if (!key) {
    return createMachineErrorResponse(
      "idempotency_key_missing",
      "Missing required Idempotency-Key header.",
      400,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return createMachineErrorResponse("invalid_request", "Request body must be valid JSON.", 400);
  }
  let reservationToken: string | undefined;
  try {
    validateTrustWatchlistDraft({
      label: body.label,
      subjectInput: body.input,
      cadence: body.cadence,
      visibility: body.visibility,
    });
    const reservation = await resolveMachineIdempotency(
      key,
      auth.context.credential.id,
      body,
      "/api/agent/v1/watchlists",
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
        "This Idempotency-Key is already bound to a different watchlist request.",
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
    const result = await createTrustWatchlist({
      ownerWallet: auth.context.ownerWallet,
      label: body.label,
      subjectInput: body.input,
      cadence: body.cadence,
      visibility: body.visibility,
      byoaAgentId: auth.context.agentId,
      machineCredentialId: auth.context.credential.id,
    });
    const payload = result.watchlist;
    const status = result.created ? 201 : 200;
    await saveMachineIdempotency(
      key,
      auth.context.credential.id,
      body,
      payload,
      {
        agentId: auth.context.agentId,
        route: "/api/agent/v1/watchlists",
        responseStatus: status,
        resourceType: "watchlist",
        resourceId: payload.id,
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
        "/api/agent/v1/watchlists",
        reservationToken,
      );
    }
    return monitoringMachineError(error);
  }
}
