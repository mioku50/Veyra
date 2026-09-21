/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { refreshNova } from "@/lib/nova/service";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

type RouteContext = { params: Promise<{ publicId: string }> };

/** Looks at everything the agent watches and records what moved. */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const body = await request.json().catch(() => ({})) as { trigger?: unknown };
    const trigger = body.trigger === "creation" ? "creation" as const : "manual" as const;
    const result = await refreshNova({
      publicId,
      ownerSecret: ownerSecretFrom(request),
      trigger,
    });
    return NextResponse.json(result, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
