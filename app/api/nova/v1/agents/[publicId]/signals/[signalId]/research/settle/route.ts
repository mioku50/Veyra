/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { settleResearch } from "@/lib/nova/investigation";

export const dynamic = "force-dynamic";
/* The seller's own call, plus the verification afterwards. A research endpoint
   answering in four seconds is normal. */
export const maxDuration = 120;

type RouteContext = { params: Promise<{ publicId: string; signalId: string }> };

/**
 * Relays the owner's signature, checks the answer, and only then records it.
 *
 * The accept is not accepted from here. It is read back from the row this
 * approval already wrote, so the payment relayed is the payment Veyra cleared
 * and not merely one that is internally consistent with itself.
 *
 * Every outcome returns 200. A payment that went through and failed its
 * verification is a real result with a real receipt, and rendering it as an
 * HTTP error would file it under "something went wrong with Nova" instead of
 * "this is what your money bought".
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, signalId } = await params;
    const body = await request.json().catch(() => ({})) as {
      researchId?: unknown;
      authorization?: unknown;
      signature?: unknown;
    };

    const settlement = await settleResearch({
      publicId,
      ownerSecret: ownerSecretFrom(request),
      researchId: typeof body.researchId === "string" ? body.researchId : "",
      authorization: body.authorization,
      signature: typeof body.signature === "string" ? body.signature : "",
    });

    return NextResponse.json(settlement, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
