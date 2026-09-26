/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { refreshArcRegistrySnapshot } from "@/lib/discovery/arc-registry";

/* The daily read of the ERC-8004 registry on Arc (vercel.json). It reads a
   public chain and public endpoints, sends no payment, and writes one row of
   counts and normalised offers. */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim();
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const result = await refreshArcRegistrySnapshot();
    return NextResponse.json(
      { arcRegistry: result },
      { status: result.saved ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "arc_registry_unavailable", retryable: true },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
