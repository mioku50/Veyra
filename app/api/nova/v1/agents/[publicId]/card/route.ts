/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/nova/service";
import { agentCard } from "@/lib/nova/identity";

export const dynamic = "force-dynamic";

/**
 * The metadata an ERC-8004 registration points at.
 *
 * Public on purpose and public by consequence: the URI is written onchain, so
 * anything served here is published the moment somebody registers. That is the
 * whole design constraint. It carries the agent's name, the product identity
 * that outlives any wallet, and which registry it belongs to -- and nothing
 * from the brief, the memory or the purchases, because none of that is the
 * owner's to have published by a side effect of claiming an identity.
 *
 * No owner secret is involved, and none is accepted. A card that required one
 * could not be read by the chain's audience, which is everyone.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const { data } = await db()
    .from("nova_agents")
    .select("public_id, name, created_at")
    .eq("public_id", publicId)
    .maybeSingle();

  const row = data as { public_id: string; name: string; created_at: string } | null;
  if (!row) return NextResponse.json({ error: "No such agent." }, { status: 404 });

  return NextResponse.json(
    agentCard({
      name: row.name,
      publicId: row.public_id,
      createdAt: row.created_at,
      origin: request.nextUrl.origin,
    }),
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
