/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import {
  listRecentHostedAgentJobs,
} from "@/lib/agent/hosted-jobs";
import {
  safeHostedError,
} from "@/lib/agent/hosted-policy";
import {
  isHostedWorkflowType,
} from "@/lib/agent/hosted-workflows";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  void request;
  return NextResponse.json(
    {
      error:
        "Direct hosted launch is disabled. Create an immutable workflow quote, then confirm its sponsored authorization or single Arc USDC payment.",
      quoteEndpoint: "/api/hosted-agent/quotes",
    },
    { status: 410 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? "8");
    const workflowParam = request.nextUrl.searchParams.get("workflowType");
    let workflowFilter: Parameters<typeof listRecentHostedAgentJobs>[1] = null;
    if (workflowParam && workflowParam !== "all") {
      if (!isHostedWorkflowType(workflowParam)) {
        return NextResponse.json({ error: "Invalid workflow filter." }, { status: 400 });
      }
      workflowFilter = workflowParam;
    }
    const jobs = await listRecentHostedAgentJobs(
      Number.isFinite(rawLimit) ? rawLimit : 8,
      workflowFilter,
    );
    return NextResponse.json({ jobs }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(`[hosted-agent] history unavailable: ${safeHostedError(error)}`);
    return NextResponse.json(
      { error: "Unable to load hosted workflow history." },
      { status: 503 },
    );
  }
}
