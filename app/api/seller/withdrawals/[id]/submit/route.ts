/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { byoaErrorResponse, jsonBody, requireOwnerSession } from "@/lib/byoa/http";
import { submitSellerWithdrawalSignature } from "@/lib/seller/withdrawal";

type RouteContext = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const session = requireOwnerSession(request);
    const { id } = await params;
    const body = await jsonBody(request);
    const result = await submitSellerWithdrawalSignature(session.wallet, id, body.signature);
    if (!result) return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit seller withdrawal.";
    if (/session|required/i.test(message)) return byoaErrorResponse(error);
    return NextResponse.json(
      { error: message, retryable: /Gateway could not|temporarily/i.test(message) },
      { status: /Gateway could not|temporarily/i.test(message) ? 503 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
