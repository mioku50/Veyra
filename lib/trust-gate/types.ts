export type TrustAction = "erc8183_job" | "x402_payment" | "paid_api_call" | "service_purchase";

export type TrustDecisionLevel = "ALLOW" | "ALLOW_WITH_LIMITS" | "REQUIRE_EVALUATOR" | "REVIEW_REQUIRED" | "DENY";

export type TrustRiskCode =
  | "LOW_CONFIDENCE"
  | "INSUFFICIENT_COVERAGE"
  | "STALE_REPUTATION"
  | "RECENT_JOB_REJECTION"
  | "LOW_EXECUTION_RELIABILITY"
  | "LOW_ECONOMIC_RELIABILITY"
  | "SYBIL_RISK"
  | "VALIDATION_FAILURE"
  | "ARC_PROOF_UNVERIFIED"
  | "VALUE_EXCEEDS_TRUST_LIMIT"
  | "NO_REPUTATION_DATA"
  | "IDENTITY_NOT_FOUND"
  | "SNAPSHOT_HASH_MISMATCH"
  | "COUNTERPARTY_FARMING";

export interface TrustDecisionRequest {
  subjectAgentId: string;
  executorWallet?: string;
  counterpartyAgentId?: string;
  counterpartyWallet?: string;
  action: TrustAction;
  requestedValueUsdc: number;
  serviceId?: string;
  workflowType?: string;
  policyPreset?: string;
}

export interface TrustSubject {
  agentId: string;
  wallet?: string;
}

export interface TrustInfo {
  score: number;
  confidence: number;       // 0-1 numeric
  coverage: number;         // 0-1 numeric
  snapshotHash: string;
  snapshotAgeSeconds: number;
}

export interface TrustRequestInfo {
  action: TrustAction;
  requestedValueUsdc: number;
  counterparty?: string;
  executor?: string;
  serviceId?: string;
  workflowType?: string;
}

export interface TrustPolicyInfo {
  version: string;
  maxValueUsdc: number;
  evaluatorRequired: boolean;
  evaluatorAddress?: string;
}

export interface TrustDecision {
  decisionId: string;
  decision: TrustDecisionLevel;
  subject: TrustSubject;
  trust: TrustInfo;
  request: TrustRequestInfo;
  policy: TrustPolicyInfo;
  reasons: TrustRiskCode[];
  riskSignals: TrustRiskCode[];
  issuedAt: string;
  expiresAt: string;
  canonicalHash: string;
}

export interface PolicyTierConfig {
  level: TrustDecisionLevel;
  minScore: number;
  minConfidence: number;     // 0-1
  minCoverage: number;       // 0-1
  maxFreshnessSeconds: number;
  maxValueUsdc: number;
  evaluatorRequired: boolean;
}

export const TRUST_POLICY_VERSION = "veyra-trust-policy-v1";
export const TRUST_DECISION_EXPIRY_SECONDS = 300;

export function isExecutableTrustDecision(decision: TrustDecisionLevel): boolean {
  return decision === "ALLOW"
    || decision === "ALLOW_WITH_LIMITS"
    || decision === "REQUIRE_EVALUATOR";
}
