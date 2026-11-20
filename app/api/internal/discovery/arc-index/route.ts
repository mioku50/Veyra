/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { refreshArcOfferIndex, runArcOfferChecks } from "@/lib/discovery/arc-offer-index";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const secret = process.env.CRON_SECRET?.trim();
  const expected = Buffer.from(secret ? `Bearer ${secret}` : "");
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const mode = request.nextUrl.searchParams.get("mode");
  const headers = { "Cache-Control": "no-store" };
  try {
    if (mode === "listings") {
      const result = await refreshArcOfferIndex();
      return NextResponse.json(result, { status: result.available ? 200 : 503, headers });
    }
    if (mode === "checks") {
      const result = await runArcOfferChecks();
      return NextResponse.json(result, { status: result.failed || !result.pruned ? 503 : 200, headers });
    }
    return NextResponse.json({ error: "unknown_mode" }, { status: 400, headers });
  } catch {
    return NextResponse.json({ error: "arc_offer_index_unavailable" }, { status: 503, headers });
  }
}
