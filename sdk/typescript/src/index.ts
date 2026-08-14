export type MachineErrorCode =
  | "agent_trust_input_required"
  | "agent_not_found"
  | "agent_access_denied"
  | "agent_registry_unavailable"
  | "agent_trust_service_unavailable"
  | "contract_not_found"
  | "contract_provider_unavailable"
  | "endpoint_invalid"
  | "endpoint_private_network_blocked"
  | "endpoint_unreachable"
  | "endpoint_response_too_large"
  | "insufficient_trust_evidence"
  | "invalid_wallet"
  | "invalid_repository"
  | "repository_not_found"
  | "repository_inaccessible"
  | "credential_missing"
  | "credential_revoked"
  | "scope_denied"
  | "workflow_disabled"
  | "quote_expired"
  | "quote_not_found"
  | "quote_already_used"
  | "idempotency_key_missing"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "idempotency_store_unavailable"
  | "invalid_request"
  | "payment_required"
  | "payment_invalid"
  | "spending_limit_exceeded"
  | "run_not_found"
  | "run_failed"
  | "run_expired"
  | "report_not_found"
  | "report_not_ready"
  | "report_generation_failed"
  | "verification_pending"
  | "provider_unavailable"
  | "rate_limited"
  | "evaluation_not_found"
  | "payment_authorization_required"
  | "request_timeout"
  | "network_error"
  | "poll_timeout"
  | "invalid_response"
  | "internal_error"
  | string;

export type MachineErrorBody = {
  error: {
    code: MachineErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
  };
};

/**
 * Canonical Veyra API error representing structured machine error responses.
 */
export class VeyraApiError extends Error {
  readonly status: number;
  readonly code: MachineErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(input: {
    status: number;
    code: MachineErrorCode;
    message: string;
    retryable: boolean;
    requestId?: string | null;
  }) {
    super(input.message);
    this.name = "VeyraApiError";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
    this.requestId = input.requestId ?? null;
  }
}

/**
 * @deprecated Use `VeyraApiError` instead. Kept for backward compatibility.
 */
export class AgentCommerceApiError extends VeyraApiError {
  constructor(input: {
    status: number;
    code: MachineErrorCode;
    message: string;
    retryable: boolean;
    requestId?: string | null;
  }) {
    super(input);
    this.name = "AgentCommerceApiError";
  }
}

export type WorkflowTemplate = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  task: string;
  estimatedUsdc: number;
  inputSchema: Record<string, unknown>;
  quoteFlow?: {
    discovery?: string;
    quote: string;
    execution: string;
    candidateSelectionRequired: boolean;
  };
  arc: {
    chainId: 5_042_002;
    network: "arc-testnet";
    asset: "USDC";
    tokenAddress: string;
  };
};

export type WorkflowQuoteRequest = {
  workflow: string;
  repository?: string;
  input?: Record<string, unknown>;
};

export type Project360SourceType =
  | "github_repository"
  | "project_wallet"
  | "agent_id"
  | "arc_contract"
  | "public_api_endpoint";

export type Project360Module =
  | "github_due_diligence"
  | "agent_trust_report"
  | "treasury_health"
  | "paid_api_quality"
  | "arc_contract_analysis";

export type Project360Candidate = {
  id: string;
  type: Project360SourceType;
  module: Project360Module;
  value: string;
  provenance: {
    origin: "primary" | "github_file" | "public_record";
    repository: string | null;
    file: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    excerpt: string | null;
  };
  confidence: "high" | "medium" | "low";
  confidenceScore: number;
  reason: string;
  validationStatus: "valid" | "unsupported" | "blocked";
  /** Discovery is advisory: candidates are always returned unchecked. */
  included: false;
};

export type Project360Discovery = {
  id: string;
  status: "queued" | "running" | "ready" | "failed" | "expired";
  revision: number;
  free: true;
  paymentRequired: false;
  primary: { type: Project360SourceType; value: string };
  candidatesHash: string | null;
  candidates: Project360Candidate[];
  warnings: string[];
  errorCode: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
};

export type Project360QuoteSelection = {
  discoveryId: string;
  discoveryRevision: number;
  discoverySnapshotHash: string;
  selectionHash: string;
  expectedCoverage: { selected: number; total: 5 };
  expectedCoverageLabel: string;
  warnings: string[];
  confirmedSources: Array<{
    candidateId: string;
    type: Project360SourceType;
    module: Project360Module;
    canonicalValue: string;
    valueHash: string;
    origin: "primary" | "github_file" | "public_record";
    confidence: "high" | "medium" | "low";
  }>;
  selectedModules: Project360Module[];
  lineItems: Array<{
    module: Project360Module | "project_360_finalization";
    label: string;
    serviceSlugs: string[];
    priceUsdc: number;
    sharedEvidence: boolean;
  }>;
  pricing: {
    moduleSubtotalUsdc: number;
    platformFeeUsdc: number;
    totalUsdc: number;
    amountDueUsdc: number;
  };
  canonicalInput: string;
};

export type Project360Quote = WorkflowQuote & {
  workflow: "project_360";
  project360: Project360QuoteSelection;
};

export type Project360Report = MachineReport & {
  schema: "veyra.project360.v1";
  workflow: "project_360";
  workflowType: "project_360";
  coverage: {
    expected: number;
    completed: number;
    total: 5;
    status: "complete" | "partial" | "limited" | "failed";
    label: string;
  };
  score: {
    formulaVersion: "project360-score-v1";
    value: number | null;
    confidencePercent: number;
    confidence: "high" | "medium" | "low" | "insufficient";
    breakdown: Array<{
      module: Project360Module;
      score: number;
      weight: number;
      confidence: "high" | "medium" | "low" | "insufficient";
    }>;
  };
  sections: Array<{
    number: number;
    id: string;
    title: string;
    status: "available" | "not_provided" | "not_analyzed" | "failed" | "limited";
    summary: string;
    data: unknown;
  }>;
};

