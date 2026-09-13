/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { loadSignalForOwner } from "@/lib/nova/service";
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
 * The wallet is optional. With one, Veyra can read its Circle Gateway balance
 * and say whether a candidate is payable right now; without one it assumes no
 * deposit, which is both the safe assumption and the true one for almost
 * everybody holding a Nova.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, signalId } = await params;
    const body = await request.json().catch(() => ({})) as { wallet?: unknown };
    const wallet = typeof body.wallet === "string" ? body.wallet : null;

    const signal = await loadSignalForOwner({
      publicId,
      ownerSecret: ownerSecretFrom(request),
      signalId,
    });

    const outcome = await proposeResearch({ signal, wallet });
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
    return NextResponse.json({ ok: true, proposal: outcome.proposal }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
