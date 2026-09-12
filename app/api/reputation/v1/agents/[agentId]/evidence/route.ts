/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { fetchReputationEvidenceForAgent } from "@/lib/reputation/db.ts";
import { sanitizeEvidenceForPublic } from "@/lib/reputation/engine.ts";

export const revalidate = 30;

export async function GET(req: NextRequest, context: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await context.params;
  const evidenceList = await fetchReputationEvidenceForAgent(agentId);
  const sanitized = sanitizeEvidenceForPublic(evidenceList);

  return NextResponse.json({
    agentId,
    totalEvidenceCount: sanitized.length,
    evidence: sanitized,
  }, {
    headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
  });
}
