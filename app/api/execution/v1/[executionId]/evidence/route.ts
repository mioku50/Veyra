/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { getExecutionAttempt } from "@/lib/execution/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ executionId: string }> }
) {
  try {
    const { executionId } = await params;
    const attempt = await getExecutionAttempt(executionId);
    if (!attempt) {
      return NextResponse.json({ error: "Execution attempt not found" }, { status: 404 });
    }

    return NextResponse.json({
      executionId: attempt.executionId,
      state: attempt.state,
      rail: attempt.rail,
      counterpartyAgentId: attempt.counterpartyAgentId,
      counterpartyWallet: attempt.counterpartyWallet,
      capability: attempt.capability,
      requestedAmountUsdc: attempt.requestedAmountUsdc,
      authorizedAmountUsdc: attempt.authorizedAmountUsdc,
      actualSettledAmountUsdc: attempt.actualSettledAmountUsdc,
      createTx: attempt.createTx,
      completeTx: attempt.completeTx,
      paymentTx: attempt.paymentTx,
      evaluationId: attempt.evaluationId,
      selectionHash: attempt.selectionHash,
      clearanceDigest: attempt.clearanceDigest,
      evidenceHash: attempt.evidenceHash,
      canonicalHash: attempt.canonicalHash,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
