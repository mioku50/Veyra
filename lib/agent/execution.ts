/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GatewayClient, type PayResult } from "@circle-fin/x402-batching/client";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  fetchWithRetry,
  installFetchWithRetry,
  toErrorMessage,
  withRetry,
} from "./fetch-with-retry.ts";
import {
  installPaymentHttpDiagnostics,
  printPaymentHttpDiagnostics,
  type PaymentHttpExchange,
} from "./payment-http-diagnostics.ts";
import {
  createAgentRun,
  createAgentStep,
  findRecentPaymentEvent,
  getPaymentEventProofStates,
  updateAgentRun,
  updateAgentStep,
  type AgentRunStatus,
  type AgentStepRow,
  type AgentStepStatus,
} from "./run-persistence.ts";
import {
  createOrUpdateAgentProfileByWallet,
  recalculateAgentProfile,
} from "./passport-persistence.ts";
import {
  planAgentPurchases,
  type AgentPlanDecision,
  type AgentPlanningPolicy,
} from "./planner.ts";
import type {
  ApiService,
  ServiceMethod,
  ServiceSourceType,
  ServiceStatus,
} from "../services/registry.ts";
import { inferPythSymbol } from "../providers/pyth.ts";
import type { PythMarketSymbol } from "../providers/types.ts";
import {
  parseGitHubRepositoryInput,
  type GitHubRepositoryRef,
} from "../providers/github-repository-ref.ts";
import {
  isGitHubRepositorySnapshot,
  type GitHubRepositorySnapshot,
} from "../providers/github-types.ts";
import type { GitHubDueDiligenceAssessment } from "./github-due-diligence.ts";

type ServiceDiscoveryResponse = {
  services?: ApiService[];
};

export type BuyerAgentProgressStage =
  | "planning"
  | "purchasing"
  | "generating_receipt"
  | "publishing_onchain_proof"
  | "completed"
  | "failed";

export type BuyerAgentProgress = {
  stage: BuyerAgentProgressStage;
  agentRunId: string | null;
  spentUsdc: string;
  paymentEventIds: string[];
  message?: string;
};

export type BuyerAgentExecutionOptions = {
  task: string;
  requestInputText?: string | null;
  marketSymbol?: PythMarketSymbol | null;
  repository?: GitHubRepositoryRef | null;
  spendingLimit: number;
  baseUrl: string;
  sellerAddress: Address;
  agentPrivateKey: Hex;
  walletSource: "generated" | "AGENT_PRIVATE_KEY" | "HOSTED_AGENT_PRIVATE_KEY";
  funderPrivateKey?: Hex | null;
  funderAddress?: Address | null;
  depositAmountUsdc?: string;
  fetchRetries?: number;
  fetchTimeoutMs?: number;
  postDepositWaitMs?: number;
  skipFunding?: boolean;
  skipDeposit?: boolean;
  writeLocalRunLog?: boolean;
  installSignalHandler?: boolean;
  requirePersistence?: boolean;
  requirePaidPurchase?: boolean;
  proofWaitTimeoutMs?: number;
  planningPolicy?: AgentPlanningPolicy;
  continueOnServiceFailure?: boolean;
  serviceAllowlist?: readonly {
    slug: string;
    endpoint: string;
    method: ServiceMethod;
  }[];
  serviceSnapshot?: readonly ApiService[];
  resolveServiceRequestBody?: (input: {
    service: ApiService;
    runtimeServiceOutputs: ReadonlyMap<string, unknown>;
    paidPreviews: readonly unknown[];
  }) => unknown | Promise<unknown>;
  requestPayload?: unknown;
  onProgress?: (progress: BuyerAgentProgress) => void | Promise<void>;
};

export type BuyerAgentServiceResult = {
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  status: "paid" | "failed";
  amountUsdc: string | null;
  stepId: string | null;
  paymentEventId: string | null;
  response: unknown;
  error: string | null;
};

export type BuyerAgentWorkflowArtifacts = {
  githubRepositorySnapshot?: GitHubRepositorySnapshot;
  githubDueDiligenceAssessment?: GitHubDueDiligenceAssessment;
};

export type BuyerAgentExecutionResult = {
  agentRunId: string | null;
  agentWallet: Address;
  spentUsdc: string;
  paidStepIds: string[];
  paymentEventIds: string[];
  selectedServices: Array<{
    id: string;
    slug: string;
    name: string;
    endpoint: string;
    method: ServiceMethod;
    priceUsd: number;
    reasoning: string;
  }>;
  skippedServices: Array<{
    id: string;
    slug: string;
    name: string;
    priceUsd: number;
    reasoning: string;
  }>;
  serviceResults: BuyerAgentServiceResult[];
  workflowArtifacts: BuyerAgentWorkflowArtifacts;
  status: "completed" | "failed";
  summary: string;
};

type RunStatus =
  | "created"
  | "discovering"
  | "planning"
  | "funding"
  | "funded"
  | "depositing"
  | "deposited"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

type LocalStepLog = {
  stepId?: string | null;
  stepIndex: number;
  serviceSlug: string;
  serviceName: string;
  status: AgentStepStatus;
  reasoning: string;
  requestId?: string | null;
  paymentEventId?: string | null;
  error?: string | null;
};

type RunLog = {
  runId: string;
  supabaseRunId: string | null;
  createdAt: string;
  updatedAt: string;
  task: string;
  mode: "scripted";
  baseUrl: string;
  funderAddress: string;
  sellerAddress: string;
  ephemeralAgentAddress: string;
  ephemeralAgentPrivateKey?: string;
  walletSource: BuyerAgentExecutionOptions["walletSource"];
  budgetUsdc: string;
  spentUsdc: string;
  depositAmountUsdc: string;
  targetNetwork: string;
  fundingTxHash: string | null;
  usdcTransferTxHash: string | null;
  depositTxHash: string | null;
  status: RunStatus;
  steps: LocalStepLog[];
  summary: string | null;
  errors: Array<{
    at: string;
    stage: string;
    message: string;
  }>;
  persistenceWarnings: string[];
};

type ExecutableDecision = AgentPlanDecision & {
  step: AgentStepRow | null;
  stepIndex: number;
};

type PreflightResult = {
  requestId?: string;
  paymentRequired?: unknown;
  responseBody?: string;
  latencyMs: number;
};

