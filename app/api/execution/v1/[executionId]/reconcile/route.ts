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
      // If already terminal (COMPLETED / FAILED), return current result idempotently
      if (
        attempt.state === "COMPLETED" ||
        attempt.state === "COMPLETED_UNPROVEN" ||
        attempt.state === "FAILED" ||
        attempt.state === "SETTLEMENT_FAILED"
      ) {
        const result = await reconcileExecutionSettlement(executionId);
        return NextResponse.json(result);
      }

      return NextResponse.json(
        { error: `Execution is in ${attempt.state}, not SETTLEMENT_UNVERIFIED`, code: "INVALID_STATE" },
        { status: 409 }
      );
    }

    // Client input may ONLY provide an optional non-authoritative lookup hint
    const body = await req.json().catch(() => ({}));
    const hint =
      typeof body.hint === "string"
        ? body.hint
        : typeof body.facilitatorRef === "string"
        ? body.facilitatorRef
        : undefined;

    const result = await reconcileExecutionSettlement(executionId, { hint });

    return NextResponse.json(result);
  } catch (err: any) {
    if (err instanceof ExecutionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: err.message, code: "SERVER_ERROR" }, { status: 500 });
  }
}
