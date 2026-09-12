/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server.js";
import { authenticateMachineRequest } from "../../../../../../lib/api/machine-auth.ts";
import { createMachineErrorResponse } from "../../../../../../lib/api/machine-errors.ts";
import {
  getHostedAgentJob,
  getHostedAgentJobView,
  type HostedAgentJobRow,
} from "../../../../../../lib/agent/hosted-jobs.ts";
import {
  buildGitHubPublicReport,
  formatGitHubPublicReportAsMarkdown,
  type HostedWorkflowArcProofItem,
  type HostedWorkflowReceiptItem,
} from "../../../../../../lib/reports/github-public-report.ts";
import { isSellerWorkflowType } from "../../../../../../lib/seller/marketplace.ts";
import { formatAgentTrustReportAsMarkdown } from "../../../../../../lib/agent-trust/markdown.ts";
import type { AgentTrustReport } from "../../../../../../lib/agent-trust/types.ts";
import {
  buildApiQualityPublicReport,
  formatApiQualityPublicReportAsMarkdown,
  parseApiQualityJobInput,
} from "../../../../../../lib/reports/api-quality-report.ts";
import { fetchApiQualityObservationsForServices } from "../../../../../../lib/providers/api-quality.ts";
import {
  formatProject360ReportAsMarkdown,
} from "../../../../../../lib/project-360/report.ts";
import type { Project360Report } from "../../../../../../lib/project-360/types.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ reportId: string }> };

