/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { assertMandateAccess, authenticateExecutionCaller } from "@/lib/execution/auth";
import { getExecutionAttempt, getExecutionMandate } from "@/lib/execution/db";
import { ExecutionError, executePreparedIntent } from "@/lib/execution/executor";

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

    const body = await req.json().catch(() => ({}));
    const idempotencyKey =
      req.headers.get("idempotency-key") ||
      req.headers.get("x-idempotency-key") ||
      body.idempotencyKey;

    const result = await executePreparedIntent({
      executionId,
      idempotencyKey,
      taskPayload: body.taskPayload || body,
    });

    return NextResponse.json(result);
  } catch (err: any) {
    if (err instanceof ExecutionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: err.message, code: "SERVER_ERROR" }, { status: 500 });
  }
}
