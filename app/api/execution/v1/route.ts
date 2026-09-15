/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { listExecutionAttempts } from "@/lib/execution/db";
import { publicExecutionView } from "@/lib/execution/public-view";

export const dynamic = "force-dynamic";

/**
 * The public execution ledger.
 *
 * Open on purpose -- a purchase a stranger cannot check is not evidence -- and
 * for that reason it must carry no material that spends anything. It returned
 * the stored model whole until now, signatures included, to anybody who asked
 * with no header at all. See publicExecutionView for what is kept and why.
 */
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

    return NextResponse.json({ executions: executions.map(publicExecutionView) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
