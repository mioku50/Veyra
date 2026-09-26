/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { settleResearch } from "@/lib/nova/investigation";

export const dynamic = "force-dynamic";
/* The seller's own call, plus the check afterwards. */
export const maxDuration = 120;

type RouteContext = { params: Promise<{ publicId: string; questionId: string }> };

/* The same settlement as a card's: the row approved for this owner, relayed
   with the owner's own signature, and checked. */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
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
