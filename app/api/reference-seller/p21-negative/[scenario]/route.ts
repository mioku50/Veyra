/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sellerAddress, withGateway } from "@/lib/x402";

type RouteContext = { params: Promise<{ scenario: string }> };

const REFERENCE_SELLER_WALLET =
  process.env.REFERENCE_SELLER_WALLET?.trim() || sellerAddress;

function authorized(request: NextRequest) {
  const expected = process.env.P21_NEGATIVE_FIXTURE_TOKEN?.trim();
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes);
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { scenario } = await params;
  if (scenario !== "invalid-json" && scenario !== "timeout") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const endpoint = `/api/reference-seller/p21-negative/${scenario}`;
  const handler = async (_paidRequest: NextRequest) => {
    if (scenario === "invalid-json") {
      return new NextResponse("{invalid-json", {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  };

  return withGateway(
    handler,
    "$0.0001",
    endpoint,
    REFERENCE_SELLER_WALLET,
  )(request);
}
