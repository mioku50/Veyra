/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { byoaErrorResponse, jsonBody, requireOwnerSession } from "@/lib/byoa/http";
import { completeSellerOnboarding, getSellerAccount } from "@/lib/seller/marketplace";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = requireOwnerSession(request);
    return NextResponse.json(
      { account: await getSellerAccount(session.wallet) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return byoaErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = requireOwnerSession(request);
    const body = await jsonBody(request);
    const account = await completeSellerOnboarding(session.wallet, {
      displayName: body.displayName,
      termsAccepted: body.termsAccepted,
    });
    return NextResponse.json(
      { account },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to complete seller onboarding.";
    if (/session|required/i.test(message)) return byoaErrorResponse(error);
    return NextResponse.json(
      { error: message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
