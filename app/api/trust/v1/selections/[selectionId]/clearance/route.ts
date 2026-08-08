import { NextRequest, NextResponse } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { counterpartyErrorResponse } from "@/lib/counterparty-selection/http";
import { issueCounterpartySelectionClearance, CounterpartySelectionError } from "@/lib/counterparty-selection/service";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ selectionId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authenticateSelectionRequest(request, "runs:create");
  if (!auth.ok) return auth.response;
  try {
    if (request.headers.get("content-length") && Number(request.headers.get("content-length")) > 0) {
      const body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
        throw new CounterpartySelectionError("client_derived_fields_forbidden");
      }
    }
    const { selectionId } = await params;
    const result = await issueCounterpartySelectionClearance({ selectionId, tenant: auth.tenant });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return counterpartyErrorResponse(error);
  }
}
