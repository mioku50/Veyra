/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { reportMiss } from "@/lib/nova/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

/**
 * Something the owner says Nova should have shown them.
 *
 * Answers with what Nova had -- the article itself, the publisher but not the
 * article, or nothing from that site -- and records the miss for the coverage
 * report. The link is parsed, never fetched.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const body = await request.json().catch(() => ({})) as { url?: unknown; note?: unknown };
    const miss = await reportMiss({ publicId, ownerSecret: ownerSecretFrom(request), url: body.url, note: body.note });
    return NextResponse.json({ ok: true, miss }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
