/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { markSignal } from "@/lib/nova/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string; signalId: string }> };

/** Marks one item read or dismissed. A dismissal is also how Nova learns. */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, signalId } = await params;
    const body = await request.json() as { status?: unknown };
    const status = body.status === "dismissed" ? "dismissed" as const : "seen" as const;
    await markSignal({ publicId, ownerSecret: ownerSecretFrom(request), signalId, status });
    return NextResponse.json({ ok: true, status }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
