import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { researchPublicSources } from "@/lib/nova/service";
import { readingForThePage } from "@/lib/nova/value";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string; signalId: string }> }) {
  try {
    /* An owner who asked for a reassessment gets a new reading, not the stored
       one. Absent or malformed, the body means the older behaviour: reuse a
       reading that still stands. */
    const body = await request.json().catch(() => ({})) as { reassess?: unknown };
    const assessment = await researchPublicSources({
      ...await params, ownerSecret: ownerSecretFrom(request), reassess: body.reassess === true,
    });
    return NextResponse.json({ assessment: readingForThePage(assessment) }, { headers: NOVA_HEADERS });
  } catch (error) { return novaErrorResponse(error); }
}
