import { createHmac } from "node:crypto";
import type { Address } from "viem";
import { executeBuyerAgent } from "../agent/execution.ts";
import {
  getHostedRunnerConfig,
  hostedIdempotencyHash,
  safeHostedError,
} from "../agent/hosted-policy.ts";
import {
  hostedWorkflowInputMetadata,
  type HostedPlannerSnapshot,
  type HostedWorkflowRequest,
} from "../agent/hosted-workflows.ts";
import { getHostedAgentJob, type HostedAgentJobRow } from "../agent/hosted-jobs.ts";
import {
  createHostedWorkflowQuote,
  finalizeHostedWorkflowUserPayment,
  getHostedWorkflowQuote,
} from "../commerce/workflow-checkout.ts";
import { defaultServicePresentation } from "../services/presentation.ts";
import type { ApiService } from "../services/registry.ts";
import {
  canonicalSellerInput,
  getSellerAccountById,
  getSellerMarketplaceClient,
  getSellerServiceRowById,
  getSellerServiceVersion,
  isSellerAccountRunnable,
  isSellerServiceRunnable,
  safeSellerResult,
  sellerWorkflowType,
  validateSellerWorkflowInput,
  type SellerMarketplaceServiceRow,
  type SellerServiceVersionRow,
} from "./marketplace.ts";

function formatUsdc(value: string | number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toFixed(6).replace(/\.?0+$/, "") || "0"
    : "0";
}

function sellerRequestHash(input: {
  secret: string;
  workflowType: string;
  inputSha256: string;
  serviceId: string;
  serviceVersion: number;
  priceUsdc: string;
}) {
  return createHmac("sha256", input.secret)
    .update([
      "seller-workflow-request-v1",
      input.workflowType,
      input.inputSha256,
      input.serviceId,
      String(input.serviceVersion),
      input.priceUsdc,
    ].join("\n"))
    .digest("hex");
}

export function sellerWorkflowAllowed(allowedWorkflows: readonly string[], workflowType: string) {
  const set = new Set(allowedWorkflows);
  return set.has("*") || set.has("seller:*") || set.has(workflowType);
}

export function sellerSponsoredExecutionEnabled() {
  return process.env.SELLER_WORKFLOW_ALLOW_SPONSORED === "true";
}

function sellerPlan(
  service: SellerMarketplaceServiceRow,
  version: SellerServiceVersionRow,
  inputText: string,
) {
  const price = Number(version.price_usdc);
  const input = hostedWorkflowInputMetadata(inputText);
  return {
    version: 4,
    workflowType: sellerWorkflowType(service.slug),
    workflowLabel: version.name,
    effectiveTask: `Execute the immutable ${version.name} external seller workflow.`,
    selectedServices: [{
      id: service.public_id,
      slug: service.public_id,
      name: version.name,
      endpoint: `/api/seller-workflows/execute/${service.public_id}/versions/${version.service_version}`,
      method: "POST",
      priceUsdc: price,
      reasoning: "The buyer explicitly selected this external seller workflow.",
      presentation: defaultServicePresentation("external_seller"),
    }],
    skippedServices: [],
    estimatedSpendUsdc: price,
    remainingBudgetUsdc: 0,
    maxPaidCalls: 1,
    budgetCapUsdc: Math.max(0.001, price),
    aggregationMode: "deterministic_execution_optional_llm",
    aggregationLabel: "Deterministic paid execution with optional StepFun synthesis",
    inputPreview: input.preview,
    inputSha256: input.sha256,
    marketSymbol: null,
    repository: null,
    warnings: [],
  } as HostedPlannerSnapshot;
}

