import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { forgetPreference } from "@/lib/nova/service";
export const dynamic = "force-dynamic";
/* Forget one learned preference. Owner-authenticated; a purchase record is
   not a preference and cannot be deleted through here. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ publicId: string; memoryId: string }> }) {
  try {
    const result = await forgetPreference({ ...await params, ownerSecret: ownerSecretFrom(request) });
    return NextResponse.json(result, { headers: NOVA_HEADERS });
  } catch (error) { return novaErrorResponse(error); }
}
