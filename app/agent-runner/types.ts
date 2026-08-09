import type { GitHubRepositoryRef } from "@/lib/providers/github-repository-ref";

import type { HostedWorkflowType } from "@/lib/agent/hosted-workflows";
import type { WorkflowPaymentDescriptor } from "@/lib/commerce/workflow-payment";

export type { HostedWorkflowType };

export type PythMarketSymbol = "BTC/USD" | "ETH/USD" | "SOL/USD";

import type { ServicePresentationMetadata } from "@/lib/services/presentation";

export type { ServicePresentationMetadata };

export type HostedPlanService = {
  id: string;
  slug: string;
  name: string;
  endpoint: string;
  method: "GET" | "POST";
  priceUsdc: number;
  reasoning: string;
  presentation: ServicePresentationMetadata;
};

export type HostedPlannerSnapshot = {
  workflowType: HostedWorkflowType;
  workflowLabel: string;
  selectedServices: HostedPlanService[];
  skippedServices: HostedPlanService[];
  estimatedSpendUsdc: number;
  remainingBudgetUsdc: number;
  maxPaidCalls: number;
  aggregationLabel: string;
  inputPreview: string;
  inputSha256: string;
  marketSymbol: PythMarketSymbol | null;
  repository?: GitHubRepositoryRef | null;
  warnings: string[];
};

export type HostedWorkflowQuote = {
  id: string;
  requesterWallet: string;
  workflowType: HostedWorkflowType;
  inputPreview: string;
  inputSha256: string;
  plan: HostedPlannerSnapshot;
  pricing: {
    estimatedProviderCostUsdc: number;
    platformFeeUsdc: number;
    listPriceUsdc: number;
    amountDueUsdc: number;
  };
  paymentMode: "sponsored" | "paid";
  treasuryAddress: string;
  chainId: number;
  asset: "native_usdc";
  payment: WorkflowPaymentDescriptor | null;
  status: "quoted" | "consumed" | "completed" | "expired" | "credited" | "cancelled";
  expiresAt: string;
  jobId: string | null;
  userPaymentId: string | null;
};

export type HostedApiResult = {
  serviceSlug: string;
  serviceName: string;
  status: "paid" | "failed";
  amountUsdc: string | null;
  response: unknown;
  error: string | null;
};

export type HostedFinalReport = {
  aggregationMode: "deterministic_structured" | "ai_generated_synthesis";
  aggregationLabel: string;
  synthesis?: {
    status: "ai_generated" | "deterministic_fallback";
    provider: "OpenRouter" | null;
    protocol: "openai-compatible" | null;
    model: string | null;
    attempted: boolean;
    usedPaidApiResponses: Array<{
      serviceSlug: string;
      serviceName: string;
      amountUsdc: string | null;
    }>;
    fallbackReason:
      | "not_configured"
      | "unsupported_provider"
      | "no_paid_api_results"
      | "timeout"
      | "rate_limited"
      | "upstream_error"
      | "response_too_large"
      | "invalid_response"
      | null;
    generatedAt: string | null;
  };
  input: {
    preview: string;
    sha256: string;
  };
  marketSymbol: PythMarketSymbol | null;
  repository?: GitHubRepositoryRef | null;
  workflowData?: Record<string, unknown> | null;
  summary: string;
  keyFindings: string[];
  apiResults: HostedApiResult[];
  selectedServices: HostedPlanService[];
  skippedServices: HostedPlanService[];
  spentUsdc: string;
  receiptIds: string[];
  proofTransactionHashes: string[];
  links: {
    hostedResult: string;
    agentRun: string | null;
    receipts: string;
    passport: string | null;
    proofTransactions: string[];
  };
  completedWithWarnings: boolean;
  generatedAt: string;
};

export type HostedJobView = {
  job: {
    id: string;
    requesterWallet: string | null;
    workflowType: HostedWorkflowType;
    task: string;
    inputPreview: string;
    inputSha256: string;
    budgetUsdc: string;
    plannerSnapshot: HostedPlannerSnapshot;
    selectedServices: HostedPlanService[];
    structuredResult: HostedFinalReport | null;
    status: "queued" | "running" | "completed" | "failed";
    progressStage:
      | "queued"
      | "planning"
      | "purchasing"
      | "generating_receipt"
      | "publishing_onchain_proof"
      | "completed"
      | "failed";
    progressMessage: string | null;
    agentRunId: string | null;
    spentUsdc: string;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    paymentMode: "legacy_sponsored" | "sponsored" | "paid";
    workflowQuoteId: string | null;
    userPaymentId: string | null;
    project360Modules?: string[];
  };
  userPayment: {
    id: string;
    quoteId: string;
    paymentMode: "sponsored" | "paid";
    status: "sponsored" | "settled" | "credit_issued" | "refund_pending" | "refunded";
    requesterWallet: string;
    grossAmountUsdc: string;
    estimatedProviderCostUsdc: string;
    providerCostUsdc: string;
    platformFeeUsdc?: string;
    netRevenueUsdc?: string;
    creditAmountUsdc: string;
    transactionHash: string | null;
    blockNumber: number | null;
    treasuryAddress: string;
    chainId: number;
    asset: "native_usdc";
    settledAt: string | null;
    creditedAt: string | null;
    completedAt: string | null;
    failureReason: string | null;
    transactionUrl: string | null;
  } | null;
  payerWallet: string | null;
  receiptIds: string[];
  services: Array<{
    receiptId: string | null;
    serviceSlug: string;
    serviceName: string;
    priceUsdc: string;
    status: string;
    reasoning: string;
    presentation: ServicePresentationMetadata;
    response: unknown;
    error: string | null;
  }>;
  proofs: Array<{
    receiptId: string;
    status: "pending" | "verified" | "failed";
    responseHash: string | null;
    transactionHash: string | null;
    blockNumber: number | null;
    contractAddress: string | null;
    transactionUrl: string | null;
    contractUrl: string | null;
  }>;
  links: {
    hostedRun: string;
    workflowReceipt: string;
    agentRun: string | null;
    receipts: string;
    receipt: string | null;
    passport: string | null;
    proofTransaction: string | null;
    proofTransactions: string[];
  };
};

export type HostedRunnerDiagnostic = {
  configured: boolean;
  chainId: number;
  payerAddress: string | null;
  maxBudgetUsdc: number;
  allowedServices: string[];
  cooldownSeconds: number;
  rateLimitWindowSeconds: number;
  rateLimitMaxRuns: number;
  checkout: {
    configured: boolean;
    chainId: number;
    asset: "native_usdc";
    treasuryAddress: string | null;
    platformFeeUsdc: number;
    maxPriceUsdc: number;
    sponsoredQuota: number;
    quoteExpirySeconds: number;
    paymentModel: "single_user_payment_then_internal_x402";
  };
};

export type RecentHostedJob = {
  id: string;
  workflowType: HostedWorkflowType;
  task: string;
  inputPreview: string;
  status: "queued" | "running" | "completed" | "failed";
  spentUsdc: string;
  createdAt: string;
  completedAt: string | null;
  receiptCount: number;
  proofCount: number;
  href: string;
};
