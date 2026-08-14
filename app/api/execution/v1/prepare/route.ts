/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { ExecutionError, prepareExecution } from "@/lib/execution/executor";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { selectionId, mandateId, requestedAmountUsdc, mode = "PREPARE", executorWallet } = body;

    if (!selectionId) {
      return NextResponse.json({ error: "selectionId is required" }, { status: 400 });
    }
    if (typeof requestedAmountUsdc !== "number" || requestedAmountUsdc <= 0) {
      return NextResponse.json(
        { error: "Valid positive requestedAmountUsdc is required" },
        { status: 400 }
      );
    }

    const prepared = await prepareExecution({
      selectionId,
      mandateId,
      requestedAmountUsdc,
      mode,
      executorWallet,
    });

    return NextResponse.json(prepared);
  } catch (err: any) {
    if (err instanceof ExecutionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
