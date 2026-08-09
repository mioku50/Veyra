import type { GitHubDueDiligenceAssessment } from "../agent/github-due-diligence.ts";
import type { GitHubRepositoryRef } from "../providers/github-repository-ref.ts";
import type { GitHubRepositorySnapshot } from "../providers/github-types.ts";

export type AgentTrustReportInput = {
  agentId?: string;
  agentWallet?: string;
  repositoryUrl?: string;
  contractAddress?: string;
  serviceEndpoint?: string;
};
export type EvidenceItem = {
  id: string;
  category:
    | "code_health"
    | "agent_identity"
    | "execution_reliability"
    | "payment_history"
    | "service_reliability"
    | "contract_transparency";
  signal: "positive" | "review" | "neutral";
  title: string;
  detail: string;
  source: string;
  observedAt: string;
};

export type ScoreCategory = {
  score: number | null;
  confidence: "high" | "medium" | "low";
  evidenceCount: number;
  summary: string;
  positiveSignals: EvidenceItem[];
  reviewItems: EvidenceItem[];
};

export type TrustScore = {
  overall: number | null;
  status:
    | "strong_signals"
    | "review_recommended"
    | "high_attention"
    | "limited_data";
  categories: {
    codeHealth?: ScoreCategory;
    agentIdentity?: ScoreCategory;
    executionReliability?: ScoreCategory;
    paymentHistory?: ScoreCategory;
    serviceReliability?: ScoreCategory;
    contractTransparency?: ScoreCategory;
  };
  excludedCategories: string[];
};

export type AgentIdentitySnapshot = {
  status: "found" | "not_found" | "unavailable";
  publicAgentId: string | null;
  displayName: string | null;
  registeredWallet: string | null;
  ownerVerified: boolean | null;
  agentStatus: "active" | "suspended" | "pending" | "revoked" | "unknown";
  registeredAt: string | null;
  passportPresent: boolean;
  activeCredentialCount: number | null;
  allowedWorkflows: string[];
  policy: {
    status: "active" | "paused" | "unknown";
    maxPricePerRunUsdc: string | null;
    dailySpendLimitUsdc: string | null;
    maxDailyCalls: number | null;
    allowedServiceTypes: string[];
  } | null;
  identifierConflict: boolean;
  privateAggregatesAuthorized: boolean;
  checkedAt: string;
};

export type ExecutionHistorySnapshot = {
  status: "available" | "restricted" | "unavailable" | "insufficient";
  completedRuns: number | null;
  completedWithWarnings: number | null;
  failedRuns: number | null;
  successRate: number | null;
  verifiedRuns: number | null;
  verificationCoverage: number | null;
  totalPaidUsdc: string | null;
  averageWorkflowCostUsdc: string | null;
  lastActivityAt: string | null;
  uniqueWorkflowsUsed: number | null;
  sellerServicesUsed: number | null;
  receiptsCount: number | null;
  checkedAt: string;
};

export type AgentServiceSignal = {
  publicId: string;
  name: string;
  status: string;
  version: number;
  priceUsdc: string;
  availabilityStatus: string;
  successfulExecutions: number | null;
  failureRate: number | null;
  medianLatencyMs: number | null;
  verifiedSettlementCount: number | null;
  lastSuccessfulExecutionAt: string | null;
  executionHistoryStatus: "available" | "insufficient";
};

export type ServiceSignalsSnapshot = {
  status: "available" | "not_found" | "unavailable";
  publishedServiceCount: number;
  services: AgentServiceSignal[];
  checkedAt: string;
};

export type ContractTransparencySnapshot = {
  status: "available" | "not_found" | "unavailable" | "not_provided";
  network: "arc-testnet";
  chainId: 5_042_002;
  address: string | null;
  hasBytecode: boolean | null;
  bytecodeSize: number | null;
  proxyDetected: boolean | null;
  implementationAddress: string | null;
  adminAddress: string | null;
  ownerAddress: string | null;
  pausable: boolean | null;
  upgradeable: boolean | null;
  verificationStatus: "verified" | "unverified" | "unavailable";
  recentEventsStatus: "available" | "unavailable";
  providerMessage: string | null;
  checkedAt: string;
};

export type EndpointAvailabilitySnapshot = {
  status: "available" | "invalid" | "blocked" | "unreachable" | "not_provided";
  endpoint: string | null;
  reachable: boolean | null;
  httpStatusCategory: string | null;
  responseTimeMs: number | null;
  contentType: string | null;
  checkedAt: string;
  redirectCount: number;
  errorCategory:
    | "endpoint_invalid"
    | "endpoint_private_network_blocked"
    | "endpoint_unreachable"
    | "endpoint_response_too_large"
    | "endpoint_timeout"
    | null;
};

export type CodeIntelligenceSnapshot = {
  status: "available" | "unavailable" | "not_provided";
  repository: GitHubRepositoryRef | null;
  snapshot: GitHubRepositorySnapshot | null;
  assessment: GitHubDueDiligenceAssessment | null;
  checkedAt: string;
};

export type ArcComplianceSnapshot = {
  status: "clear" | "blocklisted" | "unknown" | "not_provided";
  wallet: string | null;
  source: "Arc USDC onchain blocklist";
  checkedAt: string;
};

export type AgentTrustSourceSnapshots = {
  code: CodeIntelligenceSnapshot;
  identity: AgentIdentitySnapshot;
  execution: ExecutionHistorySnapshot;
  services: ServiceSignalsSnapshot;
  contract: ContractTransparencySnapshot;
  endpoint: EndpointAvailabilitySnapshot;
  arcCompliance: ArcComplianceSnapshot;
};

export type AgentTrustVerification = {
  status: "verified" | "verification_pending" | "verification_failed";
  verifiedOnArc: boolean;
  network: "arc-testnet";
  chainId: 5_042_002;
  reportHash: string;
  proofs: Array<{
    receiptId: string;
    status: "pending" | "verified" | "failed";
    transactionHash: string | null;
    explorerUrl: string | null;
  }>;
};

export type AgentTrustReport = {
  kind: "agent_trust_report";
  version: 1;
  workflowType: "agent_trust_report";
  reportId: string;
  input: AgentTrustReportInput;
  subject: {
    name: string;
    agentId: string | null;
    wallet: string | null;
    repository: GitHubRepositoryRef | null;
  };
  trustScore: TrustScore;
  executiveSummary: string[];
  identity: AgentIdentitySnapshot;
  codeIntelligence: CodeIntelligenceSnapshot;
  executionReliability: ExecutionHistorySnapshot;
  paymentsAndReceipts: ExecutionHistorySnapshot;
  services: ServiceSignalsSnapshot;
  contractTransparency: ContractTransparencySnapshot;
  endpointAvailability: EndpointAvailabilitySnapshot;
  arcCompliance: ArcComplianceSnapshot;
  evidenceBackedStrengths: EvidenceItem[];
  risksAndReviewItems: EvidenceItem[];
  questionsBeforeIntegration: string[];
  evidence: EvidenceItem[];
  dataFreshness: Array<{
    source: string;
    fetchedAt: string;
    cacheMode: string;
    upstreamStatus: string;
  }>;
  unavailableSources: string[];
  limitations: string[];
  githubDueDiligenceReportUrl: string | null;
  verification: AgentTrustVerification;
  generatedAt: string;
};
