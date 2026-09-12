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

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ runId: string }> };

function mapMachineStatus(job: HostedAgentJobRow): {
  status: string;
  progress: number;
  pollAfterMs: number;
} {
  if (job.status === "queued") {
    return { status: "queued", progress: 0.1, pollAfterMs: 2000 };
  }
  if (job.status === "running") {
    let progress = 0.5;
    const stage = job.progress_stage as string;
    if (stage === "planning") progress = 0.25;
    else if (stage === "purchasing") progress = 0.6;
    else if (stage === "generating_receipt" || stage === "publishing_onchain_proof") progress = 0.85;
    return { status: "running", progress, pollAfterMs: 2000 };
  }
  if (job.status === "failed") {
    return { status: "failed", progress: 1.0, pollAfterMs: 0 };
  }
  if (job.status === "completed") {
    const isWarnings = Boolean(job.structured_result?.completedWithWarnings);
    if (isWarnings) {
      return { status: "completed_with_warnings", progress: 1.0, pollAfterMs: 0 };
    }
    return { status: "completed", progress: 1.0, pollAfterMs: 0 };
  }
  return { status: job.status, progress: 1.0, pollAfterMs: 0 };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateMachineRequest(request, "results:read");
  if (!authResult.ok) {
    return authResult.response;
  }
  const { context } = authResult;

  const { runId } = await params;
  if (!runId || typeof runId !== "string" || !runId.trim()) {
    return createMachineErrorResponse(
      "run_not_found",
      "The requested run was not found.",
      404,
    );
  }

  let job: HostedAgentJobRow | null = null;
  try {
    job = await getHostedAgentJob(runId.trim());
  } catch (err) {
    console.error("[runs/[runId]/route] Job query error:", err);
    return createMachineErrorResponse(
      "run_not_found",
      "The requested run was not found.",
      404,
    );
  }

  if (!job) {
    return createMachineErrorResponse(
      "run_not_found",
      "The requested run was not found.",
      404,
    );
  }

  // Enforce strict Veyra Agent API credential ownership.
  const isOwner =
    job.byoa_agent_id === context.agentId &&
    job.machine_credential_id === context.credential.id;

  if (!isOwner) {
    return createMachineErrorResponse(
      "run_not_found",
      "The requested run was not found.",
      404,
    );
  }

  const mapped = mapMachineStatus(job);

  const selectedCount =
    Array.isArray(job.selected_services) && job.selected_services.length > 0
      ? job.selected_services.length
      : Array.isArray(job.receipt_ids) && job.receipt_ids.length > 0
      ? job.receipt_ids.length
      : 1;

  let proofRecords: Array<{ status: string; transactionHash?: string | null }> = [];
  let hasFailedProof = false;

  try {
    const view = await getHostedAgentJobView(job.id);
    if (view && Array.isArray(view.proofs)) {
      proofRecords = view.proofs;
      hasFailedProof = view.proofs.some((p) => p.status === "failed");
    }
  } catch {
    // A proof-view failure must never be upgraded from denormalized hashes.
  }

  const verifiedSteps = proofRecords.filter(
    (proof) =>
      proof.status === "verified" &&
      Boolean(proof.transactionHash?.trim()),
  ).length;

  let verificationStatus:
    | "verified"
    | "partially_verified"
    | "verification_pending"
    | "verification_failed";

  if (hasFailedProof || (job.status === "failed" && verifiedSteps === 0)) {
    verificationStatus = "verification_failed";
  } else if (verifiedSteps > 0 && verifiedSteps >= selectedCount) {
    verificationStatus = "verified";
  } else if (verifiedSteps > 0 && verifiedSteps < selectedCount) {
    verificationStatus = "partially_verified";
  } else {
    verificationStatus = "verification_pending";
  }

  const response: Record<string, unknown> = {
    runId: job.id,
    status: mapped.status,
    progress: mapped.progress,
    stage: job.progress_stage || job.status,
    pollAfterMs: mapped.pollAfterMs,
  };

  if (job.status === "completed" || job.status === "failed") {
    response.reportId = job.id;
    response.verification = {
      status: verificationStatus,
      verifiedSteps,
      requiredSteps: selectedCount,
    };
  }

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
