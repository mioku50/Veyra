/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { proposeForQuestion } from "@/lib/nova/ask";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { recordProposal } from "@/lib/nova/investigation";
import { loadQuestion, recordQuestionRefusal } from "@/lib/nova/questions";
import { loadOwned } from "@/lib/nova/service";

export const dynamic = "force-dynamic";
/* Up to two passes over the market on Arc, each probing eight endpoints and
   pricing up to four with the exact question. */
export const maxDuration = 120;

type RouteContext = { params: Promise<{ publicId: string; questionId: string }> };

/**
 * A tool on Arc for one of the owner's questions, priced, or why there is
 * none. It spends nothing and authorises nothing: as for a card, the terms are
 * written so that approval is checked against what was shown.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, questionId } = await params;
    const agent = await loadOwned(publicId, ownerSecretFrom(request));
    const question = await loadQuestion(agent.agent_id, questionId);
    const body = await request.json().catch(() => ({})) as { wallet?: unknown };

    const outcome = await proposeForQuestion({
      question,
      wallet: typeof body.wallet === "string" ? body.wallet : null,
    });
    if (!outcome.ok) {
      /* An answer, not an error: kept, so a reload says it again without
         another round of live probes. */
      const refusal = { reason: outcome.reason, detail: outcome.detail, at: new Date().toISOString() };
      await recordQuestionRefusal({ agentId: agent.agent_id, questionId, refusal });
      return NextResponse.json({ ok: false, ...refusal }, { headers: NOVA_HEADERS });
    }

    const researchId = await recordProposal({
      agentId: agent.agent_id,
      questionId,
      proposal: outcome.proposal,
      plan: outcome.plan,
    });
    await recordQuestionRefusal({ agentId: agent.agent_id, questionId, refusal: null });
    return NextResponse.json({ ok: true, researchId, proposal: outcome.proposal }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
