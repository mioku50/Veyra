/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import type { Hex } from "viem";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { getExecutionAttempt, updateExecutionAttemptState } from "@/lib/execution/db";
import { confirmClientTransaction, readJob } from "@/lib/erc8183/client-transactions";
import type { ExecutionState } from "@/lib/execution/types";

export const dynamic = "force-dynamic";

/**
 * Records a step the buyer's wallet actually sent.
 *
 * The transaction hash is not trusted: the receipt is read from Arc, a revert
 * is recorded as a failure, and the job id for a creation comes out of the
 * emitted event rather than from anything the browser claimed. A client that
 * lies about what it sent moves the ledger nowhere.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateSelectionRequest(request, "runs:create");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: { code: "invalid_body" } }, { status: 400 });
  }

  const executionId = typeof body.executionId === "string" ? body.executionId.trim() : "";
  const step = typeof body.step === "string" ? body.step : "";
  const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";

  if (!executionId || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "executionId and a 32-byte txHash are required." } },
      { status: 400 },
    );
  }

  const attempt = await getExecutionAttempt(executionId);
  if (!attempt) {
    return NextResponse.json(
      { error: { code: "execution_not_found", message: "No such prepared execution." } },
      { status: 404 },
    );
  }

  const receipt = await confirmClientTransaction(txHash as Hex);
  if (!receipt.ok) {
    if (receipt.reverted) {
      await updateExecutionAttemptState(executionId, "FAILED", {
        failureCode: `erc8183_${step || "step"}_reverted`,
      }).catch(() => undefined);
      return NextResponse.json({
        confirmed: false,
        reverted: true,
        message: "That transaction reverted on Arc. Nothing advanced.",
      }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({
      confirmed: false,
      reverted: false,
      message: "The transaction has not confirmed on Arc yet. Try again in a moment.",
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  /* Where the lifecycle stands after this step. Creating a job authorizes
     nothing and moves nothing, so it is still EXECUTING; a funded escrow is
     genuinely waiting on the provider, which the state machine has a name for. */
  let nextState: ExecutionState | null = null;
  const patch: Record<string, unknown> = {};

  if (step === "create_job") {
    if (!receipt.jobId) {
      return NextResponse.json({
        confirmed: true,
        message: "The transaction confirmed but emitted no JobCreated event, so no job id could be read.",
      }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    nextState = attempt.state === "PREPARED" || attempt.state === "AUTHORIZED" ? "EXECUTING" : null;
    patch.createTx = txHash;
    patch.externalReference = receipt.jobId;
  } else if (step === "fund_escrow") {
    nextState = "WAITING_FOR_PROVIDER";
    patch.paymentTx = txHash;
  } else if (step === "approve_usdc") {
    // An allowance is not part of the job's lifecycle; it is recorded by the
    // fund step that uses it.
    nextState = null;
  }

  if (nextState) {
    try {
      await updateExecutionAttemptState(executionId, nextState, patch as never);
    } catch (error) {
      console.warn("erc8183_step_not_recorded", {
        executionId,
        step,
        errorName: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  const job = receipt.jobId ? await readJob(receipt.jobId) : null;

  return NextResponse.json({
    confirmed: true,
    executionId,
    step,
    txHash,
    jobId: receipt.jobId,
    job,
    state: nextState ?? attempt.state,
  }, { headers: { "Cache-Control": "no-store" } });
}
