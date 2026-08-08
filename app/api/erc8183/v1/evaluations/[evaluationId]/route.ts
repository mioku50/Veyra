/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { authenticateMachineRequest } from "@/lib/api/machine-auth";
import { createMachineErrorResponse } from "@/lib/api/machine-errors";
import { getByoaClient } from "@/lib/byoa/service";
import type { Erc8183EvaluationRecord } from "@/lib/erc8183/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ evaluationId: string }> },
) {
  const { evaluationId } = await params;

  if (!evaluationId || !evaluationId.trim()) {
    return createMachineErrorResponse("invalid_request", "Evaluation ID is required.", 400);
  }

  const supabase = getByoaClient();
  const { data: record, error } = await supabase
    .from("erc8183_evaluations")
    .select("*")
    .eq("public_id", evaluationId.trim())
    .maybeSingle();

  if (error) {
    return createMachineErrorResponse("internal_error", "Failed to query evaluation record.", 500);
  }

  if (!record) {
    return createMachineErrorResponse("evaluation_not_found", `Evaluation '${evaluationId}' not found.`, 404);
  }

  const evaluation = record as Erc8183EvaluationRecord;

  // Check auth for non-public/pending evaluations
  if (evaluation.status !== "completed" && evaluation.status !== "rejected") {
    const authResult = await authenticateMachineRequest(req, "results:read");
    if (!authResult.ok) {
      return authResult.response;
    }
  }

  // Sanitized view model (no private keys, internal tokens or authorization headers)
  const responseData = {
    evaluationId: evaluation.public_id,
    chainId: evaluation.chain_id,
    agenticCommerce: evaluation.agentic_commerce,
    jobId: evaluation.job_id,
    evaluatorContract: evaluation.evaluator_contract,
    status: evaluation.status,
    decision: evaluation.decision,
    deliverableHash: evaluation.deliverable_hash,
    contentHash: evaluation.content_hash,
    contentUri: evaluation.content_uri,
    policyId: evaluation.policy_id,
    policyHash: evaluation.policy_hash,
    reportHash: evaluation.report_hash,
    settlementTxHash: evaluation.settlement_tx_hash,
    canonicalReport: evaluation.canonical_report,
    createdAt: evaluation.created_at,
    evaluatedAt: evaluation.evaluated_at,
    settledAt: evaluation.settled_at,
  };

  return NextResponse.json(responseData, { status: 200 });
}
