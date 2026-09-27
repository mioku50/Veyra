/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { arcTrustApiOpenApi } from "@/lib/x402/trust-api/arc-openapi";

/* Built from the route definitions, so it is prerendered and changes only with a deploy. */
export const dynamic = "force-static";

/** The OpenAPI document for Veyra's Trust API on Arc mainnet. */
export function GET() {
  return NextResponse.json(arcTrustApiOpenApi(), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
