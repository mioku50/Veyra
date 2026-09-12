/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { byoaErrorResponse, requireOwnerSession } from "@/lib/byoa/http";
import { getSellerWithdrawalDetail } from "@/lib/seller/withdrawal";

type RouteContext = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const session = requireOwnerSession(request);
    const { id } = await params;
    const result = await getSellerWithdrawalDetail(session.wallet, id);
    if (!result) return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return byoaErrorResponse(error);
  }
}
