/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { assertMandateAccess, authenticateExecutionCaller } from "@/lib/execution/auth";
import { getExecutionMandate } from "@/lib/execution/db";
import { ExecutionError, runAutopilotExecution } from "@/lib/execution/executor";
import { AUTONOMY_FROZEN, AUTONOMY_FROZEN_CODE, AUTONOMY_FROZEN_MESSAGE } from "@/lib/execution/autonomy-freeze";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  /* Frozen for every caller, whatever VEYRA_AUTOPILOT_ENABLED says: see
     lib/execution/autonomy-freeze.ts. Answered before authentication, since the
     answer is the same for everybody. */
  if (AUTONOMY_FROZEN) {
    return NextResponse.json({ error: AUTONOMY_FROZEN_MESSAGE, code: AUTONOMY_FROZEN_CODE }, { status: 503 });
  }
  try {
    const caller = await authenticateExecutionCaller(req);
    const body = await req.json();
    const { mandateId, capability, task = {}, requestedBudgetUsdc } = body;
    const idempotencyKey = req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key") || undefined;

    if (!mandateId) {
      return NextResponse.json({ error: "mandateId is required", code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (!capability) {
      return NextResponse.json({ error: "capability is required", code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (typeof requestedBudgetUsdc !== "number" || requestedBudgetUsdc <= 0) {
      return NextResponse.json(
        { error: "Valid positive requestedBudgetUsdc is required", code: "INVALID_REQUEST" },
        { status: 400 }
      );
    }

    const mandate = await getExecutionMandate(mandateId);
    if (!mandate) {
      return NextResponse.json({ error: "Mandate not found", code: "MANDATE_NOT_FOUND" }, { status: 404 });
    }

    assertMandateAccess(caller, mandate.ownerWallet, mandate.subjectWallet);

    const result = await runAutopilotExecution({
      mandateId,
      capability,
      task,
      requestedBudgetUsdc,
      idempotencyKey,
    });

    return NextResponse.json(result);
  } catch (err: any) {
    if (err instanceof ExecutionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: err.message, code: "SERVER_ERROR" }, { status: 500 });
  }
}
