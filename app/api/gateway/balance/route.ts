/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      error: "legacy_balance_disabled",
      message: "Use the owner-session-scoped Seller Console balance endpoint.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