function buildReportFromJob(
  job: HostedAgentJobRow,
  jobView: Awaited<ReturnType<typeof getHostedAgentJobView>>,
) {
  const structuredResult = job.structured_result as any;
  const workflowData = structuredResult?.workflowData || {};
  const snapshot = workflowData.snapshot || null;
  const assessment = workflowData.assessment || null;
  const plannerRepo = (job.planner_snapshot as any)?.repository;

  const repoRef =
    workflowData.repository ||
    plannerRepo ||
    structuredResult?.repository ||
    job.planner_snapshot?.repository;

  const repository = repoRef
    ? {
        fullName: repoRef.fullName || String(job.input_preview || "repository"),
        canonicalUrl:
          repoRef.canonicalUrl ||
          `https://github.com/${repoRef.fullName || job.input_preview}`,
      }
    : job.input_preview
    ? {
        fullName: job.input_preview,
        canonicalUrl: job.input_preview.startsWith("http")
          ? job.input_preview
          : `https://github.com/${job.input_preview}`,
      }
    : null;

  const mappedStatus =
    job.status === "completed"
      ? structuredResult?.completedWithWarnings
        ? "completed_with_warnings"
        : "completed"
      : job.status;

  const proofs: HostedWorkflowArcProofItem[] = (jobView?.proofs || []).map(
    (proof) => ({
      receiptId: proof.receiptId,
      txHash: proof.transactionHash || null,
      status: proof.status,
      explorerUrl:
        proof.transactionUrl ||
        (proof.transactionHash
          ? `https://testnet.arcscan.app/tx/${proof.transactionHash}`
          : null),
      blockNumber: proof.blockNumber,
      contractAddress: proof.contractAddress,
    }),
  );

  const receipts: HostedWorkflowReceiptItem[] = (jobView?.services || []).map((s) => ({
    receiptId: s.receiptId || s.serviceSlug,
    serviceSlug: s.serviceSlug,
    serviceName: s.serviceName,
    priceUsdc: s.priceUsdc,
    status: s.status,
  }));

  const generatedAt =
    job.completed_at ||
    structuredResult?.generatedAt ||
    job.updated_at ||
    job.created_at ||
    new Date().toISOString();

  return buildGitHubPublicReport({
    jobId: job.id,
    workflow: job.workflow_type,
    status: mappedStatus,
    repository,
    snapshot,
    assessment,
    proofs,
    receipts,
    generatedAt,
  });
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateMachineRequest(request, "results:read");
  if (!authResult.ok) {
    return authResult.response;
  }
  const { context } = authResult;

  const { reportId } = await params;
  if (!reportId || typeof reportId !== "string" || !reportId.trim()) {
    return createMachineErrorResponse(
      "report_not_found",
      "The requested report was not found.",
      404,
    );
  }

  let job: HostedAgentJobRow | null = null;
  let jobView: Awaited<ReturnType<typeof getHostedAgentJobView>> = null;
  try {
    job = await getHostedAgentJob(reportId.trim());
    if (job) {
      jobView = await getHostedAgentJobView(reportId.trim());
    }
  } catch (err) {
    console.error("[reports/[reportId]/route] Job query error:", err);
    return createMachineErrorResponse(
      "report_not_found",
      "The requested report was not found.",
      404,
    );
  }

  if (!job) {
    return createMachineErrorResponse(
      "report_not_found",
      "The requested report was not found.",
      404,
    );
  }

  // Enforce strict Veyra Agent API credential ownership.
  const isOwner =
    job.byoa_agent_id === context.agentId &&
    job.machine_credential_id === context.credential.id;

  if (!isOwner) {
    return createMachineErrorResponse(
      "report_not_found",
      "The requested report was not found.",
      404,
    );
  }

  // Check completion: Return 400 report_not_ready if job is still in progress
  if (job.status !== "completed" && job.status !== "failed") {
    return createMachineErrorResponse(
      "report_not_ready",
      "Report execution is not ready yet.",
      400,
    );
  }

  if (job.workflow_type === "agent_trust_report") {
    const reconciledStructured = jobView?.job.structuredResult as
      | {
          workflowData?: {
            kind?: string;
            report?: AgentTrustReport;
          } | null;
        }
      | null
      | undefined;
    const storedStructured = job.structured_result as
      | {
          workflowData?: {
            kind?: string;
            report?: AgentTrustReport;
          } | null;
        }
      | null;
    const trustReport =
      reconciledStructured?.workflowData?.report ??
      storedStructured?.workflowData?.report ??
      null;
    if (!trustReport) {
      return createMachineErrorResponse(
        job.status === "failed" ? "report_generation_failed" : "report_not_ready",
        job.status === "failed"
          ? "Agent Trust Report generation failed safely."
          : "Agent Trust Report is not ready yet.",
        job.status === "failed" ? 422 : 400,
      );
    }
    const accept = request.headers.get("accept") ?? "";
    if (accept.toLowerCase().includes("text/markdown")) {
      return new NextResponse(formatAgentTrustReportAsMarkdown(trustReport), {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(trustReport, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (job.workflow_type === "project_360") {
    const reconciledStructured = jobView?.job.structuredResult as
      | { workflowData?: { kind?: string; report?: Project360Report } | null }
      | null
      | undefined;
    const storedStructured = job.structured_result as
      | { workflowData?: { kind?: string; report?: Project360Report } | null }
      | null;
    const projectReport =
      reconciledStructured?.workflowData?.report ??
      storedStructured?.workflowData?.report ??
      null;
    if (!projectReport || projectReport.schema !== "veyra.project360.v1") {
      return createMachineErrorResponse(
        job.status === "failed" ? "report_generation_failed" : "report_not_ready",
        job.status === "failed"
          ? "Project 360 report generation failed safely."
          : "Project 360 report is not ready yet.",
        job.status === "failed" ? 422 : 400,
      );
    }
    const accept = request.headers.get("accept") ?? "";
    if (accept.toLowerCase().includes("text/markdown")) {
      return new NextResponse(formatProject360ReportAsMarkdown(projectReport), {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(projectReport, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (job.workflow_type === "paid_api_quality") {
    const structuredResult = job.structured_result as any;
    const workflowData = structuredResult?.workflowData || {};
    const inputPreview = String(job.input_preview || "");

    const { targetServices, observationWindowDays } = parseApiQualityJobInput(
      inputPreview,
      job.planner_snapshot,
      structuredResult,
    );

    let obsMap = await fetchApiQualityObservationsForServices(
      targetServices,
      observationWindowDays,
    );

    if (
      Object.values(obsMap).every((list) => list.length === 0) &&
      workflowData?.observationsByService
    ) {
      obsMap = workflowData.observationsByService;
    } else if (
      Object.values(obsMap).every((list) => list.length === 0) &&
      Array.isArray(workflowData?.observations)
    ) {
      for (const id of targetServices) {
        obsMap[id] = workflowData.observations;
      }
    }

    const mappedStatus =
      job.status === "completed"
        ? structuredResult?.completedWithWarnings
          ? "completed_with_warnings"
          : "completed"
        : job.status;

    const proofs: HostedWorkflowArcProofItem[] = (jobView?.proofs || []).map(
      (proof) => ({
        receiptId: proof.receiptId,
        txHash: proof.transactionHash || null,
        status: proof.status,
        explorerUrl:
          proof.transactionUrl ||
          (proof.transactionHash
            ? `https://testnet.arcscan.app/tx/${proof.transactionHash}`
            : null),
        blockNumber: proof.blockNumber,
        contractAddress: proof.contractAddress,
      }),
    );

    const receipts: HostedWorkflowReceiptItem[] = (jobView?.services || []).map(
      (s) => ({
        receiptId: s.receiptId || s.serviceSlug,
        serviceSlug: s.serviceSlug,
        serviceName: s.serviceName,
        priceUsdc: s.priceUsdc,
        status: s.status,
      }),
    );

    const generatedAt =
      job.completed_at ||
      structuredResult?.generatedAt ||
      job.updated_at ||
      job.created_at ||
      new Date().toISOString();

    const report = buildApiQualityPublicReport({
      jobId: job.id,
      workflow: job.workflow_type,
      status: mappedStatus,
      targetServices,
      observationWindowDays,
      observationsByService: obsMap,
      proofs,
      receipts,
      generatedAt,
    });

    const acceptHeader =
      request.headers.get("accept") || request.headers.get("Accept") || "";
    const wantsMarkdown = acceptHeader.toLowerCase().includes("text/markdown");

    if (wantsMarkdown) {
      const markdown = formatApiQualityPublicReportAsMarkdown(report);
      return new NextResponse(markdown, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(report, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  if (isSellerWorkflowType(job.workflow_type)) {
    const structured = job.structured_result as any;
    const workflowData = structured?.workflowData ?? {};
    const sellerReport = {
      reportId: job.id,
      workflowType: job.workflow_type,
      workflowName: (job.planner_snapshot as any)?.workflowLabel ?? "External Seller Workflow",
      status: job.status,
      providerType: "external_seller",
      service: {
        serviceId: workflowData.serviceId ?? null,
        serviceVersion: workflowData.serviceVersion ?? null,
      },
      result: job.status === "completed" ? workflowData.result ?? null : null,
      summary: structured?.summary ?? (job.status === "failed" ? "External seller execution failed safely." : null),
      input: { preview: job.input_preview, sha256: job.input_hash },
      generatedAt: structured?.generatedAt ?? job.completed_at ?? job.updated_at,
      receipts: (jobView?.services ?? []).flatMap((service) => service.receiptId ? [{
        receiptId: service.receiptId,
        serviceId: workflowData.serviceId ?? null,
        serviceVersion: workflowData.serviceVersion ?? null,
        status: service.status,
      }] : []),
      arcProofs: (jobView?.proofs ?? []).map((proof) => ({
        receiptId: proof.receiptId,
        status: proof.status,
        transactionHash: proof.transactionHash,
        explorerUrl: proof.transactionUrl,
      })),
      payment: jobView?.userPayment ? {
        mode: jobView.userPayment.paymentMode,
        status: jobView.userPayment.status,
        transactionHash: jobView.userPayment.transactionHash,
        transactionUrl: jobView.userPayment.transactionUrl,
        settledAt: jobView.userPayment.settledAt,
      } : null,
    };
    const accept = request.headers.get("accept") ?? "";
    if (accept.toLowerCase().includes("text/markdown")) {
      return new NextResponse([
        `# ${sellerReport.workflowName}`,
        "",
        `Status: ${sellerReport.status}`,
        `Provider: External Service`,
        `Service version: ${sellerReport.service.serviceVersion ?? "n/a"}`,
        "",
        "## Result",
        "",
        "```json",
        JSON.stringify(sellerReport.result, null, 2),
        "```",
      ].join("\n"), {
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json(sellerReport, { headers: { "Cache-Control": "no-store" } });
  }

  if (job.workflow_type !== "github_due_diligence") {
    const structured = job.structured_result as any;
    const proofs = (jobView?.proofs ?? []).map((proof) => ({
      receiptId: proof.receiptId,
      txHash: proof.transactionHash,
      status: proof.status,
      explorerUrl: proof.transactionUrl,
    }));
    const receipts = (jobView?.services ?? []).flatMap((service) =>
      service.receiptId
        ? [{
            receiptId: service.receiptId,
            serviceSlug: service.serviceSlug,
            serviceName: service.serviceName,
            priceUsdc: service.priceUsdc,
            status: service.status,
          }]
        : [],
    );
    const verifiedSteps = proofs.filter(
      (proof) => proof.status === "verified" && Boolean(proof.txHash),
    ).length;
    const requiredSteps = receipts.length || Math.max(proofs.length, 1);
    const hasFailedProof = proofs.some((proof) => proof.status === "failed");
    const verificationStatus = hasFailedProof
      ? "verification_failed"
      : verifiedSteps >= requiredSteps
        ? "verified"
        : verifiedSteps > 0
          ? "partially_verified"
          : "verification_pending";
    const genericReport = {
      reportId: job.id,
      workflow: job.workflow_type,
      workflowName:
        (job.planner_snapshot as any)?.workflowLabel ?? job.workflow_type,
      status:
        job.status === "completed" && structured?.completedWithWarnings
          ? "completed_with_warnings"
          : job.status,
      summary:
        structured?.summary ??
        (job.status === "failed"
          ? "Workflow execution failed safely."
          : "Workflow report completed."),
      keyFindings: Array.isArray(structured?.keyFindings)
        ? structured.keyFindings
        : [],
      input: {
        preview: job.input_preview,
        sha256: job.input_hash,
      },
      result: structured?.workflowData ?? null,
      services: Array.isArray(structured?.apiResults)
        ? structured.apiResults.map((result: any) => ({
            serviceSlug: result.serviceSlug,
            serviceName: result.serviceName,
            status: result.status,
            amountUsdc: result.amountUsdc,
            response: result.response,
            error: result.error,
          }))
        : [],
      spentUsdc: job.spent_usdc,
      receipts,
      verification: {
        status: verificationStatus,
        network: "arc-testnet" as const,
        proofs,
        verifiedSteps,
        requiredSteps,
      },
      generatedAt:
        structured?.generatedAt ??
        job.completed_at ??
        job.updated_at ??
        job.created_at,
    };
    const accept = request.headers.get("accept") ?? "";
    if (accept.toLowerCase().includes("text/markdown")) {
      const findings = genericReport.keyFindings.length
        ? genericReport.keyFindings.map((finding: string) => `- ${finding}`).join("\n")
        : "- No additional findings.";
      const proofLines = proofs.length
        ? proofs
            .map((proof) =>
              `- ${proof.txHash ? `\`${proof.txHash}\`` : `Receipt \`${proof.receiptId}\``} (${proof.status})${proof.explorerUrl ? ` — [Arcscan](${proof.explorerUrl})` : ""}`,
            )
            .join("\n")
        : "- No Arc proof metadata recorded.";
      return new NextResponse(
        [
          `# ${genericReport.workflowName}`,
          "",
          `**Report ID:** \`${genericReport.reportId}\`  `,
          `**Status:** \`${genericReport.status}\`  `,
          `**Generated At:** ${genericReport.generatedAt}`,
          "",
          "## Summary",
          genericReport.summary,
          "",
          "## Key Findings",
          findings,
          "",
          "## Arc Verification",
          `Status: \`${genericReport.verification.status}\``,
          "",
          proofLines,
          "",
        ].join("\n"),
        {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
    }
    return NextResponse.json(genericReport, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const report = buildReportFromJob(job, jobView);

  // Content negotiation (Accept header)
  const acceptHeader =
    request.headers.get("accept") || request.headers.get("Accept") || "";
  const wantsMarkdown = acceptHeader.toLowerCase().includes("text/markdown");

  if (wantsMarkdown) {
    const markdown = formatGitHubPublicReportAsMarkdown(report);
    return new NextResponse(markdown, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json(report, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
