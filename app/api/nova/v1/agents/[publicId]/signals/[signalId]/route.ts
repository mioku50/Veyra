/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { NovaError, markSignal } from "@/lib/nova/service";
import { NOVA_FEEDBACK, type NovaFeedback } from "@/lib/nova/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string; signalId: string }> };

/**
 * What a person says about one item, and what Nova learns from it.
 *
 * An unknown verb falls back to "seen" rather than being rejected. A client a
 * version ahead of the server would otherwise lose the read state along with
 * the opinion, and losing the smaller fact for the sake of strictness about the
 * larger one helps nobody.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId, signalId } = await params;
    const body = await request.json().catch(() => ({})) as { feedback?: unknown; status?: unknown; reason?: unknown; note?: unknown };
    // `status` is still read so an older client keeps working.
    const asked = typeof body.feedback === "string"
      ? body.feedback
      : body.status === "dismissed" ? "not_interesting" : "seen";
    const feedback = (NOVA_FEEDBACK as readonly string[]).includes(asked)
      ? asked as NovaFeedback
      : "seen";

    /* A reason travels with its verdict, never alone. A body carrying only a
       reason would fall back to "seen" above and quietly bring a dismissed
       card back, which is the smaller fact destroying the larger one. */
    if (typeof body.feedback !== "string" && (body.reason !== undefined || body.note !== undefined)) {
      throw new NovaError("A reason is given together with a rating.", "reason_without_rating");
    }
    const { learned, rated } = await markSignal({
      publicId, ownerSecret: ownerSecretFrom(request), signalId, feedback,
      reason: body.reason, note: body.note,
    });
    return NextResponse.json({ ok: true, feedback, learned, rated }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
