/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { fetchReputationSnapshotHistory } from "@/lib/reputation/db.ts";

export const revalidate = 30;

export async function GET(req: NextRequest, context: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await context.params;
  const snapshots = await fetchReputationSnapshotHistory(agentId);

  return NextResponse.json({
    agentId,
    totalSnapshots: snapshots.length,
    history: snapshots,
  }, {
    headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
  });
}
