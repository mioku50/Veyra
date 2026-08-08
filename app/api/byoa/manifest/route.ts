import { NextRequest, NextResponse } from "next/server";
import { byoaManifest, safeByoaError } from "@/lib/byoa/service";
import { listPublicSellerWorkflows } from "@/lib/seller/marketplace";
import { getCanonicalVeyraAgentIdentity } from "@/lib/erc8004/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const sellerWorkflows = await listPublicSellerWorkflows();
    const identity = await getCanonicalVeyraAgentIdentity();
    return NextResponse.json(byoaManifest(request.nextUrl.origin, sellerWorkflows, identity?.agent_id || null), {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    return NextResponse.json({ error: safeByoaError(error) }, { status: 503 });
  }
}
