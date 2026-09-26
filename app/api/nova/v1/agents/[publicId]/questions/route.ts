/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { ASK_LIMITS, lookUpDocs, ownerAsk } from "@/lib/nova/ask";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { questionsInLastHour, recordQuestion } from "@/lib/nova/questions";
import { loadOwned, NovaError } from "@/lib/nova/service";

export const dynamic = "force-dynamic";
/* Two reading-model calls, each allowed forty-five seconds, and up to three
   documentation pages read between them. */
export const maxDuration = 120;

type RouteContext = { params: Promise<{ publicId: string }> };

/**
 * A question the owner asks Nova directly.
 *
 * Free: Arc's and Circle's documentation is read for it and answered from, and
 * nothing is priced here. Looking for a paid tool is a separate request, made
 * when the documentation does not answer (see ./[questionId]/research).
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const agent = await loadOwned(publicId, ownerSecretFrom(request));
    const body = await request.json().catch(() => ({})) as { question?: unknown };
    const asked = ownerAsk(body.question);
    if (!asked.ok) return NextResponse.json({ ok: false, reason: asked.reason, detail: asked.detail }, { headers: NOVA_HEADERS });

    if (await questionsInLastHour(agent.agent_id) >= ASK_LIMITS.perHour) {
      throw new NovaError(`${ASK_LIMITS.perHour} questions in an hour is the limit for now. Try again a little later.`, "rate_limited", 429);
    }

    const { searchTerms, docs } = await lookUpDocs({ question: asked.question });
    const question = await recordQuestion({ agentId: agent.agent_id, question: asked.question, searchTerms, docs });
    return NextResponse.json({ ok: true, question }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