export async function createSellerWorkflowQuote(input: {
  service: SellerMarketplaceServiceRow;
  payload: unknown;
  idempotencyKey: string;
  requesterFingerprint: string;
  requesterWallet: Address;
  byoaAgentId?: string;
  machineCredentialId?: string;
  ownerWallet?: string;
}) {
  if (!isSellerServiceRunnable(input.service)) {
    throw new Error("Seller workflow is unavailable.");
  }
  const [version, seller] = await Promise.all([
    getSellerServiceVersion(input.service.id, input.service.service_version),
    getSellerAccountById(input.service.seller_id),
  ]);
  if (!version || !seller || !isSellerAccountRunnable(seller)) {
    throw new Error("Seller workflow is unavailable.");
  }
  validateSellerWorkflowInput(input.payload, version.input_schema);
  const inputText = canonicalSellerInput(input.payload);
  if (inputText.length > 5_000) throw new Error("Seller workflow input exceeds 5000 characters.");
  const config = getHostedRunnerConfig();
  const inputSha256 = hostedWorkflowInputMetadata(inputText).sha256;
  const priceUsdc = formatUsdc(version.price_usdc);
  const workflowType = sellerWorkflowType(input.service.slug);
  const plan = sellerPlan(input.service, version, inputText);
  const request = {
    workflowType,
    inputText,
    task: `Execute the ${version.name} external seller workflow.`,
    marketSymbol: null,
    repository: null,
    budgetUsdc: Math.max(0.001, Number(priceUsdc)),
  } as unknown as HostedWorkflowRequest;

  return createHostedWorkflowQuote({
    idempotencyHash: hostedIdempotencyHash(config.rateLimitSecret, input.idempotencyKey),
    requestHash: sellerRequestHash({
      secret: config.rateLimitSecret,
      workflowType,
      inputSha256,
      serviceId: input.service.id,
      serviceVersion: version.service_version,
      priceUsdc,
    }),
    requesterFingerprint: input.requesterFingerprint,
    requesterWallet: input.requesterWallet,
    request,
    plan,
    byoaAgentId: input.byoaAgentId,
    machineCredentialId: input.machineCredentialId,
    ownerWallet: input.ownerWallet,
    allowSponsored: sellerSponsoredExecutionEnabled(),
    sellerSnapshot: {
      serviceId: input.service.id,
      servicePublicId: input.service.public_id,
      serviceVersion: version.service_version,
      sellerId: seller.id,
      sellerPublicId: seller.public_id,
      sellerNetAmountUsdc: Number(priceUsdc),
    },
    metadata: {
      provider_type: "external_seller",
      output_schema: version.output_schema,
    },
  });
}

export function sellerQuoteRequestHash(input: {
  workflowType: string;
  payload: unknown;
  serviceId: string;
  serviceVersion: number;
  priceUsdc: string | number;
}) {
  const config = getHostedRunnerConfig();
  return sellerRequestHash({
    secret: config.rateLimitSecret,
    workflowType: input.workflowType,
    inputSha256: hostedWorkflowInputMetadata(canonicalSellerInput(input.payload)).sha256,
    serviceId: input.serviceId,
    serviceVersion: input.serviceVersion,
    priceUsdc: formatUsdc(input.priceUsdc),
  });
}

export function sellerExecutionApiService(input: {
  service: SellerMarketplaceServiceRow;
  version: SellerServiceVersionRow;
}): ApiService {
  const price = Number(input.version.price_usdc);
  return {
    id: input.service.public_id,
    slug: input.service.public_id,
    name: input.version.name,
    shortDescription: input.version.short_description,
    longDescription: input.version.long_description,
    category: input.version.category,
    method: "POST",
    endpoint: `/api/seller-workflows/execute/${input.service.public_id}/versions/${input.version.service_version}`,
    priceLabel: `${formatUsdc(price)} USDC`,
    priceUsd: price,
    status: "live",
    sourceType: "external_seller",
    presentation: defaultServicePresentation("external_seller"),
    isPaid: true,
    inputSchema: input.version.input_schema,
    outputSchema: input.version.output_schema,
    exampleRequest: {},
    exampleResponse: {},
    exampleUseCase: input.version.short_description,
    agentReasoningHint: "Execute the buyer-selected immutable external seller service version.",
  };
}

async function claimSellerJob(jobId: string) {
  const { data, error } = await getSellerMarketplaceClient().rpc("claim_hosted_agent_job", {
    p_job_id: jobId,
  });
  if (error) throw new Error("Unable to claim seller workflow job.");
  return data === true;
}

async function updateSellerJob(jobId: string, values: Record<string, unknown>) {
  const { error } = await getSellerMarketplaceClient().from("hosted_agent_jobs")
    .update(values).eq("id", jobId);
  if (error) throw new Error("Unable to update seller workflow job.");
}

