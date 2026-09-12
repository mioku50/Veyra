/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { executeBuyerAgent, type BuyerAgentProgressStage } from "./execution.ts";
import {
  getHostedRunnerConfig,
  hostedServiceAllowlist,
  safeHostedError,
} from "./hosted-policy.ts";
import {
  buildHostedFinalReport,
  createHostedWorkflowPlan,
  hashHostedWorkflowInput,
  hostedExecutionAllowlist,
  hostedWorkflowInputMetadata,
  isHostedWorkflowType,
  safeHostedServiceResult,
  workflowLabel,
  type HostedFinalReport,
  type HostedPlannerSnapshot,
  type HostedWorkflowRequest,
  type HostedWorkflowType,
  validateHostedWorkflowRequest,
} from "./hosted-workflows.ts";
import {
  configuredExplorerUrl,
  onchainPaymentEventColumns,
  onchainProofMetadataFromRow,
  publishStoredProof,
  type OnchainPaymentEventRecord,
} from "../commerce/onchain-proof.ts";
import { serviceRegistry } from "../services/registry.ts";
import { getServerSupabaseConfig } from "../supabase/server-env.ts";
import {
  defaultServicePresentation,
  providerResponsePresentation,
} from "../services/presentation.ts";
import type { ServiceSourceType } from "../services/registry.ts";
import { synthesizeHostedFinalReport } from "./llm-synthesis.ts";
import {
  finalizeHostedWorkflowUserPayment,
  getHostedWorkflowUserPaymentForJob,
} from "../commerce/workflow-checkout.ts";
import {
  finalizeByoaWorkflow,
  linkByoaAgentRun,
} from "../byoa/service.ts";
import { collectAgentTrustSources } from "../agent-trust/data-sources.ts";
import {
  applyAgentTrustVerification,
  buildAgentTrustReport,
} from "../agent-trust/build-report.ts";
import type { AgentTrustReport } from "../agent-trust/types.ts";
import type { GitHubRepositorySnapshot } from "../providers/github-types.ts";
import type { GitHubDueDiligenceAssessment } from "./github-due-diligence.ts";
import { fetchApiQualityObservationsForServices } from "../providers/api-quality.ts";
import {
  buildApiQualityPublicReport,
  parseApiQualityJobInput,
} from "../reports/api-quality-report.ts";
import {
  executeTreasuryHealthWithRetry,
  TreasuryHealthExecutionError,
  type TreasuryAttemptTelemetry,
} from "../providers/treasury-health.ts";
import { buildTreasuryHealthPublicReport } from "../reports/treasury-health-report.ts";
import { snapshotArcContract } from "../agent-trust/contract.ts";
import { snapshotEndpointAvailability } from "../agent-trust/endpoint.ts";
import {
  buildArcContractAnalysisReport,
  buildProject360Report,
  moduleResultFromReport,
  project360ModuleInputHash,
} from "../project-360/report.ts";
import {
  PROJECT_360_MODULES,
  type Project360Module,
  type Project360ModuleFailure,
  type Project360ModuleResult,
  type Project360Report,
} from "../project-360/types.ts";

export type HostedJobStatus = "queued" | "running" | "completed" | "failed";
export type HostedJobProgressStage =
  | "queued"
  | BuyerAgentProgressStage;

export type HostedAgentJobRow = {
  id: string;
  idempotency_hash: string;
  request_hash: string;
  requester_fingerprint: string;
  requester_wallet: string | null;
  workflow_type: HostedWorkflowType;
  task: string;
  input_text: string | null;
  input_preview: string;
  input_hash: string;
  budget_usdc: string;
  planner_snapshot: HostedPlannerSnapshot;
  selected_services: HostedPlannerSnapshot["selectedServices"];
  structured_result: HostedFinalReport | null;
  receipt_ids: string[];
  proof_transaction_hashes: string[];
  status: HostedJobStatus;
  progress_stage: HostedJobProgressStage;
  agent_run_id: string | null;
  spent_usdc: string;
  error: string | null;
  progress_message: string | null;
  attempt_count: number;
  recovery_count: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null;
  raw: Record<string, unknown> | null;
  workflow_quote_id: string | null;
  user_payment_id: string | null;
  payment_mode: "legacy_sponsored" | "sponsored" | "paid";
  byoa_agent_id: string | null;
  byoa_quote_id: string | null;
  aggregate_payment_event_id: string | null;
  machine_credential_id: string | null;
};

export type HostedLaunchResult = {
  jobId: string | null;
  created: boolean;
  reason:
    | "created"
    | "idempotent"
    | "idempotency_conflict"
    | "active_job"
    | "cooldown"
    | "rate_limited";
  retryAfterSeconds: number;
};

let hostedClient: SupabaseClient | null = null;

export function setHostedClientForTesting(client: SupabaseClient | null) {
  hostedClient = client;
}

