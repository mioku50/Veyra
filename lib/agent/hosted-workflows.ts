/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import type {
  BuyerAgentExecutionResult,
  BuyerAgentServiceResult,
  BuyerAgentWorkflowArtifacts,
} from "./execution.ts";
import {
  HOSTED_AGENT_MAX_TASK_LENGTH,
  HOSTED_AGENT_MAX_BUDGET_USDC,
  PROJECT_360_MAX_BUDGET_USDC,
  validateHostedBudget,
} from "./hosted-policy.ts";
import { planAgentPurchases } from "./planner.ts";
import type { ApiService, ServiceMethod } from "../services/registry.ts";
import {
  HOSTED_WORKFLOW_TYPES,
  getHostedWorkflowTemplate,
  type HostedWorkflowType,
} from "./workflow-templates.ts";
import {
  inferPythSymbol,
  normalizePythSymbol,
} from "../providers/pyth.ts";
import type { PythMarketSymbol } from "../providers/types.ts";
import {
  parseGitHubRepositoryInput,
  type GitHubRepositoryRef,
} from "../providers/github-repository-ref.ts";
import {
  servicePresentationMetadata,
  type ServicePresentationMetadata,
} from "../services/presentation.ts";
import type { HostedReportSynthesis } from "../llm/types.ts";
import { BRAND } from "../brand.ts";
import { API_QUALITY_FINALIZER_PRICE_USDC, TREASURY_HEALTH_FINALIZER_PRICE_USDC } from "../services/constants.ts";
import {
  canonicalAgentTrustInput,
  normalizeAgentTrustInput,
} from "../agent-trust/input.ts";
import type {
  AgentTrustReport,
  AgentTrustReportInput,
} from "../agent-trust/types.ts";
import {
  canonicalProject360Input,
  normalizeProject360Input,
} from "../project-360/input.ts";
import {
  PROJECT_360_MODULES,
  type Project360Input,
  type Project360Report,
} from "../project-360/types.ts";

export { HOSTED_WORKFLOW_TYPES, type HostedWorkflowType, API_QUALITY_FINALIZER_PRICE_USDC, TREASURY_HEALTH_FINALIZER_PRICE_USDC };

export const HOSTED_WORKFLOW_MAX_INPUT_LENGTH = 5_000;
export const HOSTED_WORKFLOW_MIN_INPUT_LENGTH = 20;
export const HOSTED_WORKFLOW_INPUT_PREVIEW_LENGTH = 240;
export const HOSTED_WORKFLOW_MAX_PAID_CALLS = 3;

export type HostedWorkflowRequest = {
  workflowType: HostedWorkflowType;
  task: string;
  inputText: string;
  marketSymbol: PythMarketSymbol | null;
  repository: GitHubRepositoryRef | null;
  agentTrustInput: AgentTrustReportInput | null;
  project360Input: Project360Input | null;
  budgetUsdc: number;
};

export type HostedPlanService = {
  id: string;
  slug: string;
  name: string;
  endpoint: string;
  method: ServiceMethod;
  priceUsdc: number;
  reasoning: string;
  presentation: ServicePresentationMetadata;
};

export type HostedPlannerSnapshot = {
  version: 4;
  workflowType: HostedWorkflowType;
  workflowLabel: string;
  effectiveTask: string;
  selectedServices: HostedPlanService[];
  skippedServices: HostedPlanService[];
  estimatedSpendUsdc: number;
  remainingBudgetUsdc: number;
  maxPaidCalls: number;
  budgetCapUsdc: number;
  aggregationMode: "deterministic_execution_optional_llm";
  aggregationLabel: "Deterministic paid execution with optional StepFun synthesis";
  inputPreview: string;
  inputSha256: string;
  marketSymbol: PythMarketSymbol | null;
  repository: GitHubRepositoryRef | null;
  warnings: string[];
  metadata?: Record<string, unknown>;
};

export function hostedExecutionAllowlist<
  T extends { slug: string; endpoint: string; method: ServiceMethod },
>(
  plan: HostedPlannerSnapshot,
  configuredAllowlist: readonly T[],
): T[] {
  const plannedServices = new Set(
    plan.selectedServices.map(
      (service) => `${service.slug}\n${service.method}\n${service.endpoint}`,
    ),
  );
  return configuredAllowlist.filter((service) =>
    plannedServices.has(`${service.slug}\n${service.method}\n${service.endpoint}`),
  );
}

