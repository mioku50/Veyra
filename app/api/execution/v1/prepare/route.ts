/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { assertMandateAccess, authenticateExecutionCaller } from "@/lib/execution/auth";
import { getExecutionMandate } from "@/lib/execution/db";
import { ExecutionError, prepareExecution } from "@/lib/execution/executor";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { selectionId, mandateId, requestedAmountUsdc, mode = "PREPARE", executorWallet } = body;

    if (!selectionId) {
      return NextResponse.json({ error: "selectionId is required", code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (typeof requestedAmountUsdc !== "number" || requestedAmountUsdc <= 0) {
      return NextResponse.json(
        { error: "Valid positive requestedAmountUsdc is required", code: "INVALID_REQUEST" },
        { status: 400 }
      );
    }

    let finalExecutorWallet = executorWallet;

    if (mandateId) {
      const caller = await authenticateExecutionCaller(req);
      const mandate = await getExecutionMandate(mandateId);
      if (!mandate) {
        return NextResponse.json({ error: "Mandate not found", code: "MANDATE_NOT_FOUND" }, { status: 404 });
      }
      assertMandateAccess(caller, mandate.ownerWallet, mandate.subjectWallet);
      finalExecutorWallet = finalExecutorWallet || caller.wallet;
    }

    const prepared = await prepareExecution({
      selectionId,
      mandateId,
      requestedAmountUsdc,
      mode,
      executorWallet: finalExecutorWallet,
    });

    return NextResponse.json(prepared);
  } catch (err: any) {
    if (err instanceof ExecutionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: err.message, code: "SERVER_ERROR" }, { status: 500 });
  }
}
