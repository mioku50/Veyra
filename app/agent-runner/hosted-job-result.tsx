/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BadgeCheck, Check, CheckCircle2, Circle, CreditCard, Download, ExternalLink, LoaderCircle, ReceiptText, RotateCcw, Share2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderResponseDetails } from "@/components/services/provider-response-details";
import { ServicePresentation } from "@/components/services/service-presentation";
import {
  HOSTED_REQUESTER_IDENTITY_LABEL,
  HOSTED_REQUESTER_NOT_CHARGED_COPY,
  HOSTED_REQUESTER_PAYMENT_COPY,
  hostedRequesterDisplayLine,
  evaluateArcVerificationState,
  getEvidenceState,
  type EvidenceState,
} from "@/lib/agent/hosted-ui";
import { sanitizePublicReportText } from "@/lib/agent/public-report-copy";
import { BRAND } from "@/lib/brand";
import { shortenHash } from "@/lib/utils";
import type {
  AssessmentStatus,
  DueDiligenceOverallStatus,
  GitHubDueDiligenceAssessment,
  RiskSeverity,
} from "@/lib/agent/github-due-diligence";
import type { GitHubRepositorySnapshot, DataConfidence } from "@/lib/providers/github-types";
import type { AgentTrustReport } from "@/lib/agent-trust/types";
import {
  buildGitHubPublicReport,
  formatGitHubPublicReportAsMarkdown,
} from "@/lib/reports/github-public-report";
import {
  buildApiQualityPublicReport,
  formatApiQualityPublicReportAsMarkdown,
  parseApiQualityJobInput,
} from "@/lib/reports/api-quality-report";
import type { QualityStatus } from "@/lib/providers/api-quality-types";
import type { HostedJobView } from "./types";
import { AgentTrustReportView } from "./agent-trust-report-view";
import { Project360ReportView } from "./project-360-report-view";
import {
  PROJECT_360_MODULE_LABELS,
  PROJECT_360_MODULES,
  type Project360Module,
  type Project360Report,
} from "@/lib/project-360/types";

const DEFAULT_CONSUMER_STAGES = [
  { id: "preparing", label: "Preparing report", matches: ["queued", "planning"] },
  { id: "collecting", label: "Collecting data", matches: ["purchasing"] },
  { id: "analyzing", label: "Analyzing results", matches: ["generating_receipt"] },
  { id: "verifying", label: "Verifying result", matches: ["publishing_onchain_proof"] },
  { id: "completed", label: "Completed", matches: ["completed"] },
] as const;

const GITHUB_CONSUMER_STAGES = [
  { id: "preparing", label: "Preparing repository", matches: ["queued", "planning"] },
  { id: "collecting", label: "Collecting GitHub data", matches: ["purchasing_1"] },
  { id: "activity", label: "Checking recent activity", matches: ["purchasing_2"] },
  { id: "reviewing", label: "Reviewing documentation and releases", matches: ["purchasing_3"] },
  { id: "building", label: "Building the due diligence report", matches: ["generating_receipt"] },
  { id: "verifying", label: "Verifying the result on Arc", matches: ["publishing_onchain_proof"] },
  { id: "completed", label: "Completed", matches: ["completed"] },
] as const;

const PROJECT_360_MODULE_SERVICES: Record<Project360Module, string[]> = {
  github_due_diligence: [
    "github-repository-intelligence",
    "github-due-diligence-analysis",
  ],
  agent_trust_report: ["agent-trust-finalizer"],
  treasury_health: ["treasury-health-finalizer"],
  paid_api_quality: ["api-quality-finalizer"],
  arc_contract_analysis: ["arc-contract-analysis-finalizer"],
};

function formatDate(value?: string | null) {
  if (!value) return "N/A";
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function qualityStatusBadge(status?: QualityStatus) {
  switch (status) {
    case "Excellent":
      return { label: "Excellent", color: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" };
    case "Reliable":
      return { label: "Reliable", color: "bg-blue-500/10 text-blue-500 border-blue-500/20" };
    case "Mixed signals":
      return { label: "Mixed signals", color: "bg-amber-500/10 text-amber-500 border-amber-500/20" };
    case "High attention":
      return { label: "High attention", color: "bg-red-500/10 text-red-500 border-red-500/20" };
    case "Insufficient data":
    default:
      return { label: "Insufficient data", color: "bg-muted text-muted-foreground border-muted" };
  }
}

function overallStatusBadge(status?: DueDiligenceOverallStatus) {
  switch (status) {
    case "healthy_signals":
      return { label: "Healthy signals", color: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" };
    case "review_needed":
      return { label: "Review recommended", color: "bg-amber-500/10 text-amber-500 border-amber-500/20" };
    case "high_attention":
      return { label: "High attention", color: "bg-red-500/10 text-red-500 border-red-500/20" };
    case "limited_data":
      return { label: "Limited data", color: "bg-muted text-muted-foreground" };
    default:
      return { label: "Review recommended", color: "bg-amber-500/10 text-amber-500 border-amber-500/20" };
  }
}

function riskSeverityBadge(severity: RiskSeverity) {
  switch (severity) {
    case "high":
      return { label: "High attention", color: "border-red-500/30 bg-red-500/5 text-red-400" };
    case "medium":
      return { label: "Review recommended", color: "border-amber-500/30 bg-amber-500/5 text-amber-400" };
    case "low":
    case "info":
    default:
      return { label: "Additional context", color: "border-blue-500/30 bg-blue-500/5 text-blue-400" };
  }
}

function categoryStatusBadge(status?: AssessmentStatus) {
  switch (status) {
    case "strong":
      return { label: "Strong", color: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" };
    case "moderate":
      return { label: "Moderate", color: "bg-amber-500/10 text-amber-500 border-amber-500/20" };
    case "weak":
      return { label: "Weak", color: "bg-red-500/10 text-red-500 border-red-500/20" };
    case "unknown":
    default:
      return { label: "Unknown", color: "bg-muted text-muted-foreground" };
  }
}

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function fallbackReasonLabel(
  value: NonNullable<
    NonNullable<HostedJobView["job"]["structuredResult"]>["synthesis"]
  >["fallbackReason"],
) {
  if (value === "not_configured") return "OpenRouter is not configured";
  if (value === "unsupported_provider") return "Unsupported LLM provider configuration";
  if (value === "no_paid_api_results") return "No successful paid API response was available";
  if (value === "timeout") return "OpenRouter timed out";
  if (value === "rate_limited") return "OpenRouter rate limit";
  if (value === "response_too_large") return "OpenRouter response exceeded the safe limit";
  if (value === "invalid_response") return "OpenRouter returned an invalid response";
  if (value === "upstream_error") return "OpenRouter was unavailable";
  return "Deterministic report selected";
}


function renderEvidenceBadge(
  state: EvidenceState,
  presentLabel = "Present",
  missingLabel = "Missing",
  unavailableLabel = "Unavailable"
) {
  if (state === "present") {
    return (
      <span className="flex items-center gap-1 font-semibold text-emerald-500">
        <Check className="size-4" /> {presentLabel}
      </span>
    );
  }
  if (state === "missing") {
    return (
      <span className="flex items-center gap-1 font-semibold text-amber-500">
        {missingLabel}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 font-medium text-muted-foreground">
      {unavailableLabel}
    </span>
  );
}

function renderMetricDisplay(
  value: number | string | null | undefined,
  isCollected: boolean,
  fallbackLabel = "Unavailable"
) {
  if (!isCollected || value === undefined || value === null) {
    return <span className="text-muted-foreground font-normal">{fallbackLabel}</span>;
  }
  return String(value);
}

function renderCommitCountDisplay(
  value: number | null | undefined,
  isLowerBound: boolean | null | undefined,
  isCollected: boolean,
  fallbackLabel = "Unavailable"
) {
  if (!isCollected || value === undefined || value === null) {
    return <span className="text-muted-foreground font-normal">{fallbackLabel}</span>;
  }
  return isLowerBound ? `${value}+` : String(value);
}

function renderConfidenceBadge(confidence?: DataConfidence) {
  if (!confidence) return null;
  const label =
    confidence === "high"
      ? "High confidence"
      : confidence === "medium"
        ? "Medium confidence"
        : "Low confidence";
  return (
    <Badge variant="outline" className="text-[10px] font-normal border-muted text-muted-foreground">
      {label}
    </Badge>
  );
}

function ArcVerificationBadge({
  proofs,
  services,
  isGithubWorkflow,
  jobStatus,
}: {
  proofs: HostedJobView["proofs"];
  services?: HostedJobView["services"];
  isGithubWorkflow?: boolean;
  jobStatus?: string;
}) {
  const result = evaluateArcVerificationState({ proofs, services, isGithubWorkflow, jobStatus });

  if (result.variant === "verified") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 text-emerald-500 bg-emerald-500/10">
        <BadgeCheck className="size-3.5" />
        {result.label}
      </Badge>
    );
  }

  if (result.variant === "partially_verified") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/30 text-amber-500 bg-amber-500/10">
        <BadgeCheck className="size-3.5" />
        {result.label}
      </Badge>
    );
  }

  if (result.variant === "pending") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/30 text-amber-500 bg-amber-500/10">
        <LoaderCircle className="size-3.5 animate-spin" />
        {result.label}
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="gap-1 border-muted bg-muted/50 text-muted-foreground">
      {result.label}
    </Badge>
  );
}

