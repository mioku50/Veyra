/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { listExecutionAttempts } from "@/lib/execution/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const counterpartyWallet = url.searchParams.get("counterpartyWallet") || undefined;
    const mandateId = url.searchParams.get("mandateId") || undefined;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;

    const executions = await listExecutionAttempts({
      counterpartyWallet,
      mandateId,
      limit,
    });

    return NextResponse.json({ executions });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
