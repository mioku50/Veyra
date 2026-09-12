/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { byoaErrorResponse, jsonBody, requireOwnerSession } from "@/lib/byoa/http";
import { confirmSellerWithdrawal } from "@/lib/seller/withdrawal";

type RouteContext = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const session = requireOwnerSession(request);
    const { id } = await params;
    const body = await jsonBody(request);
    const withdrawal = await confirmSellerWithdrawal(session.wallet, id, body.transactionHash);
    if (!withdrawal) return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 });
    return NextResponse.json(
      { withdrawal },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to confirm seller withdrawal.";
    if (/session|required/i.test(message)) return byoaErrorResponse(error);
    return NextResponse.json(
      { error: message, retryable: /not found|temporarily|timeout/i.test(message) },
      { status: /not found|temporarily|timeout/i.test(message) ? 425 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
