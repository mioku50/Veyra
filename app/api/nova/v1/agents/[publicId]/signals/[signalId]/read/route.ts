import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { researchPublicSources } from "@/lib/nova/service";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string; signalId: string }> }) {
  try {
    const assessment = await researchPublicSources({ ...await params, ownerSecret: ownerSecretFrom(request) });
    return NextResponse.json({ assessment }, { headers: NOVA_HEADERS });
  } catch (error) { return novaErrorResponse(error); }
}
