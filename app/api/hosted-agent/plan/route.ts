/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { previewHostedWorkflow } from "@/lib/agent/hosted-jobs";
import { safeHostedError } from "@/lib/agent/hosted-policy";
import {
  hostedWorkflowInputMetadata,
  validateHostedWorkflowRequest,
} from "@/lib/agent/hosted-workflows";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const workflowRequest = validateHostedWorkflowRequest(await request.json());
    const plan = await previewHostedWorkflow(workflowRequest);
    const input = hostedWorkflowInputMetadata(workflowRequest.inputText);
    return NextResponse.json({
      request: {
        workflowType: workflowRequest.workflowType,
        task: workflowRequest.task,
        budgetUsdc: workflowRequest.budgetUsdc,
        inputPreview: input.preview,
        inputSha256: input.sha256,
        marketSymbol: workflowRequest.marketSymbol,
      },
      plan,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = safeHostedError(error);
    const unavailable = message.includes("not configured");
    return NextResponse.json(
      { error: unavailable ? "Hosted workflow preview is unavailable." : message },
      { status: unavailable ? 503 : 400 },
    );
  }
}
