/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { getExecutionAttempt, getExecutionMandate } from "@/lib/execution/db";
import { authenticateExecutionCaller } from "@/lib/execution/auth";
import { publicExecutionView } from "@/lib/execution/public-view";

export const dynamic = "force-dynamic";

/**
 * One execution, in the detail the caller is entitled to.
 *
 * Public by default and unauthenticated, because the ledger is meant to be
 * checkable by a stranger. The owner of the mandate gets the record whole --
 * they signed the authorization in it, so nothing there is disclosed to them.
 *
 * Authentication failing is not an error here. A reader with no wallet is the
 * ordinary case, and answering 401 would take the public ledger away to protect
 * a field that should never have been in it.
 */
async function callerOwnsMandate(req: Request, mandateId: string | null | undefined) {
  if (!mandateId) return false;
  try {
    const caller = await authenticateExecutionCaller(req);
    const mandate = await getExecutionMandate(mandateId);
    if (!mandate) return false;
    const wallet = caller.wallet.toLowerCase();
    return wallet === mandate.ownerWallet.toLowerCase()
      || wallet === mandate.subjectWallet?.toLowerCase();
  } catch {
    return false;
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ executionId: string }> }
) {
  try {
    const { executionId } = await params;
    const attempt = await getExecutionAttempt(executionId);
    if (!attempt) {
      return NextResponse.json({ error: "Execution attempt not found" }, { status: 404 });
    }

    const owner = await callerOwnsMandate(req, attempt.mandateId);
    return NextResponse.json({
      execution: owner ? attempt : publicExecutionView(attempt),
      view: owner ? "owner" : "public",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
