import { NextRequest, NextResponse } from "next/server";
import { authenticateMachineRequest } from "@/lib/api/machine-auth";
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
import { Project360InputError } from "@/lib/project-360/input";
import {
  createMachineProject360Discovery,
  Project360Error,
} from "@/lib/project-360/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function errorResponse(error: unknown) {
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
    "/api/agent/v1/project-360/discoveries",
  );
}

export async function POST(request: NextRequest) {
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
  let body: Record<string, unknown>;
  let reservationToken: string | undefined;
  try {
    body = await request.json();
  } catch {
    return createMachineErrorResponse("invalid_request", "Request body must be valid JSON.", 400);
  }
  try {
    const reservation = await resolveMachineIdempotency(
      key,
      auth.context.credential.id,
      body,
      "/api/agent/v1/project-360/discoveries",
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
        "This Idempotency-Key is already bound to a different discovery input.",
        409,
      );
    }
    if (reservation.pending) {
      return createMachineErrorResponse(
        "idempotency_in_progress",
        "A discovery with this Idempotency-Key is already running.",
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
    const result = await createMachineProject360Discovery({
      ownerWallet: auth.context.ownerWallet,
      machineCredentialId: auth.context.credential.id,
      idempotencyKey: key,
      primaryType: body.type,
      primaryValue: body.value,
    });
    const status = result.created ? 201 : 200;
    await saveMachineIdempotency(
      key,
      auth.context.credential.id,
      body,
      result,
      {
        agentId: auth.context.agentId,
        route: "/api/agent/v1/project-360/discoveries",
        responseStatus: status,
        resourceType: "project_360_discovery",
        resourceId: result.discovery.id,
        reservationToken,
      },
    );
    reservationToken = undefined;
    return NextResponse.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (reservationToken) {
      await releaseMachineIdempotency(
        key,
        auth.context.credential.id,
        body,
        "/api/agent/v1/project-360/discoveries",
        reservationToken,
      );
    }
    return errorResponse(error);
  }
}
