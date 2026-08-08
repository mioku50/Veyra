import { NextResponse, type NextRequest } from "next/server";
import { fetchTrustDecision } from "@/lib/trust-gate/db";

export async function GET(request: NextRequest, context: { params: Promise<{ decisionId: string }> }) {
  try {
    const { decisionId } = await context.params;
    const decision = await fetchTrustDecision(decisionId);

    if (!decision) {
      return NextResponse.json({ error: "Decision not found" }, { status: 404 });
    }

    return NextResponse.json({
      decisionId: decision.decisionId,
      decision: decision.decision,
      subject: { agentId: decision.subject.agentId },
      trust: decision.trust,
      request: {
        action: decision.request.action,
        requestedValueUsdc: decision.request.requestedValueUsdc,
        serviceId: decision.request.serviceId,
        workflowType: decision.request.workflowType,
      },
      policy: decision.policy,
      reasons: decision.reasons,
      riskSignals: decision.riskSignals,
      issuedAt: decision.issuedAt,
      expiresAt: decision.expiresAt,
      canonicalHash: decision.canonicalHash,
    });
  } catch {
    return NextResponse.json({ error: "Trust decision storage is unavailable." }, { status: 503 });
  }
}
