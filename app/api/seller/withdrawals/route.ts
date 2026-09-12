/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { byoaErrorResponse, jsonBody, requireOwnerSession } from "@/lib/byoa/http";
import { listSellerWithdrawals, prepareSellerWithdrawal } from "@/lib/seller/withdrawal";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    const session = requireOwnerSession(request);
    return NextResponse.json(
      await listSellerWithdrawals(session.wallet),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load seller withdrawals.";
    if (/session|required/i.test(message)) return byoaErrorResponse(error);
    return NextResponse.json(
      { error: message, retryable: /temporarily/i.test(message) },
      { status: /temporarily/i.test(message) ? 503 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = requireOwnerSession(request);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const body = await jsonBody(request);
    return NextResponse.json(
      await prepareSellerWithdrawal(session.wallet, body.amountUsdc, idempotencyKey),
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare seller withdrawal.";
    if (/session|required/i.test(message)) return byoaErrorResponse(error);
    const status = /temporarily unavailable/i.test(message) ? 503 : /Idempotency-Key is already bound/i.test(message) ? 409 : 400;
    return NextResponse.json(
      { error: message, retryable: status === 503 },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
