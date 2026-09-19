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
    const counterpartyWallet =
      url.searchParams.get("counterpartyWallet") || undefined;
    const mandateId = url.searchParams.get("mandateId") || undefined;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return NextResponse.json(
        { error: "limit must be 1–100" },
        { status: 400 },
      );
    let before: { createdAt: string; executionId: string } | undefined;
    const cursor = url.searchParams.get("cursor");
    if (cursor) {
      try {
        if (cursor.length > 1024) throw new Error();
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          typeof parsed.createdAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(
            parsed.createdAt,
          ) ||
          !Number.isFinite(Date.parse(parsed.createdAt)) ||
          typeof parsed.executionId !== "string" ||
          !/^vexec_[a-zA-Z0-9_-]+$/.test(parsed.executionId)
        )
          throw new Error();
        before = {
          createdAt: parsed.createdAt,
          executionId: parsed.executionId,
        };
      } catch {
        return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
      }
    }

    const executions = await listExecutionAttempts({
      counterpartyWallet,
      mandateId,
      limit: limit + 1,
      before,
    });

    const page = executions.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      executions.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt,
              executionId: last.executionId,
            }),
          ).toString("base64url")
        : null;
    return NextResponse.json({
      executions: page.map(publicExecutionView),
      nextCursor,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
