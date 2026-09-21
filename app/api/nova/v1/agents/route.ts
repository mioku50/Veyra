/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse } from "@/lib/nova/http";
import { createNova } from "@/lib/nova/service";

export const dynamic = "force-dynamic";

/**
 * Creates a personal agent.
 *
 * A name and a few interests, and nothing else. No wallet, no budget, no
 * on-chain identity: an agent that has to be funded before it is useful is a
 * product nobody finishes signing up for, and an identity registered at signup
 * certifies only that an account was created.
 *
 * The owner secret is returned exactly once, here.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { name?: unknown; interests?: unknown; goal?: unknown };
    const { agent, ownerSecret } = await createNova({
      name: typeof body.name === "string" ? body.name : "",
      interests: body.interests,
      goal: body.goal,
    });
    return NextResponse.json({ agent, ownerSecret }, { status: 201, headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
