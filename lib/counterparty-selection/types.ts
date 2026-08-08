import type { Hex } from "viem";
import type { TrustDecision, TrustDecisionLevel } from "../trust-gate/types.ts";

export const COUNTERPARTY_RANKING_VERSION = "veyra-counterparty-selection-v1" as const;
export const COUNTERPARTY_NETWORK = "eip155:5042002" as const;

export type CandidateInput = {
  agentId?: string;
  wallet?: string;
  serviceId?: string;
};

export type CapabilityMatch = "exact" | "related" | "generic" | "none";
export type EligibilityStatus =
  | "ELIGIBLE"
  | "ELIGIBLE_WITH_LIMITS"
  | "REQUIRES_EVALUATOR"
  | "REVIEW_REQUIRED"
  | "INELIGIBLE";
export type EvidenceFreshness = "fresh" | "aging" | "stale" | "missing";
export type PriceKind = "advertised" | "historical" | "unknown";

export type CanonicalCandidateIdentity = {
  agentId: string;
  ownerAddress: `0x${string}`;
  agentWallet?: `0x${string}`;
  registryAddress: `0x${string}`;
  metadataUri: string;
  serviceIds: string[];
  source: "erc8004" | "seller_registry" | "observed_service";
  verifiedOnchain: true;
};

export type CandidateService = {
  serviceId: string;
  workflowType: string;
  slug: string;
  category: string;
  status: string;
  reviewStatus: string;
  availabilityStatus: string;
  advertisedPriceUsdc: number;
  sellerWallet: `0x${string}`;
  capabilityMatch: CapabilityMatch;
};

export type EvidenceSourceSummary = {
  source: "identity" | "reputation" | "execution" | "economic" | "service_quality" | "evaluator" | "risk";
  observedAt: string | null;
  ageSeconds: number | null;
  freshness: EvidenceFreshness;
  evidenceCount: number;
};

export type CandidateEvidence = {
  identity: CanonicalCandidateIdentity;
  snapshotHash: Hex;
  snapshotCreatedAt: string;
  trustScore: number;
  snapshotConfidence: number;
  snapshotCoverage: number;
  dimensions: {
    reputationQuality: number;
    executionReliability: number;
    evaluatorSuccess: number;
    economicReliability: number;
    serviceQuality: number;
  };
  evidenceCounts: {
    total: number;
    execution: number;
    evaluator: number;
    economic: number;
    serviceQuality: number;
    independentCounterparties: number;
  };
  sources: EvidenceSourceSummary[];
  riskSignals: string[];
  positiveSignals: string[];
  services: CandidateService[];
  selectedService?: CandidateService;
  evidenceHash: Hex;
};

export type RankingDimensionName =
  | "reputationQuality"
  | "executionReliability"
  | "evaluatorSuccess"
  | "economicReliability"
  | "serviceQuality"
  | "evidenceFreshnessCoverage";

export type RankingDimension = {
  name: RankingDimensionName;
  score: number;
  weight: number;
  evidenceCount: number;
  freshness: EvidenceFreshness;
  confidence: number;
  explanation: string;
};

export type CandidateRankingInput = {
  identity: CanonicalCandidateIdentity;
  evidence: CandidateEvidence;
  trustDecision: TrustDecision;
  requestedBudgetUsdc: number;
  capability: string;
  capabilityMatch: CapabilityMatch;
  requireExactCapability: boolean;
  advertisedPriceUsdc?: number;
  priceKind: PriceKind;
  hardExclusions?: string[];
};

export type RankedCandidate = {
  identity: CanonicalCandidateIdentity;
  serviceId?: string;
  capabilityMatch: CapabilityMatch;
  eligibility: EligibilityStatus;
  trustDecision: TrustDecisionLevel;
  trustDecisionId: string;
  trustDecisionHash: Hex;
  trustScore: number;
  baseQualityScore: number;
  rankingScore: number;
  confidence: number;
  requestedAmountUsdc: number;
  policyMaxExposureUsdc: number;
  recommendedMaxExposureUsdc: number;
  advertisedPriceUsdc?: number;
  historicalMedianPriceUsdc?: number;
  quotedPriceUsdc?: number;
  priceKind: PriceKind;
  evidenceHash: Hex;
  evidenceCoverage: number;
  evidenceCount: number;
  evidenceSources: EvidenceSourceSummary[];
  refreshSuggested: boolean;
  refreshableModules: Array<{ module: string; estimatedCostUsdc: number | null }>;
  dimensions: RankingDimension[];
  topReasons: string[];
  riskSignals: string[];
  tradeoffs: string[];
  rejectionReason?: string;
  rank: number;
};

