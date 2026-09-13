/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runScheduledTick } from "@/lib/nova/schedule";

export const dynamic = "force-dynamic";
/* A tick is bounded to 210s of work; this leaves room for the sweep, the claim
   round-trips and a slow final refresh to finish rather than be cut off
   holding a claim. */
export const maxDuration = 300;

/**
 * Nova's heartbeat.
 *
 * Deliberately not a route that does the work itself: everything here is the
 * doorway, and {@link runScheduledTick} is the thing under test. A cron
 * endpoint that contains its own logic can only be exercised by calling it
 * over HTTP with the production secret, which is not a test anyone runs.
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

export async function GET(request: Request) {
  /* 404, not 401. This path either belongs to the scheduler or does not exist,
     and confirming that Veyra runs a Nova cron is free information for someone
     probing for one. */
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  try {
    const outcome = await runScheduledTick();
    return NextResponse.json(
      { ok: true, ...outcome },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    /* The tick already survives one agent failing. Reaching here means the
       sweep or the claim query failed, which is a database problem, not an
       agent problem -- reported as a 503 so a retry is the obvious response. */
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Tick failed." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
