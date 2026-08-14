/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { ExecutionError, runAutopilotExecution } from "@/lib/execution/executor";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { mandateId, capability, task = {}, requestedBudgetUsdc } = body;
    const idempotencyKey = req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key") || undefined;

    if (!mandateId) {
      return NextResponse.json({ error: "mandateId is required" }, { status: 400 });
    }
    if (!capability) {
      return NextResponse.json({ error: "capability is required" }, { status: 400 });
    }
    if (typeof requestedBudgetUsdc !== "number" || requestedBudgetUsdc <= 0) {
      return NextResponse.json(
        { error: "Valid positive requestedBudgetUsdc is required" },
        { status: 400 }
      );
    }

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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
