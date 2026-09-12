/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { getHostedAgentJobView, redactPublicSellerAccounting } from "@/lib/agent/hosted-jobs";
import { safeHostedError } from "@/lib/agent/hosted-policy";
import { isByoaHostedJob } from "@/lib/byoa/service";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_request: Request, { params }: RouteContext) {
  const { jobId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return NextResponse.json({ error: "Invalid hosted job ID." }, { status: 400 });
  }

  try {
    if (await isByoaHostedJob(jobId)) {
      return NextResponse.json({ error: "Hosted job not found." }, { status: 404 });
    }
    const view = await getHostedAgentJobView(jobId);
    if (!view) {
      return NextResponse.json({ error: "Hosted job not found." }, { status: 404 });
    }
    return NextResponse.json(redactPublicSellerAccounting(view), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(
      `[hosted-agent] status read failed for job=${jobId}: ${safeHostedError(error)}`,
    );
    return NextResponse.json(
      { error: "Unable to load hosted job." },
      { status: 503 },
    );
  }
}
