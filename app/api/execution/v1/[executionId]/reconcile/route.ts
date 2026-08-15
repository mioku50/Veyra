/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { assertMandateAccess, authenticateExecutionCaller } from "@/lib/execution/auth";
import { getExecutionAttempt, getExecutionMandate } from "@/lib/execution/db";
import { ExecutionError, reconcileExecutionSettlement } from "@/lib/execution/executor";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ executionId: string }> }
) {
  try {
    const { executionId } = await params;
    const caller = await authenticateExecutionCaller(req);
    const attempt = await getExecutionAttempt(executionId);

    if (!attempt) {
      return NextResponse.json({ error: "Execution attempt not found", code: "EXECUTION_NOT_FOUND" }, { status: 404 });
    }

    if (attempt.mandateId) {
      const mandate = await getExecutionMandate(attempt.mandateId);
      if (mandate) {
        assertMandateAccess(caller, mandate.ownerWallet, mandate.subjectWallet);
      }
    }

    if (attempt.state !== "SETTLEMENT_UNVERIFIED") {
      return NextResponse.json(
        { error: `Execution is in ${attempt.state}, not SETTLEMENT_UNVERIFIED`, code: "INVALID_STATE" },
        { status: 409 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { settled, paymentTx, failureCode, actualSettledAmountUsdc } = body;

    if (typeof settled !== "boolean") {
      return NextResponse.json(
        { error: "'settled' boolean is required", code: "MISSING_REQUIRED_FIELDS" },
        { status: 400 }
      );
    }

    const result = await reconcileExecutionSettlement({
      executionId,
      settled,
      paymentTx,
      failureCode,
      actualSettledAmountUsdc,
    });

    return NextResponse.json(result);
  } catch (err: any) {
    if (err instanceof ExecutionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: err.message, code: "SERVER_ERROR" }, { status: 500 });
  }
}
