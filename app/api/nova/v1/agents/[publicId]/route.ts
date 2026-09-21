/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { getNova, updateNova } from "@/lib/nova/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

/** The agent itself, for the holder of its secret. */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const agent = await getNova(publicId, ownerSecretFrom(request));
    return NextResponse.json({ agent }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}

/**
 * Changes what the agent cares about.
 *
 * Only the interests. The name is what a person called it and the wallet is
 * theirs to connect; neither belongs behind the same button as "follow
 * something else instead", and an endpoint that can quietly rewrite all three
 * is a larger thing to get wrong.
 *
 * The refresh is not done here. Re-resolving subjects means eight or more live
 * HTTP reads, and folding that into the save would make a person wait on the
 * network to find out whether a checkbox was accepted. The client saves, sees
 * the answer, and then asks for a refresh -- which is the same request the
 * "Look again" button already makes.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const ownerSecret = ownerSecretFrom(request);
    const body = await request.json().catch(() => ({})) as { interests?: unknown; goal?: unknown };

    const result = await updateNova({ publicId, ownerSecret, interests: body.interests, goal: body.goal });

    return NextResponse.json({
      agent: result.agent,
      /* Said back, because dropping an interest quietly removes cards a person
         was looking at a moment ago, and a change they cannot see the size of
         is one they cannot undo with any confidence. */
      droppedInterests: result.droppedInterests,
      retiredSignals: result.retiredSignals,
    }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
