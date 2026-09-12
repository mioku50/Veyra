/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "legacy_withdrawal_disabled",
      message: "Use the seller-scoped non-custodial withdrawal flow in Seller Console.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