export type AgentTrustReportInput = (
  | { agentId: string; agentWallet?: string; repositoryUrl?: string }
  | { agentId?: string; agentWallet: string; repositoryUrl?: string }
  | { agentId?: string; agentWallet?: string; repositoryUrl: string }
) & {
  contractAddress?: string;
  serviceEndpoint?: string;
};

export type AgentTrustQuoteRequest = {
  workflow: "agent_trust_report";
  input: AgentTrustReportInput;
};

export type TrustMonitoringCadence = "manual" | "daily" | "weekly";

export type TrustWatchlist = {
  id: string;
  profileId: string;
  label: string;
  input: AgentTrustReportInput;
  objectType:
    | "github_repository"
    | "ai_agent"
    | "wallet"
    | "arc_contract"
    | "service_endpoint";
  visibility: "private" | "public";
  cadence: TrustMonitoringCadence;
  status: "active" | "paused";
  nextRecheckAt: string | null;
  lastRecheckAt: string | null;
  currentScore: number | null;
  trustStatus: string | null;
  verificationStatus: string | null;
  latestSnapshotId: string | null;
  publicHistoryUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type TrustDeltaChange = {
  code: string;
  kind: "new_risk" | "improved" | "activity" | "status_change" | "changed";
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  summary: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
};

export type TrustDeltaReport = {
  kind: "trust_delta_report";
  version: 1;
  previousSnapshotId: string | null;
  currentSnapshotId: string;
  score: {
    before: number | null;
    after: number | null;
    change: number | null;
    direction: "improved" | "declined" | "unchanged" | "unavailable";
  };
  summary: {
    newRisks: number;
    improvements: number;
    statusChanges: number;
    activityChanges: number;
    totalChanges: number;
  };
  changes: TrustDeltaChange[];
  generatedAt: string;
};

export type TrustHistory = {
  watchlist: {
    id: string;
    profileId: string;
    label: string;
    input: AgentTrustReportInput;
    objectType: TrustWatchlist["objectType"];
    visibility: "private" | "public";
    cadence: TrustMonitoringCadence;
    status: "active" | "paused";
    lastCheckedAt: string | null;
    nextRecheckAt: string | null;
  };
  currentReport: AgentTrustReport | null;
  currentDelta: TrustDeltaReport | null;
  history: Array<{
    snapshotId: string;
    jobId: string;
    sequence: number;
    score: number | null;
    trustStatus: string;
    reportHash: string;
    verificationStatus: string;
    proofTransactionHash: string | null;
    proofUrl: string | null;
    observedAt: string;
    delta: TrustDeltaReport;
    reportUrl: string;
  }>;
};

export type PublicTrustProfile = {
  profile: {
    id: string;
    name: string;
    objectType: TrustWatchlist["objectType"];
    identity: {
      agentId: string | null;
      repositoryUrl: string | null;
      wallet: string | null;
      contractAddress: string | null;
      serviceEndpoint: string | null;
    };
    currentScore: number | null;
    trustStatus: string | null;
    scoreChange: number | null;
    lastCheckedAt: string | null;
    lastVerifiedOnArcAt: string | null;
    snapshotCount: number;
  };
  currentReport: AgentTrustReport | null;
  currentDelta: TrustDeltaReport | null;
  snapshots: Array<{
    snapshotId: string;
    sequence: number;
    score: number | null;
    trustStatus: string;
    reportHash: string;
    verificationStatus: string;
    verifiedOnArc: boolean;
    proofTransactionHash: string | null;
    proofUrl: string | null;
    observedAt: string;
    newRiskCount: number;
    resolvedRiskCount: number;
    delta: TrustDeltaReport;
    fullReportUrl: string;
  }>;
};

export type PublicTrustStatus = {
  profileId: string;
  score: number | null;
  status: string | null;
  verifiedOnArc: boolean;
  lastCheckedAt: string | null;
  profileUrl: string;
};

export type TrustAlertEventType =
  | "trust_score_changed"
  | "trust_status_changed"
  | "risk_added"
  | "risk_resolved"
  | "verification_failed"
  | "recheck_failed"
  | "subject_unavailable";

export type TrustAlert = {
  id: string;
  type: TrustAlertEventType;
  state: "unread" | "read" | "archived";
  message: string;
  profileId: string;
  profileUrl: string;
  snapshotId: string | null;
  snapshotUrl: string;
  change: Record<string, unknown>;
  createdAt: string;
};

export type WebhookSubscription = {
  id: string;
  name: string;
  endpointUrl: string;
  endpointDomain: string;
  profileIds: string[];
  eventTypes: TrustAlertEventType[];
  status: "active" | "paused";
  lastSuccessfulDelivery: string | null;
  lastFailedDelivery: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDelivery = {
  id: string;
  eventId: string;
  eventType: TrustAlertEventType | "test";
  eventCreatedAt: string;
  attemptNumber: number;
  httpStatus: number | null;
  durationMs: number | null;
  status:
    | "pending"
    | "delivering"
    | "delivered"
    | "retry_scheduled"
    | "failed";
  nextRetryAt: string | null;
  errorCategory: string | null;
  deliveredAt: string | null;
};

export type WorkflowPaymentTransaction = {
  protocol: "arc_memo_erc20_v1" | "arc_native_usdc_v1";
  chainId: 5_042_002;
  to: `0x${string}`;
  value: `0x${string}`;
  data: `0x${string}`;
  memo: null | {
    contractAddress: `0x${string}`;
    targetAddress: `0x${string}`;
    memoId: `0x${string}`;
    memoData: `0x${string}`;
    callDataHash: `0x${string}`;
  };
};

export type TrustRecheckQuote = {
  watchlistId: string;
  recheckId: string;
  quoteId: string;
  workflow: "agent_trust_report";
  totalUsdc: number;
  sponsored: boolean;
  checkout: {
    mode: "sponsored" | "arc_transaction";
    asset: "USDC";
    network: "arc-testnet";
  };
  downstreamSettlement: "server_side_x402";
  expiresAt: string;
  requiredPayment: {
    network: "arc-testnet";
    asset: "USDC";
    amount: number;
    treasuryAddress: string;
    chainId: 5_042_002;
    transaction: WorkflowPaymentTransaction | null;
  };
};

export type WorkflowQuote = {
  quoteId: string;
  workflow: string;
  repository: { fullName: string; canonicalUrl: string } | null;
  inputSources?: {
    agentRegistry: boolean;
    github: boolean;
    contract: boolean;
    endpoint: boolean;
  };
  totalUsdc: number;
  sponsored: boolean;
  checkout?: {
    mode: "sponsored" | "arc_transaction";
    asset: "USDC";
    network: "arc-testnet";
  };
  downstreamSettlement?: "server_side_x402";
  expiresAt: string;
  requiredPayment: {
    network: "arc-testnet";
    asset: "USDC";
    amount: number;
    treasuryAddress: string;
    chainId: 5_042_002;
    transaction: WorkflowPaymentTransaction | null;
  };
};

export type PaymentAuthorization = {
  type: "arc_transaction";
  payload: `0x${string}`;
};

export type RunLaunch = {
  runId: string;
  status: "queued";
  pollAfterMs: number;
};

export type VerificationSummary = {
  status:
    | "verified"
    | "partially_verified"
    | "verification_pending"
    | "verification_failed";
  verifiedSteps: number;
  requiredSteps: number;
};

export type RunStatus = {
  runId: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "completed_with_warnings"
    | "failed"
    | "expired";
  progress: number;
  stage: string;
  pollAfterMs: number;
  reportId?: string;
  verification?: VerificationSummary;
};

export type ArcProof = {
  receiptId?: string;
  txHash: string | null;
  status: string;
  explorerUrl: string | null;
};

export type MachineReport = {
  reportId: string;
  workflow: string;
  status: string;
  generatedAt: string;
  executiveSummary?: string;
  summary?: string;
  verdict?: {
    code: string;
    label: string;
    confidence: "high" | "medium" | "low";
    summary: string;
    reasons: string[];
    blockingFindings: string[];
  } | null;
  verification: {
    status: string;
    network: "arc-testnet";
    proofs: ArcProof[];
    verifiedSteps?: number;
    requiredSteps?: number;
  };
  [key: string]: unknown;
};

export type AgentTrustScoreCategory = {
  score: number | null;
  confidence: "high" | "medium" | "low";
  evidenceCount: number;
  summary: string;
  positiveSignals: Array<Record<string, unknown>>;
  reviewItems: Array<Record<string, unknown>>;
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
    repository: { fullName: string; canonicalUrl: string } | null;
  };
  trustScore: {
    overall: number | null;
    status:
      | "strong_signals"
      | "review_recommended"
      | "high_attention"
      | "limited_data";
    categories: Partial<
      Record<
        | "codeHealth"
        | "agentIdentity"
        | "executionReliability"
        | "paymentHistory"
        | "serviceReliability"
        | "contractTransparency",
        AgentTrustScoreCategory
      >
    >;
    excludedCategories: string[];
  };
  executiveSummary: string[];
  identity: Record<string, unknown>;
  codeIntelligence: Record<string, unknown>;
  executionReliability: Record<string, unknown>;
  paymentsAndReceipts: Record<string, unknown>;
  services: Record<string, unknown>;
  contractTransparency: Record<string, unknown>;
  endpointAvailability: Record<string, unknown>;
  evidenceBackedStrengths: Array<Record<string, unknown>>;
  risksAndReviewItems: Array<Record<string, unknown>>;
  questionsBeforeIntegration: string[];
  dataFreshness: Array<{
    source: string;
    fetchedAt: string;
    cacheMode: string;
    upstreamStatus: string;
  }>;
  unavailableSources: string[];
  limitations: string[];
  verification: {
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
  generatedAt: string;
};

export type VeyraClientOptions = {
  baseUrl: string;
  credential: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/**
 * @deprecated Use `VeyraClientOptions` instead.
 */
export type AgentCommerceClientOptions = VeyraClientOptions;

export type CounterpartyCandidateInput = {
  agentId?: string;
  wallet?: string;
  serviceId?: string;
};

export type CounterpartyDiscovery = {
  capability: string;
  network: "eip155:5042002";
  readOnly: true;
  paymentCreated: false;
  jobCreated: false;
  candidates: Array<{
    agentId: string;
    ownerAddress: string;
    registryAddress: string;
    metadataUri: string;
    verifiedOnchain: true;
    source: string;
    services: Array<{
      serviceId: string;
      workflowType: string;
      category: string;
      advertisedPriceUsdc: number;
      priceKind: "advertised";
      capabilityMatch: "exact" | "related" | "generic" | "none";
    }>;
  }>;
};

export type CounterpartySelection = {
  selectionId: string;
  publicId: string;
  capability: string;
  taskHash: string;
  requestedBudgetUsdc: number;
  network: "eip155:5042002";
  policyVersion: string;
  rankingVersion: "veyra-counterparty-selection-v1";
  recommendedAgentId: string;
  recommendedWallet: string;
  recommendedServiceId?: string;
  decision: "ALLOW" | "ALLOW_WITH_LIMITS" | "REQUIRE_EVALUATOR";
  recommendedMaxExposureUsdc: number;
  trustScore: number;
  rankingScore: number;
  confidence: number;
  winnerExplanation: string;
  candidates: Array<Record<string, unknown>>;
  canonicalHash: string;
  createdAt: string;
  expiresAt: string;
  visibility: "private" | "public";
  publicUrl?: string;
  proof?: {
    proofTx: string;
    blockNumber: number;
    proofStatus: "verified";
    evidenceSource: "erc8183_job";
    evidenceSourceId: string;
    evidenceAmountUsdc: number;
    evidenceTx: string;
  };
};

export type CounterpartyClearance = {
  clearanceId: string;
  decisionId: string;
  clearanceDigest: string;
  selectionHash: string;
  clearance: Record<string, string>;
  signature: string;
  issuedAt: string;
  expiresAt: string;
};

export type WaitForRunOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onStatus?: (status: RunStatus) => void | Promise<void>;
};

export type ExecuteWorkflowOptions = {
  quoteIdempotencyKey?: string;
  runIdempotencyKey?: string;
  paymentAuthorization?:
    | PaymentAuthorization
    | ((quote: WorkflowQuote) => Promise<PaymentAuthorization>);
  wait?: WaitForRunOptions;
};

function createIdempotencyKey(prefix: string) {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error(
      "crypto.randomUUID() is required; provide an explicit idempotency key in this runtime.",
    );
  }
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function isMachineErrorBody(value: unknown): value is MachineErrorBody {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(
    error &&
      typeof error === "object" &&
      typeof (error as { code?: unknown }).code === "string" &&
      typeof (error as { message?: unknown }).message === "string",
  );
}

function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Veyra Agent API request timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export class AgentCommerceClient {
  readonly baseUrl: string;
  private readonly credential: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: AgentCommerceClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol)) {
      throw new Error("Veyra Agent API baseUrl must use http or https.");
    }
    if (!options.credential.trim()) {
      throw new Error("Veyra Agent API credential is required.");
    }
    this.baseUrl = baseUrl.toString().replace(/\/$/, "");
    this.credential = options.credential.trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: {
      idempotencyKey?: string;
      accept?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const merged = mergeSignals(options.signal ?? init.signal ?? undefined, this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: merged.signal,
        headers: {
          Authorization: `Bearer ${this.credential}`,
          Accept: options.accept ?? "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(options.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      const body = text ? (JSON.parse(text) as unknown) : null;
      if (!response.ok) {
        if (isMachineErrorBody(body)) {
          throw new AgentCommerceApiError({
            status: response.status,
            code: body.error.code,
            message: body.error.message,
            retryable: Boolean(body.error.retryable),
            requestId: body.error.requestId,
          });
        }
        throw new AgentCommerceApiError({
          status: response.status,
          code: "invalid_response",
          message: `Veyra Agent API returned HTTP ${response.status} without a valid error body.`,
          retryable: response.status >= 500,
          requestId: response.headers.get("x-request-id"),
        });
      }
      return body as T;
    } catch (error) {
      if (error instanceof AgentCommerceApiError) throw error;
      if (merged.signal.aborted) {
        throw new AgentCommerceApiError({
          status: 0,
          code: "request_timeout",
          message: "Veyra Agent API request timed out or was aborted.",
          retryable: true,
        });
      }
      throw new AgentCommerceApiError({
        status: 0,
        code: "network_error",
        message: error instanceof Error ? error.message : "Veyra Agent API network request failed.",
        retryable: true,
      });
    } finally {
      merged.cleanup();
    }
  }

  async listWorkflows(options: { signal?: AbortSignal } = {}) {
    const response = await this.request<{ version: "1"; workflows: WorkflowTemplate[] }>(
      "/api/agent/v1/workflows",
      { method: "GET" },
      options,
    );
    return response.workflows;
  }

  /** Read-only discovery. This method never creates a payment, job, or proof. */
  async discoverCandidates(
    input: { capability: string; network?: "eip155:5042002"; maxPriceUsdc?: number; limit?: number },
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<CounterpartyDiscovery>(
      "/api/trust/v1/counterparties/discover",
      { method: "POST", body: JSON.stringify(input) },
      options,
    );
  }

  async discoverCounterparties(
    input: { capability: string; network?: "eip155:5042002"; maxPriceUsdc?: number; limit?: number },
    options: { signal?: AbortSignal } = {},
  ) {
    return this.discoverCandidates(input, options);
  }

  /** Produces an immutable decision receipt. It does not execute or charge the winner. */
  async selectCounterparty(
    input: {
      capability: string;
      task?: string;
      budgetUsdc: number;
      candidates: CounterpartyCandidateInput[];
      network?: "eip155:5042002";
      requireExactCapability?: boolean;
      visibility?: "private" | "public";
    },
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return this.request<{
      selection: CounterpartySelection;
      replayed: boolean;
      paymentCreated: false;
      jobCreated: false;
      proofPublished: boolean;
    }>(
      "/api/trust/v1/counterparties/select",
      { method: "POST", body: JSON.stringify(input) },
      {
        idempotencyKey: options.idempotencyKey ?? createIdempotencyKey("counterparty-selection"),
        signal: options.signal,
      },
    );
  }

  async getSelection(selectionId: string, options: { signal?: AbortSignal } = {}) {
    return this.request<{ selection: CounterpartySelection }>(
      `/api/trust/v1/selections/${encodeURIComponent(selectionId)}`,
      { method: "GET" },
      options,
    );
  }

  async getEvidence(selectionId: string, options: { signal?: AbortSignal } = {}) {
    return this.request<Record<string, unknown>>(
      `/api/trust/v1/selections/${encodeURIComponent(selectionId)}/evidence`,
      { method: "GET" },
      options,
    );
  }

  async getSelectionEvidence(selectionId: string, options: { signal?: AbortSignal } = {}) {
    return this.getEvidence(selectionId, options);
  }

  async issueClearance(selectionId: string, options: { signal?: AbortSignal } = {}) {
    return this.request<{ clearance: CounterpartyClearance; replayed: boolean; onchainVerified: true }>(
      `/api/trust/v1/selections/${encodeURIComponent(selectionId)}/clearance`,
      { method: "POST" },
      options,
    );
  }

  async issueSelectionClearance(selectionId: string, options: { signal?: AbortSignal } = {}) {
    return this.issueClearance(selectionId, options);
  }

  /** Explicit opt-in Arc publication; no workflow payment or provider execution is created. */
  async publishSelectionProof(selectionId: string, options: { signal?: AbortSignal } = {}) {
    return this.request<{
      proof: NonNullable<CounterpartySelection["proof"]>;
      replayed: boolean;
      chargedUsdc: 0;
      jobCreated: false;
      evidenceReused: true;
    }>(
      `/api/trust/v1/selections/${encodeURIComponent(selectionId)}/proof`,
      { method: "POST" },
      options,
    );
  }

  /**
   * Runs the free, non-transactional Project 360 discovery phase. Returned
   * candidates are advisory and must be explicitly selected before quoting.
   */
  async discoverProject360(
    input: { type: Project360SourceType; value: string },
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return this.request<{ discovery: Project360Discovery; created: boolean }>(
      "/api/agent/v1/project-360/discoveries",
      { method: "POST", body: JSON.stringify(input) },
      {
        idempotencyKey:
          options.idempotencyKey ?? createIdempotencyKey("project360-discovery"),
        signal: options.signal,
      },
    );
  }

  async getProject360Discovery(
    discoveryId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<{ discovery: Project360Discovery }>(
      `/api/agent/v1/project-360/discoveries/${encodeURIComponent(discoveryId)}`,
      { method: "GET" },
      options,
    );
  }

  /** Creates an immutable quote from an explicit discovery selection. */
  async createProject360Quote(
    discoveryId: string,
    input: {
      revision: number;
      selectedCandidateIds: string[];
      modules: Project360Module[];
    },
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return this.request<Project360Quote>(
      `/api/agent/v1/project-360/discoveries/${encodeURIComponent(discoveryId)}/quote`,
      { method: "POST", body: JSON.stringify(input) },
      {
        idempotencyKey:
          options.idempotencyKey ?? createIdempotencyKey("project360-quote"),
        signal: options.signal,
      },
    );
  }

  async listWatchlists(options: { signal?: AbortSignal } = {}) {
    const response = await this.request<{ watchlists: TrustWatchlist[] }>(
      "/api/agent/v1/watchlists",
      { method: "GET" },
      options,
    );
    return response.watchlists;
  }

  async createWatchlist(
    input: {
      label?: string;
      input: AgentTrustReportInput;
      cadence?: TrustMonitoringCadence;
      visibility?: "private" | "public";
    },
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return this.request<TrustWatchlist>(
      "/api/agent/v1/watchlists",
      { method: "POST", body: JSON.stringify(input) },
      {
        idempotencyKey:
          options.idempotencyKey ?? createIdempotencyKey("watchlist"),
        signal: options.signal,
      },
    );
  }

  async getWatchlist(
    watchlistId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<TrustHistory>(
      `/api/agent/v1/watchlists/${encodeURIComponent(watchlistId)}`,
      { method: "GET" },
      options,
    );
  }

  async getPublicTrustProfile(
    profileId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<PublicTrustProfile>(
      `/api/monitoring/public/${encodeURIComponent(profileId)}`,
      { method: "GET" },
      options,
    );
  }

  async getPublicTrustStatus(
    profileId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<PublicTrustStatus>(
      `/api/public/trust/${encodeURIComponent(profileId)}/status`,
      { method: "GET" },
      options,
    );
  }

  async listAlerts(
    filters: {
      profileId?: string;
      type?: TrustAlertEventType;
      state?: "unread" | "read" | "archived";
      signal?: AbortSignal;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (filters.profileId) params.set("profileId", filters.profileId);
    if (filters.type) params.set("type", filters.type);
    if (filters.state) params.set("state", filters.state);
    return this.request<{ alerts: TrustAlert[]; unreadCount: number }>(
      `/api/agent/v1/alerts${params.size ? `?${params}` : ""}`,
      { method: "GET" },
      { signal: filters.signal },
    );
  }

  async markAlertRead(
    alertId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<{ id: string; state: "read" }>(
      `/api/agent/v1/alerts/${encodeURIComponent(alertId)}/read`,
      { method: "POST", body: "{}" },
      options,
    );
  }

  async listWebhooks(options: { signal?: AbortSignal } = {}) {
    const result = await this.request<{ webhooks: WebhookSubscription[] }>(
      "/api/agent/v1/webhooks",
      { method: "GET" },
      options,
    );
    return result.webhooks;
  }

  async createWebhook(
    input: {
      name: string;
      endpointUrl: string;
      profileIds: string[];
      eventTypes: TrustAlertEventType[];
    },
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<{
      webhook: WebhookSubscription;
      secret: string;
      warning: string;
    }>(
      "/api/agent/v1/webhooks",
      { method: "POST", body: JSON.stringify(input) },
      options,
    );
  }

  async updateWebhook(
    webhookId: string,
    input: Partial<{
      name: string;
      endpointUrl: string;
      profileIds: string[];
      eventTypes: TrustAlertEventType[];
      status: "active" | "paused";
    }>,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<WebhookSubscription>(
      `/api/agent/v1/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
      options,
    );
  }

  async deleteWebhook(
    webhookId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<{ deleted: true }>(
      `/api/agent/v1/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "DELETE" },
      options,
    );
  }

  async sendWebhookTest(
    webhookId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<{
      eventId: string;
      deliveryId: string | null;
      scheduled: true;
    }>(
      `/api/agent/v1/webhooks/${encodeURIComponent(webhookId)}/test`,
      { method: "POST", body: "{}" },
      options,
    );
  }

  async rotateWebhookSecret(
    webhookId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<{
      webhook: WebhookSubscription;
      secret: string;
      previousSecretValidUntil: string;
      warning: string;
    }>(
      `/api/agent/v1/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`,
      { method: "POST", body: "{}" },
      options,
    );
  }

  async listWebhookDeliveries(
    webhookId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    const result = await this.request<{ deliveries: WebhookDelivery[] }>(
      `/api/agent/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
      { method: "GET" },
      options,
    );
    return result.deliveries;
  }

  async createWatchlistRecheck(
    watchlistId: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return this.request<TrustRecheckQuote>(
      `/api/agent/v1/watchlists/${encodeURIComponent(watchlistId)}/rechecks`,
      { method: "POST", body: "{}" },
      {
        idempotencyKey:
          options.idempotencyKey ?? createIdempotencyKey("recheck"),
        signal: options.signal,
      },
    );
  }

  async recheckWatchlist(
    watchlistId: string,
    options: Omit<ExecuteWorkflowOptions, "quoteIdempotencyKey"> & {
      recheckIdempotencyKey?: string;
    } = {},
  ) {
    const quote = await this.createWatchlistRecheck(watchlistId, {
      idempotencyKey: options.recheckIdempotencyKey,
      signal: options.wait?.signal,
    });
    let paymentAuthorization: PaymentAuthorization | undefined;
    if (!quote.sponsored) {
      if (typeof options.paymentAuthorization === "function") {
        paymentAuthorization = await options.paymentAuthorization({
          ...quote,
          repository: null,
          requiredPayment: quote.requiredPayment,
        });
      } else {
        paymentAuthorization = options.paymentAuthorization;
      }
      if (!paymentAuthorization) {
        throw new AgentCommerceApiError({
          status: 402,
          code: "payment_authorization_required",
          message:
            "This recheck requires an Arc Testnet payment transaction. Provide paymentAuthorization or a payment callback.",
          retryable: false,
        });
      }
    }
    const launch = await this.createRun(
      { quoteId: quote.quoteId, paymentAuthorization },
      {
        idempotencyKey: options.runIdempotencyKey,
        signal: options.wait?.signal,
      },
    );
    const run = await this.waitForRun(launch.runId, options.wait);
    if (run.status === "failed" || run.status === "expired" || !run.reportId) {
      throw new AgentCommerceApiError({
        status: 422,
        code: run.status === "expired" ? "run_expired" : "run_failed",
        message: `Watchlist recheck ${run.runId} did not produce a report.`,
        retryable: false,
      });
    }
    const [report, history] = await Promise.all([
      this.getReport<AgentTrustReport>(run.reportId, {
        signal: options.wait?.signal,
      }),
      this.getWatchlist(watchlistId, { signal: options.wait?.signal }),
    ]);
    return { quote, launch, run, report, history };
  }

  async createQuote(
    input: WorkflowQuoteRequest,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return this.request<WorkflowQuote>(
      "/api/agent/v1/quotes",
      { method: "POST", body: JSON.stringify(input) },
      {
        idempotencyKey:
          options.idempotencyKey ?? createIdempotencyKey("quote"),
        signal: options.signal,
      },
    );
  }

  async createRun(
    input: { quoteId: string; paymentAuthorization?: PaymentAuthorization },
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return this.request<RunLaunch>(
      "/api/agent/v1/runs",
      { method: "POST", body: JSON.stringify(input) },
      {
        idempotencyKey:
          options.idempotencyKey ?? createIdempotencyKey("run"),
        signal: options.signal,
      },
    );
  }

  async getRun(runId: string, options: { signal?: AbortSignal } = {}) {
    return this.request<RunStatus>(
      `/api/agent/v1/runs/${encodeURIComponent(runId)}`,
      { method: "GET" },
      options,
    );
  }

  async waitForRun(runId: string, options: WaitForRunOptions = {}) {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000;
    const deadline = Date.now() + timeoutMs;
    let transientFailures = 0;

    while (Date.now() < deadline) {
      let status: RunStatus;
      try {
        status = await this.getRun(runId, { signal: options.signal });
        transientFailures = 0;
      } catch (error) {
        if (
          !(error instanceof AgentCommerceApiError) ||
          !error.retryable ||
          transientFailures >= 3
        ) {
          throw error;
        }
        const delay = 500 * 2 ** transientFailures++;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      await options.onStatus?.(status);
      if (
        status.status === "completed" ||
        status.status === "completed_with_warnings" ||
        status.status === "failed" ||
        status.status === "expired"
      ) {
        return status;
      }
      const delay = Math.max(250, Math.min(status.pollAfterMs || 2_000, 10_000));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new AgentCommerceApiError({
      status: 0,
      code: "poll_timeout",
      message: `Run ${runId} did not reach a terminal state before the SDK timeout.`,
      retryable: true,
    });
  }

  async getReport<
    TReport extends MachineReport | AgentTrustReport | Project360Report = MachineReport,
  >(
    reportId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<TReport>(
      `/api/agent/v1/reports/${encodeURIComponent(reportId)}`,
      { method: "GET" },
      options,
    );
  }

  async getReportMarkdown(
    reportId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    const merged = mergeSignals(options.signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/agent/v1/reports/${encodeURIComponent(reportId)}`,
        {
          method: "GET",
          signal: merged.signal,
          headers: {
            Authorization: `Bearer ${this.credential}`,
            Accept: "text/markdown",
          },
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as unknown;
        if (isMachineErrorBody(body)) {
          throw new AgentCommerceApiError({
            status: response.status,
            code: body.error.code,
            message: body.error.message,
            retryable: Boolean(body.error.retryable),
            requestId: body.error.requestId,
          });
        }
        throw new AgentCommerceApiError({
          status: response.status,
          code: "invalid_response",
          message: `Veyra Agent API returned HTTP ${response.status}.`,
          retryable: response.status >= 500,
        });
      }
      return response.text();
    } catch (error) {
      if (error instanceof AgentCommerceApiError) throw error;
      if (merged.signal.aborted) {
        throw new AgentCommerceApiError({
          status: 0,
          code: "request_timeout",
          message: "Veyra Agent API request timed out or was aborted.",
          retryable: true,
        });
      }
      throw new AgentCommerceApiError({
        status: 0,
        code: "network_error",
        message:
          error instanceof Error
            ? error.message
            : "Veyra Agent API network request failed.",
        retryable: true,
      });
    } finally {
      merged.cleanup();
    }
  }

  async executeWorkflow(
    input: WorkflowQuoteRequest,
    options: ExecuteWorkflowOptions = {},
  ) {
    const quote = await this.createQuote(input, {
      idempotencyKey: options.quoteIdempotencyKey,
      signal: options.wait?.signal,
    });
    let paymentAuthorization: PaymentAuthorization | undefined;
    if (!quote.sponsored) {
      if (typeof options.paymentAuthorization === "function") {
        paymentAuthorization = await options.paymentAuthorization(quote);
      } else {
        paymentAuthorization = options.paymentAuthorization;
      }
      if (!paymentAuthorization) {
        throw new AgentCommerceApiError({
          status: 402,
          code: "payment_authorization_required",
          message:
            "This quote requires an Arc Testnet payment transaction. Provide paymentAuthorization or a payment callback.",
          retryable: false,
        });
      }
    }

    const launch = await this.createRun(
      { quoteId: quote.quoteId, paymentAuthorization },
      {
        idempotencyKey: options.runIdempotencyKey,
        signal: options.wait?.signal,
      },
    );
    const run = await this.waitForRun(launch.runId, options.wait);
    if (run.status === "failed" || run.status === "expired" || !run.reportId) {
      throw new AgentCommerceApiError({
        status: 422,
        code: run.status === "expired" ? "run_expired" : "run_failed",
        message:
          run.status === "expired"
            ? `Run ${run.runId} expired before producing a report.`
            : `Run ${run.runId} did not produce a report.`,
        retryable: false,
      });
    }
    const report = await this.getReport(run.reportId, {
      signal: options.wait?.signal,
    });
    return { quote, launch, run, report };
  }

  async prepareErc8183Deliverable(
    input: {
      contentUri: string;
      contentHash: `0x${string}`;
      contentType?: "application/json";
      schemaId?: "veyra://schemas/structured-deliverable-v1";
      policyId?: "structured-deliverable-v1";
    },
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<any>(
      "/api/erc8183/v1/deliverables/prepare",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      options,
    );
  }

  async evaluateErc8183Job(
    input: {
      chainId?: number;
      agenticCommerce: string;
      jobId: string;
      deliverable: any;
    },
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return this.request<{
      evaluationId: string;
      status: string;
      statusUrl: string;
    }>(
      "/api/erc8183/v1/evaluations",
      {
        method: "POST",
        headers: options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
        body: JSON.stringify({
          chainId: input.chainId ?? 5042002,
          agenticCommerce: input.agenticCommerce,
          jobId: input.jobId,
          deliverable: input.deliverable,
        }),
      },
      options,
    );
  }

  async getErc8183Evaluation(
    evaluationId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<any>(
      `/api/erc8183/v1/evaluations/${encodeURIComponent(evaluationId)}`,
      { method: "GET" },
      options,
    );
  }

  // --- P6.1 Trust-Routed Execution & Mandate Methods ---

  async createExecutionMandate(
    input: {
      ownerWallet: string;
      subjectAgentId: string;
      subjectWallet: string;
      mode: "PREVIEW" | "PREPARE" | "AUTOPILOT";
      network?: string;
      allowedCapabilities: string[];
      allowedRails?: ("erc8183" | "x402")[];
      maxPerTransactionUsdc: number;
      maxPerDayUsdc: number;
      maxTotalUsdc: number;
      minimumTrustScore?: number;
      minimumConfidence?: number;
      requireVerifiedIdentity?: boolean;
      evaluatorThresholdUsdc?: number;
      expiresAt: string;
    },
    options: { signal?: AbortSignal } = {}
  ) {
    return this.request<{
      mandateId: string;
      canonicalHash: string;
      eip712Payload: Record<string, any>;
      instructions: string;
    }>("/api/execution/v1/mandates", { method: "POST", body: JSON.stringify(input) }, options);
  }

  async activateExecutionMandate(
    mandateId: string,
    input: {
      ownerWallet: string;
      subjectAgentId: string;
      subjectWallet: string;
      mode: "PREVIEW" | "PREPARE" | "AUTOPILOT";
      network?: string;
      allowedCapabilities: string[];
      allowedRails?: ("erc8183" | "x402")[];
      maxPerTransactionUsdc: number;
      maxPerDayUsdc: number;
      maxTotalUsdc: number;
      minimumTrustScore?: number;
      minimumConfidence?: number;
      requireVerifiedIdentity?: boolean;
      evaluatorThresholdUsdc?: number;
      signature: string;
      expiresAt: string;
    },
    options: { signal?: AbortSignal } = {}
  ) {
    return this.request<{
      success: boolean;
      mandateId: string;
      status: "ACTIVE";
      canonicalHash: string;
      owner: string;
    }>(
      `/api/execution/v1/mandates/${encodeURIComponent(mandateId)}/activate`,
      { method: "POST", body: JSON.stringify(input) },
      options
    );
  }

  async getExecutionMandate(mandateId: string, options: { signal?: AbortSignal } = {}) {
    return this.request<{ mandate: any }>(
      `/api/execution/v1/mandates/${encodeURIComponent(mandateId)}`,
      { method: "GET" },
      options
    );
  }

  async listExecutionMandates(ownerWallet: string, options: { signal?: AbortSignal } = {}) {
    return this.request<{ mandates: any[] }>(
      `/api/execution/v1/mandates?ownerWallet=${encodeURIComponent(ownerWallet)}`,
      { method: "GET" },
      options
    );
  }

  async revokeExecutionMandate(mandateId: string, ownerWallet: string, options: { signal?: AbortSignal } = {}) {
    return this.request<{ success: boolean; mandateId: string; status: "REVOKED" }>(
      `/api/execution/v1/mandates/${encodeURIComponent(mandateId)}/revoke`,
      { method: "POST", body: JSON.stringify({ ownerWallet }) },
      options
    );
  }

  async prepareExecution(
    input: {
      selectionId: string;
      mandateId?: string;
      requestedAmountUsdc: number;
      mode?: "PREVIEW" | "PREPARE" | "AUTOPILOT";
      executorWallet?: string;
    },
    options: { signal?: AbortSignal } = {}
  ) {
    return this.request<any>(
      "/api/execution/v1/prepare",
      { method: "POST", body: JSON.stringify(input) },
      options
    );
  }

  async execute(
    executionId: string,
    input?: { taskPayload?: any },
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ) {
    return this.request<any>(
      `/api/execution/v1/${encodeURIComponent(executionId)}/execute`,
      { method: "POST", body: input ? JSON.stringify(input) : undefined },
      {
        idempotencyKey: options.idempotencyKey ?? createIdempotencyKey("exec"),
        signal: options.signal,
      }
    );
  }

  async runAutopilot(
    input: {
      mandateId: string;
      capability: string;
      task?: Record<string, unknown>;
      requestedBudgetUsdc: number;
    },
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ) {
    return this.request<any>(
      "/api/execution/v1/autopilot",
      { method: "POST", body: JSON.stringify(input) },
      {
        idempotencyKey: options.idempotencyKey ?? createIdempotencyKey("autopilot"),
        signal: options.signal,
      }
    );
  }

  async getExecution(executionId: string, options: { signal?: AbortSignal } = {}) {
    return this.request<{ execution: any }>(
      `/api/execution/v1/${encodeURIComponent(executionId)}`,
      { method: "GET" },
      options
    );
  }

  async getExecutionEvidence(executionId: string, options: { signal?: AbortSignal } = {}) {
    return this.request<any>(
      `/api/execution/v1/${encodeURIComponent(executionId)}/evidence`,
      { method: "GET" },
      options
    );
  }

  get execution() {
    return {
      createMandate: this.createExecutionMandate.bind(this),
      activateMandate: this.activateExecutionMandate.bind(this),
      getMandate: this.getExecutionMandate.bind(this),
      listMandates: this.listExecutionMandates.bind(this),
      revokeMandate: this.revokeExecutionMandate.bind(this),
      prepare: this.prepareExecution.bind(this),
      execute: this.execute.bind(this),
      autopilot: this.runAutopilot.bind(this),
      get: this.getExecution.bind(this),
      getEvidence: this.getExecutionEvidence.bind(this),
    };
  }
}

/** Canonical Veyra Agent API client */
export class VeyraClient extends AgentCommerceClient {}

/** Canonical Veyra SDK client alias */
export class VeyraSDK extends VeyraClient {}

/** Factory to instantiate a VeyraClient */
export function createVeyraClient(options: VeyraClientOptions): VeyraClient {
  return new VeyraClient(options);
}

/** Named facade used by agent examples and integrations. */
export class VeyraTrustSdk extends VeyraClient {}

export function veyraTrustSdk(options: VeyraClientOptions) {
  return new VeyraTrustSdk(options);
}