type GatewayBalanceDiagnostic = {
  available: number | null;
  formattedAvailable: string | null;
  detectable: boolean;
  warning?: string;
};

const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
const TARGET_NETWORK = "Arc Testnet (chain ID 5042002)";
const GAS_FUND_AMOUNT = parseEther("0.01");
const RUN_DIR = ".agent-runs";

function normalizeBaseUrl(raw: string) {
  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    throw new Error("BASE_URL must be a valid URL, for example http://localhost:3000.");
  }
}

function createRunId(date = new Date()) {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function formatUsdc(amount: number) {
  const formatted = amount.toFixed(6).replace(/\.?0+$/, "");
  return formatted === "" ? "0" : formatted;
}

function roundUsdc(amount: number) {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isServiceStatus(value: unknown): value is ServiceStatus {
  return (
    value === "draft" ||
    value === "verifying" ||
    value === "live" ||
    value === "mock" ||
    value === "coming-soon" ||
    value === "disabled"
  );
}

function isServiceMethod(value: unknown): value is ServiceMethod {
  return value === "GET" || value === "POST";
}

function isServiceSourceType(value: unknown): value is ServiceSourceType {
  return (
    value === "static" ||
    value === "provider_backed" ||
    value === "seller_mock" ||
    value === "external_placeholder" ||
    value === "external_seller"
  );
}

function isApiService(value: unknown): value is ApiService {
  if (!value || typeof value !== "object") return false;
  const service = value as Record<string, unknown>;

  return (
    typeof service.id === "string" &&
    typeof service.slug === "string" &&
    typeof service.name === "string" &&
    typeof service.shortDescription === "string" &&
    typeof service.category === "string" &&
    isServiceMethod(service.method) &&
    typeof service.endpoint === "string" &&
    typeof service.priceUsd === "number" &&
    isServiceStatus(service.status) &&
    isServiceSourceType(service.sourceType)
  );
}

async function writeRunLog(runFilePath: string | null, runLog: RunLog) {
  runLog.updatedAt = new Date().toISOString();
  if (!runFilePath) return;
  await mkdir(path.dirname(runFilePath), { recursive: true });
  await writeFile(runFilePath, `${JSON.stringify(runLog, null, 2)}\n`);
}

async function appendRunError(
  runFilePath: string | null,
  runLog: RunLog,
  stage: string,
  error: unknown,
) {
  runLog.errors.push({
    at: new Date().toISOString(),
    stage,
    message: toErrorMessage(error),
  });
  await writeRunLog(runFilePath, runLog);
}

function retryCommand(runFilePath: string, options: BuyerAgentExecutionOptions) {
  const task = options.task.replace(/"/g, '\\"');
  return `AGENT_PRIVATE_KEY=$(node -e "console.log(require('./${runFilePath}').ephemeralAgentPrivateKey)") AGENT_SKIP_FUNDING=1 AGENT_SKIP_DEPOSIT=1 npm run agent -- --task "${task}" --limit ${formatUsdc(options.spendingLimit)} --mode scripted`;
}

async function withNonceRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = toErrorMessage(err);
      const isNonceError =
        msg.includes("replacement transaction underpriced") ||
        msg.includes("nonce too low") ||
        msg.includes("already known");
      if (!isNonceError || attempt === maxRetries - 1) throw err;
      const delay = 1000 + Math.random() * 2000;
      console.log(`  ${label}: nonce collision, retrying in ${Math.round(delay)}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("unreachable");
}

function serviceUrl(baseUrl: string, service: ApiService) {
  return `${baseUrl}${service.endpoint}`;
}

function createTextAnalyzerBody(
  task: string,
  inputText: string | null | undefined,
  paidPreviews: unknown[],
) {
  if (inputText?.trim()) {
    return { text: inputText.trim() };
  }

  const context = paidPreviews.length > 0
    ? JSON.stringify(paidPreviews, null, 2)
    : "No paid context has been collected yet.";

  return {
    text: [
      `Task: ${task}`,
      inputText?.trim() ? `User input:\n${inputText.trim()}` : null,
      `Paid context collected so far:\n${context}`,
    ].filter(Boolean).join("\n\n"),
  };
}

export function requestBodyForService(
  service: ApiService,
  task: string,
  inputText: string | null | undefined,
  paidPreviews: unknown[],
  marketSymbol?: PythMarketSymbol | null,
  repository?: GitHubRepositoryRef | null,
  runtimeServiceOutputs?: ReadonlyMap<string, unknown>,
  requestPayload?: unknown,
) {
  if (service.method !== "POST") return undefined;

  if (requestPayload !== undefined) return requestPayload;

  if (service.slug === "github-repository-intelligence") {
    let repoRef = repository;
    if (!repoRef && inputText) {
      try {
        repoRef = parseGitHubRepositoryInput(inputText);
      } catch {
        // ignore invalid input for fallback
      }
    }
    if (repoRef) {
      return { owner: repoRef.owner, repository: repoRef.name };
    }
  }

  if (service.slug === "github-due-diligence-analysis") {
    let snapshot: unknown = undefined;
    if (runtimeServiceOutputs && runtimeServiceOutputs.has("github-repository-intelligence")) {
      snapshot = runtimeServiceOutputs.get("github-repository-intelligence");
    } else {
      for (const preview of paidPreviews) {
        if (preview && typeof preview === "object") {
          const item = preview as Record<string, unknown>;
          const resp = (item.response ?? item) as Record<string, unknown>;
          if (resp && typeof resp === "object") {
            if ("ref" in resp && "repository" in resp) {
              snapshot = resp;
              break;
            }
            if ("snapshot" in resp && typeof resp.snapshot === "object" && resp.snapshot) {
              snapshot = resp.snapshot;
              break;
            }
          }
        }
      }
    }

    if (!isGitHubRepositorySnapshot(snapshot)) {
      throw new WorkflowDependencyError(
        "github_snapshot_unavailable",
        "GitHub repository intelligence did not produce a valid snapshot.",
      );
    }
    return { repository, snapshot };
  }

  if (service.slug === "text-analyzer") {
    return createTextAnalyzerBody(task, inputText, paidPreviews);
  }

  if (service.slug === "pyth-market-price") {
    return { symbol: marketSymbol ?? inferPythSymbol(inputText, task) };
  }

  const example = service.exampleRequest as { body?: Record<string, unknown> };
  return example.body ?? {};
}

function requestInitForService(service: ApiService, body: unknown): RequestInit {
  return {
    method: service.method,
    headers: service.method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function latestExchange(
  exchanges: PaymentHttpExchange[],
  paidAttempt?: boolean,
) {
  const filtered = paidAttempt === undefined
    ? exchanges
    : exchanges.filter((exchange) => exchange.paidAttempt === paidAttempt);

  return filtered.at(-1);
}

export function previewJson(value: unknown, maxChars = 1600): unknown {
  const encoded = JSON.stringify(value);
  if (!encoded) return null;
  if (encoded.length <= maxChars) return value;

  return {
    truncated: true,
    preview: encoded.slice(0, maxChars),
  };
}

function safeRaw(value: Record<string, unknown>) {
  return previewJson(value, 2200) as Record<string, unknown>;
}

function updateLocalStep(
  runLog: RunLog,
  stepIndex: number,
  patch: Partial<LocalStepLog>,
) {
  const index = runLog.steps.findIndex((step) => step.stepIndex === stepIndex);
  if (index === -1) return;
  runLog.steps[index] = { ...runLog.steps[index], ...patch };
}

function runSummary(input: {
  selected: number;
  skipped: number;
  paid: number;
  failed: number;
  spent: number;
}) {
  return `Selected ${input.selected}, paid ${input.paid}, skipped ${input.skipped}, failed ${input.failed}. Spent ${formatUsdc(input.spent)} USDC.`;
}

export class WorkflowDependencyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowDependencyError";
  }
}

class InsufficientGatewayBalanceError extends Error {
  constructor(
    message: string,
    readonly availableUsdc: number | null,
    readonly requiredUsdc: number,
  ) {
    super(message);
    this.name = "InsufficientGatewayBalanceError";
  }
}

function isInsufficientBalanceError(error: unknown) {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("insufficient_balance") ||
    message.includes("insufficient balance") ||
    message.includes("not enough balance")
  );
}

function lowerLimitDemoCommand(options: BuyerAgentExecutionOptions) {
  const task = options.task.replace(/"/g, '\\"');
  return `AGENT_MAX_IN_FLIGHT=1 npm run agent -- --task "${task}" --limit 0.001`;
}

function printPlanPreflight(input: {
  selected: ExecutableDecision[];
  skippedCount: number;
  estimatedSpendUsdc: number;
  budgetUsdc: number;
  gatewayBalance: GatewayBalanceDiagnostic;
  skipDeposit: boolean;
  depositAmountUsdc: string;
}) {
  console.log("\nBuyer-agent preflight summary:");
  console.log(`  Selected services: ${input.selected.length}`);
  for (const decision of input.selected) {
    console.log(
      `    - ${decision.service.name}: ${formatUsdc(decision.expectedPriceUsd)} USDC (${decision.service.method} ${decision.service.endpoint})`,
    );
  }
  console.log(`  Skipped services: ${input.skippedCount}`);
  console.log(`  Estimated spend: ${formatUsdc(input.estimatedSpendUsdc)} USDC`);
  console.log(`  Current budget: ${formatUsdc(input.budgetUsdc)} USDC`);
  console.log(
    `  Fits budget: ${input.estimatedSpendUsdc <= input.budgetUsdc + 0.0000001 ? "yes" : "no"}`,
  );

  if (input.gatewayBalance.detectable) {
    console.log(
      `  Gateway available balance: ${input.gatewayBalance.formattedAvailable ?? "unknown"} USDC`,
    );
    const projected =
      (input.gatewayBalance.available ?? 0) +
      (input.skipDeposit ? 0 : Number(input.depositAmountUsdc));
    console.log(
      `  Balance appears sufficient: ${projected + 0.0000001 >= input.estimatedSpendUsdc ? "yes" : "no"}`,
    );
  } else {
    console.log(
      `  Gateway balance: not detectable${input.gatewayBalance.warning ? ` (${input.gatewayBalance.warning})` : ""}`,
    );
  }
}

async function fetchServiceRegistry(baseUrl: string, retries: number, timeoutMs: number) {
  const response = await fetchWithRetry(
    `${baseUrl}/api/store/services`,
    { method: "GET" },
    {
      retries,
      timeoutMs,
      label: "Service discovery GET /api/store/services",
    },
  );

  if (!response.ok) {
    throw new Error(`Service discovery failed with HTTP ${response.status}.`);
  }

  const data = (await response.json()) as ServiceDiscoveryResponse;
  const services = data.services;

  if (!Array.isArray(services)) {
    throw new Error("Service discovery response did not include a services array.");
  }

  const invalid = services.find((service) => !isApiService(service));
  if (invalid) {
    throw new Error(`Service discovery returned an invalid service record: ${JSON.stringify(invalid)}`);
  }

  return services;
}

export async function executeBuyerAgent(
  options: BuyerAgentExecutionOptions,
): Promise<BuyerAgentExecutionResult> {
  const task = options.task.trim();
  if (!task) throw new Error("Buyer-agent task must not be empty.");
  if (!Number.isFinite(options.spendingLimit) || options.spendingLimit <= 0) {
    throw new Error("Buyer-agent spending limit must be positive.");
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const sellerAddress = options.sellerAddress;
  const depositAmount = options.depositAmountUsdc ?? "1";
  const fetchRetries = options.fetchRetries ?? 3;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 30_000;
  const postDepositWaitMs = options.postDepositWaitMs ?? 0;
  const skipFunding = options.skipFunding ?? false;
  const skipDeposit = options.skipDeposit ?? false;
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";

  if (!/^\d+(?:\.\d{1,6})?$/.test(depositAmount) || Number(depositAmount) <= 0) {
    throw new Error("Deposit amount must be a positive USDC value with at most 6 decimals.");
  }
  if (!Number.isInteger(fetchRetries) || fetchRetries < 0) {
    throw new Error("Fetch retries must be a non-negative integer.");
  }
  if (!Number.isInteger(fetchTimeoutMs) || fetchTimeoutMs <= 0) {
    throw new Error("Fetch timeout must be a positive integer.");
  }
  if (!skipFunding && (!options.funderPrivateKey || !options.funderAddress)) {
    throw new Error("Funding requires a funder private key and matching address.");
  }

  const agentKey = options.agentPrivateKey;
  const agentAccount = privateKeyToAccount(agentKey);
  const funderAccount = options.funderPrivateKey
    ? privateKeyToAccount(options.funderPrivateKey)
    : null;

  if (
    funderAccount &&
    options.funderAddress &&
    funderAccount.address.toLowerCase() !== options.funderAddress.toLowerCase()
  ) {
    throw new Error("BUYER_ADDRESS does not match BUYER_PRIVATE_KEY.");
  }

  const restoreFetchWithRetry = installFetchWithRetry({
    // Gateway payments are intentionally single-attempt. Read-only preflight,
    // balance, deposit, and provider retries are handled at their own boundary.
    retries: 0,
    timeoutMs: fetchTimeoutMs,
    label: "agent HTTP request",
  });
  const httpDiagnostics = installPaymentHttpDiagnostics(baseUrl);
  let fetchRestored = false;
  function restoreFetch() {
    if (fetchRestored) return;
    fetchRestored = true;
    httpDiagnostics.restore();
    restoreFetchWithRetry();
  }

  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  });
  const funderWallet = funderAccount
    ? createWalletClient({
        account: funderAccount,
        chain: arcTestnet,
        transport: http(rpcUrl),
      })
    : null;
  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: agentKey,
  });

  const runId = createRunId();
  const runFilePath = options.writeLocalRunLog === false
    ? null
    : path.join(RUN_DIR, `${runId}.json`);
  const runLog: RunLog = {
    runId,
    supabaseRunId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    task,
    mode: "scripted",
    baseUrl,
    funderAddress: funderAccount?.address ?? agentAccount.address,
    sellerAddress,
    ephemeralAgentAddress: agentAccount.address,
    ...(runFilePath ? { ephemeralAgentPrivateKey: agentKey } : {}),
    walletSource: options.walletSource,
    budgetUsdc: formatUsdc(options.spendingLimit),
    spentUsdc: "0",
    depositAmountUsdc: depositAmount,
    targetNetwork: TARGET_NETWORK,
    fundingTxHash: null,
    usdcTransferTxHash: null,
    depositTxHash: null,
    status: "created",
    steps: [],
    summary: null,
    errors: [],
    persistenceWarnings: [],
  };
  await writeRunLog(runFilePath, runLog);

  const paidStepIds: string[] = [];
  const serviceResults: BuyerAgentServiceResult[] = [];

  async function emitProgress(
    stage: BuyerAgentProgressStage,
    message?: string,
  ) {
    if (!options.onProgress) return;

    try {
      await options.onProgress({
        stage,
        agentRunId: runLog.supabaseRunId,
        spentUsdc: runLog.spentUsdc,
        paymentEventIds: runLog.steps
          .map((step) => step.paymentEventId)
          .filter((value): value is string => Boolean(value)),
        message,
      });
    } catch (error) {
      console.warn(
        `[agent-persistence] hosted progress update failed: ${toErrorMessage(error)}`,
      );
    }
  }

  async function waitForOnchainProofs() {
    const timeoutMs = options.proofWaitTimeoutMs ?? 0;
    const paymentEventIds = runLog.steps
      .map((step) => step.paymentEventId)
      .filter((value): value is string => Boolean(value));
    if (timeoutMs <= 0 || paymentEventIds.length === 0) return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let states;
      try {
        states = await getPaymentEventProofStates(paymentEventIds);
      } catch (error) {
        addPersistenceWarning("wait for onchain proofs", toErrorMessage(error));
        return;
      }
      if (
        states.length === paymentEventIds.length &&
        states.every((state) => state.onchain_status === "verified")
      ) {
        return;
      }
      if (
        states.length === paymentEventIds.length &&
        states.some((state) => state.onchain_status === "failed")
      ) {
        return;
      }
      await sleep(750);
    }
  }

  function addPersistenceWarning(stage: string, detail: string) {
    const warning = `${stage}: ${detail}`;
    runLog.persistenceWarnings.push(warning);
    console.warn(`[agent-persistence] ${warning}`);
  }

  async function safeCreateRun() {
    try {
      const created = await createAgentRun({
        task,
        mode: "scripted",
        status: "running",
        base_url: baseUrl,
        agent_wallet: agentAccount.address,
        budget_usdc: formatUsdc(options.spendingLimit),
        spent_usdc: "0",
        raw: {
          localRunId: runId,
          walletSource: runLog.walletSource,
          targetNetwork: TARGET_NETWORK,
          mcp: "raw Arc Docs MCP fallback verified before implementation",
        },
      });
      if (!created) {
        addPersistenceWarning("create agent run", "Supabase row was not created; local paid execution will continue.");
      }
      return created;
    } catch (error) {
      addPersistenceWarning("create agent run", toErrorMessage(error));
      return null;
    }
  }

  async function safeUpdateRun(input: Parameters<typeof updateAgentRun>[1], stage: string) {
    try {
      const ok = await updateAgentRun(runLog.supabaseRunId, input);
      if (!ok && runLog.supabaseRunId) {
        addPersistenceWarning(stage, "Supabase run update returned false.");
      }
      return ok;
    } catch (error) {
      addPersistenceWarning(stage, toErrorMessage(error));
      return false;
    }
  }

  async function safeCreateStep(input: Parameters<typeof createAgentStep>[0], stage: string) {
    try {
      const step = await createAgentStep(input);
      if (!step) addPersistenceWarning(stage, "Supabase step was not created.");
      return step;
    } catch (error) {
      addPersistenceWarning(stage, toErrorMessage(error));
      return null;
    }
  }

  async function safeUpdateStep(
    stepId: string | null,
    input: Parameters<typeof updateAgentStep>[1],
    stage: string,
  ) {
    try {
      const ok = await updateAgentStep(stepId, input);
      if (!ok && stepId) addPersistenceWarning(stage, "Supabase step update returned false.");
      return ok;
    } catch (error) {
      addPersistenceWarning(stage, toErrorMessage(error));
      return false;
    }
  }

  async function safeFindPaymentEvent(input: Parameters<typeof findRecentPaymentEvent>[0]) {
    try {
      return await findRecentPaymentEvent(input);
    } catch (error) {
      addPersistenceWarning("payment event matching", toErrorMessage(error));
      return null;
    }
  }

  async function safeRecalculatePassport(stage: string) {
    try {
      return await recalculateAgentProfile(agentAccount.address, {
        runId: runLog.supabaseRunId,
      });
    } catch (error) {
      addPersistenceWarning(stage, toErrorMessage(error));
      return null;
    }
  }

  const supabaseRun = await safeCreateRun();
  if (!supabaseRun && options.requirePersistence) {
    restoreFetch();
    throw new Error("Hosted buyer-agent requires durable run persistence.");
  }
  runLog.supabaseRunId = supabaseRun?.id ?? null;
  try {
    const profile = await createOrUpdateAgentProfileByWallet(agentAccount.address);
    if (!profile) {
      addPersistenceWarning("passport bootstrap", "Agent profile was not created yet.");
    }
  } catch (error) {
    addPersistenceWarning("passport bootstrap", toErrorMessage(error));
  }
  await writeRunLog(runFilePath, runLog);

  if (runFilePath) console.log(`Run file: ${runFilePath}`);
  console.log(`Supabase run: ${runLog.supabaseRunId ?? "not persisted"}`);
  console.log(`Task: ${task}`);
  console.log("Mode: scripted");
  console.log(`Budget: ${formatUsdc(options.spendingLimit)} USDC`);
  console.log(`Agent wallet: ${agentAccount.address}`);
  if (funderAccount) console.log(`Funder wallet: ${funderAccount.address}`);
  console.log(`Seller address: ${sellerAddress}`);
  console.log(`Target network: ${TARGET_NETWORK}`);
  console.log(`Base URL: ${baseUrl}`);

  async function gracefulFailure(stage: string, error: unknown) {
    runLog.status = "failed";
    runLog.summary = `${stage} failed: ${toErrorMessage(error)}`;
    await appendRunError(runFilePath, runLog, stage, error);
    await safeUpdateRun({
      status: "failed",
      spent_usdc: runLog.spentUsdc,
      summary: runLog.summary,
      error: toErrorMessage(error),
    }, "mark run failed");
    await safeRecalculatePassport("recalculate passport after failure");

    console.error("\nAgent runner stopped gracefully.");
    if (runLog.depositTxHash) {
      console.error(`Deposit completed: ${runLog.depositTxHash}`);
    }
    console.error(`${stage} failed.`);
    console.error(`Reason: ${toErrorMessage(error)}`);
    if (isInsufficientBalanceError(error)) {
      console.error(
        "Gateway balance is insufficient for the selected plan. Fund the buyer-agent from /agent-launch, deposit more USDC into Gateway, or run a lower-limit proof command:",
      );
      console.error(lowerLimitDemoCommand(options));
    }
    if (runFilePath) console.error(`Run file: ${runFilePath}`);
    console.error(`Paid count: ${runLog.steps.filter((step) => step.status === "paid").length}`);
    console.error(`Spent amount: ${runLog.spentUsdc} USDC`);
    if (runLog.persistenceWarnings.length > 0) {
      console.error("Persistence warnings:");
      for (const warning of runLog.persistenceWarnings) {
        console.error(`  - ${warning}`);
      }
    }
    if (runFilePath) {
      console.error("Retry with the same wallet and existing Gateway balance:");
      console.error(retryCommand(runFilePath, options));
    }
  }

  if (options.installSignalHandler) {
    process.once("SIGINT", () => {
      void (async () => {
        runLog.status = "stopped";
        runLog.summary = "Agent run stopped by SIGINT.";
        await writeRunLog(runFilePath, runLog);
        await safeUpdateRun({
          status: "stopped",
          spent_usdc: runLog.spentUsdc,
          summary: runLog.summary,
        }, "mark run stopped");
        await safeRecalculatePassport("recalculate passport after stop");
        if (runFilePath) console.log(`\nAgent stopped. Run file: ${runFilePath}`);
        process.exit(0);
      })();
    });
  }

  async function fundAgentWallet() {
    if (skipFunding) {
      console.log("Skipping funding because AGENT_SKIP_FUNDING=1.");
      return;
    }
    if (!funderAccount || !funderWallet) {
      throw new Error("Funder wallet is unavailable for this execution mode.");
    }

    runLog.status = "funding";
    await writeRunLog(runFilePath, runLog);

    console.log(`Funding agent wallet from funder ${funderAccount.address}...`);

    const gasTxHash = await withNonceRetry(
      () => funderWallet.sendTransaction({
        to: agentAccount.address,
        value: GAS_FUND_AMOUNT,
      }),
      "Gas tx",
    );
    await publicClient.waitForTransactionReceipt({ hash: gasTxHash });
    runLog.fundingTxHash = gasTxHash;
    await writeRunLog(runFilePath, runLog);
    console.log(`  Gas funded (${gasTxHash.slice(0, 10)}...)`);

    const usdcAmount = parseUnits(depositAmount, 6);
    const usdcTxHash = await withNonceRetry(
      () => funderWallet.writeContract({
        address: ARC_TESTNET_USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [agentAccount.address, usdcAmount],
      }),
      "USDC tx",
    );
    await publicClient.waitForTransactionReceipt({ hash: usdcTxHash });
    runLog.usdcTransferTxHash = usdcTxHash;
    runLog.status = "funded";
    await writeRunLog(runFilePath, runLog);
    console.log(`  USDC transferred (${usdcTxHash.slice(0, 10)}...)`);
  }

  async function depositToGateway() {
    if (skipDeposit) {
      console.log("Skipping initial Gateway deposit because AGENT_SKIP_DEPOSIT=1.");
      return;
    }

    runLog.status = "depositing";
    await writeRunLog(runFilePath, runLog);

    console.log("\nGateway deposit details:");
    console.log(`  Wallet: ${agentAccount.address}`);
    console.log(`  Deposit amount: ${depositAmount} USDC`);
    console.log(`  Network: ${TARGET_NETWORK}`);
    console.log(`  Base URL: ${baseUrl}`);

    const result = await withRetry(
      () => gateway.deposit(depositAmount),
      {
        retries: fetchRetries,
        timeoutMs: fetchTimeoutMs,
        label: "Gateway deposit",
      },
    );
    runLog.depositTxHash = result.depositTxHash;
    runLog.status = "deposited";
    await writeRunLog(runFilePath, runLog);
    console.log(`Deposit complete! TX: ${result.depositTxHash}`);

    try {
      const updated = await withRetry(
        () => gateway.getBalances(),
        {
          retries: fetchRetries,
          timeoutMs: fetchTimeoutMs,
          label: "Gateway balance refresh after deposit",
        },
      );
      console.log(`Gateway available balance: ${updated.gateway.formattedAvailable}`);
    } catch (error) {
      await appendRunError(runFilePath, runLog, "Gateway balance refresh after deposit", error);
      console.warn(
        `Gateway balance refresh failed after deposit: ${toErrorMessage(error)}. Continuing to paid requests.`,
      );
    }
  }

  async function waitAfterDepositIfConfigured() {
    if (postDepositWaitMs <= 0) return;

    console.log(
      `Waiting ${postDepositWaitMs}ms after Gateway deposit before paid API requests...`,
    );
    await new Promise((resolve) => setTimeout(resolve, postDepositWaitMs));
  }

  async function detectGatewayBalance(label: string): Promise<GatewayBalanceDiagnostic> {
    try {
      const balances = await withRetry(
        () => gateway.getBalances(),
        {
          retries: 1,
          timeoutMs: Math.min(fetchTimeoutMs, 15_000),
          label,
        },
      );
      const available = Number(balances.gateway.formattedAvailable);
      return {
        available: Number.isFinite(available) ? available : null,
        formattedAvailable: balances.gateway.formattedAvailable,
        detectable: true,
      };
    } catch (error) {
      await appendRunError(runFilePath, runLog, label, error);
      return {
        available: null,
        formattedAvailable: null,
        detectable: false,
        warning: toErrorMessage(error),
      };
    }
  }

  function assertGatewayBalanceCanCoverPlan(
    diagnostic: GatewayBalanceDiagnostic,
    estimatedSpendUsdc: number,
  ) {
    if (!diagnostic.detectable || diagnostic.available === null) return;
    const projectedAvailable = diagnostic.available + (skipDeposit ? 0 : Number(depositAmount));
    if (projectedAvailable + 0.0000001 >= estimatedSpendUsdc) return;

    throw new InsufficientGatewayBalanceError(
      `Gateway balance is insufficient for selected plan: ${formatUsdc(projectedAvailable)} USDC projected available, ${formatUsdc(estimatedSpendUsdc)} USDC required.`,
      diagnostic.available,
      estimatedSpendUsdc,
    );
  }

  async function preflightPaymentRequirement(
    service: ApiService,
    body: unknown,
  ): Promise<PreflightResult> {
    const url = serviceUrl(baseUrl, service);
    const startedAt = Date.now();
    const response = await fetchWithRetry(
      url,
      requestInitForService(service, body),
      {
        retries: fetchRetries,
        timeoutMs: fetchTimeoutMs,
        label: `Payment requirement preflight ${service.method} ${url}`,
      },
    );
    const exchanges = httpDiagnostics.getRecent(url);
    const exchange = latestExchange(exchanges, false);
    const responseBody = await response.clone().text().catch(() => "");

    if (response.status !== 402) {
      console.warn(
        `Preflight expected HTTP 402 from ${service.endpoint}, received ${response.status}. Continuing to paid request.`,
      );
    } else {
      console.log(`  ${service.name}: payment requirement received (HTTP 402).`);
    }

    return {
      requestId:
        response.headers.get("X-Agent-Commerce-Request-Id") ??
        exchange?.requestId,
      paymentRequired: exchange?.paymentRequired,
      responseBody: responseBody.slice(0, 800),
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }

  async function executePaidStep(
    decision: ExecutableDecision,
    paidPreviews: unknown[],
    runtimeServiceOutputs: Map<string, unknown>,
  ) {
    const { service, step, stepIndex } = decision;
    const url = serviceUrl(baseUrl, service);
    let body: unknown;
    try {
      const defaultBody = requestBodyForService(
        service,
        task,
        options.requestInputText,
        paidPreviews,
        options.marketSymbol,
        options.repository,
        runtimeServiceOutputs,
        options.requestPayload,
      );
      const resolvedBody = options.resolveServiceRequestBody
        ? await options.resolveServiceRequestBody({
            service,
            runtimeServiceOutputs,
            paidPreviews,
          })
        : undefined;
      body = resolvedBody === undefined ? defaultBody : resolvedBody;
    } catch (error) {
      if (error instanceof WorkflowDependencyError) {
        updateLocalStep(runLog, stepIndex, {
          status: "failed",
          error: error.code,
        });
        await writeRunLog(runFilePath, runLog);
        await safeUpdateStep(
          step?.id ?? null,
          {
            status: "failed",
            error: error.code,
            raw: safeRaw({ dependencyError: error.message }),
          },
          `persist dependency failed step ${stepIndex}`,
        );
        throw error;
      }
      throw error;
    }

    updateLocalStep(runLog, stepIndex, { status: "selected" });
    await writeRunLog(runFilePath, runLog);
    await safeUpdateStep(step?.id ?? null, {
      status: "selected",
      raw: safeRaw({ decision: "selected" }),
    }, `persist selected step ${stepIndex}`);

    const preflight = await preflightPaymentRequirement(service, body);
    updateLocalStep(runLog, stepIndex, {
      status: "payment_required",
      requestId: preflight.requestId ?? null,
    });
    await writeRunLog(runFilePath, runLog);
    await safeUpdateStep(step?.id ?? null, {
      status: "payment_required",
      request_id: preflight.requestId ?? null,
      raw: safeRaw({
        paymentRequired: preflight.paymentRequired,
        responseBody: preflight.responseBody,
      }),
    }, `persist payment requirement step ${stepIndex}`);

    const paidCallStartedMs = Date.now();
    const paymentStartedAt = new Date(paidCallStartedMs - 5000);
    let result: PayResult<unknown>;
    try {
      result = await withRetry(
        () => gateway.pay(url, { method: service.method, body }),
        {
          retries: 0,
          timeoutMs: fetchTimeoutMs,
          label: `Paid API request ${service.method} ${url}`,
        },
      );
    } catch (error) {
      const exchanges = httpDiagnostics.getRecent(url);
      const exchange = latestExchange(exchanges);
      const requestId = exchange?.requestId ?? preflight.requestId ?? null;

      updateLocalStep(runLog, stepIndex, {
        status: "failed",
        requestId,
        error: toErrorMessage(error),
      });
      await writeRunLog(runFilePath, runLog);
      await safeUpdateStep(step?.id ?? null, {
        status: "failed",
        request_id: requestId,
        error: toErrorMessage(error),
        raw: safeRaw({
          diagnostics: exchanges,
          preflightLatencyMs: preflight.latencyMs,
          providerLatencyMs: Math.max(0, Date.now() - paidCallStartedMs),
        }),
      }, `persist failed step ${stepIndex}`);
      if (runFilePath) printPaymentHttpDiagnostics(exchanges, runFilePath);
      if (isInsufficientBalanceError(error)) {
        throw new InsufficientGatewayBalanceError(
          `Gateway balance is insufficient for ${service.name}. Required plan spend is ${formatUsdc(decision.expectedPriceUsd)} USDC for this step; fund or deposit more USDC before retrying.`,
          null,
          decision.expectedPriceUsd,
        );
      }
      throw error;
    }

    const amount = Number(result.formattedAmount);
    const safeAmount = Number.isFinite(amount) ? amount : service.priceUsd;
    const currentSpent = Number(runLog.spentUsdc);
    const nextSpent = roundUsdc(currentSpent + safeAmount);
    runLog.spentUsdc = formatUsdc(nextSpent);

    const paidExchange = latestExchange(httpDiagnostics.getRecent(url), true);
    const requestId = paidExchange?.requestId ?? preflight.requestId ?? null;
    const paymentEventId = await safeFindPaymentEvent({
      endpoint: service.endpoint,
      payer: agentAccount.address,
      amountUsdc: result.formattedAmount,
      since: paymentStartedAt,
      requestId,
    });
    const responsePreview = previewJson(result.data);
    paidPreviews.push({
      service: service.name,
      response: responsePreview,
    });

    runtimeServiceOutputs.set(service.slug, result.data);

    updateLocalStep(runLog, stepIndex, {
      status: "paid",
      requestId,
      paymentEventId,
    });
    if (step?.id) paidStepIds.push(step.id);
    await writeRunLog(runFilePath, runLog);
    await safeUpdateStep(step?.id ?? null, {
      status: "paid",
      request_id: requestId,
      payment_event_id: paymentEventId,
      response_preview: responsePreview,
      raw: safeRaw({
        amount: result.formattedAmount,
        transaction: result.transaction,
        status: result.status,
        paymentResponse: paidExchange?.paymentResponse,
        preflightLatencyMs: preflight.latencyMs,
        providerLatencyMs: Math.max(0, Date.now() - paidCallStartedMs),
      }),
    }, `persist paid step ${stepIndex}`);
    await safeUpdateRun({
      spent_usdc: runLog.spentUsdc,
    }, "persist spent amount");

    console.log(
      `  ${service.name}: paid ${result.formattedAmount} USDC (spent ${runLog.spentUsdc}/${formatUsdc(options.spendingLimit)} USDC).`,
    );
    return {
      serviceId: service.id,
      serviceSlug: service.slug,
      serviceName: service.name,
      status: "paid" as const,
      amountUsdc: result.formattedAmount,
      stepId: step?.id ?? null,
      paymentEventId,
      response: responsePreview,
      error: null,
    };
  }

  try {
    await emitProgress("planning", "Discovering allowlisted live services.");
    runLog.status = "discovering";
    await writeRunLog(runFilePath, runLog);
    console.log("\nDiscovering services from /api/store/services...");
    const discoveredServices = options.serviceSnapshot
      ? [...options.serviceSnapshot]
      : await fetchServiceRegistry(
          baseUrl,
          fetchRetries,
          fetchTimeoutMs,
        );
    const services = options.serviceAllowlist
      ? discoveredServices.filter((service) =>
          options.serviceAllowlist?.some(
            (allowed) =>
              allowed.slug === service.slug &&
              allowed.endpoint === service.endpoint &&
              allowed.method === service.method,
          ),
        )
      : discoveredServices;
    console.log(
      `Discovered ${discoveredServices.length} services; ${services.length} allowed for this execution mode.`,
    );

    runLog.status = "planning";
    await writeRunLog(runFilePath, runLog);
    const plan = planAgentPurchases({
      task,
      budgetUsdc: options.spendingLimit,
      services,
      policy: options.planningPolicy,
    });
    const decisions = plan.decisions;
    const selectedCount = plan.selected.length;
    const skippedCount = plan.skipped.length;
    console.log(`Planner selected ${selectedCount} service(s), skipped ${skippedCount}.`);

    await safeUpdateRun({
      raw: {
        localRunId: runId,
        walletSource: runLog.walletSource,
        targetNetwork: TARGET_NETWORK,
        serviceCount: services.length,
        selectedCount,
        skippedCount,
        estimatedSpendUsdc: plan.estimatedSpendUsdc,
        planWarnings: plan.warnings,
      },
    }, "persist plan summary");

    const executableDecisions: ExecutableDecision[] = [];
    for (const [index, decision] of decisions.entries()) {
      const stepIndex = index + 1;
      const { service } = decision;
      const step = runLog.supabaseRunId
        ? await safeCreateStep({
            run_id: runLog.supabaseRunId,
            step_index: stepIndex,
            service_id: service.id,
            service_slug: service.slug,
            service_name: service.name,
            service_source_type: service.sourceType,
            endpoint: service.endpoint,
            method: service.method,
            price_usdc: formatUsdc(service.priceUsd),
            status: "discovered",
            reasoning: decision.reasoning,
            raw: safeRaw({
              decision: decision.decision,
              expectedPriceUsd: decision.expectedPriceUsd,
              sourceType: service.sourceType,
            }),
          }, `create timeline step ${stepIndex}`)
        : null;

      const status: AgentStepStatus =
        decision.decision === "selected" ? "selected" : "skipped";
      runLog.steps.push({
        stepId: step?.id ?? null,
        stepIndex,
        serviceSlug: service.slug,
        serviceName: service.name,
        status,
        reasoning: decision.reasoning,
      });
      await safeUpdateStep(step?.id ?? null, {
        status,
        raw: safeRaw({
          decision: decision.decision,
          expectedPriceUsd: decision.expectedPriceUsd,
          sourceType: service.sourceType,
        }),
      }, `persist planned step ${stepIndex}`);
      executableDecisions.push({ ...decision, step, stepIndex });
    }
    await writeRunLog(runFilePath, runLog);

    const selected = executableDecisions.filter(
      (decision) => decision.decision === "selected",
    );

    await emitProgress(
      "purchasing",
      `Planner selected ${selected.length} allowlisted service(s).`,
    );

    if (selected.length > 0) {
      const gatewayDiagnostic = await detectGatewayBalance("Gateway balance preflight");
      printPlanPreflight({
        selected,
        skippedCount,
        estimatedSpendUsdc: plan.estimatedSpendUsdc,
        budgetUsdc: options.spendingLimit,
        gatewayBalance: gatewayDiagnostic,
        skipDeposit,
        depositAmountUsdc: depositAmount,
      });
      assertGatewayBalanceCanCoverPlan(gatewayDiagnostic, plan.estimatedSpendUsdc);

      console.log(
        skipDeposit
          ? "This run will reuse existing Gateway balance and skip the initial deposit."
          : `This run will deposit ${depositAmount} USDC into Gateway from the ephemeral wallet.`,
      );
      await fundAgentWallet();
      await depositToGateway();
      await waitAfterDepositIfConfigured();
    } else {
      console.log("No services selected for purchase; skipping funding and Gateway deposit.");
    }

    runLog.status = "running";
    await writeRunLog(runFilePath, runLog);

    const paidPreviews: unknown[] = [];
    const runtimeServiceOutputs = new Map<string, unknown>();
    const workflowArtifacts: BuyerAgentWorkflowArtifacts = {};
    for (const decision of selected) {
      try {
        const stepResult = await executePaidStep(
          decision,
          paidPreviews,
          runtimeServiceOutputs,
        );
        serviceResults.push(stepResult);
        if (stepResult.status === "paid") {
          const rawResult = runtimeServiceOutputs.get(decision.service.slug);
          if (decision.service.slug === "github-repository-intelligence" && rawResult) {
            workflowArtifacts.githubRepositorySnapshot = rawResult as GitHubRepositorySnapshot;
          }
          if (decision.service.slug === "github-due-diligence-analysis" && rawResult) {
            workflowArtifacts.githubDueDiligenceAssessment = (
              rawResult as { assessment: GitHubDueDiligenceAssessment }
            ).assessment;
          }
        }
      } catch (error) {
        serviceResults.push({
          serviceId: decision.service.id,
          serviceSlug: decision.service.slug,
          serviceName: decision.service.name,
          status: "failed",
          amountUsdc: null,
          stepId: decision.step?.id ?? null,
          paymentEventId: null,
          response: null,
          error: error instanceof WorkflowDependencyError ? error.code : toErrorMessage(error),
        });
        if (!options.continueOnServiceFailure) throw error;
      }
    }

    await emitProgress(
      "generating_receipt",
      "Linking settled payments to commerce receipts.",
    );
    await emitProgress(
      "publishing_onchain_proof",
      "Waiting for the post-settlement Arc proof publisher.",
    );
    await waitForOnchainProofs();

    const paidCount = runLog.steps.filter((step) => step.status === "paid").length;
    const failedCount = runLog.steps.filter((step) => step.status === "failed").length;
    if (options.requirePaidPurchase && paidCount === 0) {
      throw new Error(
        "Hosted buyer-agent did not complete an allowlisted paid purchase.",
      );
    }
    const summary = runSummary({
      selected: selected.length,
      skipped: skippedCount,
      paid: paidCount,
      failed: failedCount,
      spent: Number(runLog.spentUsdc),
    });
    const finalStatus: AgentRunStatus =
      failedCount > 0 && !options.continueOnServiceFailure
        ? "failed"
        : "completed";
    runLog.status = finalStatus;
    runLog.summary = summary;
    await writeRunLog(runFilePath, runLog);
    await safeUpdateRun({
      status: finalStatus,
      spent_usdc: runLog.spentUsdc,
      summary,
      error: failedCount > 0 ? "One or more selected services failed." : null,
    }, "persist final run summary");
    const passport = await safeRecalculatePassport("recalculate passport after completion");

    console.log(`\nAgent run complete. ${summary}`);
    if (runFilePath) console.log(`Run file: ${runFilePath}`);
    console.log(`Paid count: ${paidCount}`);
    console.log(`Spent amount: ${runLog.spentUsdc} USDC`);
    if (runLog.persistenceWarnings.length > 0) {
      console.log("Persistence warnings (paid execution still completed):");
      for (const warning of runLog.persistenceWarnings) {
        console.log(`  - ${warning}`);
      }
    }
    if (runLog.supabaseRunId) {
      console.log(`Timeline: ${baseUrl}/runs/${runLog.supabaseRunId}`);
    }
    if (passport) {
      console.log(`Agent Passport: ${baseUrl}/agents/${agentAccount.address}`);
      console.log(`Demo trust score: ${passport.trust_score}/100`);
    }
    await emitProgress("completed", summary);
    restoreFetch();
    return {
      agentRunId: runLog.supabaseRunId,
      agentWallet: agentAccount.address,
      spentUsdc: runLog.spentUsdc,
      paidStepIds,
      paymentEventIds: runLog.steps
        .map((step) => step.paymentEventId)
        .filter((value): value is string => Boolean(value)),
      selectedServices: plan.selected.map((decision) => ({
        id: decision.service.id,
        slug: decision.service.slug,
        name: decision.service.name,
        endpoint: decision.service.endpoint,
        method: decision.service.method,
        priceUsd: decision.expectedPriceUsd,
        reasoning: decision.reasoning,
      })),
      skippedServices: plan.skipped.map((decision) => ({
        id: decision.service.id,
        slug: decision.service.slug,
        name: decision.service.name,
        priceUsd: decision.expectedPriceUsd,
        reasoning: decision.reasoning,
      })),
      serviceResults,
      workflowArtifacts,
      status: finalStatus,
      summary,
    };
  } catch (error) {
    await gracefulFailure("Agent run", error);
    await emitProgress("failed", toErrorMessage(error));
    restoreFetch();
    throw error;
  }
}
