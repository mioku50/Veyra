/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { assertMandateAccess, authenticateExecutionCaller } from "@/lib/execution/auth";
import { getExecutionMandate, revokeExecutionMandate } from "@/lib/execution/db";
import { sanitizeMandate } from "@/lib/execution/types";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ mandateId: string }> }
) {
  try {
    const caller = await authenticateExecutionCaller(req);
    const { mandateId } = await params;
    const mandate = await getExecutionMandate(mandateId);

    if (!mandate) {
      return NextResponse.json({ error: "Mandate not found", code: "MANDATE_NOT_FOUND" }, { status: 404 });
    }

    assertMandateAccess(caller, mandate.ownerWallet, mandate.subjectWallet);

    return NextResponse.json({ mandate: sanitizeMandate(mandate) });
  } catch (err: any) {
    const status = err.status || 500;
    return NextResponse.json({ error: err.message, code: err.code || "SERVER_ERROR" }, { status });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ mandateId: string }> }
) {
  try {
    const caller = await authenticateExecutionCaller(req);
    const { mandateId } = await params;
    const mandate = await getExecutionMandate(mandateId);

    if (!mandate) {
      return NextResponse.json({ error: "Mandate not found", code: "MANDATE_NOT_FOUND" }, { status: 404 });
    }

    // Only owner can revoke mandate
    assertMandateAccess(caller, mandate.ownerWallet);

    const revoked = await revokeExecutionMandate(mandateId, caller.wallet);
    return NextResponse.json({ success: revoked, revokedAt: new Date().toISOString() });
  } catch (err: any) {
    const status = err.status || 500;
    return NextResponse.json({ error: err.message, code: err.code || "SERVER_ERROR" }, { status });
  }
}