function getHostedClient() {
  if (!hostedClient) {
    const config = getServerSupabaseConfig();
    hostedClient = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return hostedClient;
}

export async function launchHostedAgentJob(input: {
  idempotencyHash: string;
  requestHash: string;
  requesterFingerprint: string;
  requesterWallet: string | null;
  request: HostedWorkflowRequest;
}) {
  const config = getHostedRunnerConfig();
  const plan = await previewHostedWorkflow(input.request);
  const inputMetadata = hostedWorkflowInputMetadata(input.request.inputText);
  const { data, error } = await getHostedClient().rpc("launch_hosted_agent_workflow_v2", {
    p_idempotency_hash: input.idempotencyHash,
    p_request_hash: input.requestHash,
    p_requester_fingerprint: input.requesterFingerprint,
    p_requester_wallet: input.requesterWallet,
    p_workflow_type: input.request.workflowType,
    p_task: input.request.task,
    p_input_preview: inputMetadata.preview,
    p_input_hash: inputMetadata.sha256,
    p_budget_usdc: input.request.budgetUsdc,
    p_planner_snapshot: plan,
    p_selected_services: plan.selectedServices,
    p_cooldown_seconds: config.cooldownSeconds,
    p_rate_window_seconds: config.rateLimitWindowSeconds,
    p_rate_max_runs: config.rateLimitMaxRuns,
  });
  if (error) throw new Error("Unable to launch hosted agent job.");

  const row = (data as Array<{
    job_id: string | null;
    created: boolean;
    reason: HostedLaunchResult["reason"];
    retry_after_seconds: number;
  }> | null)?.[0];
  if (!row) throw new Error("Hosted launch did not return a result.");

  return {
    jobId: row.job_id,
    created: row.created,
    reason: row.reason,
    retryAfterSeconds: row.retry_after_seconds,
  } satisfies HostedLaunchResult;
}

export async function previewHostedWorkflow(request: HostedWorkflowRequest) {
  return createHostedWorkflowPlan({
    request,
    services: serviceRegistry,
    allowlist: hostedServiceAllowlist(),
  });
}

export async function getHostedAgentJob(jobId: string) {
  const { data, error } = await getHostedClient()
    .from("hosted_agent_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error("Unable to load hosted agent job.");
  return (data as HostedAgentJobRow | null) ?? null;
}

async function updateHostedAgentJob(
  jobId: string,
  values: Record<string, unknown>,
) {
  const { error } = await getHostedClient()
    .from("hosted_agent_jobs")
    .update(values)
    .eq("id", jobId);
  if (error) throw new Error("Unable to update hosted agent job.");
}

async function claimHostedAgentJob(jobId: string) {
  const { data, error } = await getHostedClient().rpc("claim_hosted_agent_job", {
    p_job_id: jobId,
  });
  if (error) throw new Error("Unable to claim hosted agent job.");
  return data === true;
}

async function initializeProject360ModuleRuns(
  jobId: string,
  projectInput: NonNullable<HostedWorkflowRequest["project360Input"]>,
) {
  const rows = PROJECT_360_MODULES.map((module) => ({
    job_id: jobId,
    module,
    status: projectInput.modules.includes(module)
      ? "pending"
      : projectInput.sources.some((source) => source.module === module)
        ? "not_selected"
        : "not_provided",
    input_hash: project360ModuleInputHash(projectInput, module),
    attempt_count: 0,
    confidence: "insufficient",
  }));
  const result = await getHostedClient()
    .from("project_360_module_runs")
    .upsert(rows, {
      onConflict: "job_id,module",
      ignoreDuplicates: true,
    });
  if (result.error) throw new Error("Unable to initialize Project 360 module states.");
}

async function markProject360ModuleRunning(
  jobId: string,
  module: Project360Module,
) {
  const result = await getHostedClient()
    .from("project_360_module_runs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      attempt_count: 0,
    })
    .eq("job_id", jobId)
    .eq("module", module)
    .eq("status", "pending");
  if (result.error) throw new Error("Unable to update Project 360 module state.");
}

function responseReport<T>(value: unknown): T | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const report = record.report ?? value;
  return report && typeof report === "object" && !Array.isArray(report)
    ? report as T
    : null;
}

function failedProject360ModuleResult(
  projectInput: NonNullable<HostedWorkflowRequest["project360Input"]>,
  module: Project360Module,
  failure?: Project360ModuleFailure | null,
): Project360ModuleResult {
  return {
    module,
    status: failure?.status ?? "failed",
    inputHash: project360ModuleInputHash(projectInput, module),
    childReportHash: null,
    score: null,
    confidence: "insufficient",
    retryable: failure?.retryable ?? false,
    publicReason:
      failure?.publicReason ??
      "The module could not be completed; successful module results were preserved.",
    internalErrorCode: failure?.internalErrorCode ?? "internal_error",
    report: null,
  };
}

function buildProject360ModuleResults(input: {
  projectInput: NonNullable<HostedWorkflowRequest["project360Input"]>;
  runtimeServiceOutputs: ReadonlyMap<string, unknown>;
  agentTrustReport: AgentTrustReport | null;
  treasuryFailure: Project360ModuleFailure | null;
}) {
  return input.projectInput.modules.map((module): Project360ModuleResult => {
    const inputHash = project360ModuleInputHash(input.projectInput, module);
    if (module === "github_due_diligence") {
      const analysis = input.runtimeServiceOutputs.get("github-due-diligence-analysis") as
        | { assessment?: GitHubDueDiligenceAssessment }
        | undefined;
      const snapshot = input.runtimeServiceOutputs.get("github-repository-intelligence") as
        | GitHubRepositorySnapshot
        | undefined;
      const report = analysis?.assessment
        ? {
            ...analysis.assessment,
            ...(snapshot
              ? {
                  monitoringSignals: {
                    commitCount30d: snapshot.activity.commitCount30d,
                    commitCount90d: snapshot.activity.commitCount90d,
                    sampledHumanContributorCount:
                      snapshot.contributors.sampledHumanContributorCount,
                    hasSecurityPolicy: snapshot.documentation.hasSecurityPolicy,
                    hasLicense: snapshot.documentation.hasLicense,
                    workflowCount: snapshot.stack.workflowCount,
                    latestReleaseTag: snapshot.releases.latestRelease?.tagName ?? null,
                    latestReleaseAt:
                      snapshot.releases.latestRelease?.publishedAt ?? null,
                    isArchived: snapshot.repository.isArchived,
                    pushedAt: snapshot.repository.pushedAt,
                  },
                }
              : {}),
          }
        : null;
      return report
        ? moduleResultFromReport({ module, inputHash, report })
        : failedProject360ModuleResult(input.projectInput, module);
    }
    if (module === "agent_trust_report") {
      const report = responseReport<AgentTrustReport>(
        input.runtimeServiceOutputs.get("agent-trust-finalizer"),
      );
      return report && input.agentTrustReport
        ? moduleResultFromReport({ module, inputHash, report })
        : failedProject360ModuleResult(input.projectInput, module);
    }
    if (module === "treasury_health") {
      const report = responseReport<ReturnType<typeof buildTreasuryHealthPublicReport>>(
        input.runtimeServiceOutputs.get("treasury-health-finalizer"),
      );
      return report
        ? moduleResultFromReport({ module, inputHash, report })
        : failedProject360ModuleResult(
            input.projectInput,
            module,
            input.treasuryFailure,
          );
    }
    if (module === "paid_api_quality") {
      const report = responseReport<ReturnType<typeof buildApiQualityPublicReport>>(
        input.runtimeServiceOutputs.get("api-quality-finalizer"),
      );
      return report
        ? moduleResultFromReport({ module, inputHash, report })
        : failedProject360ModuleResult(input.projectInput, module);
    }
    const report = responseReport<ReturnType<typeof buildArcContractAnalysisReport>>(
      input.runtimeServiceOutputs.get("arc-contract-analysis-finalizer"),
    );
    return report
      ? moduleResultFromReport({ module, inputHash, report })
      : failedProject360ModuleResult(input.projectInput, module);
  });
}

