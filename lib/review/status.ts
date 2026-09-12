/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  fetchRecentAgentRuns,
  type PublicAgentRun,
} from "@/lib/agent/runs-public";
import {
  listAgentProfiles,
  type PublicAgentProfile,
} from "@/lib/agent/passport-persistence";
import {
  fetchRecentReceipts,
  type CommerceReceipt,
} from "@/lib/commerce/receipts";
import { listAllStoreServices } from "@/lib/services/store-service-persistence";
import type { ApiService } from "@/lib/services/registry";
import { getServerDatabaseDiagnostic } from "../supabase/server-env";
import { getProofRegistryDiagnostic } from "../commerce/onchain-proof";
import { getHostedRunnerDiagnostic } from "../agent/hosted-policy";
import { listRecentHostedAgentJobs } from "../agent/hosted-jobs";
import { getPythProviderDiagnostic } from "../providers/pyth";
import { getLlmSynthesisDiagnostic } from "../llm/openai-compatible";
import { getHostedWorkflowCheckoutDiagnostic } from "../agent/workflow-pricing";
import { getByoaDiagnostic } from "../byoa/config";

export const RECOMMENDED_REVIEWER_COMMAND =
  'AGENT_MAX_IN_FLIGHT=1 npm run agent -- --task "Analyze tone and sentiment for a short builder update" --limit 0.005';

export type ReviewHealthStatus = {
  generatedAt: string;
  baseUrl: string;
  checks: {
    latestSuccessfulRunExists: boolean;
    latestReceiptExists: boolean;
    sellerCreatedLiveServiceExists: boolean;
    apiStoreServiceCount: number;
    receiptCount: number;
    sellerCreatedLiveServiceCount: number;
    recentInsufficientBalanceFailures: number;
    verifiedProofExists: boolean;
    verifiedProofCount: number;
    pendingProofCount: number;
    failedProofCount: number;
    latestHostedWorkflowExists: boolean;
    latestHostedWorkflowVerified: boolean;
    hostedRealInputWorkflowsEnabled: boolean;
    hostedInputPrivacyEnabled: boolean;
    workflowFirstProductEnabled: boolean;
    publicWorkflowPagesEnabled: boolean;
    liveProviderEnabled: boolean;
    llmSynthesisConfigured: boolean;
    userPaidCheckoutEnabled: boolean;
    byoaCanaryReady: boolean;
  };
  productPositioning: {
    mode: "workflow-first";
    primaryRoute: "/agent-runner";
    templatesRoute: "/workflows";
    resultsRoute: "/results";
    proofsRoute: "/proofs";
    developerToolsRoute: "/developer-tools";
  };
  recommendedCommand: string;
  recentFailedRuns: PublicAgentRun[];
  latestRunUrl: string | null;
  latestReceiptUrl: string | null;
  latestHostedWorkflowUrl: string | null;
  mainPassportUrl: string | null;
  latestRun: PublicAgentRun | null;
  latestReceipt: CommerceReceipt | null;
  mainProfile: PublicAgentProfile | null;
  warnings: string[];
  database: ReturnType<typeof getServerDatabaseDiagnostic>;
  proofRegistry: ReturnType<typeof getProofRegistryDiagnostic>;
  hostedRunner: ReturnType<typeof getHostedRunnerDiagnostic>;
  provider: ReturnType<typeof getPythProviderDiagnostic>;
  llm: ReturnType<typeof getLlmSynthesisDiagnostic>;
  checkout: ReturnType<typeof getHostedWorkflowCheckoutDiagnostic>;
  byoa: ReturnType<typeof getByoaDiagnostic>;
  latestHostedWorkflow: Awaited<ReturnType<typeof listRecentHostedAgentJobs>>[number] | null;
};

export function getDefaultProductionUrl() {
  const publicUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  return (publicUrl ?? "https://agent-commerce-six.vercel.app").replace(/\/$/, "");
}

function isInsufficientBalanceRun(run: PublicAgentRun) {
  const text = [run.error, run.summary].filter(Boolean).join(" ").toLowerCase();
  return (
    text.includes("insufficient_balance") ||
    text.includes("insufficient balance") ||
    text.includes("not enough balance") ||
    text.includes("gateway balance")
  );
}

function urlFor(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function resultWarning(label: string, result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return null;
  const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
  return `${label}: ${reason}`;
}

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 8_000) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

