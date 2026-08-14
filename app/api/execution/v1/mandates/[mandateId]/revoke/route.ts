/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { revokeExecutionMandate } from "@/lib/execution/db";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ mandateId: string }> }
) {
  try {
    const { mandateId } = await params;
    const { ownerWallet } = await req.json();

    if (!ownerWallet) {
      return NextResponse.json({ error: "ownerWallet is required" }, { status: 400 });
    }

    const success = await revokeExecutionMandate(mandateId, ownerWallet);
    if (!success) {
      return NextResponse.json({ error: "Mandate not found or owner mismatch" }, { status: 404 });
    }

    return NextResponse.json({ success: true, mandateId, status: "REVOKED" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
