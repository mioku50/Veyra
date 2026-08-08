import { NextRequest, NextResponse } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { fetchCounterpartySelection } from "@/lib/counterparty-selection/db";
import { counterpartyErrorResponse } from "@/lib/counterparty-selection/http";
import { CounterpartySelectionError } from "@/lib/counterparty-selection/service";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ selectionId: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authenticateSelectionRequest(request, "results:read");
  if (!auth.ok) return auth.response;
  try {
    const { selectionId } = await params;
    const selection = await fetchCounterpartySelection(selectionId, auth.tenant);
    if (!selection) throw new CounterpartySelectionError("selection_not_found", 404);
    return NextResponse.json({
      selectionId: selection.selectionId,
      canonicalHash: selection.canonicalHash,
      policyVersion: selection.policyVersion,
      rankingVersion: selection.rankingVersion,
      candidates: selection.candidates.map((candidate) => ({
        agentId: candidate.identity?.agentId ?? null,
        serviceId: candidate.serviceId ?? null,
        eligibility: candidate.eligibility,
        trustDecision: candidate.trustDecision,
        evidenceHash: candidate.evidenceHash,
        evidenceCount: candidate.evidenceCount,
        evidenceCoverage: candidate.evidenceCoverage,
        sources: candidate.evidenceSources,
        dimensions: candidate.dimensions,
        reasons: candidate.topReasons,
        risks: candidate.riskSignals,
        tradeoffs: candidate.tradeoffs,
        refreshSuggested: candidate.refreshSuggested,
        refreshableModules: candidate.refreshableModules,
      })),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return counterpartyErrorResponse(error);
  }
}