async function persistProject360ModuleResults(
  jobId: string,
  results: Project360ModuleResult[],
) {
  const completedAt = new Date().toISOString();
  for (const result of results) {
    const update = await getHostedClient()
      .from("project_360_module_runs")
      .update({
        status: result.status,
        child_report_hash: result.childReportHash,
        score: result.score,
        confidence: result.confidence,
        result_snapshot: result.report,
        error_code: result.internalErrorCode,
        retryable: result.retryable,
        public_reason: result.publicReason,
        completed_at: completedAt,
      })
      .eq("job_id", jobId)
      .eq("module", result.module)
      .neq("status", "completed");
    if (update.error) throw new Error("Unable to persist Project 360 module result.");
  }
}

function validatedExecutionRequest(job: HostedAgentJobRow, inputText: string) {
  const project360Input =
    job.workflow_type === "project_360"
      ? (job.planner_snapshot.metadata as Record<string, unknown> | undefined)
          ?.project360Input
      : undefined;
  const request = validateHostedWorkflowRequest({
    workflowType: job.workflow_type,
    task: job.task,
    inputText,
    project360Input,
    marketSymbol: job.planner_snapshot.marketSymbol,
    budgetUsdc: Number(job.budget_usdc),
  });
  if (hashHostedWorkflowInput(request.inputText) !== job.input_hash) {
    throw new Error("Hosted workflow input does not match the original launch request.");
  }
  return request;
}