export function HostedJobResult({ initialView }: { initialView: HostedJobView }) {
  const [view, setView] = useState(initialView);
  const [pollError, setPollError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const proofStatusKey = view.proofs.map((proof) => proof.status).join(",");
  const allProofsFinal =
    view.proofs.length > 0 &&
    view.proofs.every((proof) => proof.status !== "pending");

  useEffect(() => {
    if (view.job.status === "failed") return;
    if (view.job.status === "completed" && allProofsFinal) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/hosted-agent/jobs/${view.job.id}`, { cache: "no-store" });
        const data = (await response.json()) as HostedJobView & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Unable to refresh hosted workflow.");
        if (!cancelled) {
          setView(data);
          setPollError(null);
        }
      } catch (error) {
        if (!cancelled) setPollError(error instanceof Error ? error.message : String(error));
      }
      if (!cancelled) timer = window.setTimeout(poll, 1_500);
    };
    timer = window.setTimeout(poll, 800);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [allProofsFinal, proofStatusKey, view.job.id, view.job.status]);

  function copyShareLink() {
    if (typeof window !== "undefined") {
      void navigator.clipboard.writeText(window.location.href).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(() => setCopied(false));
    }
  }

  function downloadGitHubReport(format: "json" | "markdown") {
    const content =
      format === "json"
        ? `${JSON.stringify(publicReport, null, 2)}\n`
        : formatGitHubPublicReportAsMarkdown(publicReport);
    const blob = new Blob([content], {
      type:
        format === "json"
          ? "application/json;charset=utf-8"
          : "text/markdown;charset=utf-8",
    });
    const href = URL.createObjectURL(blob);
    const repositoryName =
      publicReport.repository?.fullName.replace(/[^a-z0-9._-]+/gi, "-") ??
      publicReport.reportId;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${repositoryName}-due-diligence.${format === "json" ? "json" : "md"}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }

  const activeStage = view.job.progressStage;
  const isGithubWorkflow = view.job.workflowType === "github_due_diligence";
  const isAgentTrustWorkflow = view.job.workflowType === "agent_trust_report";
  const isApiQualityWorkflow = view.job.workflowType === "paid_api_quality";
  const isProject360Workflow = view.job.workflowType === "project_360";
  const project360Report = isProject360Workflow
    ? ((view.job.structuredResult?.workflowData as { report?: Project360Report } | null)?.report ?? null)
    : null;
  const project360Proof = project360Report
    ? view.proofs.find(
        (proof) =>
          proof.responseHash?.toLowerCase() ===
          project360Report.verification.reportHash.toLowerCase(),
      ) ?? null
    : null;
  const project360ModuleProgress = PROJECT_360_MODULES.map((module) => {
    const finalModule = project360Report?.modules.find((item) => item.module === module);
    if (finalModule) return { module, status: finalModule.status };
    const selected = view.job.project360Modules?.includes(module) ?? false;
    const serviceSlugs = PROJECT_360_MODULE_SERVICES[module];
    const moduleServices = view.services.filter((service) =>
      serviceSlugs.includes(service.serviceSlug),
    );
    const status = !selected
      ? "not_selected"
      : moduleServices.some((service) => service.status === "failed")
        ? "failed"
        : moduleServices.filter((service) => service.status === "paid").length ===
            serviceSlugs.length
          ? "completed"
          : moduleServices.length > 0
            ? "running"
            : "pending";
    return { module, status };
  });
  const isSellerWorkflow = String(view.job.workflowType).startsWith("seller_");
  const consumerStages = isGithubWorkflow ? GITHUB_CONSUMER_STAGES : DEFAULT_CONSUMER_STAGES;
  const currentIndex = DEFAULT_CONSUMER_STAGES.findIndex((stage) =>
    (stage.matches as readonly string[]).includes(activeStage),
  );
  const active = view.job.status === "queued" || view.job.status === "running";

  const report = view.job.structuredResult;
  const trustReport =
    isAgentTrustWorkflow &&
    (report?.workflowData as {
      kind?: string;
      report?: AgentTrustReport;
    } | null)?.kind === "agent_trust_report"
      ? ((report?.workflowData as { report: AgentTrustReport }).report)
      : null;

  const apiQualityReport = isApiQualityWorkflow
    ? (() => {
        const { targetServices, observationWindowDays } = parseApiQualityJobInput(
          view.job.inputPreview,
          view.job.plannerSnapshot,
          view.job.structuredResult,
        );
        const proofs = view.proofs.map((p) => ({
          receiptId: p.receiptId,
          txHash: p.transactionHash || null,
          status: p.status,
          explorerUrl: p.transactionUrl,
          blockNumber: p.blockNumber,
          contractAddress: p.contractAddress,
        }));
        const receipts = view.services.map((s) => ({
          receiptId: s.receiptId || s.serviceSlug,
          serviceSlug: s.serviceSlug,
          serviceName: s.serviceName,
          priceUsdc: String(s.priceUsdc),
          status: s.status,
        }));
        const workflowData = (view.job.structuredResult as any)?.workflowData;
        const observationsByService = workflowData?.observationsByService;
        const observations = workflowData?.observations;

        return buildApiQualityPublicReport({
          jobId: view.job.id,
          workflow: view.job.workflowType,
          status: view.job.status,
          targetServices,
          observationWindowDays,
          observationsByService,
          observations,
          proofs,
          receipts,
          generatedAt: view.job.completedAt || view.job.createdAt,
        });
      })()
    : null;

  function downloadApiQualityReport(format: "json" | "markdown") {
    if (!apiQualityReport) return;
    const content =
      format === "json"
        ? `${JSON.stringify(apiQualityReport, null, 2)}\n`
        : formatApiQualityPublicReportAsMarkdown(apiQualityReport);
    const blob = new Blob([content], {
      type:
        format === "json"
          ? "application/json;charset=utf-8"
          : "text/markdown;charset=utf-8",
    });
    const href = URL.createObjectURL(blob);
    const fileName = `paid-api-quality-${apiQualityReport.reportId}`;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${fileName}.${format === "json" ? "json" : "md"}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }
  const reportInput = report?.input ?? {
    preview: view.job.inputPreview,
    sha256: view.job.inputSha256,
  };

  const repoRef =
    report?.repository ??
    view.job.plannerSnapshot.repository ??
    (report?.workflowData as any)?.repository;

  const snapshot: GitHubRepositorySnapshot | null =
    (report?.workflowData as any)?.snapshot ??
    (() => {
      const service = view.services.find((s) => s.serviceSlug === "github-repository-intelligence");
      const resp = service?.response as any;
      return resp?.snapshot ?? (resp && "repository" in resp ? resp : null);
    })();

  const isDataAvailable = Boolean(snapshot);

  const canonicalUrl =
    repoRef?.canonicalUrl ||
    snapshot?.ref?.canonicalUrl ||
    (snapshot?.repository?.fullName
      ? `https://github.com/${snapshot.repository.fullName}`
      : null);

  const assessment: GitHubDueDiligenceAssessment | null =
    (report?.workflowData as any)?.assessment ??
    (() => {
      const service = view.services.find((s) => s.serviceSlug === "github-due-diligence-analysis");
      const resp = service?.response as any;
      return resp?.assessment ?? (resp && "overallStatus" in resp ? resp : null);
    })();

  const publicExecutiveSummary =
    assessment?.overallSummary ??
    report?.summary ??
    "Repository analysis is unavailable.";

  const publicReport = buildGitHubPublicReport({
    jobId: view.job.id,
    workflow: view.job.workflowType,
    status: view.job.status,
    repository: repoRef
      ? {
          fullName: repoRef.fullName || view.job.inputPreview,
          canonicalUrl:
            repoRef.canonicalUrl ||
            canonicalUrl ||
            `https://github.com/${repoRef.fullName || view.job.inputPreview}`,
        }
      : null,
    snapshot,
    assessment,
    proofs: view.proofs.map((p) => ({
      receiptId: p.receiptId,
      txHash: p.transactionHash || null,
      status: p.status,
      explorerUrl: p.transactionUrl,
      blockNumber: p.blockNumber,
      contractAddress: p.contractAddress,
    })),
    receipts: view.services.map((s) => ({
      receiptId: s.receiptId || s.serviceSlug,
      serviceSlug: s.serviceSlug,
      serviceName: s.serviceName,
      priceUsdc: s.priceUsdc,
      status: s.status,
    })),
    generatedAt: view.job.completedAt || view.job.createdAt,
  });

  const isCompleted = view.job.status === "completed";
  const durationMs = isCompleted && view.job.completedAt && (view.job.startedAt || view.job.createdAt)
    ? Date.parse(view.job.completedAt) - Date.parse(view.job.startedAt || view.job.createdAt)
    : null;
  const durationSec = durationMs && durationMs > 0 ? Math.max(1, Math.round(durationMs / 1000)) : null;

  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/20">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <Badge className="mb-3">
                {isGithubWorkflow
                  ? "GitHub Project Intelligence · Arc Testnet"
                  : isAgentTrustWorkflow
                    ? "Agent trust intelligence · Arc Testnet"
                    : "Shareable hosted result"}
              </Badge>
              <h1 className="text-3xl font-bold sm:text-4xl">
                {isGithubWorkflow
                  ? `GitHub Project Due Diligence`
                  : view.job.plannerSnapshot.workflowLabel ?? "Hosted agent workflow"}
              </h1>
              <p className="mt-3 max-w-3xl text-muted-foreground">
                {isGithubWorkflow
                  ? repoRef?.fullName ?? snapshot?.repository?.fullName ?? view.job.inputPreview
                  : view.job.task}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={view.job.status === "failed" ? "destructive" : view.job.status === "completed" ? "default" : "secondary"}>
                {view.job.status === "completed" ? "Completed" : view.job.status}
              </Badge>
              {isGithubWorkflow && assessment ? (
                <Badge className={overallStatusBadge(assessment.overallStatus).color}>
                  {overallStatusBadge(assessment.overallStatus).label}
                </Badge>
              ) : null}
              <ArcVerificationBadge
                proofs={view.proofs}
                services={view.services}
                isGithubWorkflow={isGithubWorkflow}
                jobStatus={view.job.status}
              />
              {!isGithubWorkflow && !isAgentTrustWorkflow && view.job.status === "completed" ? (
                <Button variant="outline" onClick={copyShareLink}>
                  {copied ? <Check className="size-4 text-emerald-500" /> : <Share2 className="size-4" />}
                  {copied ? "Copied!" : "Share Report"}
                </Button>
              ) : null}
              <Button asChild variant="outline">
                <Link href="/agent-runner">
                  <RotateCcw className="size-4" />
                  New workflow
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section
        className={
          isCompleted
            ? "mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 grid gap-6"
            : "mx-auto grid w-full max-w-6xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[0.72fr_1.28fr]"
        }
      >
        {isCompleted ? (
          <div className="rounded-lg border p-4 bg-card flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex size-7 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
                  <Check className="size-4" />
                </div>
                <div>
                  <span className="font-semibold text-sm text-foreground">Workflow execution completed</span>
                  {durationSec ? (
                    <span className="ml-2 text-xs text-muted-foreground font-mono">
                      ({durationSec}s)
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs">
                {view.userPayment?.transactionUrl ? (
                  <a
                    href={view.userPayment.transactionUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:underline flex items-center gap-1"
                  >
                    Payment details <ExternalLink className="size-3" />
                  </a>
                ) : view.links.workflowReceipt ? (
                  <Link
                    href={view.links.workflowReceipt}
                    className="font-medium text-primary hover:underline flex items-center gap-1"
                  >
                    Payment details <ExternalLink className="size-3" />
                  </Link>
                ) : (
                  <a
                    href="#technical-details"
                    className="font-medium text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Payment & technical details
                  </a>
                )}
              </div>
            </div>
            <details className="text-xs text-muted-foreground border-t pt-2 mt-1">
              <summary className="cursor-pointer font-medium hover:text-foreground select-none">
                Execution steps ({consumerStages.length}/{consumerStages.length} completed)
              </summary>
              <div className="mt-2 grid gap-1.5 font-mono text-[11px] sm:grid-cols-2">
                {consumerStages.map((stageItem) => (
                  <div key={stageItem.id} className="flex items-center gap-2 text-emerald-500">
                    <Check className="size-3.5 shrink-0" />
                    <span>{stageItem.label}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        ) : (
          <div className="grid content-start gap-6">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>Live progress</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {consumerStages.map((stageItem, index) => {
                  let done = false;
                  let current = false;

                  if (active) {
                    if (!isGithubWorkflow) {
                      done = currentIndex >= 0 && index < currentIndex;
                      current = (stageItem.matches as readonly string[]).includes(activeStage);
                    } else {
                      const paidCount = view.services.filter((s) => s.status === "paid").length;
                      if (activeStage === "queued" || activeStage === "planning") {
                        current = index === 0;
                        done = index < 0;
                      } else if (activeStage === "purchasing") {
                        done = index < 1 + Math.min(paidCount, 2);
                        current = index === 1 + Math.min(paidCount, 2);
                      } else if (activeStage === "generating_receipt") {
                        done = index < 4;
                        current = index === 4;
                      } else if (activeStage === "publishing_onchain_proof") {
                        done = index < 5;
                        current = index === 5;
                      }
                    }
                  }

                  return (
                    <div key={stageItem.id} className="flex items-center gap-3 text-sm">
                      {done ? (
                        <Check className="size-5 text-primary" />
                      ) : current && active ? (
                        <LoaderCircle className="size-5 animate-spin text-primary" />
                      ) : (
                        <Circle className="size-5 text-muted-foreground/40" />
                      )}
                      <span className={done || current ? "font-medium" : "text-muted-foreground"}>
                        {stageItem.label}
                      </span>
                    </div>
                  );
                })}
                {view.job.status === "failed" ? (
                  <p className="text-sm text-destructive">Failed · {view.job.error}</p>
                ) : null}
                {pollError ? <p className="text-sm text-destructive">{pollError}</p> : null}
                {view.job.progressMessage ? (
                  <p className="mt-2 text-xs text-muted-foreground">{view.job.progressMessage}</p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        )}

        <div className="grid content-start gap-6">
          {isProject360Workflow ? (
            <Card className="rounded-2xl border-white/10 bg-[#090c13]" data-testid="project-360-module-progress">
              <CardHeader><CardTitle>Project 360 module progress</CardTitle></CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                {project360ModuleProgress.map((item) => (
                  <div key={item.module} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 p-3 text-sm">
                    <span>{PROJECT_360_MODULE_LABELS[item.module]}</span>
                    <Badge variant="outline">{item.status.replaceAll("_", " ")}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
          {isProject360Workflow && project360Report ? (
            <Project360ReportView report={project360Report} proof={project360Proof} jobId={view.job.id} />
          ) : isApiQualityWorkflow && apiQualityReport ? (
            <Card className="rounded-lg">
              <CardContent className="p-6 grid gap-6">
                {/* 1. Header & Actions */}
                <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <Badge variant="secondary">Generated by {BRAND.name}</Badge>
                      <Badge variant="outline" className="font-mono text-xs">
                        {apiQualityReport.targetServices.join(", ")}
                      </Badge>
                      <Badge className={qualityStatusBadge(apiQualityReport.overallStatus).color}>
                        {apiQualityReport.overallScore !== null && apiQualityReport.overallScore !== undefined
                          ? `Score: ${apiQualityReport.overallScore}/100 (${apiQualityReport.overallStatus})`
                          : `Insufficient data`}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {apiQualityReport.confidence} confidence
                      </Badge>
                      <ArcVerificationBadge
                        proofs={view.proofs}
                        services={view.services}
                        jobStatus={view.job.status}
                      />
                    </div>
                    <h2 className="text-2xl font-bold tracking-tight">Paid API Quality Report</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {apiQualityReport.mode === "comparison"
                        ? `Comparative evaluation across ${apiQualityReport.targetServices.length} paid API service(s) (${apiQualityReport.observationWindowDays}-day window)`
                        : `Empirical telemetry evaluation for service '${apiQualityReport.targetServices[0]}' (${apiQualityReport.observationWindowDays}-day window)`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={copyShareLink} className="gap-1.5">
                      {copied ? <Check className="size-4 text-emerald-500" /> : <Share2 className="size-4" />}
                      {copied ? "Copied!" : "Share Report"}
                    </Button>
                    {view.job.status === "completed" ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadApiQualityReport("json")}
                          className="gap-1.5"
                        >
                          <Download className="size-4" />
                          JSON
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadApiQualityReport("markdown")}
                          className="gap-1.5"
                        >
                          <Download className="size-4" />
                          Markdown
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                {/* 2. Executive Summary */}
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    1. Executive Summary
                  </h3>
                  <div className="rounded-md bg-secondary/30 p-4 text-sm leading-6">
                    {sanitizePublicReportText(apiQualityReport.executiveSummary)}
                  </div>
                </div>

                {/* 3. Category Performance Highlights */}
                {apiQualityReport.comparison?.highlights?.length ? (
                  <div className="border-t pt-6">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      2. Category Performance Highlights
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                      {apiQualityReport.comparison.highlights.map((h) => (
                        <div key={h.category} className="rounded-md border p-3.5 bg-primary/5 border-primary/20">
                          <p className="font-semibold text-xs text-primary uppercase tracking-wide">{h.title}</p>
                          <p className="mt-1 text-sm font-bold">{h.winnerServiceName || h.winnerServiceId}</p>
                          <Badge variant="secondary" className="mt-1 font-mono text-[11px]">
                            {h.value}
                          </Badge>
                          <p className="mt-2 text-muted-foreground leading-4">{h.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* 4. Side-by-Side Comparison Matrix */}
                {apiQualityReport.servicesCompared?.length > 1 ? (
                  <div className="border-t pt-6">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      3. Side-by-Side Comparison Matrix
                    </h3>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-secondary/40 text-muted-foreground">
                          <tr>
                            <th className="p-3 font-semibold">Rank</th>
                            <th className="p-3 font-semibold">Service</th>
                            <th className="p-3 font-semibold">Quality Score</th>
                            <th className="p-3 font-semibold">Status</th>
                            <th className="p-3 font-semibold">Observations</th>
                            <th className="p-3 font-semibold">P50 Latency</th>
                            <th className="p-3 font-semibold">Uptime</th>
                            <th className="p-3 font-semibold">Cost / Result</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {apiQualityReport.servicesCompared.map((s) => {
                            const match = apiQualityReport.comparison?.services.find(
                              (item) => item.serviceId === s.serviceId,
                            );
                            const isWinner = apiQualityReport.comparison?.overallWinnerServiceId === s.serviceId;
                            return (
                              <tr key={s.serviceId} className={isWinner ? "bg-primary/5 font-medium" : ""}>
                                <td className="p-3 font-bold font-mono">#{s.rank ?? 1}</td>
                                <td className="p-3 font-medium">
                                  {s.serviceName}
                                  <code className="block text-[10px] text-muted-foreground font-mono">{s.serviceId}</code>
                                </td>
                                <td className="p-3 font-bold font-mono text-sm">
                                  {s.qualityScore !== null && s.qualityScore !== undefined ? `${s.qualityScore}/100` : "N/A"}
                                </td>
                                <td className="p-3">
                                  <Badge className={qualityStatusBadge(s.status).color}>
                                    {s.status ?? "Insufficient data"}
                                  </Badge>
                                </td>
                                <td className="p-3 font-mono">{s.observationCount.value}</td>
                                <td className="p-3 font-mono">{match && match.metrics.latencyP50Ms > 0 ? `${match.metrics.latencyP50Ms}ms` : "N/A"}</td>
                                <td className="p-3 font-mono">{match && match.metrics.uptimePercent !== null ? `${match.metrics.uptimePercent}%` : "N/A"}</td>
                                <td className="p-3 font-mono">{match && match.metrics.costPerSuccessfulResultUsdc !== null ? `${match.metrics.costPerSuccessfulResultUsdc} USDC` : "N/A"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {/* 5. Single / Primary Service Review Metrics */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    {apiQualityReport.servicesCompared.length > 1 ? "4. Primary Service Review Metrics" : "2. Primary Service Review Metrics"}
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                    <div className="rounded-md border p-3.5">
                      <p className="text-xs text-muted-foreground">Observed Uptime</p>
                      <p className="font-semibold text-lg mt-1">
                        {apiQualityReport.availability.uptimePercent.value !== null
                          ? `${apiQualityReport.availability.uptimePercent.value}%`
                          : "N/A"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {(apiQualityReport.availability.totalObservations.value ?? 0) > 0
                          ? `${apiQualityReport.availability.totalObservations.value} total observation(s)`
                          : "No observations"}
                      </p>
                    </div>
                    <div className="rounded-md border p-3.5">
                      <p className="text-xs text-muted-foreground">Latency (P50 / P95 / Max)</p>
                      <p className="font-semibold text-lg mt-1 font-mono">
                        {(apiQualityReport.availability.totalObservations.value ?? 0) > 0
                          ? `${apiQualityReport.latencyDistribution.latencyP50Ms.value}ms / ${apiQualityReport.latencyDistribution.latencyP95Ms.value}ms`
                          : "N/A"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {(apiQualityReport.availability.totalObservations.value ?? 0) > 0
                          ? `Max: ${apiQualityReport.latencyDistribution.latencyMaxMs.value}ms`
                          : "No observations"}
                      </p>
                    </div>
                    <div className="rounded-md border p-3.5">
                      <p className="text-xs text-muted-foreground">Valid Response & Schema Rate</p>
                      <p className="font-semibold text-lg mt-1 font-mono">
                        {apiQualityReport.responseQuality.validResponsePercent.value !== null
                          ? `${apiQualityReport.responseQuality.validResponsePercent.value}%`
                          : "N/A"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {(apiQualityReport.availability.totalObservations.value ?? 0) > 0
                          ? `Schema: ${apiQualityReport.responseQuality.schemaValidationPercent.value}% | Size limit: ${apiQualityReport.responseQuality.withinSizeLimitPercent.value}%`
                          : "No observations"}
                      </p>
                    </div>
                    <div className="rounded-md border p-3.5">
                      <p className="text-xs text-muted-foreground">Payment & Settlement Reliability</p>
                      <p className="font-semibold text-lg mt-1 font-mono">
                        {apiQualityReport.paymentAndSettlementReliability.paymentSuccessPercent.value !== null
                          ? `${apiQualityReport.paymentAndSettlementReliability.paymentSuccessPercent.value}%`
                          : "N/A"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Arc Settlement: {apiQualityReport.paymentAndSettlementReliability.settlementSuccessPercent.value !== null
                          ? `${apiQualityReport.paymentAndSettlementReliability.settlementSuccessPercent.value}%`
                          : "N/A"}
                      </p>
                    </div>
                    <div className="rounded-md border p-3.5 sm:col-span-2 lg:col-span-2">
                      <p className="text-xs text-muted-foreground">Quoted Pricing & Cost Efficiency</p>
                      <div className="flex flex-wrap items-center gap-4 mt-1 font-mono text-sm">
                        <span>Min: <strong>{(apiQualityReport.availability.totalObservations.value ?? 0) > 0 ? `${apiQualityReport.priceAndCostEfficiency.quotedPriceMinUsdc.value} USDC` : "N/A"}</strong></span>
                        <span>Median: <strong>{(apiQualityReport.availability.totalObservations.value ?? 0) > 0 ? `${apiQualityReport.priceAndCostEfficiency.quotedPriceMedianUsdc.value} USDC` : "N/A"}</strong></span>
                        <span>Max: <strong>{(apiQualityReport.availability.totalObservations.value ?? 0) > 0 ? `${apiQualityReport.priceAndCostEfficiency.quotedPriceMaxUsdc.value} USDC` : "N/A"}</strong></span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Cost per successful result: {apiQualityReport.priceAndCostEfficiency.costPerSuccessfulResultUsdc.value !== null
                          ? `${apiQualityReport.priceAndCostEfficiency.costPerSuccessfulResultUsdc.value} USDC`
                          : "N/A"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 6. Quality Score Breakdown */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Quality Score Breakdown (0–100)
                  </h3>
                  {apiQualityReport.overallScore === null || apiQualityReport.qualityScoreAndConfidence.overallScore === null ? (
                    <div className="rounded-md border p-4 bg-muted/20 text-center">
                      <div className="inline-flex items-center gap-2 mb-2">
                        <Badge variant="outline" className="bg-muted text-muted-foreground">
                          Insufficient data
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        At least 10 observations are required to compute a high-confidence Quality Score. Current observation count: {apiQualityReport.availability.totalObservations.value ?? 0}.
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                      {[
                        { label: "Availability", score: apiQualityReport.qualityScoreAndConfidence.breakdown.availabilityScore, max: 25 },
                        { label: "Execution Reliability", score: apiQualityReport.qualityScoreAndConfidence.breakdown.executionReliabilityScore, max: 20 },
                        { label: "Response Validity", score: apiQualityReport.qualityScoreAndConfidence.breakdown.responseValidityScore, max: 15 },
                        { label: "Payment Success", score: apiQualityReport.qualityScoreAndConfidence.breakdown.paymentSuccessScore, max: 15 },
                        { label: "Settlement Success", score: apiQualityReport.qualityScoreAndConfidence.breakdown.settlementSuccessScore, max: 15 },
                        { label: "Latency Consistency", score: apiQualityReport.qualityScoreAndConfidence.breakdown.latencyConsistencyScore, max: 10 },
                      ].map((item) => (
                        <div key={item.label} className="rounded-md border p-3">
                          <div className="flex justify-between items-center mb-1.5">
                            <span className="font-medium text-foreground">{item.label}</span>
                            <span className="font-mono font-bold">
                              {item.score !== null && item.score !== undefined ? `${item.score} / ${item.max}` : "N/A"}
                            </span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                            <div
                              className="h-full bg-primary transition-all"
                              style={{ width: item.score !== null && item.score !== undefined ? `${Math.min(100, (item.score / item.max) * 100)}%` : "0%" }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 7. Evidence-Backed Strengths */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Evidence-Backed Strengths
                  </h3>
                  {apiQualityReport.strengths?.length ? (
                    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-4 text-xs">
                      <ul className="grid gap-2 text-muted-foreground">
                        {apiQualityReport.strengths.map((s, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <Check className="size-4 text-emerald-500 shrink-0 mt-0.5" />
                            <span>{s}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No specific strengths highlighted.</p>
                  )}
                </div>

                {/* 8. Risks and Review Items */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Risks & Review Items
                  </h3>
                  {apiQualityReport.risksAndReviewItems?.length ? (
                    <div className="grid gap-3 text-xs">
                      {apiQualityReport.risksAndReviewItems.map((risk, i) => {
                        const badge = riskSeverityBadge(risk.severity as RiskSeverity);
                        return (
                          <div key={i} className={`rounded-md border p-4 ${badge.color}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                              <p className="font-semibold text-sm">{risk.title}</p>
                              <Badge variant="outline" className="text-xs font-medium">
                                {badge.label}
                              </Badge>
                            </div>
                            <p className="text-muted-foreground leading-5">{risk.description}</p>
                            <p className="mt-2 text-[11px] font-medium text-foreground/80">Impact: {risk.impact}</p>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No significant risk factors identified by telemetry rules.</p>
                  )}
                </div>

                {/* 9. Questions Before Integration */}
                {apiQualityReport.questionsBeforeIntegration?.length ? (
                  <div className="border-t pt-6">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Questions Before Integration
                    </h3>
                    <div className="rounded-md border p-4 text-xs">
                      <ul className="grid gap-2 text-muted-foreground">
                        {apiQualityReport.questionsBeforeIntegration.map((q, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="font-semibold text-primary shrink-0">{i + 1}.</span>
                            <span>{q}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}

                {/* 10. Evidence & Telemetry Window */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Evidence & Observation Telemetry Window
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Observation Window</p>
                      <p className="font-semibold mt-1">{apiQualityReport.evidenceAndObservationWindow.windowDays} Days</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Real Paid Executions</p>
                      <p className="font-semibold mt-1 font-mono">{apiQualityReport.evidenceAndObservationWindow.realPaidExecutionCount.value}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Scheduled Probes</p>
                      <p className="font-semibold mt-1 font-mono">{apiQualityReport.evidenceAndObservationWindow.scheduledProbeCount.value}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Historical Executions</p>
                      <p className="font-semibold mt-1 font-mono">{apiQualityReport.evidenceAndObservationWindow.historicalExecutionCount.value}</p>
                    </div>
                  </div>
                </div>

                {/* 11. Limitations & Disclaimer */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Limitations & Disclaimer
                  </h3>
                  <div className="rounded-md border border-amber-400/20 bg-amber-400/5 p-4 text-xs leading-5 text-amber-200/90">
                    <p>{apiQualityReport.limitations.disclaimer}</p>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Analysis timestamp: {apiQualityReport.limitations.analyzedAt}.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : isAgentTrustWorkflow && trustReport ? (
            <AgentTrustReportView
              report={trustReport}
              copied={copied}
              onShare={copyShareLink}
              receiptUrl={view.links.workflowReceipt}
            />
          ) : isGithubWorkflow ? (
            <Card className="rounded-lg">
              <CardContent className="p-6 grid gap-6">
                {/* 1. Header & Actions */}
                <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <Badge variant="secondary">Generated by {BRAND.name}</Badge>
                      <Badge variant="outline" className="font-mono text-xs">
                        {repoRef?.fullName ?? snapshot?.repository?.fullName ?? view.job.inputPreview}
                      </Badge>
                      {assessment ? (
                        <Badge className={overallStatusBadge(assessment.overallStatus).color}>
                          {overallStatusBadge(assessment.overallStatus).label}
                        </Badge>
                      ) : null}
                      <ArcVerificationBadge
                        proofs={view.proofs}
                        services={view.services}
                        isGithubWorkflow={isGithubWorkflow}
                        jobStatus={view.job.status}
                      />
                    </div>
                    <h2 className="text-2xl font-bold tracking-tight">GitHub Project Due Diligence</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {snapshot?.repository?.description ?? "Public repository intelligence and automated risk assessment."}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canonicalUrl ? (
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={canonicalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="gap-1.5"
                        >
                          <ExternalLink className="size-4" />
                          Open Repository
                        </a>
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={copyShareLink} className="gap-1.5">
                      {copied ? <Check className="size-4 text-emerald-500" /> : <Share2 className="size-4" />}
                      {copied ? "Copied!" : "Share Report"}
                    </Button>
                    {view.job.status === "completed" ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadGitHubReport("json")}
                          className="gap-1.5"
                        >
                          <Download className="size-4" />
                          JSON
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadGitHubReport("markdown")}
                          className="gap-1.5"
                        >
                          <Download className="size-4" />
                          Markdown
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                {/* 12 P1.4 GitHub Report Sections */}

                {publicReport.verdict ? (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Final verdict
                    </h3>
                    <div className="grid gap-3 rounded-md border border-primary/25 bg-primary/5 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={overallStatusBadge(publicReport.overallStatus).color}>
                          {publicReport.verdict.label}
                        </Badge>
                        <Badge variant="outline">
                          {publicReport.verdict.confidence} confidence
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {publicReport.verdict.evidenceCoverage.assessedCategories}/
                          {publicReport.verdict.evidenceCoverage.totalCategories} evidence areas assessed
                        </span>
                      </div>
                      <p className="text-sm leading-6">{publicReport.verdict.summary}</p>
                      <ul className="grid gap-2 text-sm text-muted-foreground">
                        {publicReport.verdict.reasons.slice(0, 4).map((reason) => (
                          <li key={reason} className="flex gap-2">
                            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                            <span>{sanitizePublicReportText(reason)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}

                {/* 1. Executive Summary */}
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">1. Executive Summary</h3>
                  <div className="rounded-md bg-secondary/30 p-4 text-sm leading-6">
                    {sanitizePublicReportText(publicExecutiveSummary)}
                  </div>
                </div>

                {/* 2. What This Project Does */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">2. What This Project Does</h3>
                  <div className="grid gap-3 sm:grid-cols-2 text-sm mb-4">
                    <div className="rounded-md border p-3 sm:col-span-2">
                      <p className="text-xs text-muted-foreground">Purpose Summary</p>
                      <p className="font-semibold mt-1">
                        {(() => {
                          const rawSummary =
                            snapshot?.projectPurpose?.summary ??
                            (isDataAvailable
                              ? snapshot?.repository?.description ?? "No detailed purpose summary available in repository metadata."
                              : "Unavailable");
                          return sanitizePublicReportText(rawSummary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
                        })()}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Primary Interface</p>
                      <p className="font-semibold mt-1">
                        {snapshot?.projectPurpose?.primaryInterface ?? (isDataAvailable ? "Unspecified interface" : "Unavailable")}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Development Stage</p>
                      <p className="font-semibold mt-1">
                        {snapshot?.projectPurpose?.developmentStage ?? (isDataAvailable ? "Active project" : "Unavailable")}
                      </p>
                    </div>
                    <div className="rounded-md border p-3 sm:col-span-2">
                      <p className="text-xs text-muted-foreground">Target Users</p>
                      <p className="font-semibold mt-1">
                        {snapshot?.projectPurpose?.targetUsers ?? (isDataAvailable ? "General developers & open-source community" : "Unavailable")}
                      </p>
                    </div>
                  </div>
                  {snapshot?.projectPurpose?.capabilities?.length ? (
                    <div className="rounded-md border bg-secondary/10 p-3 text-xs">
                      <p className="font-medium text-muted-foreground mb-2">Key Project Capabilities</p>
                      <div className="flex flex-wrap gap-2">
                        {snapshot.projectPurpose.capabilities.map((cap, i) => (
                          <Badge key={i} variant="secondary">
                            {cap}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* 3. Architecture & Technology */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">3. Architecture & Technology</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm mb-3">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Primary Language</p>
                      <p className="font-semibold mt-1">
                        {renderMetricDisplay(snapshot?.stack?.primaryLanguage, isDataAvailable)}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Default Branch</p>
                      <p className="font-semibold mt-1 font-mono">
                        {renderMetricDisplay(snapshot?.repository?.defaultBranch, isDataAvailable)}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Open Source License</p>
                      <p className="font-semibold mt-1">
                        {isDataAvailable
                          ? snapshot?.repository?.license?.name ?? "No license detected"
                          : "Unavailable"}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 text-xs mb-3">
                    {snapshot?.stack?.languages && Object.keys(snapshot.stack.languages).length > 0 ? (
                      <div className="rounded-md border p-3">
                        <p className="font-medium text-muted-foreground mb-2">Languages Breakdown</p>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(snapshot.stack.languages).slice(0, 6).map(([lang]) => (
                            <Badge key={lang} variant="secondary">
                              {lang}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ) : isDataAvailable ? (
                      <div className="rounded-md border p-3">
                        <p className="font-medium text-muted-foreground mb-1">Languages Breakdown</p>
                        <p className="text-muted-foreground">No language stats returned</p>
                      </div>
                    ) : null}

                    {snapshot?.dependencyProfile?.manifests?.length ? (
                      <div className="rounded-md border p-3">
                        <p className="font-medium text-muted-foreground mb-2">Dependency Manifests</p>
                        <div className="flex flex-wrap gap-2 font-mono">
                          {snapshot.dependencyProfile.manifests.map((m) => (
                            <Badge key={m} variant="outline">
                              {m}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ) : isDataAvailable ? (
                      <div className="rounded-md border p-3">
                        <p className="font-medium text-muted-foreground mb-1">Dependency Manifests</p>
                        <p className="text-muted-foreground">No dependency manifests detected</p>
                      </div>
                    ) : null}
                  </div>

                  {snapshot?.dependencyProfile?.detectedCapabilities?.length ? (
                    <div className="rounded-md border bg-secondary/10 p-3 text-xs mb-3">
                      <p className="font-medium text-muted-foreground mb-2">Detected Capabilities & Systems</p>
                      <div className="flex flex-wrap gap-2">
                        {snapshot.dependencyProfile.detectedCapabilities.map((cap) => (
                          <Badge key={cap} variant="default" className="font-medium">
                            {cap}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {snapshot?.repositoryStructure ? (
                    <div className="grid gap-3 sm:grid-cols-2 text-xs">
                      {snapshot.repositoryStructure.sourceDirectories?.length ? (
                        <div className="rounded-md border p-3">
                          <p className="font-medium text-muted-foreground mb-1">Source Directories</p>
                          <p className="font-mono text-muted-foreground">{snapshot.repositoryStructure.sourceDirectories.join(", ")}</p>
                        </div>
                      ) : null}
                      {snapshot.repositoryStructure.testDirectories?.length ? (
                        <div className="rounded-md border p-3">
                          <p className="font-medium text-muted-foreground mb-1">Test Directories</p>
                          <p className="font-mono text-muted-foreground">{snapshot.repositoryStructure.testDirectories.join(", ")}</p>
                        </div>
                      ) : null}
                      {snapshot.repositoryStructure.entrypoints?.length ? (
                        <div className="rounded-md border p-3">
                          <p className="font-medium text-muted-foreground mb-1">Entrypoints</p>
                          <p className="font-mono text-muted-foreground">{snapshot.repositoryStructure.entrypoints.join(", ")}</p>
                        </div>
                      ) : null}
                      {snapshot.repositoryStructure.dockerFiles?.length ? (
                        <div className="rounded-md border p-3">
                          <p className="font-medium text-muted-foreground mb-1">Containerization</p>
                          <p className="font-mono text-muted-foreground">{snapshot.repositoryStructure.dockerFiles.join(", ")}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {/* 4. Development Activity */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">4. Development Activity</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 text-sm">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Last Commit</p>
                      <p className="font-semibold mt-1">
                        {snapshot?.activity?.lastCommitAt
                          ? formatDate(snapshot.activity.lastCommitAt)
                          : isDataAvailable
                            ? "No commit record"
                            : "Unavailable"}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">30-Day Commits</p>
                      <p className="font-semibold mt-1 text-lg">
                        {renderCommitCountDisplay(snapshot?.activity?.commitCount30d, snapshot?.activity?.commitCount30dIsLowerBound, isDataAvailable)}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">90-Day Commits</p>
                      <p className="font-semibold mt-1 text-lg">
                        {renderCommitCountDisplay(snapshot?.activity?.commitCount90d, snapshot?.activity?.commitCount90dIsLowerBound, isDataAvailable)}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Sampled Human Contributors</p>
                      <p className="font-semibold mt-1 text-lg">
                        {renderMetricDisplay(snapshot?.contributors?.sampledHumanContributorCount ?? snapshot?.contributors?.sampledCount, isDataAvailable)}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Automation Accounts</p>
                      <p className="font-semibold mt-1 text-lg">
                        {renderMetricDisplay(snapshot?.contributors?.sampledBotContributorCount ?? 0, isDataAvailable)}
                      </p>
                    </div>
                  </div>
                  {snapshot?.contributors?.topContributors?.length ? (
                    <div className="mt-3 rounded-md border bg-secondary/10 p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <p className="font-medium text-muted-foreground">
                          Lifetime GitHub contribution totals
                        </p>
                        {(snapshot.contributors.botContributionShare ?? 0) >= 0.5 ? (
                          <Badge variant="secondary">
                            Automation-heavy contribution history
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {snapshot.contributors.topContributors.slice(0, 8).map((c) => (
                          <Badge key={c.login} variant="secondary" className="font-mono text-xs">
                            {c.login} ({c.contributions} commits){c.isBot ? " [bot]" : ""}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* 5. Engineering Quality */}
                {assessment ? (
                  <div className="border-t pt-6">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">5. Engineering Quality</h3>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {[
                        { key: "testing", title: "Testing & Test Suite", cat: assessment.categories.testing },
                        { key: "dependencyHygiene", title: "Dependency Hygiene", cat: assessment.categories.dependencyHygiene },
                        { key: "documentationDepth", title: "Documentation Depth", cat: assessment.categories.documentationDepth },
                        { key: "deploymentReadiness", title: "Deployment Readiness", cat: assessment.categories.deploymentReadiness },
                        { key: "operationalMaturity", title: "Operational Maturity", cat: assessment.categories.operationalMaturity },
                      ].map(({ key, title, cat }) => (
                        <div key={key} className="rounded-md border p-4 flex flex-col justify-between">
                          <div>
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b pb-3 mb-3">
                              <h4 className="font-semibold text-sm text-foreground">{title}</h4>
                              <div className="flex flex-wrap items-center gap-2">
                                {renderConfidenceBadge(cat?.confidence)}
                                <Badge variant="outline" className={categoryStatusBadge(cat?.status).color}>
                                  {categoryStatusBadge(cat?.status).label}
                                </Badge>
                              </div>
                            </div>
                            <p className="text-xs leading-5 text-muted-foreground">{cat?.summary ?? "Category evaluation pending"}</p>
                          </div>
                          {cat?.evidence?.length ? (
                            <div className="mt-3 border-t pt-2 text-[11px] text-muted-foreground/80 grid gap-1">
                              {cat.evidence.map((ev, i) => (
                                <span key={i}>• {ev}</span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* 6. Documentation & Governance */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">6. Documentation & Governance</h3>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                    {[
                      { label: "README Documentation", state: getEvidenceState(snapshot?.documentation?.hasReadme, isDataAvailable) },
                      { label: "Open Source License", state: getEvidenceState(snapshot?.documentation?.hasLicense, isDataAvailable) },
                      { label: "Security Policy (SECURITY.md)", state: getEvidenceState(snapshot?.documentation?.hasSecurityPolicy, isDataAvailable) },
                      { label: "Contributing Guide (CONTRIBUTING.md)", state: getEvidenceState(snapshot?.documentation?.hasContributing, isDataAvailable) },
                      { label: "Code of Conduct (CODE_OF_CONDUCT.md)", state: getEvidenceState(snapshot?.documentation?.hasCodeOfConduct, isDataAvailable) },
                      { label: "CODEOWNERS Governance", state: getEvidenceState(snapshot?.documentation?.hasCodeowners, isDataAvailable) },
                      { label: "Automated CI Workflows", state: getEvidenceState(snapshot?.stack?.hasWorkflows, isDataAvailable) },
                    ].map(({ label, state }) => (
                      <div key={label} className="flex items-center justify-between rounded-md border p-3">
                        <span>{label}</span>
                        {renderEvidenceBadge(state)}
                      </div>
                    ))}
                  </div>
                </div>

                {/* 7. Releases & Maintenance */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">7. Releases & Maintenance</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs mb-3">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Total Tagged Releases</p>
                      <p className="font-semibold mt-1 text-sm">
                        {renderMetricDisplay(snapshot?.releases?.totalCount, isDataAvailable)}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">90-Day Release Count</p>
                      <p className="font-semibold mt-1 text-sm">
                        {renderMetricDisplay(snapshot?.releases?.releaseCount90d, isDataAvailable)}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Latest Release Tag</p>
                      <p className="font-semibold mt-1 text-sm font-mono">
                        {snapshot?.releases?.latestRelease?.tagName ?? (isDataAvailable ? "No release tag" : "Unavailable")}
                      </p>
                    </div>
                  </div>
                  {assessment?.categories?.maintenance ? (
                    <div className="rounded-md border p-4 text-xs">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b pb-3 mb-3">
                        <h4 className="font-semibold text-sm text-foreground">Maintenance Status Assessment</h4>
                        <div className="flex flex-wrap items-center gap-2">
                          {renderConfidenceBadge(assessment.categories.maintenance.confidence)}
                          <Badge variant="outline" className={categoryStatusBadge(assessment.categories.maintenance.status).color}>
                            {categoryStatusBadge(assessment.categories.maintenance.status).label}
                          </Badge>
                        </div>
                      </div>
                      <p className="text-muted-foreground leading-5">{assessment.categories.maintenance.summary}</p>
                    </div>
                  ) : null}
                </div>

                {/* 8. Evidence-Backed Strengths */}
                {assessment ? (
                  <div className="border-t pt-6">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">8. Evidence-Backed Strengths</h3>
                    {assessment.strengths?.length ? (
                      <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-4 text-xs">
                        <ul className="grid gap-2 text-muted-foreground">
                          {assessment.strengths.map((s, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <Check className="size-4 text-emerald-500 shrink-0 mt-0.5" />
                              <span>{s}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No specific evidence-backed strengths highlighted for this repository state.</p>
                    )}
                  </div>
                ) : null}

                {/* 9. Risks & Review Items */}
                {assessment ? (
                  <div className="border-t pt-6">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">9. Risks & Review Items</h3>
                    {assessment.risks?.length ? (
                      <div className="grid gap-3 text-xs">
                        {assessment.risks.map((risk, i) => {
                          const badge = riskSeverityBadge(risk.severity);
                          return (
                            <div key={i} className={`rounded-md border p-4 ${badge.color}`}>
                              <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                                <p className="font-semibold text-sm">{risk.title}</p>
                                <Badge variant="outline" className="text-xs font-medium">
                                  {badge.label}
                                </Badge>
                              </div>
                              <p className="text-muted-foreground leading-5">{risk.description}</p>
                              <p className="mt-2 text-[11px] font-medium text-foreground/80">Impact: {risk.impact}</p>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No significant risk factors identified by deterministic rules.</p>
                    )}
                  </div>
                ) : null}

                {/* 10. Questions Before Adoption */}
                {assessment?.suggestedQuestions?.length ? (
                  <div className="border-t pt-6">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">10. Questions Before Adoption</h3>
                    <div className="rounded-md border p-4 text-xs">
                      <ul className="grid gap-2 text-muted-foreground">
                        {assessment.suggestedQuestions.map((q, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="font-semibold text-primary shrink-0">{i + 1}.</span>
                            <span>{q}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}

                {/* 11. Evidence & Data Freshness */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">11. Evidence & Data Freshness</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Data Provider</p>
                      <p className="font-semibold mt-1">
                        {snapshot?.source?.provider ?? (isDataAvailable ? "GitHub REST API v3" : "Unavailable")}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Cache Mode</p>
                      <p className="font-semibold mt-1">
                        {isDataAvailable
                          ? snapshot?.source?.cacheHit
                            ? `Cached (${snapshot.source.cacheAgeSeconds ?? 0}s ago)`
                            : "Live fetch"
                          : "Unavailable"}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Fetched At</p>
                      <p className="font-semibold mt-1">
                        {snapshot?.source?.fetchedAt
                          ? formatDate(snapshot.source.fetchedAt)
                          : isDataAvailable
                            ? "Recent"
                            : "Unavailable"}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Upstream Status</p>
                      <p className="font-semibold mt-1">
                        {isDataAvailable ? snapshot?.source?.upstreamStatus ?? "success" : "Unavailable"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 12. Limitations */}
                <div className="border-t pt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">12. Limitations</h3>
                  <div className="rounded-md border border-amber-400/20 bg-amber-400/5 p-4 text-xs leading-5 text-amber-200/90">
                    <p>{assessment?.limitationsDisclaimer || "This report analyzes public GitHub metadata. It is not a security audit or investment recommendation."}</p>
                    {assessment?.analyzedAt ? (
                      <p className="mt-2 text-[11px] text-muted-foreground">Analysis generated at {formatDate(assessment.analyzedAt)}.</p>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="rounded-lg">
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <CardTitle>{BRAND.name} Report</CardTitle>
                    {report ? (
                      <Badge variant={report.completedWithWarnings ? "secondary" : "default"}>
                        {report.completedWithWarnings ? "Completed with warnings" : "Completed"}
                      </Badge>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="grid gap-5">
                  {report ? (
                    <>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Generated by {BRAND.name}
                      </p>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Summary</p>
                        <p className="mt-2 leading-7">{sanitizePublicReportText(report.summary)}</p>
                      </div>
                      <div className="rounded-md bg-secondary/30 p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Input preview</p>
                        <p className="mt-2 text-sm">{sanitizePublicReportText(reportInput.preview)}</p>
                      </div>
                      {report.synthesis ? (
                        <div className="rounded-md border border-primary/20 bg-primary/5 p-4 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={report.synthesis.status === "ai_generated" ? "default" : "secondary"}>
                              {report.synthesis.status === "ai_generated" ? "AI-generated synthesis" : "Deterministic fallback"}
                            </Badge>
                            {report.synthesis.provider ? <Badge variant="outline">Provider · {report.synthesis.provider}</Badge> : null}
                            {report.synthesis.model ? <Badge variant="outline">Model · {report.synthesis.model}</Badge> : null}
                          </div>
                          {report.synthesis.status === "ai_generated" ? (
                            <>
                              <p className="mt-3 text-xs text-muted-foreground">
                                Summary and findings synthesized after execution completed.
                              </p>
                              <div className="mt-3">
                                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Paid API responses used</p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {report.synthesis.usedPaidApiResponses.map((service) => (
                                    <Badge key={service.serviceSlug} variant="secondary">
                                      {service.serviceName}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            </>
                          ) : (
                            <p className="mt-3 text-xs text-muted-foreground">
                              {fallbackReasonLabel(report.synthesis.fallbackReason)}. Successful paid API results, receipts, and Arc proofs were preserved.
                            </p>
                          )}
                        </div>
                      ) : null}
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Key findings</p>
                        <ul className="mt-2 grid gap-2 text-sm">
                          {report.keyFindings.map((finding, index) => (
                            <li key={`${index}-${finding}`} className="rounded-md bg-secondary/30 p-3">
                              {sanitizePublicReportText(finding)}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Selected services</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {report.selectedServices.map((service) => (
                              <Badge key={service.slug}>{service.name}</Badge>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Skipped services</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {report.skippedServices.length ? (
                              report.skippedServices.map((service) => (
                                <Badge key={service.slug} variant="outline">{service.name}</Badge>
                              ))
                            ) : (
                              <span className="text-sm text-muted-foreground">None in the allowlisted plan.</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 pt-2">
                        {report.links.agentRun ? (
                          <Button asChild variant="outline">
                            <Link href={report.links.agentRun}>Agent Run</Link>
                          </Button>
                        ) : null}
                        <Button asChild variant="outline">
                          <Link href={report.links.receipts}>Commerce Receipts</Link>
                        </Button>
                        {report.links.passport ? (
                          <Button asChild variant="outline">
                            <Link href={report.links.passport}>Agent Passport</Link>
                          </Button>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <LoaderCircle className="size-4 animate-spin" />
                      The Final Report appears after execution completes.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-lg">
                <CardHeader>
                  <CardTitle>Services purchased</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {view.services
                    .filter((service) => service.status === "paid" || service.status === "failed")
                    .map((service) => (
                      <div key={service.serviceSlug} className="min-w-0 rounded-md border p-4">
                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium">{service.serviceName}</p>
                            <div className="mt-2">
                              <ServicePresentation metadata={service.presentation} />
                            </div>
                          </div>
                          <Badge variant={service.status === "paid" ? "default" : "destructive"}>
                            {service.status === "paid" ? `${service.priceUsdc} USDC` : "failed"}
                          </Badge>
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">{service.reasoning}</p>
                        {service.presentation.providerType === "live_provider" ? (
                          <div className="mt-3">
                            <ProviderResponseDetails value={service.response} />
                          </div>
                        ) : service.response ? (
                          <pre className="mt-3 max-h-52 max-w-full overflow-auto rounded-md bg-secondary/40 p-3 text-xs">
                            {prettyJson(service.response)}
                          </pre>
                        ) : null}
                        {service.error ? (
                          <p className="mt-2 break-words text-sm text-destructive">{service.error}</p>
                        ) : null}
                        {service.receiptId ? (
                          <Button asChild size="sm" variant="outline" className="mt-3">
                            <Link href={`/receipts/${service.receiptId}`}>
                              <ReceiptText className="size-4" />
                              Receipt
                            </Link>
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  {!view.services.some((service) => service.status === "paid" || service.status === "failed") ? (
                    <p className="text-sm text-muted-foreground">Purchases have not started yet.</p>
                  ) : null}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-12 sm:px-6">
        {!isProject360Workflow ? <details className="mt-6 rounded-md border p-4" id="technical-details">
          <summary className="cursor-pointer font-semibold text-sm text-muted-foreground hover:text-foreground">
            Payment & verification details
          </summary>
          <div className="mt-4 grid gap-6">
            {view.userPayment ? (
              <Card className="rounded-lg">
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <CreditCard className="size-4 text-primary" />
                      Workflow Checkout & Payment
                    </CardTitle>
                    <Badge variant={view.userPayment.status === "credit_issued" ? "secondary" : "default"}>
                      {view.userPayment.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-4 text-sm">
                  <div className={`grid gap-3 sm:grid-cols-2 ${isSellerWorkflow ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
                    <div>
                      <p className="text-xs text-muted-foreground">User payment</p>
                      <p className="font-mono font-medium">{view.userPayment.grossAmountUsdc} USDC</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Provider cost</p>
                      <p className="font-mono font-medium">{view.userPayment.providerCostUsdc} USDC</p>
                    </div>
                    {isSellerWorkflow ? (
                      <div>
                        <p className="text-xs text-muted-foreground">Service version</p>
                        <p className="font-mono font-medium">v{String((report?.workflowData as any)?.serviceVersion ?? "n/a")}</p>
                      </div>
                    ) : (
                      <>
                        <div>
                          <p className="text-xs text-muted-foreground">Quoted platform fee</p>
                          <p className="font-mono font-medium">{view.userPayment.platformFeeUsdc} USDC</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Net revenue</p>
                          <p className="font-mono font-medium">{view.userPayment.netRevenueUsdc} USDC</p>
                        </div>
                      </>
                    )}
                  </div>
                  {Number(view.userPayment.creditAmountUsdc) > 0 ? (
                    <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3">
                      <p className="font-medium">Credit issued · {view.userPayment.creditAmountUsdc} USDC</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {view.userPayment.failureReason ?? "The paid workflow could not complete."}
                      </p>
                    </div>
                  ) : null}
                  {view.userPayment.transactionHash ? (
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">User checkout transaction</p>
                      <p className="break-all font-mono text-xs">{view.userPayment.transactionHash}</p>
                      {view.userPayment.transactionUrl ? (
                        <Button asChild size="sm" variant="outline" className="mt-2">
                          <a href={view.userPayment.transactionUrl} target="_blank" rel="noreferrer">
                            User payment on Arc <ExternalLink className="size-3" />
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Sponsored checkout · no user USDC transaction.</p>
                  )}
                  <Button asChild variant="outline" size="sm" className="w-fit">
                    <Link href={view.links.workflowReceipt}>
                      <ReceiptText className="size-4" />
                      Workflow Receipt
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="text-base">Identity & Wallets</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-xs">
                <div>
                  <p className="font-medium">{HOSTED_REQUESTER_IDENTITY_LABEL}</p>
                  <p className={view.job.requesterWallet ? "mt-1 break-all font-mono" : "mt-1 text-muted-foreground"}>
                    {hostedRequesterDisplayLine(view.job.requesterWallet)}
                  </p>
                  {view.userPayment?.paymentMode === "paid" ? (
                    <p className="mt-1 text-muted-foreground">Paid user-facing workflow price.</p>
                  ) : (
                    <p className="mt-1 text-muted-foreground">{HOSTED_REQUESTER_NOT_CHARGED_COPY}</p>
                  )}
                </div>
                <div className="border-t pt-2">
                  <p className="text-muted-foreground">
                    Internal x402 payer wallet: <span className="font-mono">{view.payerWallet ?? "Pending"}</span>
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="text-base">Arc Proof Details</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {view.proofs.map((proof) => (
                  <div key={proof.receiptId} className="rounded-md border p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {proof.status === "verified" ? (
                          <BadgeCheck className="size-4 text-primary" />
                        ) : proof.status === "pending" ? (
                          <LoaderCircle className="size-4 animate-spin text-primary" />
                        ) : (
                          <Circle className="size-4 text-destructive" />
                        )}
                        <span className="font-medium">
                          {proof.status === "verified" ? "Verified on Arc" : proof.status === "failed" ? "Proof failed" : "Onchain proof pending"}
                        </span>
                      </div>
                      <Badge variant="outline">receipt {shortenHash(proof.receiptId, 6)}</Badge>
                    </div>
                    {proof.transactionHash ? <p className="mt-2 break-all font-mono">{proof.transactionHash}</p> : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {proof.transactionUrl ? (
                        <Button asChild size="sm" variant="outline">
                          <a href={proof.transactionUrl} target="_blank" rel="noreferrer">
                            Proof transaction <ExternalLink className="size-3" />
                          </a>
                        </Button>
                      ) : null}
                      {proof.contractUrl ? (
                        <Button asChild size="sm" variant="outline">
                          <a href={proof.contractUrl} target="_blank" rel="noreferrer">
                            Registry contract <ExternalLink className="size-3" />
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!view.proofs.length ? <p className="text-xs text-muted-foreground">Proof metadata appears after settlement creates a receipt.</p> : null}
              </CardContent>
            </Card>

            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="text-base">Raw Execution & Planner Snapshot</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-xs">
                <div className="grid gap-1 font-mono">
                  <p>Job ID: {view.job.id}</p>
                  <p>Input SHA-256: {reportInput.sha256}</p>
                  <p>Budget: {view.job.budgetUsdc} USDC | Spent: {view.job.spentUsdc} USDC</p>
                  <p>Internal Progress Stage: {view.job.progressStage}</p>
                </div>
                {view.job.plannerSnapshot.marketSymbol ? (
                  <Badge variant="outline" className="w-fit">Selected asset · {view.job.plannerSnapshot.marketSymbol}</Badge>
                ) : null}
                <div className="grid gap-2 border-t pt-2">
                  <p className="font-medium text-muted-foreground">Planner Service Selections:</p>
                  {view.job.plannerSnapshot.selectedServices?.map((service) => (
                    <div key={service.slug} className="rounded-md border p-2">
                      <div className="flex justify-between font-mono">
                        <span>{service.name}</span>
                        <span>{service.priceUsdc.toFixed(4)} USDC</span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{service.reasoning}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </details> : null}
      </section>
    </main>
  );
}