export type UnresolvedCandidate = {
  identity: CanonicalCandidateIdentity | null;
  candidateInput: CandidateInput;
  serviceId?: string;
  capabilityMatch: "none";
  eligibility: "INELIGIBLE";
  trustDecision: "DENY";
  trustDecisionId?: string;
  trustDecisionHash: Hex;
  trustScore: 0;
  baseQualityScore: 0;
  rankingScore: 0;
  confidence: 0;
  requestedAmountUsdc: number;
  policyMaxExposureUsdc: 0;
  recommendedMaxExposureUsdc: 0;
  advertisedPriceUsdc?: undefined;
  historicalMedianPriceUsdc?: undefined;
  quotedPriceUsdc?: undefined;
  priceKind: "unknown";
  evidenceHash: Hex;
  evidenceCoverage: 0;
  evidenceCount: 0;
  evidenceSources: [];
  refreshSuggested: false;
  refreshableModules: [];
  dimensions: [];
  topReasons: [];
  riskSignals: string[];
  tradeoffs: [];
  rejectionReason: string;
  rank: number;
};

export type SelectionCandidate = RankedCandidate | UnresolvedCandidate;

export type CounterpartySelectionRequest = {
  capability: string;
  task?: string;
  budgetUsdc: number;
  candidates: CandidateInput[];
  network?: string;
  requireExactCapability?: boolean;
  publishProof?: false;
  visibility?: "private" | "public";
};

export type CounterpartyDiscoveryRequest = {
  capability: string;
  network?: string;
  maxPriceUsdc?: number;
  limit?: number;
};

export type SelectionProof = {
  proofTx: Hex;
  blockNumber: number;
  proofStatus: "verified";
  evidenceSource: "erc8183_job";
  evidenceSourceId: string;
  evidenceAmountUsdc: number;
  evidenceTx: Hex;
};

export type SelectionClearance = {
  clearanceId: string;
  decisionId: string;
  clearanceDigest: Hex;
  selectionHash: Hex;
  clearance: Record<string, string>;
  signature: Hex;
  issuedAt: string;
  expiresAt: string;
};

export type CounterpartySelection = {
  selectionId: string;
  publicId: string;
  requester: {
    agentId?: string;
    wallet: `0x${string}`;
  };
  capability: string;
  taskHash: Hex;
  requestedBudgetUsdc: number;
  network: typeof COUNTERPARTY_NETWORK;
  requireExactCapability: boolean;
  policyVersion: string;
  rankingVersion: typeof COUNTERPARTY_RANKING_VERSION;
  recommendedAgentId: string;
  recommendedWallet: `0x${string}`;
  recommendedServiceId?: string;
  decision: "ALLOW" | "ALLOW_WITH_LIMITS" | "REQUIRE_EVALUATOR";
  recommendedMaxExposureUsdc: number;
  trustScore: number;
  rankingScore: number;
  confidence: number;
  winnerExplanation: string;
  candidates: SelectionCandidate[];
  canonicalHash: Hex;
  createdAt: string;
  expiresAt: string;
  visibility: "private" | "public";
  publicUrl?: string;
  proof?: SelectionProof;
};

export type SelectionTenant = {
  tenantKey: string;
  requesterAgentId?: string;
  requesterWallet: `0x${string}`;
  machineCredentialId?: string;
};

export type SelectionCanonicalPayload = {
  schema: "veyra.counterparty-selection.v1";
  selectionId: string;
  requester: {
    agentId: string | null;
    wallet: string;
  };
  intent: {
    capability: string;
    taskHash: Hex;
    requestedBudgetUsdc: string;
    network: typeof COUNTERPARTY_NETWORK;
    requireExactCapability: boolean;
  };
  selectedCandidateSet: Array<{
    candidateKey: Hex;
    agentId: string | null;
    ownerAddress: string | null;
    serviceId: string | null;
    evidenceHash: Hex;
    trustDecisionHash: Hex;
  }>;
  finalRanking: Array<{
    candidateKey: Hex;
    agentId: string | null;
    rank: number;
    eligibility: EligibilityStatus;
    rankingScore: number;
    trustScore: number;
    confidence: number;
    maxExposureUsdc: string;
  }>;
  winner: {
    agentId: string;
    ownerAddress: string;
    serviceId: string | null;
    trustDecision: "ALLOW" | "ALLOW_WITH_LIMITS" | "REQUIRE_EVALUATOR";
    maxExposureUsdc: string;
  };
  policyVersion: string;
  rankingVersion: typeof COUNTERPARTY_RANKING_VERSION;
  createdAt: string;
  expiresAt: string;
};