export async function runHostedAgentJob(jobId: string, inputText: string) {
  const queuedJob = await getHostedAgentJob(jobId);
  if (!queuedJob) throw new Error("Hosted job no longer exists.");
  const request = validatedExecutionRequest(queuedJob, inputText);
  const claimed = await claimHostedAgentJob(jobId);
  if (!claimed) return { claimed: false as const };

  const job = await getHostedAgentJob(jobId);
  if (!job) throw new Error("Claimed hosted job no longer exists.");

  try {
    const config = getHostedRunnerConfig();
    const plannerSnapshot = job.planner_snapshot;
    let agentTrustReport: AgentTrustReport | null = null;
    let project360Report: Project360Report | null = null;
    let project360ModuleResults: Project360ModuleResult[] = [];
    let treasuryFailure: Project360ModuleFailure | null = null;
    if (request.workflowType === "project_360" && request.project360Input) {
      await initializeProject360ModuleRuns(jobId, request.project360Input);
    }
    const result = await executeBuyerAgent({
      task: plannerSnapshot.effectiveTask ?? job.task,
      requestInputText: request.inputText,
      marketSymbol: request.marketSymbol,
      repository: request.repository,
      spendingLimit: Number(job.budget_usdc),
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
        allowOfficial: true,
        allowSellerCreated: false,
        maxPaidCalls: request.workflowType === "project_360" ? 7 : 3,
        maxServicePriceUsd: Number(job.budget_usdc),
      },
      continueOnServiceFailure: true,
      fetchRetries: 2,
      fetchTimeoutMs: 30_000,
      serviceAllowlist: hostedExecutionAllowlist(
        plannerSnapshot,
        config.serviceAllowlist,
      ),
      serviceSnapshot: serviceRegistry,
      resolveServiceRequestBody: async ({
        service,
        runtimeServiceOutputs,
      }) => {
        if (
          service.slug === "agent-trust-finalizer" &&
          (request.workflowType === "agent_trust_report" ||
            request.workflowType === "project_360") &&
          request.agentTrustInput
        ) {
          if (request.workflowType === "project_360") {
            await markProject360ModuleRunning(jobId, "agent_trust_report");
          }
          const githubSnapshot =
            runtimeServiceOutputs.get("github-repository-intelligence") as
              | GitHubRepositorySnapshot
              | undefined;
          const githubAnalysis =
            runtimeServiceOutputs.get("github-due-diligence-analysis") as
              | { assessment?: GitHubDueDiligenceAssessment }
              | undefined;
          agentTrustReport = buildAgentTrustReport({
            reportId: jobId,
            reportInput: request.agentTrustInput,
            sources: await collectAgentTrustSources({
              client: getHostedClient(),
              reportInput: request.agentTrustInput,
              reportId: jobId,
              requesterWallet: job.requester_wallet,
              requesterAgentId: job.byoa_agent_id,
              repository: request.repository,
              githubSnapshot: githubSnapshot ?? null,
              githubAssessment: githubAnalysis?.assessment ?? null,
            }),
          });
          return { report: agentTrustReport };
        }

        if (
          service.slug === "api-quality-finalizer" &&
          (request.workflowType === "paid_api_quality" ||
            request.workflowType === "project_360")
        ) {
          if (request.workflowType === "project_360") {
            await markProject360ModuleRunning(jobId, "paid_api_quality");
          }
          const projectEndpoint = request.project360Input?.sources.find(
            (source) => source.type === "public_api_endpoint",
          )?.canonicalValue;
          const { targetServices, observationWindowDays } = projectEndpoint
            ? { targetServices: [projectEndpoint], observationWindowDays: 30 }
            : parseApiQualityJobInput(request.inputText, plannerSnapshot);
          // A discovered endpoint is not a trusted Veyra service identifier.
          // Never let an arbitrary URL enter the internal service-observation
          // lookup; Project 360 evaluates it with the protected availability
          // probe only. Existing standalone API Quality reports retain their
          // persisted service observations.
          const observationsByService = projectEndpoint
            ? { [projectEndpoint]: [] }
            : await fetchApiQualityObservationsForServices(
                targetServices,
                observationWindowDays,
              );
          const qualityReport = buildApiQualityPublicReport({
            jobId,
            workflow: "paid_api_quality",
            status: "completed",
            targetServices,
            observationWindowDays,
            observationsByService,
          });
          if (projectEndpoint) {
            const endpointAvailability = await snapshotEndpointAvailability(projectEndpoint);
            Object.assign(qualityReport, {
              endpointAvailability,
              availabilityOnly:
                Object.values(observationsByService).every(
                  (observations) => observations.length === 0,
                ),
            });
          }
          return { report: qualityReport };
        }

        if (
          service.slug === "treasury-health-finalizer" &&
          (request.workflowType === "treasury_health" ||
            request.workflowType === "project_360")
        ) {
          if (request.workflowType === "project_360") {
            await markProject360ModuleRunning(jobId, "treasury_health");
          }
          const treasurySource = request.project360Input?.sources.find(
            (source) => source.type === "project_wallet",
          );
          const targetWallet = treasurySource?.canonicalValue ?? request.inputText;
          const privateAttempts: TreasuryAttemptTelemetry[] = [];
          let execution;
          try {
            execution = await executeTreasuryHealthWithRetry({
              walletAddress: targetWallet,
              scanDays: 180,
              maxAttempts: 3,
              deadlineMs: 120_000,
              onAttempt: async (attempt) => {
                privateAttempts.push(attempt);
                if (request.workflowType !== "project_360" || !treasurySource) return;
                console[attempt.errorCode ? "error" : "info"](
                  `[project360-module] ${JSON.stringify({
                    project360JobId: jobId,
                    module: "treasury_health",
                    candidateType: treasurySource.type,
                    candidateHash: treasurySource.valueHash,
                    provider: attempt.provider,
                    errorCode: attempt.errorCode,
                    retryable: attempt.retryable,
                    durationMs: attempt.durationMs,
                  })}`,
                );
                const telemetryUpdate = await getHostedClient()
                  .from("project_360_module_runs")
                  .update({
                    attempt_count: attempt.attempt,
                    provider: attempt.provider,
                    retryable: attempt.retryable,
                    duration_ms: privateAttempts.reduce(
                      (sum, item) => sum + item.durationMs,
                      0,
                    ),
                    execution_telemetry: { attempts: privateAttempts },
                  })
                  .eq("job_id", jobId)
                  .eq("module", "treasury_health")
                  .eq("status", "running");
                if (telemetryUpdate.error) {
                  console.error(
                    `[project360-module] ${JSON.stringify({
                      project360JobId: jobId,
                      module: "treasury_health",
                      candidateType: treasurySource.type,
                      candidateHash: treasurySource.valueHash,
                      provider: "internal",
                      errorCode: "telemetry_persistence_failed",
                      retryable: true,
                      durationMs: attempt.durationMs,
                    })}`,
                  );
                }
              },
            });
          } catch (error) {
            if (
              request.workflowType === "project_360" &&
              error instanceof TreasuryHealthExecutionError
            ) {
              const providerUnavailable =
                error.failure.internalErrorCode === "treasury_provider_unavailable";
              treasuryFailure = {
                status: providerUnavailable ? "provider_unavailable" : "failed",
                retryable: error.failure.retryable,
                publicReason: providerUnavailable
                  ? "Treasury data could not be collected from the configured provider."
                  : "Treasury data could not be analyzed from the confirmed source.",
                internalErrorCode: error.failure.internalErrorCode,
                provider: error.failure.provider,
                attemptCount: error.attempts.length,
                durationMs: error.durationMs,
              };
            }
            throw error;
          }
          const treasuryReport = buildTreasuryHealthPublicReport({
            reportId: jobId,
            targetWallet,
            analytics: execution.analytics,
            status: "completed",
          });
          return { report: treasuryReport };
        }

        if (
          service.slug === "arc-contract-analysis-finalizer" &&
          request.workflowType === "project_360" &&
          request.project360Input
        ) {
          await markProject360ModuleRunning(jobId, "arc_contract_analysis");
          const targetContract = request.project360Input.sources.find(
            (source) => source.type === "arc_contract",
          )?.canonicalValue;
          if (!targetContract) throw new Error("project360_contract_source_missing");
          const contractReport = buildArcContractAnalysisReport({
            reportId: jobId,
            targetContract,
            snapshot: await snapshotArcContract(targetContract),
          });
          return { report: contractReport };
        }

        if (
          service.slug === "project-360-finalizer" &&
          request.workflowType === "project_360" &&
          request.project360Input
        ) {
          project360ModuleResults = buildProject360ModuleResults({
            projectInput: request.project360Input,
            runtimeServiceOutputs,
            agentTrustReport,
            treasuryFailure,
          });
          await persistProject360ModuleResults(jobId, project360ModuleResults);
          project360Report = buildProject360Report({
            reportId: jobId,
            projectInput: request.project360Input,
            moduleResults: project360ModuleResults,
          });
          return { report: project360Report };
        }

        return undefined;
      },
      onProgress: async (progress) => {
        if (progress.stage === "completed" || progress.stage === "failed") return;
        await updateHostedAgentJob(jobId, {
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

    let proofTransactionHashes: string[] = [];
    let proofRows: Array<{
      response_hash: string | null;
      onchain_tx_hash: string | null;
      onchain_status: string | null;
    }> = [];
    if (result.paymentEventIds.length > 0) {
      const { data, error } = await getHostedClient()
        .from("payment_events")
        .select("response_hash,onchain_tx_hash,onchain_status")
        .in("id", result.paymentEventIds)
        .eq("onchain_status", "verified");
      if (error) {
        console.warn(
          `[hosted-agent] job=${jobId} proof metadata will reconcile on read: ${safeHostedError(error)}`,
        );
      } else {
        proofRows = (data ?? []) as typeof proofRows;
        proofTransactionHashes = proofRows
          .map((row) => (row as { onchain_tx_hash: string | null }).onchain_tx_hash)
          .filter((value): value is string => Boolean(value));
      }
    }
    const completedProject360Report = project360Report as Project360Report | null;
    if (completedProject360Report) {
      const aggregateProof = proofRows.find(
        (row) =>
          row.response_hash?.toLowerCase() ===
          completedProject360Report.verification.reportHash.toLowerCase(),
      );
      project360Report = {
        ...completedProject360Report,
        verification: {
          ...completedProject360Report.verification,
          status: aggregateProof?.onchain_status === "verified"
            ? "verified"
            : aggregateProof?.onchain_status === "failed"
              ? "verification_failed"
              : "verification_pending",
        },
      };
    }
    if (
      request.workflowType === "agent_trust_report" &&
      request.agentTrustInput &&
      !agentTrustReport
    ) {
      agentTrustReport = buildAgentTrustReport({
        reportId: jobId,
        reportInput: request.agentTrustInput,
        sources: await collectAgentTrustSources({
          client: getHostedClient(),
          reportInput: request.agentTrustInput,
          reportId: jobId,
          requesterWallet: job.requester_wallet,
          requesterAgentId: job.byoa_agent_id,
          repository: request.repository,
          githubSnapshot:
            result.workflowArtifacts.githubRepositorySnapshot ?? null,
          githubAssessment:
            result.workflowArtifacts.githubDueDiligenceAssessment ?? null,
        }),
      });
    }
    const deterministicReport = buildHostedFinalReport({
      jobId,
      request,
      plan: plannerSnapshot,
      agentRunId: result.agentRunId,
      agentWallet: result.agentWallet,
      spentUsdc: result.spentUsdc,
      receiptIds: result.paidStepIds,
      proofTransactionHashes,
      serviceResults: result.serviceResults,
      executionResult: result,
      explorerUrl: configuredExplorerUrl(),
      agentTrustReport,
      project360Report,
    });
    const structuredResult = await synthesizeHostedFinalReport({
      request,
      report: deterministicReport,
      serviceResults: result.serviceResults,
    });

    await updateHostedAgentJob(jobId, {
      status: "completed",
      progress_stage: "completed",
      progress_message: result.summary,
      agent_run_id: result.agentRunId,
      spent_usdc: result.spentUsdc,
      error: null,
      structured_result: structuredResult,
      selected_services: plannerSnapshot.selectedServices,
      receipt_ids: result.paidStepIds,
      proof_transaction_hashes: proofTransactionHashes,
      completed_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      raw: {
        paymentEventIds: result.paymentEventIds,
        paidStepIds: result.paidStepIds,
        serviceResults: result.serviceResults.map(safeHostedServiceResult),
      },
    });

    if (job.byoa_agent_id) {
      try {
        await linkByoaAgentRun(jobId, job.byoa_agent_id, result.agentRunId);
        await finalizeByoaWorkflow({
          jobId,
          succeeded: true,
          downstreamSpentUsdc: Number(result.spentUsdc),
          receiptCount: result.paidStepIds.length,
          verifiedProofCount: proofTransactionHashes.length,
        });
      } catch (error) {
        console.error(
          `[byoa] job=${jobId} registered-agent accounting will require reconciliation: ${safeHostedError(error)}`,
        );
      }
    }

    try {
      await finalizeHostedWorkflowUserPayment({
        jobId,
        providerCostUsdc: Number(result.spentUsdc),
        succeeded: true,
      });
    } catch (error) {
      console.error(
        `[hosted-checkout] job=${jobId} payment accounting will reconcile later: ${safeHostedError(error)}`,
      );
    }

    return { claimed: true as const, result };
  } catch (error) {
    const safeError = safeHostedError(error);
    await updateHostedAgentJob(jobId, {
      status: "failed",
      progress_stage: "failed",
      progress_message: "Hosted buyer-agent execution failed.",
      error: safeError,
      completed_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
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
      console.error(
        `[hosted-checkout] job=${jobId} failed-payment credit will reconcile later: ${safeHostedError(accountingError)}`,
      );
    }
    if (job.byoa_agent_id) {
      try {
        await finalizeByoaWorkflow({
          jobId,
          succeeded: false,
          downstreamSpentUsdc: Number((await getHostedAgentJob(jobId))?.spent_usdc ?? 0),
          receiptCount: 0,
          verifiedProofCount: 0,
          failureReason: safeError,
        });
      } catch (accountingError) {
        console.error(
          `[byoa] job=${jobId} failure credit will require reconciliation: ${safeHostedError(accountingError)}`,
        );
      }
    }
    console.error(`[hosted-agent] job=${jobId} failed: ${safeError}`);
    return { claimed: true as const, error: safeError };
  }
}

export async function requeueFailedHostedAgentJob(jobId: string) {
  const { data, error } = await getHostedClient().rpc(
    "requeue_failed_hosted_agent_job",
    { p_job_id: jobId },
  );
  if (error) throw new Error("Unable to recover hosted agent job.");
  return data === true;
}

export async function recoverAndRunHostedAgentJob(jobId: string, inputText: string) {
  const job = await getHostedAgentJob(jobId);
  if (!job) throw new Error("Hosted job not found.");
  validatedExecutionRequest(job, inputText);
  const recovered = await requeueFailedHostedAgentJob(jobId);
  if (!recovered) return { recovered: false as const };
  return {
    recovered: true as const,
    execution: await runHostedAgentJob(jobId, inputText),
  };
}

export async function recoverHostedProject360AggregateProof(jobId: string) {
  const job = await getHostedAgentJob(jobId);
  const workflowData = job?.structured_result?.workflowData as
    | { kind?: string; report?: Project360Report }
    | null
    | undefined;
  if (
    !job ||
    job.status !== "completed" ||
    job.workflow_type !== "project_360" ||
    workflowData?.kind !== "project_360_report" ||
    !workflowData.report ||
    workflowData.report.verification.status === "verified"
  ) {
    return { recovered: false as const, reason: "not_recoverable" as const };
  }
  const eventIds = Array.isArray(job.raw?.paymentEventIds)
    ? job.raw.paymentEventIds.filter(
        (value): value is string =>
          typeof value === "string" &&
          /^[0-9a-f-]{36}$/i.test(value),
      )
    : [];
  if (eventIds.length === 0) {
    return { recovered: false as const, reason: "proof_event_missing" as const };
  }
  const { data, error } = await getHostedClient()
    .from("payment_events")
    .select(onchainPaymentEventColumns)
    .in("id", eventIds)
    .in("onchain_status", ["pending", "failed"]);
  if (error) throw new Error("Unable to load the aggregate Project 360 proof event.");
  const aggregate = ((data ?? []) as unknown as OnchainPaymentEventRecord[]).find(
    (row) =>
      String(row.response_hash ?? "").toLowerCase() ===
      workflowData.report!.verification.reportHash.toLowerCase(),
  );
  if (!aggregate) {
    return { recovered: false as const, reason: "proof_event_missing" as const };
  }
  const result = await publishStoredProof({
    supabase: getHostedClient(),
    record: aggregate as unknown as OnchainPaymentEventRecord,
  });
  if (result.status === "verified") {
    await getHostedAgentJobView(jobId);
  }
  return {
    recovered: result.status === "verified",
    status: result.status,
    transactionHash: result.transactionHash,
  };
}

type PaymentEventView = {
  id: string;
  receipt_hash: string | null;
  service_hash: string | null;
  request_hash: string | null;
  response_hash: string | null;
  onchain_contract_address: string | null;
  onchain_chain_id: number | string | null;
  onchain_tx_hash: string | null;
  onchain_status: string | null;
  onchain_block_number: number | string | null;
  onchain_proof_id: string | null;
  onchain_attester: string | null;
  onchain_verified_at: string | null;
  onchain_last_attempt_at: string | null;
  onchain_attempt_count: number | null;
  onchain_error: string | null;
};

export async function getHostedAgentJobView(jobId: string) {
  const job = await getHostedAgentJob(jobId);
  if (!job) return null;

  const userPayment = await getHostedWorkflowUserPaymentForJob(jobId);

  let agentWallet: string | null = null;
  let steps: Array<{
    id: string;
    service_slug: string;
    service_name: string;
    service_source_type: string | null;
    price_usdc: string;
    status: string;
    reasoning: string;
    payment_event_id: string | null;
    response_preview: unknown;
    error: string | null;
  }> = [];
  if (job.agent_run_id) {
    const [{ data: run }, { data: dataSteps }] = await Promise.all([
      getHostedClient()
        .from("agent_runs")
        .select("agent_wallet")
        .eq("id", job.agent_run_id)
        .maybeSingle(),
      getHostedClient()
        .from("agent_purchase_steps")
        .select("id,service_slug,service_name,service_source_type,price_usdc,status,reasoning,payment_event_id,response_preview,error")
        .eq("run_id", job.agent_run_id)
        .order("step_index", { ascending: true }),
    ]);
    agentWallet = (run as { agent_wallet?: string } | null)?.agent_wallet ?? null;
    steps = (dataSteps ?? []) as typeof steps;
  }

  const paidSteps = steps.filter((step) => step.status === "paid");
  const paymentEventIds = paidSteps
    .map((step) => step.payment_event_id)
    .filter((value): value is string => Boolean(value));
  let paymentEvents: PaymentEventView[] = [];
  if (paymentEventIds.length > 0) {
    const { data, error } = await getHostedClient()
      .from("payment_events")
      .select([
        "id",
        "receipt_hash",
        "service_hash",
        "request_hash",
        "response_hash",
        "onchain_contract_address",
        "onchain_chain_id",
        "onchain_tx_hash",
        "onchain_status",
        "onchain_block_number",
        "onchain_proof_id",
        "onchain_attester",
        "onchain_verified_at",
        "onchain_last_attempt_at",
        "onchain_attempt_count",
        "onchain_error",
      ].join(","))
      .in("id", paymentEventIds);
    if (error) throw new Error("Unable to load hosted proof metadata.");
    paymentEvents = (data ?? []) as unknown as PaymentEventView[];
  }

  const eventById = new Map(paymentEvents.map((event) => [event.id, event]));
  const proofs = paidSteps.flatMap((step) => {
    const event = step.payment_event_id ? eventById.get(step.payment_event_id) : null;
    const proof = event ? onchainProofMetadataFromRow(event) : null;
    if (!proof) return [];
    return [{
      receiptId: step.id,
      paymentEventId: step.payment_event_id,
      ...proof,
      transactionUrl: proof.transactionHash
        ? `${configuredExplorerUrl()}/tx/${proof.transactionHash}`
        : null,
      contractUrl: proof.contractAddress
        ? `${configuredExplorerUrl()}/address/${proof.contractAddress}`
        : null,
    }];
  });
  const verifiedProof = proofs.find((proof) => proof.status === "verified") ?? null;
  const firstReceiptId = paidSteps[0]?.id ?? null;
  const verifiedHashes = proofs
    .filter((proof) => proof.status === "verified" && proof.transactionHash)
    .map((proof) => proof.transactionHash as string);

  let structuredResult = job.structured_result;
  let shouldPersistReconciliation = false;
  if (
    job.status === "completed" &&
    JSON.stringify(verifiedHashes) !== JSON.stringify(job.proof_transaction_hashes)
  ) {
    structuredResult = structuredResult
      ? {
          ...structuredResult,
          proofTransactionHashes: verifiedHashes,
          links: {
            ...structuredResult.links,
            proofTransactions: verifiedHashes.map(
              (hash) => `${configuredExplorerUrl()}/tx/${hash}`,
            ),
          },
        }
      : null;
    shouldPersistReconciliation = true;
  }

  const trustData = structuredResult?.workflowData as
    | {
        kind?: string;
        report?: AgentTrustReport;
      }
    | null
    | undefined;
  if (
    job.status === "completed" &&
    trustData?.kind === "agent_trust_report" &&
    trustData.report
  ) {
    const reconciledReport = applyAgentTrustVerification(
      trustData.report,
      proofs.map((proof) => ({
        receiptId: proof.receiptId,
        status: proof.status,
        transactionHash: proof.transactionHash,
        transactionUrl: proof.transactionUrl,
        responseHash: proof.responseHash,
      })),
    );
    if (
      JSON.stringify(reconciledReport.verification) !==
      JSON.stringify(trustData.report.verification)
    ) {
      structuredResult = {
        ...structuredResult,
        workflowData: {
          ...trustData,
          report: reconciledReport,
        },
      } as HostedFinalReport;
      shouldPersistReconciliation = true;
    }
  }

  const project360Data = structuredResult?.workflowData as
    | { kind?: string; report?: Project360Report }
    | null
    | undefined;
  if (
    job.status === "completed" &&
    project360Data?.kind === "project_360_report" &&
    project360Data.report
  ) {
    const aggregateProof = proofs.find(
      (proof) =>
        proof.responseHash?.toLowerCase() ===
        project360Data.report!.verification.reportHash.toLowerCase(),
    );
    const status = aggregateProof?.status === "verified"
      ? "verified"
      : aggregateProof?.status === "failed"
        ? "verification_failed"
        : "verification_pending";
    if (status !== project360Data.report.verification.status) {
      structuredResult = {
        ...structuredResult,
        workflowData: {
          ...project360Data,
          report: {
            ...project360Data.report,
            verification: {
              ...project360Data.report.verification,
              status,
            },
          },
        },
      } as HostedFinalReport;
      shouldPersistReconciliation = true;
    }
  }

  if (shouldPersistReconciliation) {
    await updateHostedAgentJob(job.id, {
      proof_transaction_hashes: verifiedHashes,
      structured_result: structuredResult,
    });
  }

  return {
    job: {
      id: job.id,
      requesterWallet: job.requester_wallet,
      workflowType: job.workflow_type,
      task: job.task,
      inputPreview: job.input_preview,
      inputSha256: job.input_hash,
      budgetUsdc: job.budget_usdc,
      plannerSnapshot: job.planner_snapshot,
      selectedServices: job.selected_services,
      structuredResult,
      status: job.status,
      progressStage: job.progress_stage,
      progressMessage: job.progress_message,
      agentRunId: job.agent_run_id,
      spentUsdc: job.spent_usdc,
      error: job.error,
      attemptCount: job.attempt_count,
      recoveryCount: job.recovery_count,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      paymentMode: job.payment_mode,
      workflowQuoteId: job.workflow_quote_id,
      userPaymentId: job.user_payment_id,
      byoaAgentId: job.byoa_agent_id ?? null,
      machineCredentialId: job.machine_credential_id ?? null,
    },
    userPayment,
    payerWallet: agentWallet,
    receiptIds: paidSteps.map((step) => step.id),
    services: steps.map((step) => {
      const planned = job.planner_snapshot.selectedServices?.find(
        (service) => service.slug === step.service_slug,
      );
      const responseProvider = providerResponsePresentation(step.response_preview);
      const sourceType = (
        step.service_source_type === "provider_backed" ||
        step.service_source_type === "seller_mock" ||
        step.service_source_type === "external_placeholder" ||
        step.service_source_type === "external_seller"
          ? step.service_source_type
          : "static"
      ) as ServiceSourceType;
      const fallback = defaultServicePresentation(sourceType);
      const presentation = planned?.presentation ?? {
        ...fallback,
        providerName: responseProvider?.providerName ?? fallback.providerName,
        assetSymbol: responseProvider?.assetSymbol ?? fallback.assetSymbol,
      };
      return {
        receiptId: step.status === "paid" ? step.id : null,
        serviceSlug: step.service_slug,
        serviceName: step.service_name,
        priceUsdc: step.price_usdc,
        status: step.status,
        reasoning: step.reasoning,
        presentation,
        response: step.response_preview,
        error: step.error,
      };
    }),
    proofs,
    proof: verifiedProof ?? proofs[0] ?? null,
    links: {
      hostedRun: `/agent-runner/${job.id}`,
      workflowReceipt: `/workflow-receipts/${job.id}`,
      agentRun: job.agent_run_id ? `/runs/${job.agent_run_id}` : null,
      receipts: agentWallet ? `/receipts?wallet=${agentWallet}` : "/receipts",
      receipt: firstReceiptId ? `/receipts/${firstReceiptId}` : null,
      passport: agentWallet ? `/agents/${agentWallet}` : null,
      proofTransaction:
        verifiedProof?.transactionHash && verifiedProof.contractAddress
          ? `${configuredExplorerUrl()}/tx/${verifiedProof.transactionHash}`
          : null,
      proofTransactions: proofs
        .filter((proof) => proof.transactionUrl)
        .map((proof) => proof.transactionUrl as string),
    },
  };
}

export function redactPublicSellerAccounting<T extends {
  job: { workflowType: string } & Record<string, unknown>;
  userPayment: object | null;
}>(view: T): T {
  if (view.job.workflowType === "project_360") {
    const safeJob = { ...view.job } as Record<string, unknown>;
    const planner = safeJob.plannerSnapshot as
      | (Record<string, unknown> & {
          metadata?: { project360Input?: { modules?: unknown } };
        })
      | undefined;
    const selectedProject360Modules = Array.isArray(
      planner?.metadata?.project360Input?.modules,
    )
      ? planner.metadata.project360Input.modules.filter(
          (module): module is string => typeof module === "string",
        )
      : [];
    if (planner) {
      const { metadata: _metadata, ...publicPlanner } = planner;
      safeJob.plannerSnapshot = publicPlanner;
    }
    const structuredResult = safeJob.structuredResult as
      | (Record<string, unknown> & { apiResults?: unknown[] })
      | null
      | undefined;
    if (structuredResult && Array.isArray(structuredResult.apiResults)) {
      safeJob.structuredResult = {
        ...structuredResult,
        apiResults: structuredResult.apiResults.map((result) => {
          if (!result || typeof result !== "object") return result;
          const safeResult = { ...(result as Record<string, unknown>) };
          delete safeResult.paymentEventId;
          return safeResult;
        }),
      };
    }
    safeJob.project360Modules = selectedProject360Modules;
    for (const key of [
      "requesterWallet",
      "workflowQuoteId",
      "userPaymentId",
      "byoaAgentId",
      "machineCredentialId",
      "agentRunId",
      "attemptCount",
      "recoveryCount",
    ]) {
      delete safeJob[key];
    }
    const safePayment = view.userPayment
      ? ({ ...view.userPayment } as Record<string, unknown>)
      : null;
    if (safePayment) {
      delete safePayment.id;
      delete safePayment.quoteId;
      delete safePayment.requesterWallet;
      delete safePayment.failureReason;
    }
    const safeLinks = "links" in view && view.links
      ? {
          ...(view.links as Record<string, unknown>),
          agentRun: null,
          receipts: null,
          receipt: null,
          passport: null,
        }
      : undefined;
    const safeProofs = "proofs" in view && Array.isArray(view.proofs)
      ? view.proofs.map((proof) => {
          const safeProof = { ...(proof as Record<string, unknown>) };
          delete safeProof.paymentEventId;
          return safeProof;
        })
      : undefined;
    const safeProof = "proof" in view && view.proof
      ? { ...(view.proof as Record<string, unknown>) }
      : undefined;
    if (safeProof) delete safeProof.paymentEventId;
    return {
      ...view,
      job: safeJob,
      userPayment: safePayment,
      payerWallet: null,
      ...(safeLinks ? { links: safeLinks } : {}),
      ...(safeProofs ? { proofs: safeProofs } : {}),
      ...(safeProof ? { proof: safeProof } : {}),
    } as T;
  }
  if (!view.job.workflowType.startsWith("seller_") || !view.userPayment) return view;
  const safePayment = { ...view.userPayment } as Record<string, unknown>;
  delete safePayment.platformFeeUsdc;
  delete safePayment.netRevenueUsdc;
  return { ...view, userPayment: safePayment } as T;
}

export async function listRecentHostedAgentJobs(
  limit = 8,
  workflowType?: HostedWorkflowType | null,
) {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 20));
  let query = getHostedClient()
    .from("hosted_agent_jobs")
    .select("id,workflow_type,task,input_preview,status,spent_usdc,created_at,completed_at,receipt_ids,proof_transaction_hashes")
    .is("byoa_agent_id", null)
    .order("created_at", { ascending: false });
  if (workflowType && isHostedWorkflowType(workflowType)) {
    query = query.eq("workflow_type", workflowType);
  }
  const { data, error } = await query.limit(safeLimit);
  if (error) throw new Error("Unable to load recent hosted workflows.");
  return (data ?? []).map((row) => ({
    id: row.id as string,
    workflowType: row.workflow_type as HostedWorkflowType,
    task: row.task as string,
    inputPreview: String(row.input_preview ?? ""),
    status: row.status as HostedJobStatus,
    spentUsdc: String(row.spent_usdc),
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    receiptCount: Array.isArray(row.receipt_ids) ? row.receipt_ids.length : 0,
    proofCount: Array.isArray(row.proof_transaction_hashes)
      ? row.proof_transaction_hashes.length
      : 0,
    href: `/agent-runner/${row.id as string}`,
  }));
}

export type HostedFinalReportSummary = {
  id: string;
  workflowType: HostedWorkflowType;
  workflowLabel: string;
  inputPreview: string;
  summary: string;
  keyFindings: string[];
  spentUsdc: string;
  receiptCount: number;
  proofCount: number;
  completedWithWarnings: boolean;
  generatedAt: string;
  href: string;
};

export async function listHostedFinalReports(
  limit = 12,
  workflowType?: HostedWorkflowType | null,
) {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 50));
  let query = getHostedClient()
    .from("hosted_agent_jobs")
    .select("id,workflow_type,input_preview,structured_result,spent_usdc,completed_at,receipt_ids,proof_transaction_hashes")
    .eq("status", "completed")
    .is("byoa_agent_id", null)
    .not("structured_result", "is", null)
    .order("completed_at", { ascending: false, nullsFirst: false });
  if (workflowType && isHostedWorkflowType(workflowType)) {
    query = query.eq("workflow_type", workflowType);
  }
  const { data, error } = await query.limit(safeLimit);
  if (error) throw new Error("Unable to load hosted Final Reports.");

  return (data ?? []).flatMap((row) => {
    const report = row.structured_result as HostedFinalReport | null;
    if (!report) return [];
    const receiptIds = Array.isArray(row.receipt_ids) ? row.receipt_ids : [];
    const proofHashes = Array.isArray(row.proof_transaction_hashes)
      ? row.proof_transaction_hashes
      : [];
    return [{
      id: row.id as string,
      workflowType: row.workflow_type as HostedWorkflowType,
      workflowLabel: workflowLabel(row.workflow_type as HostedWorkflowType),
      inputPreview: report.input?.preview ?? String(row.input_preview ?? ""),
      summary: report.summary,
      keyFindings: Array.isArray(report.keyFindings) ? report.keyFindings.slice(0, 3) : [],
      spentUsdc: report.spentUsdc ?? String(row.spent_usdc ?? "0"),
      receiptCount: receiptIds.length,
      proofCount: proofHashes.length,
      completedWithWarnings: Boolean(report.completedWithWarnings),
      generatedAt:
        report.generatedAt ?? (row.completed_at as string | null) ?? new Date(0).toISOString(),
      href: `/agent-runner/${row.id as string}`,
    } satisfies HostedFinalReportSummary];
  });
}

export async function countHostedFinalReports(): Promise<number> {
  const { count, error } = await getHostedClient()
    .from("hosted_agent_jobs")
    .select("*", { count: "exact", head: true })
    .eq("status", "completed")
    .is("byoa_agent_id", null)
    .not("structured_result", "is", null);
  if (error) throw new Error("Unable to count hosted Final Reports.");
  return count ?? 0;
}