export async function getReviewHealthStatus(
  baseUrl = getDefaultProductionUrl(),
): Promise<ReviewHealthStatus> {
  const [runsResult, receiptsResult, profilesResult, servicesResult, hostedResult] =
    await Promise.allSettled([
      withTimeout("Runs", fetchRecentAgentRuns(30)),
      withTimeout("Receipts", fetchRecentReceipts({ limit: 10 })),
      withTimeout("Agent Passports", listAgentProfiles(1)),
      withTimeout("API Store services", listAllStoreServices()),
      withTimeout("Hosted workflows", listRecentHostedAgentJobs(1)),
    ]);

  const runs =
    runsResult.status === "fulfilled" ? runsResult.value : ([] as PublicAgentRun[]);
  const receipts =
    receiptsResult.status === "fulfilled" ? receiptsResult.value : ([] as CommerceReceipt[]);
  const profiles =
    profilesResult.status === "fulfilled" ? profilesResult.value : ([] as PublicAgentProfile[]);
  const services =
    servicesResult.status === "fulfilled" ? servicesResult.value.services : ([] as ApiService[]);
  const hostedWorkflows =
    hostedResult.status === "fulfilled" ? hostedResult.value : [];
  const latestHostedWorkflow = hostedWorkflows[0] ?? null;
  const hostedRunner = getHostedRunnerDiagnostic();
  const llm = getLlmSynthesisDiagnostic();
  const checkout = getHostedWorkflowCheckoutDiagnostic();
  const byoa = getByoaDiagnostic();

  const latestSuccessfulRun =
    runs.find((run) => run.status === "completed" && (run.paid_count ?? 0) > 0) ??
    runs.find((run) => run.status === "completed") ??
    null;
  const latestRun = latestSuccessfulRun;
  const latestReceipt = receipts[0] ?? null;
  const verifiedReceipts = receipts.filter(
    (receipt) => receipt.onchainProof?.status === "verified",
  );
  const pendingProofCount = receipts.filter(
    (receipt) => receipt.onchainProof?.status === "pending",
  ).length;
  const failedProofCount = receipts.filter(
    (receipt) => receipt.onchainProof?.status === "failed",
  ).length;
  const mainProfile = profiles[0] ?? null;
  const recentFailedRuns = runs.filter((run) => run.status === "failed");
  const recentInsufficientBalanceFailures =
    recentFailedRuns.filter(isInsufficientBalanceRun).length;
  const sellerCreatedLiveServices = services.filter(
    (service) =>
      (service.sourceType === "seller_mock" ||
        service.sourceType === "external_placeholder") &&
      service.status === "live",
  );
  const warnings = [
    resultWarning("Runs", runsResult),
    resultWarning("Receipts", receiptsResult),
    resultWarning("Agent Passports", profilesResult),
    resultWarning("API Store services", servicesResult),
    resultWarning("Hosted workflows", hostedResult),
  ].filter(Boolean) as string[];

  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    checks: {
      latestSuccessfulRunExists: Boolean(latestSuccessfulRun),
      latestReceiptExists: Boolean(latestReceipt),
      sellerCreatedLiveServiceExists: sellerCreatedLiveServices.length > 0,
      apiStoreServiceCount: services.length,
      receiptCount: receipts.length,
      sellerCreatedLiveServiceCount: sellerCreatedLiveServices.length,
      recentInsufficientBalanceFailures,
      verifiedProofExists: verifiedReceipts.length > 0,
      verifiedProofCount: verifiedReceipts.length,
      pendingProofCount,
      failedProofCount,
      latestHostedWorkflowExists: Boolean(latestHostedWorkflow),
      latestHostedWorkflowVerified: (latestHostedWorkflow?.proofCount ?? 0) > 0,
      hostedRealInputWorkflowsEnabled:
        hostedRunner.supportedWorkflows.includes("sentiment_tone") &&
        hostedRunner.supportedWorkflows.includes("builder_update") &&
        hostedRunner.supportedWorkflows.includes("market_context"),
      hostedInputPrivacyEnabled:
        hostedRunner.inputPersistence === "redacted_preview_and_sha256_only",
      workflowFirstProductEnabled: true,
      publicWorkflowPagesEnabled: true,
      liveProviderEnabled:
        getPythProviderDiagnostic().configured &&
        hostedRunner.allowedServices.includes("pyth-market-price"),
      llmSynthesisConfigured: llm.configured,
      userPaidCheckoutEnabled:
        checkout.configured &&
        checkout.paymentModel === "single_user_payment_then_internal_x402" &&
        checkout.chainId === 5_042_002,
      byoaCanaryReady:
        byoa.configured &&
        byoa.enabled &&
        byoa.canaryOnly &&
        byoa.chainId === 5_042_002,
    },
    productPositioning: {
      mode: "workflow-first",
      primaryRoute: "/agent-runner",
      templatesRoute: "/workflows",
      resultsRoute: "/results",
      proofsRoute: "/proofs",
      developerToolsRoute: "/developer-tools",
    },
    recommendedCommand: RECOMMENDED_REVIEWER_COMMAND,
    recentFailedRuns,
    latestRunUrl: latestRun ? urlFor(baseUrl, `/runs/${latestRun.id}`) : null,
    latestReceiptUrl: latestReceipt
      ? urlFor(baseUrl, `/receipts/${latestReceipt.id}`)
      : null,
    latestHostedWorkflowUrl: latestHostedWorkflow
      ? urlFor(baseUrl, latestHostedWorkflow.href)
      : null,
    mainPassportUrl: mainProfile
      ? urlFor(baseUrl, `/agents/${mainProfile.wallet}`)
      : null,
    latestRun,
    latestReceipt,
    mainProfile,
    warnings,
    database: getServerDatabaseDiagnostic(),
    proofRegistry: getProofRegistryDiagnostic(),
    hostedRunner,
    provider: getPythProviderDiagnostic(),
    llm,
    checkout,
    byoa,
    latestHostedWorkflow,
  };
}
