/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { approveQuestionResearch } from "@/lib/nova/investigation";

export const dynamic = "force-dynamic";
/* A full re-read of the market plus a live 402 challenge for the exact
   request, with somebody holding a wallet open. */
export const maxDuration = 60;

type RouteContext = { params: Promise<{ publicId: string; questionId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, questionId } = await params;
    const body = await request.json().catch(() => ({})) as {
      wallet?: unknown;
      acknowledge?: unknown;
    };

    const outcome = await approveQuestionResearch({
      publicId,
      ownerSecret: ownerSecretFrom(request),
      questionId,
      wallet: typeof body.wallet === "string" ? body.wallet : "",
      acknowledged: typeof body.acknowledge === "string" ? body.acknowledge : null,
    });

    return NextResponse.json(outcome, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
