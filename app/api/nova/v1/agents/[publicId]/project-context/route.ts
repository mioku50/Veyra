/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { projectContextFor, resolveProjectContextProposal, setProjectContext } from "@/lib/nova/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

/** What the owner says is already true about the work, and what Nova has
 *  asked them to confirm. */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const context = await projectContextFor({ publicId, ownerSecret: ownerSecretFrom(request) });
    return NextResponse.json({ context }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}

/**
 * Replace the confirmed list.
 *
 * Only the owner's own statements move through here. Nova's suggestions are
 * answered by POST, one at a time, because "save my project context" and
 * "yes, that inference about my project is correct" are different acts and a
 * single endpoint that did both would let the second happen by accident.
 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const body = await request.json().catch(() => ({})) as { statements?: unknown };
    const context = await setProjectContext({
      publicId,
      ownerSecret: ownerSecretFrom(request),
      statements: body.statements,
    });
    return NextResponse.json({ context }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}

/** Answer one proposal: the only path from Nova's inference to a statement an
 *  assessment may rely on. */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const body = await request.json().catch(() => ({})) as { contextId?: unknown; action?: unknown };
    const context = await resolveProjectContextProposal({
      publicId,
      ownerSecret: ownerSecretFrom(request),
      contextId: String(body.contextId ?? ""),
      action: body.action === "confirm" ? "confirm" : "dismiss",
    });
    return NextResponse.json({ context }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