export type HostedFinalReport = {
  version: 4;
  workflowType: HostedWorkflowType;
  aggregationMode: "deterministic_structured" | "ai_generated_synthesis";
  aggregationLabel: string;
  synthesis: HostedReportSynthesis;
  input: {
    preview: string;
    sha256: string;
  };
  marketSymbol: PythMarketSymbol | null;
  repository: GitHubRepositoryRef | null;
  workflowData?: {
    repository?: GitHubRepositoryRef | null;
    snapshot?: unknown;
    assessment?: unknown;
    [key: string]: unknown;
  } | null;
  summary: string;
  keyFindings: string[];
  apiResults: BuyerAgentServiceResult[];
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

const WORKFLOW_LABELS: Record<HostedWorkflowType, string> = {
  github_due_diligence: "GitHub Project Due Diligence",
  agent_trust_report: `${BRAND.name} Agent Trust Report`,
  paid_api_quality: "Paid API Quality Report",
  sentiment_tone: "Sentiment & Tone Report",
  builder_update: "Builder Update Summary",
  market_context: "Market Context Brief",
  custom_task: "Custom Task",
  treasury_health: "Treasury Health Report",
  project_360: `${BRAND.name} Project 360 Due Diligence`,
};

const OBVIOUS_SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "private key block",
    pattern: /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/i,
  },
  {
    label: "private key or seed phrase",
    pattern:
      /\b(?:private[_\s-]?key|wallet[_\s-]?key|seed[_\s-]?phrase|mnemonic)\s*[:=]\s*["']?(?:0x)?[a-z0-9+/=_-]{20,}/i,
  },
  {
    label: "secret environment value",
    pattern:
      /\b(?:AGENT_DB_SUPABASE_SECRET_KEY|AGENT_DB_SUPABASE_SERVICE_ROLE_KEY|HOSTED_AGENT_PRIVATE_KEY|PRIVATE_KEY|SECRET_KEY|SERVICE_ROLE_KEY|API_KEY)\s*=/i,
  },
  {
    label: "API token",
    pattern: /\b(?:sk-(?:proj-)?|ghp_|github_pat_|AKIA)[a-z0-9_-]{12,}\b/i,
  },
  {
    label: "bearer token",
    pattern: /\bbearer\s+[a-z0-9._~+/-]{20,}/i,
  },
  {
    label: "JWT",
    pattern: /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/i,
  },
  {
    label: "unprefixed private key",
    pattern: /^(?:[0-9a-f]{64})$/i,
  },
];

function normalizedText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("Input text must be a string.");
  return value.trim().replace(/\r\n/g, "\n");
}

function rejectObviousSecrets(value: string, field: "Task" | "Input text") {
  const match = OBVIOUS_SECRET_PATTERNS.find(({ pattern }) => pattern.test(value));
  if (match) {
    throw new Error(
      `${field} appears to contain a ${match.label}. Remove credentials or wallet secrets before continuing.`,
    );
  }
}

export function rejectHostedWorkflowSecrets(value: string) {
  rejectObviousSecrets(value, "Input text");
}

