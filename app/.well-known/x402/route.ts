/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { buildTrustApiCatalog } from "@/lib/x402/trust-api/catalog";

export const dynamic = "force-dynamic";

/** The conventional location an x402 client looks first. Same content as
 *  /api/x402/v1/catalog; agents should not have to read documentation to find
 *  out what a host sells. */
export async function GET(request: NextRequest) {
  const catalog = await buildTrustApiCatalog(request.nextUrl.origin);
  return NextResponse.json(catalog, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
  });
}
