/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/nova/service";
import { publishMissingArcProofs } from "@/lib/nova/arc-proof";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Puts verified Nova purchases that predate onchain publishing onto Arc.
 *
 * New purchases publish as they settle. This exists for the ones that settled
 * before that, and it lives as a route rather than only a script because the
 * environment holding the attester key is production -- a backfill that can
 * only be run from a laptop that does not have the key is a backfill nobody
 * can run.
 *
 * Same bearer guard as the payment-event recovery route beside it: writing to
 * a registry is signing with Veyra's own key, and the ability to trigger that
 * belongs to whoever holds the token, not to anyone who finds the URL.
 */
function authorized(request: Request) {
  const expected = process.env.AGENT_COMMERCE_PROOF_RECOVERY_TOKEN;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const published = await publishMissingArcProofs({ db: db() });
    return NextResponse.json({
      ok: true,
      considered: published.length,
      published: published.filter((entry) => entry.published),
      unreachable: published.filter((entry) => !entry.published).map((entry) => entry.executionPublicId),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 300) : "Could not publish." },
      { status: 500 },
    );
  }
}
