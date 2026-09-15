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

    /* Both halves of this used to be permissive. An attempt with no mandate
       skipped the check entirely, and so did one whose mandate row could not be
       found -- so any authenticated caller could execute an attempt nobody
       owned, on a path that spends a key the server holds. Prepare does not
       even authenticate when no mandateId is given, so such attempts are
       trivially created.

       There is no owner to check against without a mandate, which makes the
       only safe answer no. Browser relay purchases carry no mandate and are not
       executed through here; they are settled by the relay, against the buyer's
       own signature. */
    if (!attempt.mandateId) {
      return NextResponse.json(
        {
          error: "This execution has no mandate, so there is no owner to authorize it.",
          code: "EXECUTION_REQUIRES_MANDATE",
        },
        { status: 403 },
      );
    }
    const mandate = await getExecutionMandate(attempt.mandateId);
    if (!mandate) {
      return NextResponse.json(
        { error: "Mandate not found", code: "MANDATE_NOT_FOUND" },
        { status: 404 },
      );
    }
    assertMandateAccess(caller, mandate.ownerWallet, mandate.subjectWallet);

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
