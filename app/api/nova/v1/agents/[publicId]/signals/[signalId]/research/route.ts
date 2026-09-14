/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { recentLearnings, recordProposal } from "@/lib/nova/investigation";
import { loadOwned, loadSignalForOwner } from "@/lib/nova/service";
import { proposeResearch } from "@/lib/nova/research";

export const dynamic = "force-dynamic";
/* Discovery, then a live 402 probe against every candidate. Eight endpoints on
   a slow morning is more than the default allows, and a person is watching. */
export const maxDuration = 60;

type RouteContext = { params: Promise<{ publicId: string; signalId: string }> };

/**
 * What it would cost to look deeper, and who would be paid.
 *
 * A POST because it is not free to serve -- it probes live endpoints -- but it
 * spends nothing and authorises nothing. No clearance is issued here: a
 * clearance is a signed permission bound to a wallet, and producing one just
 * because somebody read their brief would mean reading was an act of consent.
 *
 * What it does write is the terms. Approval is checked against what this card
 * actually said, which only works if what it said still exists somewhere the
 * page cannot edit.
 *
 * The wallet is optional. With one, Veyra can read its Circle Gateway balance
 * and say whether a candidate is payable right now; without one it assumes no
 * deposit, which is both the safe assumption and the true one for almost
 * everybody holding a Nova.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, signalId } = await params;
    const ownerSecret = ownerSecretFrom(request);
    const body = await request.json().catch(() => ({})) as { wallet?: unknown };
    const wallet = typeof body.wallet === "string" ? body.wallet : null;

    const [agent, signal] = await Promise.all([
      loadOwned(publicId, ownerSecret),
      loadSignalForOwner({ publicId, ownerSecret, signalId }),
    ]);

    /* The context the question is written from. One model serves every agent;
       what makes this question Nova's is these interests and this memory, not a
       model of its own. */
    const outcome = await proposeResearch({
      signal,
      wallet,
      agentName: agent.name,
      interests: agent.interests ?? [],
      memory: await recentLearnings(agent.agent_id),
    });
    if (!outcome.ok) {
      /* 200, not an error status. "Veyra looked and would not authorise any of
         them" is an answer, and the most useful one the product gives -- a 4xx
         would make the client render it as a failure of Nova rather than a
         decision by Veyra. */
      return NextResponse.json(
        { ok: false, reason: outcome.reason, detail: outcome.detail },
        { headers: NOVA_HEADERS },
      );
    }

    const researchId = await recordProposal({
      agentId: agent.agent_id,
      signalId,
      proposal: outcome.proposal,
      plan: outcome.plan,
    });

    return NextResponse.json(
      { ok: true, researchId, proposal: outcome.proposal },
      { headers: NOVA_HEADERS },
    );
  } catch (error) {
    return novaErrorResponse(error);
  }
}
