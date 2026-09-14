/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { loadOwned, NovaError } from "@/lib/nova/service";
import { setOwnerFeedback } from "@/lib/nova/autonomy-db";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string; decisionId: string }> };

/**
 * What the owner made of a decision Nova would have paid for.
 *
 * The half of shadow autonomy a database cannot produce. The counts say
 * whether the limits were right; only the person who would have paid can say
 * whether the judgement was worth funding, and that is the question the whole
 * rehearsal exists to answer.
 *
 * Nothing here can move money, and nothing here changes a limit. It records an
 * opinion against a decision that already happened.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, decisionId } = await params;
    const body = await request.json().catch(() => ({})) as { feedback?: unknown };
    if (body.feedback !== "useful" && body.feedback !== "not_worth_it") {
      throw new NovaError("Say either useful or not_worth_it.", "bad_request", 400);
    }

    const agent = await loadOwned(publicId, ownerSecretFrom(request));
    const changed = await setOwnerFeedback({
      agentId: agent.agent_id,
      decisionId,
      feedback: body.feedback,
      at: new Date(),
    });
    if (!changed) throw new NovaError("No such decision.", "not_found", 404);

    return NextResponse.json({ ok: true, feedback: body.feedback }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
