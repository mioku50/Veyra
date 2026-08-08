import { keccak256, toBytes } from "viem";
import type { TrustDecision } from "./types.ts";

export function computeCanonicalDecisionHash(decision: TrustDecision): string {
  const payload = {
    decisionId: decision.decisionId,
    decision: decision.decision,
    subjectAgentId: decision.subject.agentId,
    subjectWallet: decision.subject.wallet || null,
    trustSnapshotHash: decision.trust.snapshotHash,
    requestAction: decision.request.action,
    requestRequestedValueUsdc: decision.request.requestedValueUsdc,
    requestCounterparty: decision.request.counterparty || null,
    requestExecutor: decision.request.executor || null,
    requestServiceId: decision.request.serviceId || null,
    requestWorkflowType: decision.request.workflowType || null,
    policyVersion: decision.policy.version,
    policyMaxValueUsdc: decision.policy.maxValueUsdc,
    policyEvaluatorRequired: decision.policy.evaluatorRequired,
    policyEvaluatorAddress: decision.policy.evaluatorAddress || null,
    reasons: [...decision.reasons].sort(),
    riskSignals: [...decision.riskSignals].sort(),
    issuedAt: decision.issuedAt,
    expiresAt: decision.expiresAt,
  };

  const sortedKeys = Object.keys(payload).sort();
  const sortedPayload: Record<string, any> = {};
  for (const key of sortedKeys) {
    sortedPayload[key] = (payload as any)[key];
  }

  const jsonString = JSON.stringify(sortedPayload);
  return keccak256(toBytes(jsonString));
}
