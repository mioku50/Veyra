/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { approveResearch } from "@/lib/nova/investigation";

export const dynamic = "force-dynamic";
/* A full re-read of the market plus a live 402 challenge for the exact body.
   Slower than the default allows, and somebody is holding a wallet open. */
export const maxDuration = 60;

type RouteContext = { params: Promise<{ publicId: string; signalId: string }> };

/**
 * Reads the market again, and authorises only what it finds unchanged.
 *
 * This is the first point in the whole flow at which anything is signed, and it
 * signs nothing until the seven facts the card showed -- provider, endpoint,
 * capability, price, payee, network, rail -- have been measured again and
 * matched. A difference stops the payment and comes back as an answer, not an
 * error: the new terms, the changed fields side by side, and a hash of what is
 * true now.
 *
 * Confirming means sending that hash back. It is deliberately not a boolean: a
 * price that moves twice must not be payable by a click that only ever saw the
 * first move, and `acknowledge: true` could not tell the difference.
 *
 * A 200 with `ok: false` throughout, because none of this is a failure. Veyra
 * looking and stopping is the product working.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, signalId } = await params;
    const body = await request.json().catch(() => ({})) as {
      wallet?: unknown;
      acknowledge?: unknown;
    };

    const outcome = await approveResearch({
      publicId,
      ownerSecret: ownerSecretFrom(request),
      signalId,
      wallet: typeof body.wallet === "string" ? body.wallet : "",
      acknowledged: typeof body.acknowledge === "string" ? body.acknowledge : null,
    });

    return NextResponse.json(outcome, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
