/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { getByoaClient } from "@/lib/byoa/service.ts";
import type { Erc8004ValidationLinkRecord } from "@/lib/erc8004/types.ts";

export const dynamic = "force-dynamic";
export const revalidate = 15;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(100, parseInt(searchParams.get("limit") || "20", 10));

  let validations: Erc8004ValidationLinkRecord[] = [];

  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("erc8004_validation_links")
    .select("*")
    .eq("status", "confirmed")
    .order("created_at", { ascending: false })
    .limit(Number.isFinite(limit) ? limit : 20);
  if (error) {
    return NextResponse.json(
      { error: { code: "validation_storage_unavailable", message: "Validations are unavailable." } },
      { status: 503 }
    );
  }
  if (data) {
    validations = data as Erc8004ValidationLinkRecord[];
  }

  return NextResponse.json(
    {
      count: validations.length,
      validations: validations.map((record) => ({
        requestHash: record.request_hash,
        agentId: record.agent_id,
        evaluationPublicId: record.evaluation_public_id,
        canonicalReportHash: record.canonical_report_hash,
        response: record.response,
        responseHash: record.response_hash,
        responseTx: record.response_tx,
        tag: record.tag,
        status: record.status,
        confirmedAt: record.confirmed_at,
      })),
    },
    { headers: { "Cache-Control": "public, max-age=15, s-maxage=15" } }
  );
}
