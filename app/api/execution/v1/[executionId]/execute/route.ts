/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { ExecutionError, executePreparedIntent } from "@/lib/execution/executor";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ executionId: string }> }
) {
  try {
    const { executionId } = await params;
    const idempotencyKey = req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key") || undefined;
    
    let taskPayload: any = undefined;
    try {
      const body = await req.json();
      taskPayload = body?.taskPayload;
    } catch {
      // Empty payload is valid
    }

    const result = await executePreparedIntent({
      executionId,
      idempotencyKey,
      taskPayload,
    });

    return NextResponse.json(result);
  } catch (err: any) {
    if (err instanceof ExecutionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
