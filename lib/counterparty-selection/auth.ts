import { NextRequest, NextResponse } from "next/server.js";
import { getAddress } from "viem";
import { authenticateMachineRequest } from "../api/machine-auth.ts";
import { createMachineErrorResponse } from "../api/machine-errors.ts";
import { requireOwnerSession } from "../byoa/http.ts";
import type { SelectionTenant } from "./types.ts";

export type SelectionAuthResult =
  | { ok: true; tenant: SelectionTenant }
  | { ok: false; response: NextResponse };

export async function authenticateSelectionRequest(
  request: NextRequest,
  machineScope: "workflows:read" | "quotes:create" | "runs:create" | "results:read",
): Promise<SelectionAuthResult> {
  if (request.headers.get("authorization")) {
    const auth = await authenticateMachineRequest(request, machineScope);
    if (!auth.ok) return auth;
    return {
      ok: true,
      tenant: {
        tenantKey: `machine:${auth.context.agentId}:${auth.context.credential.id}`,
        requesterAgentId: auth.context.agentId,
        requesterWallet: getAddress(auth.context.ownerWallet),
        machineCredentialId: auth.context.credential.id,
      },
    };
  }

  try {
    const session = requireOwnerSession(request);
    return {
      ok: true,
      tenant: {
        tenantKey: `owner:${session.wallet.toLowerCase()}`,
        requesterWallet: getAddress(session.wallet),
      },
    };
  } catch {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_missing",
        "A Machine API credential or verified owner-wallet session is required.",
        401,
      ),
    };
  }
}
