/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      status: "operational",
      network: "arc-testnet",
      chainId: 5_042_002,
      version: "0.2.0-beta.8",
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=15, s-maxage=30",
      },
    },
  );
}
