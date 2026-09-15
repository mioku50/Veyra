/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { sweepUnverifiedSettlements } from "@/lib/execution/reconcile-sweep";

export const dynamic = "force-dynamic";
/* Twenty-five attempts, each at most a couple of eth_calls. The ceiling is for
   an RPC having a bad day, not for the usual case, which finishes in seconds. */
export const maxDuration = 300;

/**
 * The scheduled half of settlement reconciliation.
 *
 * The per-execution route next door is the manual one: someone holds an
 * execution id and asks about it. This one holds nothing and asks about
 * everything still waiting, which is the only version that helps an attempt
 * nobody is watching.
 *
 * Same doorway rules as Nova's tick: the secret, a 404 rather than a 401, and
 * no logic of its own -- {@link sweepUnverifiedSettlements} is the part under
 * test.
 */
function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export async function POST(request: Request) {
  /* 404, not 401: whether Veyra runs a settlement sweep is not information a
     stranger gets for free, and the shape of the answer would give it. */
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  try {
    const outcome = await sweepUnverifiedSettlements();
    return NextResponse.json(
      { ok: true, ...outcome },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    /* The sweep already survives one attempt failing. Reaching here means the
       query itself did not, which is a database problem and worth a retry. */
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Sweep failed." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
