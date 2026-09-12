/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { byoaErrorResponse, requireOwnerSession } from "@/lib/byoa/http";
import { checkOwnedSellerServiceAvailability } from "@/lib/seller/lifecycle";
import { listSellerHealthChecks } from "@/lib/seller/marketplace";

type RouteContext = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const session = requireOwnerSession(request);
    const { id } = await params;
    return NextResponse.json(
      { checks: await listSellerHealthChecks(session.wallet, id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return byoaErrorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const session = requireOwnerSession(request);
    const { id } = await params;
    const availability = await checkOwnedSellerServiceAvailability(session.wallet, id);
    if (!availability) return NextResponse.json({ error: "Service not found" }, { status: 404 });
    revalidatePath("/");
    revalidatePath("/agent-runner");
    revalidatePath("/console/seller");
    return NextResponse.json(
      { availability },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to check seller availability.";
    if (/session|required/i.test(message)) return byoaErrorResponse(error);
    return NextResponse.json(
      { error: message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
