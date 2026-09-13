/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { buildTrustApiCatalog } from "@/lib/x402/trust-api/catalog";

export const dynamic = "force-dynamic";

/** Veyra's own resources, in x402 discovery shape. Free, and deliberately
 *  cacheable: this is a directory, not an answer about anybody. */
export async function GET(request: NextRequest) {
  const catalog = await buildTrustApiCatalog(request.nextUrl.origin);
  return NextResponse.json(catalog, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
  });
}
