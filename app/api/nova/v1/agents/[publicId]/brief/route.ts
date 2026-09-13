/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { loadBrief } from "@/lib/nova/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    /* The reader's own hour, sent by the browser. A greeting computed on the
       server says "Good morning" at ten at night for half the world, which is a
       small way of admitting the page was written for nobody in particular. */
    const hour = Number(request.nextUrl.searchParams.get("hour"));
    const brief = await loadBrief({
      publicId,
      ownerSecret: ownerSecretFrom(request),
      hourOfDay: Number.isFinite(hour) ? hour : new Date().getHours(),
    });
    return NextResponse.json(brief, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