export function hashHostedWorkflowInput(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function redactHostedWorkflowText(value: string) {
  return value
    .replace(/-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/gi, "[redacted-private-key]")
    .replace(/\b0x[0-9a-f]{64}\b/gi, "[redacted-hex]")
    .replace(/\b(?:sk-(?:proj-)?|ghp_|github_pat_|AKIA)[a-z0-9_-]{12,}\b/gi, "[redacted-token]")
    .replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi, "[redacted-jwt]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
}

export function safeHostedWorkflowInputPreview(value: string) {
  const compact = redactHostedWorkflowText(value)
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= HOSTED_WORKFLOW_INPUT_PREVIEW_LENGTH) return compact;
  return `${compact.slice(0, HOSTED_WORKFLOW_INPUT_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

export function hostedWorkflowInputMetadata(value: string) {
  return {
    preview: safeHostedWorkflowInputPreview(value),
    sha256: hashHostedWorkflowInput(value),
  };
}

export function safeHostedServiceResponse(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactHostedWorkflowText(value).slice(0, 2_000);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => safeHostedServiceResponse(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(?:authorization|api.?key|private.?key|secret|token|headers?|raw|feed.?id)/i.test(key))
      .slice(0, 40)
      .map(([key, entry]) => [key, safeHostedServiceResponse(entry, depth + 1)]),
  );
}

export function safeHostedServiceResult(
  result: BuyerAgentServiceResult,
): BuyerAgentServiceResult {
  return {
    ...result,
    response: safeHostedServiceResponse(result.response),
    error: result.status === "failed"
      ? "Service call failed; successful paid results were preserved."
      : null,
  };
}

export function isHostedWorkflowType(value: unknown): value is HostedWorkflowType {
  return HOSTED_WORKFLOW_TYPES.includes(value as HostedWorkflowType);
}

export function workflowLabel(workflowType: HostedWorkflowType) {
  return WORKFLOW_LABELS[workflowType];
}

export function validateHostedWorkflowRequest(input: {
  workflowType?: unknown;
  task?: unknown;
  inputText?: unknown;
  repositoryUrl?: unknown;
  agentTrustInput?: unknown;
  agentId?: unknown;
  agentWallet?: unknown;
  contractAddress?: unknown;
  serviceEndpoint?: unknown;
  project360Input?: unknown;
  marketSymbol?: unknown;
  budgetUsdc?: unknown;
}): HostedWorkflowRequest {
  if (!isHostedWorkflowType(input.workflowType)) {
    throw new Error(
      "Workflow type must be github_due_diligence, agent_trust_report, paid_api_quality, treasury_health, project_360, sentiment_tone, builder_update, market_context, or custom_task.",
    );
  }

  const workflowType = input.workflowType;
  let repository: GitHubRepositoryRef | null = null;
  let agentTrustInput: AgentTrustReportInput | null = null;
  let project360Input: Project360Input | null = null;
  let rawInputText = typeof input.inputText === "string" ? input.inputText : "";

  if (workflowType === "github_due_diligence") {
    const rawRepoInput =
      typeof input.repositoryUrl === "string" && input.repositoryUrl.trim()
        ? input.repositoryUrl.trim()
        : rawInputText.trim();
    repository = parseGitHubRepositoryInput(rawRepoInput);
    rawInputText = repository.canonicalUrl;
  } else if (workflowType === "agent_trust_report") {
    let trustValue = input.agentTrustInput;
    if (!trustValue && rawInputText.trim().startsWith("{")) {
      try {
        trustValue = JSON.parse(rawInputText);
      } catch {
        trustValue = null;
      }
    }
    agentTrustInput = normalizeAgentTrustInput(
      trustValue && typeof trustValue === "object"
        ? trustValue
        : {
            agentId: input.agentId,
            agentWallet: input.agentWallet,
            repositoryUrl: input.repositoryUrl,
            contractAddress: input.contractAddress,
            serviceEndpoint: input.serviceEndpoint,
          },
    );
    rawInputText = canonicalAgentTrustInput(agentTrustInput);
    repository = agentTrustInput.repositoryUrl
      ? parseGitHubRepositoryInput(agentTrustInput.repositoryUrl)
      : null;
  } else if (workflowType === "project_360") {
    project360Input = normalizeProject360Input(
      input.project360Input ?? rawInputText,
    );
    rawInputText = canonicalProject360Input(project360Input);
    const repositorySource = project360Input.sources.find(
      (source) => source.type === "github_repository",
    );
    repository = repositorySource
      ? parseGitHubRepositoryInput(repositorySource.canonicalValue)
      : null;
    const agentSource = project360Input.sources.find(
      (source) => source.type === "agent_id",
    );
    const walletSource = project360Input.sources.find(
      (source) => source.type === "project_wallet",
    );
    const contractSource = project360Input.sources.find(
      (source) => source.type === "arc_contract",
    );
    const endpointSource = project360Input.sources.find(
      (source) => source.type === "public_api_endpoint",
    );
    agentTrustInput = normalizeAgentTrustInput({
      agentId: agentSource?.canonicalValue,
      agentWallet: walletSource?.canonicalValue,
      repositoryUrl: repositorySource?.canonicalValue,
      contractAddress: contractSource?.canonicalValue,
      serviceEndpoint: endpointSource?.canonicalValue,
    });
  }

  const rawTask = normalizedText(input.task).replace(/\s+/g, " ");
  const templateTask =
    getHostedWorkflowTemplate(workflowType)?.task || defaultWorkflowTask(workflowType);

  const isStandardWorkflow =
    workflowType === "github_due_diligence" ||
    workflowType === "agent_trust_report" ||
    workflowType === "paid_api_quality" ||
    workflowType === "project_360" ||
    workflowType === "sentiment_tone" ||
    workflowType === "builder_update" ||
    workflowType === "market_context";

  const task = isStandardWorkflow || !rawTask ? templateTask : rawTask;

  const inputText = normalizedText(rawInputText);
  if (task.length > HOSTED_AGENT_MAX_TASK_LENGTH) {
    throw new Error(`Task must contain at most ${HOSTED_AGENT_MAX_TASK_LENGTH} characters.`);
  }
  if (inputText.length > HOSTED_WORKFLOW_MAX_INPUT_LENGTH) {
    throw new Error(`Input text must contain at most ${HOSTED_WORKFLOW_MAX_INPUT_LENGTH} characters.`);
  }

  if (task && task.length < 10) {
    throw new Error("Task must contain at least 10 characters.");
  }
  if (inputText.length < HOSTED_WORKFLOW_MIN_INPUT_LENGTH) {
    throw new Error(
      `${workflowLabel(workflowType)} requires at least ${HOSTED_WORKFLOW_MIN_INPUT_LENGTH} input characters.`,
    );
  }
  rejectObviousSecrets(task, "Task");
  rejectObviousSecrets(inputText, "Input text");

  let marketSymbol: PythMarketSymbol | null = null;
  if (workflowType === "market_context") {
    marketSymbol =
      input.marketSymbol === undefined ||
      input.marketSymbol === null ||
      input.marketSymbol === ""
        ? inferPythSymbol(inputText, task)
        : normalizePythSymbol(input.marketSymbol);
  } else if (
    input.marketSymbol !== undefined &&
    input.marketSymbol !== null &&
    input.marketSymbol !== ""
  ) {
    marketSymbol = normalizePythSymbol(input.marketSymbol);
  }

  const maxBudgetUsdc = workflowType === "project_360"
    ? PROJECT_360_MAX_BUDGET_USDC
    : HOSTED_AGENT_MAX_BUDGET_USDC;
  const rawBudget =
    input.budgetUsdc === undefined ||
    input.budgetUsdc === null ||
    input.budgetUsdc === ""
      ? maxBudgetUsdc
      : input.budgetUsdc;

  return {
    workflowType,
    task,
    inputText,
    marketSymbol,
    repository,
    agentTrustInput,
    project360Input,
    budgetUsdc: validateHostedBudget(rawBudget, maxBudgetUsdc),
  };
}

export function defaultWorkflowTask(workflowType: HostedWorkflowType) {
  if (workflowType === "github_due_diligence") {
    return "Analyze the selected public GitHub repository using live repository data and deterministic due diligence rules.";
  }
  if (workflowType === "agent_trust_report") {
    return "Build an evidence-backed Agent Trust Report from the supplied public identifiers and available Veyra signals.";
  }
  if (workflowType === "paid_api_quality") {
    return "Evaluate and compare paid APIs using observed pricing, latency, availability, response validity, payment execution, and settlement history.";
  }
  if (workflowType === "treasury_health") {
    return "Analyze USDC transfer history and produce a deterministic Treasury Health Report.";
  }
  if (workflowType === "project_360") {
    return "Run the explicitly selected Project 360 modules from the immutable confirmed-source snapshot and produce one aggregate report.";
  }
  if (workflowType === "sentiment_tone") {
    return "Analyze the submitted text and produce a sentiment and tone workflow report.";
  }
  if (workflowType === "builder_update") {
    return "Analyze the submitted builder update and produce a concise structured report.";
  }
  if (workflowType === "market_context") {
    return "Analyze the submitted crypto market context with live provider-backed data and produce a concise evidence-labeled brief.";
  }
  return "Analyze the request with useful allowlisted paid API services.";
}

export function effectiveWorkflowTask(input: HostedWorkflowRequest) {
  if (input.workflowType === "github_due_diligence") {
    return `${input.task} Analyze ${input.repository?.fullName ?? input.inputText} using live GitHub repository intelligence and deterministic due diligence analysis.`;
  }
  if (input.workflowType === "agent_trust_report") {
    const sources = [
      input.agentTrustInput?.agentId ? `${BRAND.name} agent identity` : null,
      input.agentTrustInput?.agentWallet ? "registered wallet signals" : null,
      input.repository ? "GitHub repository intelligence" : null,
      input.agentTrustInput?.contractAddress
        ? "Arc Testnet contract transparency"
        : null,
      input.agentTrustInput?.serviceEndpoint
        ? "a protected endpoint availability snapshot"
        : null,
    ].filter(Boolean);
    return `${input.task} Use ${sources.join(", ")} and deterministic scoring. ${
      input.repository
        ? `Analyze ${input.repository.fullName} using the existing GitHub intelligence pipeline.`
        : "Analyze the normalized public identifier record and produce the structured report without inventing unavailable evidence."
    }`;
  }
  if (input.workflowType === "paid_api_quality") {
    return `${input.task} Evaluate and benchmark paid API telemetry, latency distribution, availability, response validity, and Arc settlement proofs.`;
  }
  if (input.workflowType === "treasury_health") {
    return `${input.task} Fetch on-chain USDC transfer events and calculate treasury health metrics.`;
  }
  if (input.workflowType === "project_360" && input.project360Input) {
    const labels = input.project360Input.modules.join(", ");
    return `${input.task} Selected modules: ${labels}. Run GitHub repository due diligence, agent trust, treasury health, paid API quality, and Arc contract analysis only when present in the immutable selection. Finalize Project 360 after child module hashes are fixed.`;
  }
  if (input.workflowType === "sentiment_tone") {
    return `${input.task} Use paid text analysis and concise research context for the report.`;
  }
  if (input.workflowType === "builder_update") {
    return `${input.task} Use paid text analysis and concise research context for the builder update report.`;
  }
  if (input.workflowType === "market_context") {
    return `${input.task} Use paid text analysis and the current ${input.marketSymbol ?? "BTC/USD"} price sourced from Pyth Network. Never invent provider data.`;
  }
  return input.task;
}

function safeService(decision: {
  service: ApiService;
  expectedPriceUsd: number;
  reasoning: string;
}, marketSymbol: PythMarketSymbol | null): HostedPlanService {
  return {
    id: decision.service.id,
    slug: decision.service.slug,
    name: decision.service.name,
    endpoint: decision.service.endpoint,
    method: decision.service.method,
    priceUsdc: decision.expectedPriceUsd,
    reasoning: decision.reasoning,
    presentation: servicePresentationMetadata(decision.service, marketSymbol),
  };
}

export function createHostedWorkflowPlan(input: {
  request: HostedWorkflowRequest;
  services: ApiService[];
  allowlist: readonly { slug: string; endpoint: string; method: ServiceMethod }[];
}): HostedPlannerSnapshot {
  const allowedServices = input.services.filter((service) =>
    input.allowlist.some(
      (allowed) =>
        allowed.slug === service.slug &&
        allowed.endpoint === service.endpoint &&
        allowed.method === service.method,
    ),
  ).filter(
    (service) => {
      if (input.request.workflowType === "agent_trust_report") {
        if (input.request.repository) {
          return [
            "github-repository-intelligence",
            "github-due-diligence-analysis",
            "agent-trust-finalizer",
          ].includes(service.slug);
        }
        return [
          "text-analyzer",
          "agent-trust-finalizer",
        ].includes(service.slug);
      }
      if (input.request.workflowType === "paid_api_quality") {
        return service.slug === "api-quality-finalizer";
      }
      if (input.request.workflowType === "treasury_health") {
        return service.slug === "treasury-health-finalizer";
      }
      if (
        input.request.workflowType === "project_360" &&
        input.request.project360Input
      ) {
        const modules = new Set(input.request.project360Input.modules);
        return (
          (modules.has("github_due_diligence") && [
            "github-repository-intelligence",
            "github-due-diligence-analysis",
          ].includes(service.slug)) ||
          (modules.has("agent_trust_report") && service.slug === "agent-trust-finalizer") ||
          (modules.has("treasury_health") && service.slug === "treasury-health-finalizer") ||
          (modules.has("paid_api_quality") && service.slug === "api-quality-finalizer") ||
          (modules.has("arc_contract_analysis") && service.slug === "arc-contract-analysis-finalizer") ||
          service.slug === "project-360-finalizer"
        );
      }
      return true;
    },
  );
  const effectiveTask = effectiveWorkflowTask(input.request);
  const inputMetadata = hostedWorkflowInputMetadata(input.request.inputText ?? "");
  const plan = planAgentPurchases({
    task: effectiveTask,
    budgetUsdc: input.request.budgetUsdc,
    services: allowedServices,
    policy: {
      allowOfficial: true,
      allowSellerCreated: false,
      maxPaidCalls:
        input.request.workflowType === "project_360"
          ? 7
          : HOSTED_WORKFLOW_MAX_PAID_CALLS,
      maxServicePriceUsd: input.request.budgetUsdc,
    },
  });

  return {
    version: 4,
    workflowType: input.request.workflowType,
    workflowLabel: workflowLabel(input.request.workflowType),
    effectiveTask,
    selectedServices: plan.selected.map((decision) =>
      safeService(decision, input.request.marketSymbol)
    ),
    skippedServices: plan.skipped.map((decision) =>
      safeService(decision, input.request.marketSymbol)
    ),
    estimatedSpendUsdc: plan.estimatedSpendUsdc,
    remainingBudgetUsdc: plan.remainingBudgetUsdc,
    maxPaidCalls:
      input.request.workflowType === "project_360"
        ? 7
        : HOSTED_WORKFLOW_MAX_PAID_CALLS,
    budgetCapUsdc: input.request.budgetUsdc,
    aggregationMode: "deterministic_execution_optional_llm",
    aggregationLabel: "Deterministic paid execution with optional StepFun synthesis",
    inputPreview: inputMetadata.preview,
    inputSha256: inputMetadata.sha256,
    marketSymbol: input.request.marketSymbol,
    repository: input.request.repository,
    warnings: plan.warnings,
    metadata:
      input.request.workflowType === "agent_trust_report"
        ? {
            agentTrustInput: input.request.agentTrustInput,
            requestedSources: {
              agentRegistry: Boolean(
                input.request.agentTrustInput?.agentId ||
                  input.request.agentTrustInput?.agentWallet,
              ),
              github: Boolean(input.request.repository),
              contract: Boolean(
                input.request.agentTrustInput?.contractAddress,
              ),
              endpoint: Boolean(
                input.request.agentTrustInput?.serviceEndpoint,
              ),
            },
          }
        : input.request.workflowType === "project_360" && input.request.project360Input
          ? {
              project360Input: input.request.project360Input,
              requestedSources: Object.fromEntries(
                input.request.project360Input.sources.map((source) => [source.type, true]),
              ),
              expectedCoverage: {
                selected: input.request.project360Input.modules.length,
                total: PROJECT_360_MODULES.length,
              },
            }
          : undefined,
  };
}

function findingForResult(result: BuyerAgentServiceResult) {
  if (result.status === "failed") {
    return `${result.serviceName} failed; the report preserves the partial result without retrying a payment automatically.`;
  }
  const response = result.response as Record<string, unknown> | null;
  if (result.serviceSlug === "api-quality-finalizer" && response) {
    return `API Quality Report Finalizer validated canonical quality report and published hash attestation for Arc Testnet proof settlement.`;
  }
  if (result.serviceSlug === "github-repository-intelligence" && response) {
    const repoInfo = response.repository as Record<string, unknown> | undefined;
    return `GitHub Repository Intelligence fetched metadata, recent commits, and releases for ${String(repoInfo?.fullName ?? "the repository")}.`;
  }
  if (result.serviceSlug === "github-due-diligence-analysis" && response) {
    const assessment = response.assessment as Record<string, unknown> | undefined;
    return `GitHub Due Diligence Analysis evaluated project health signals and risk rules (status: ${String(assessment?.overallStatus ?? "evaluated")}).`;
  }
  if (result.serviceSlug === "text-analyzer" && response) {
    return `Text Analyzer measured ${String(response.word_count ?? "unknown")} words, ${String(response.sentence_count ?? "unknown")} sentences, and ${String(response.char_count ?? "unknown")} characters.`;
  }
  if (result.serviceSlug === "premium-quote" && response?.quote) {
    return `Premium Quote returned: ${String(response.quote)}`;
  }
  if (result.serviceSlug === "pyth-market-price" && response) {
    const interval = response.confidenceInterval as Record<string, unknown> | undefined;
    return `Pyth Network returned ${String(response.symbol ?? "the requested symbol")} at ${String(response.price ?? "unavailable")} with confidence interval ${String(interval?.low ?? "unavailable")}–${String(interval?.high ?? "unavailable")} (±${String(response.confidence ?? "unavailable")}), published ${String(response.publishTime ?? "unknown")}, age ${String(response.priceAgeSeconds ?? "unknown")}s when fetched ${String(response.fetchedAt ?? "unknown")}; ${BRAND.name} charged ${String(result.amountUsdc ?? response.paidAmountUsdc ?? "unknown")} USDC for access to its provider-backed service, not as a direct payment to Pyth.`;
  }
  return `${result.serviceName} returned a structured paid API result.`;
}

function deterministicWorkflowFindings(request: HostedWorkflowRequest) {
  const text = request.inputText?.trim() ?? "";
  if (!text) return [];
  if (request.workflowType === "github_due_diligence") {
    return [
      `Target GitHub repository: ${request.repository?.fullName ?? request.inputText}.`,
      "Deterministic due diligence workflow combines live server-side GitHub API intelligence with automated category assessments.",
    ];
  }
  if (request.workflowType === "agent_trust_report") {
    const supplied = [
      request.agentTrustInput?.agentId ? "Agent ID" : null,
      request.agentTrustInput?.agentWallet ? "agent wallet" : null,
      request.repository ? "GitHub repository" : null,
      request.agentTrustInput?.contractAddress ? "Arc contract" : null,
      request.agentTrustInput?.serviceEndpoint ? "service endpoint" : null,
    ].filter(Boolean);
    return [
      `Trust report sources supplied: ${supplied.join(", ")}.`,
      "Trust Score is deterministic; missing optional sources are excluded rather than scored as zero.",
    ];
  }
  if (request.workflowType === "paid_api_quality") {
    return [
      `Target paid API quality input: ${request.inputText}.`,
      "Deterministic API quality evaluation combines real observation telemetry, response validity checks, and Arc settlement proofs.",
    ];
  }
  if (request.workflowType === "treasury_health") {
    return [
      `Target wallet address: ${request.inputText}.`,
      "Deterministic treasury health evaluation based on on-chain USDC transfer events.",
    ];
  }
  if (request.workflowType === "project_360" && request.project360Input) {
    return [
      `Project 360 confirmed ${request.project360Input.sources.length} source(s) for ${request.project360Input.modules.length} selected module(s).`,
      `Expected coverage: ${request.project360Input.modules.length} of ${PROJECT_360_MODULES.length} modules. Missing modules remain unknown rather than scoring as zero.`,
    ];
  }
  const words: string[] = text.toLowerCase().match(/[a-z0-9'-]+/g) ?? [];
  if (request.workflowType === "sentiment_tone") {
    const positive = new Set([
      "clear", "good", "great", "helpful", "improved", "ready", "stable",
      "strong", "successful", "thoughtful", "trustworthy", "useful",
    ]);
    const negative = new Set([
      "bad", "blocked", "broken", "confusing", "failed", "risk", "slow",
      "unstable", "unclear", "weak", "worse",
    ]);
    const positiveCount = words.filter((word) => positive.has(word)).length;
    const negativeCount = words.filter((word) => negative.has(word)).length;
    const sentiment = positiveCount > negativeCount
      ? "positive"
      : negativeCount > positiveCount
        ? "negative"
        : "neutral or mixed";
    const tone = /!/.test(text)
      ? "emphatic"
      : /\b(must|urgent|immediately|critical)\b/i.test(text)
        ? "urgent"
        : "measured";
    return [
      `Deterministic keyword heuristic: ${sentiment} sentiment (${positiveCount} positive and ${negativeCount} negative signal words).`,
      `Deterministic punctuation/keyword heuristic: ${tone} tone.`,
    ];
  }
  if (request.workflowType === "builder_update") {
    const deliverySignals = [
      "built", "fixed", "launched", "merged", "released", "shipped", "tested",
    ].filter((signal) => words.includes(signal));
    const riskSignals = ["blocked", "bug", "delay", "failed", "risk"].filter(
      (signal) => words.includes(signal),
    );
    return [
      `Deterministic builder signal scan found ${deliverySignals.length} delivery marker(s)${deliverySignals.length ? `: ${deliverySignals.join(", ")}` : "."}`,
      `Deterministic risk scan found ${riskSignals.length} risk marker(s)${riskSignals.length ? `: ${riskSignals.join(", ")}` : "."}`,
    ];
  }
  if (request.workflowType === "market_context") {
    const directionalSignals = [
      "down", "decreased", "declined", "grew", "growth", "increased", "rose", "up",
    ].filter((signal) => words.includes(signal));
    const riskSignals = [
      "risk", "uncertain", "uncertainty", "volatile", "volatility",
    ].filter((signal) => words.includes(signal));
    const numericSignals = text.match(/(?:\$|€|£)?\d+(?:\.\d+)?%?/g) ?? [];
    return [
      `Input-supplied market context contains ${numericSignals.length} numeric signal(s) and ${directionalSignals.length} directional marker(s).`,
      `Deterministic risk scan found ${riskSignals.length} market-risk marker(s)${riskSignals.length ? `: ${riskSignals.join(", ")}` : "."}`,
      "Deterministic aggregation combines the submitted context with actual paid API responses; no model inference is claimed.",
    ];
  }
  return [
    `Custom workflow supplied ${words.length} source word(s) for deterministic aggregation.`,
  ];
}

export function buildHostedFinalReport(input: {
  jobId: string;
  request: HostedWorkflowRequest;
  plan: HostedPlannerSnapshot;
  agentRunId: string | null;
  agentWallet: string;
  spentUsdc: string;
  receiptIds: string[];
  proofTransactionHashes: string[];
  serviceResults: BuyerAgentServiceResult[];
  executionResult?: {
    workflowArtifacts?: BuyerAgentWorkflowArtifacts;
  } | BuyerAgentExecutionResult | null;
  workflowArtifacts?: BuyerAgentWorkflowArtifacts | null;
  explorerUrl: string;
  agentTrustReport?: AgentTrustReport | null;
  project360Report?: Project360Report | null;
}): HostedFinalReport {
  const { request } = input;
  const serviceResults = input.serviceResults.map(safeHostedServiceResult);
  const paidCount = serviceResults.filter((result) => result.status === "paid").length;
  const failedCount = serviceResults.filter((result) => result.status === "failed").length;
  const inputMetadata = hostedWorkflowInputMetadata(request.inputText ?? "");

  const executionResult = input.executionResult ?? { workflowArtifacts: input.workflowArtifacts };
  const snapshot = executionResult.workflowArtifacts?.githubRepositorySnapshot ?? null;
  const assessment = executionResult.workflowArtifacts?.githubDueDiligenceAssessment ?? null;

  const workflowData =
    request.workflowType === "project_360"
      ? input.project360Report
        ? {
            kind: "project_360_report",
            report: input.project360Report,
          }
        : null
      : request.workflowType === "agent_trust_report"
      ? input.agentTrustReport
        ? {
            kind: "agent_trust_report",
            report: input.agentTrustReport,
          }
        : null
      : request.workflowType === "github_due_diligence"
      ? snapshot
        ? {
            kind: "github_due_diligence",
            repository: request.repository!,
            snapshot,
            assessment,
          }
        : null
      : null;

  return {
    version: 4,
    workflowType: input.request.workflowType,
    aggregationMode: "deterministic_structured",
    aggregationLabel: "Structured workflow result (no LLM configured)",
    synthesis: {
      status: "deterministic_fallback",
      provider: null,
      protocol: null,
      model: null,
      attempted: false,
      usedPaidApiResponses: [],
      fallbackReason: "not_configured",
      generatedAt: null,
    },
    input: {
      preview: inputMetadata.preview,
      sha256: inputMetadata.sha256,
    },
    marketSymbol: input.request.marketSymbol,
    repository: input.request.repository,
    workflowData,
    summary: `${workflowLabel(input.request.workflowType)} completed ${paidCount} of ${input.plan.selectedServices.length} selected paid API call(s) using deterministic aggregation${failedCount > 0 ? `; ${failedCount} call(s) failed` : ""}.`,
    keyFindings: [
      ...deterministicWorkflowFindings(input.request),
      ...serviceResults.map(findingForResult),
    ],
    apiResults: serviceResults,
    selectedServices: input.plan.selectedServices,
    skippedServices: input.plan.skippedServices,
    spentUsdc: input.spentUsdc,
    receiptIds: input.receiptIds,
    proofTransactionHashes: input.proofTransactionHashes,
    links: {
      hostedResult: `/agent-runner/${input.jobId}`,
      agentRun: input.agentRunId ? `/runs/${input.agentRunId}` : null,
      receipts: `/receipts?wallet=${input.agentWallet}`,
      passport: `/agents/${input.agentWallet}`,
      proofTransactions: input.proofTransactionHashes.map(
        (hash) => `${input.explorerUrl.replace(/\/$/, "")}/tx/${hash}`,
      ),
    },
    completedWithWarnings: failedCount > 0,
    generatedAt: new Date().toISOString(),
  };
}
