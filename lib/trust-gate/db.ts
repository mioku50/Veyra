import { getByoaClient } from "../byoa/service.ts";
import type { TrustDecision } from "./types.ts";

export type TrustDecisionRow = {
  decision_id: string;
  subject_agent_id: string;
  subject_wallet: string | null;
  executor_wallet: string | null;
  counterparty_agent_id: string | null;
  counterparty_wallet: string | null;
  action: TrustDecision["request"]["action"];
  service_id: string | null;
  workflow_type: string | null;
  requested_value_usdc: string | number;
  decision: TrustDecision["decision"];
  max_value_usdc: string | number;
  snapshot_hash: string | null;
  trust_score: number;
  confidence: number;
  coverage: number;
  snapshot_age_seconds: number;
  policy_version: string;
  evaluator: string | null;
  evaluator_required: boolean;
  reasons: TrustDecision["reasons"];
  risk_signals: TrustDecision["riskSignals"];
  canonical_hash: string;
  issued_at: string;
  expires_at: string;
};

export function trustDecisionToRow(decision: TrustDecision): TrustDecisionRow {
  const counterparty = decision.request.counterparty;
  const counterpartyIsWallet = Boolean(counterparty && /^0x[0-9a-f]{40}$/i.test(counterparty));
  return {
    decision_id: decision.decisionId,
    subject_agent_id: decision.subject.agentId,
    subject_wallet: decision.subject.wallet || null,
    executor_wallet: decision.request.executor || null,
    counterparty_agent_id: counterparty && !counterpartyIsWallet ? counterparty : null,
    counterparty_wallet: counterpartyIsWallet ? counterparty! : null,
    action: decision.request.action,
    service_id: decision.request.serviceId || null,
    workflow_type: decision.request.workflowType || null,
    requested_value_usdc: decision.request.requestedValueUsdc,
    decision: decision.decision,
    max_value_usdc: decision.policy.maxValueUsdc,
    snapshot_hash: decision.trust.snapshotHash || null,
    trust_score: decision.trust.score,
    confidence: decision.trust.confidence,
    coverage: decision.trust.coverage,
    snapshot_age_seconds: decision.trust.snapshotAgeSeconds,
    policy_version: decision.policy.version,
    evaluator: decision.policy.evaluatorAddress || null,
    evaluator_required: decision.policy.evaluatorRequired,
    reasons: decision.reasons,
    risk_signals: decision.riskSignals,
    canonical_hash: decision.canonicalHash,
    issued_at: decision.issuedAt,
    expires_at: decision.expiresAt,
  };
}

function fromRow(row: TrustDecisionRow): TrustDecision {
  return {
    decisionId: row.decision_id,
    decision: row.decision,
    subject: {
      agentId: row.subject_agent_id,
      wallet: row.subject_wallet || undefined,
    },
    trust: {
      score: row.trust_score,
      confidence: row.confidence,
      coverage: row.coverage,
      snapshotHash: row.snapshot_hash || "",
      snapshotAgeSeconds: row.snapshot_age_seconds,
    },
    request: {
      action: row.action,
      requestedValueUsdc: Number(row.requested_value_usdc),
      counterparty: row.counterparty_wallet || row.counterparty_agent_id || undefined,
      executor: row.executor_wallet || undefined,
      serviceId: row.service_id || undefined,
      workflowType: row.workflow_type || undefined,
    },
    policy: {
      version: row.policy_version,
      maxValueUsdc: Number(row.max_value_usdc),
      evaluatorRequired: row.evaluator_required,
      evaluatorAddress: row.evaluator || undefined,
    },
    reasons: row.reasons,
    riskSignals: row.risk_signals,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    canonicalHash: row.canonical_hash,
  };
}

export async function saveTrustDecision(decision: TrustDecision) {
  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("trust_decisions")
    .insert(trustDecisionToRow(decision))
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`trust_decision_storage_unavailable:${error?.code || "insert_failed"}`);
  }
  const reloaded = fromRow(data as TrustDecisionRow);
  if (reloaded.canonicalHash.toLowerCase() !== decision.canonicalHash.toLowerCase()) {
    throw new Error("trust_decision_storage_mismatch");
  }
  return reloaded;
}

export async function fetchTrustDecision(decisionId: string): Promise<TrustDecision | null> {
  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("trust_decisions")
    .select("*")
    .eq("decision_id", decisionId)
    .maybeSingle();
  if (error) {
    throw new Error(`trust_decision_storage_unavailable:${error.code || "query_failed"}`);
  }
  return data ? fromRow(data as TrustDecisionRow) : null;
}
