/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { NextResponse } from "next/server";
import { getCachedArcStateReport } from "@/lib/discovery/arc-state-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  const report = await getCachedArcStateReport();
  if (!report) {
    return NextResponse.json(
      { error: "state_unavailable", message: "Arc x402 state metrics are temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(report, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=600, stale-while-revalidate=600",
    },
  });
}