async function verifiedProofHashes(paymentEventIds: string[]) {
  if (paymentEventIds.length === 0) return [];
  const result = await getSellerMarketplaceClient().from("payment_events")
    .select("onchain_tx_hash").in("id", paymentEventIds).eq("onchain_status", "verified");
  if (result.error) return [];
  return (result.data ?? []).map((row) => row.onchain_tx_hash as string | null)
    .filter((value): value is string => Boolean(value));
}

async function finalizeSellerSuccess(input: {
  job: HostedAgentJobRow;
  service: SellerMarketplaceServiceRow;
  version: SellerServiceVersionRow;
  receiptId: string | null;
  paymentEventId: string | null;
  providerCostUsdc: number;
}) {
  const result = await getSellerMarketplaceClient().rpc("finalize_seller_workflow_success_v1", {
    p_job_id: input.job.id,
    p_service_id: input.service.id,
    p_service_version: input.version.service_version,
    p_receipt_id: input.receiptId,
    p_payment_event_id: input.paymentEventId,
    p_provider_cost_usdc: input.providerCostUsdc,
  });
  if (result.error || result.data !== true) {
    throw new Error("Unable to atomically finalize seller revenue and buyer accounting.");
  }
}

export async function runSellerAgentJob(jobId: string, payload: unknown) {
  const queuedJob = await getHostedAgentJob(jobId);
  if (!queuedJob || !queuedJob.workflow_quote_id) throw new Error("Seller workflow job was not found.");
  const claimed = await claimSellerJob(jobId);
  if (!claimed) return { claimed: false as const };
  const job = await getHostedAgentJob(jobId);
  if (!job) throw new Error("Claimed seller workflow job was not found.");

  try {
    const quote = await getHostedWorkflowQuote(queuedJob.workflow_quote_id);
    if (!quote?.seller_service_id || !quote.seller_service_version || !quote.seller_id) {
      throw new Error("Immutable seller quote snapshot is missing.");
    }
    const inputText = canonicalSellerInput(payload);
    if (hostedWorkflowInputMetadata(inputText).sha256 !== quote.input_hash) {
      throw new Error("Seller workflow input does not match the immutable quote.");
    }
    const [service, version, seller] = await Promise.all([
      getSellerServiceRowById(quote.seller_service_id),
      getSellerServiceVersion(quote.seller_service_id, quote.seller_service_version),
      getSellerAccountById(quote.seller_id),
    ]);
    if (!service || !version || !seller || service.seller_id !== quote.seller_id) {
      throw new Error("Immutable seller service version is unavailable.");
    }
    if (!isSellerServiceRunnable(service) || !isSellerAccountRunnable(seller)) {
      throw new Error("Seller workflow is paused or unavailable.");
    }
    validateSellerWorkflowInput(payload, version.input_schema);
    const config = getHostedRunnerConfig();
    const apiService = sellerExecutionApiService({ service, version });
    const result = await executeBuyerAgent({
      task: `Execute ${version.name} for the buyer-provided JSON input.`,
      requestInputText: inputText,
      requestPayload: { quoteId: quote.id, jobId, input: payload },
      spendingLimit: Math.max(0.001, Number(version.price_usdc)),
      baseUrl: config.baseUrl,
      sellerAddress: config.sellerAddress,
      agentPrivateKey: config.agentPrivateKey,
      walletSource: "HOSTED_AGENT_PRIVATE_KEY",
      skipFunding: true,
      skipDeposit: true,
      writeLocalRunLog: false,
      installSignalHandler: false,
      requirePersistence: true,
      requirePaidPurchase: true,
      proofWaitTimeoutMs: 45_000,
      planningPolicy: {
        allowOfficial: false,
        allowSellerCreated: true,
        maxPaidCalls: 1,
        maxServicePriceUsd: Number(version.price_usdc),
      },
      continueOnServiceFailure: false,
      fetchRetries: 0,
      fetchTimeoutMs: Math.min(30_000, version.max_timeout_ms + 5_000),
      serviceSnapshot: [apiService],
      serviceAllowlist: [{ slug: apiService.slug, endpoint: apiService.endpoint, method: apiService.method }],
      onProgress: async (progress) => {
        if (progress.stage === "completed" || progress.stage === "failed") return;
        await updateSellerJob(jobId, {
          status: "running",
          progress_stage: progress.stage,
          progress_message: progress.message ?? null,
          agent_run_id: progress.agentRunId,
          spent_usdc: progress.spentUsdc,
          last_heartbeat_at: new Date().toISOString(),
          raw: { paymentEventIds: progress.paymentEventIds },
        });
      },
    });
    const successful = result.serviceResults.find((item) => item.status === "paid");
    if (!successful) throw new Error("External seller did not return a validated result.");
    const sanitized = safeSellerResult(successful.response);
    const proofHashes = await verifiedProofHashes(result.paymentEventIds);
    if (
      result.paymentEventIds.length === 0 ||
      proofHashes.length !== result.paymentEventIds.length
    ) {
      throw new Error("Arc payment proof verification did not complete.");
    }
    const generatedAt = new Date().toISOString();
    const structuredResult = {
      version: 4,
      workflowType: quote.workflow_type,
      aggregationMode: "deterministic_structured",
      aggregationLabel: "Validated external seller result",
      synthesis: {
        status: "deterministic_fallback",
        provider: null,
        protocol: null,
        model: null,
        attempted: false,
        usedPaidApiResponses: [version.name],
        fallbackReason: "not_configured",
        generatedAt: null,
      },
      input: { preview: quote.input_preview, sha256: quote.input_hash },
      marketSymbol: null,
      repository: null,
      workflowData: {
        serviceId: service.public_id,
        serviceVersion: version.service_version,
        providerType: "external_seller",
        result: sanitized,
      },
      summary: `${version.name} completed with a schema-validated external seller response.`,
      keyFindings: [],
      apiResults: [{ ...successful, response: sanitized }],
      selectedServices: [{
        id: service.public_id,
        slug: service.public_id,
        name: version.name,
        endpoint: "external_seller",
        method: version.method,
        priceUsdc: Number(version.price_usdc),
        reasoning: "Buyer-selected external service.",
        presentation: defaultServicePresentation("external_seller"),
      }],
      skippedServices: [],
      spentUsdc: result.spentUsdc,
      receiptIds: result.paidStepIds,
      proofTransactionHashes: proofHashes,
      links: {
        hostedResult: `/agent-runner/${jobId}`,
        agentRun: result.agentRunId ? `/runs/${result.agentRunId}` : null,
        receipts: result.agentWallet ? `/receipts?wallet=${result.agentWallet}` : "/receipts",
        passport: result.agentWallet ? `/agents/${result.agentWallet}` : null,
        proofTransactions: proofHashes.map((hash) => `https://testnet.arcscan.app/tx/${hash}`),
      },
      completedWithWarnings: false,
      generatedAt,
    };
    await updateSellerJob(jobId, {
      status: "completed",
      progress_stage: "completed",
      progress_message: structuredResult.summary,
      agent_run_id: result.agentRunId,
      spent_usdc: result.spentUsdc,
      error: null,
      structured_result: structuredResult,
      receipt_ids: result.paidStepIds,
      proof_transaction_hashes: proofHashes,
      completed_at: generatedAt,
      last_heartbeat_at: generatedAt,
      raw: { paymentEventIds: result.paymentEventIds },
    });
    await finalizeSellerSuccess({
      job,
      service,
      version,
      receiptId: result.paidStepIds[0] ?? null,
      paymentEventId: result.paymentEventIds[0] ?? null,
      providerCostUsdc: Number(result.spentUsdc),
    });
    return { claimed: true as const, result };
  } catch (error) {
    const safeError = safeHostedError(error);
    await updateSellerJob(jobId, {
      status: "failed",
      progress_stage: "failed",
      progress_message: "External seller execution failed safely.",
      error: safeError,
      completed_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      structured_result: null,
      receipt_ids: [],
      proof_transaction_hashes: [],
    });
    try {
      const latest = await getHostedAgentJob(jobId);
      await finalizeHostedWorkflowUserPayment({
        jobId,
        providerCostUsdc: Number(latest?.spent_usdc ?? 0),
        succeeded: false,
        failureReason: safeError,
      });
    } catch (accountingError) {
      console.error(`[seller-workflow] job=${jobId} credit reconciliation required: ${safeHostedError(accountingError)}`);
    }
    return { claimed: true as const, error: safeError };
  }
}
