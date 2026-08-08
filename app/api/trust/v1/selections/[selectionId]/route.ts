import { NextRequest, NextResponse } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { fetchCounterpartySelection } from "@/lib/counterparty-selection/db";
import { counterpartyErrorResponse } from "@/lib/counterparty-selection/http";
import { CounterpartySelectionError } from "@/lib/counterparty-selection/service";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ selectionId: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authenticateSelectionRequest(request, "results:read");
  if (!auth.ok) return auth.response;
  try {
    const { selectionId } = await params;
    const selection = await fetchCounterpartySelection(selectionId, auth.tenant);
    if (!selection) throw new CounterpartySelectionError("selection_not_found", 404);
    return NextResponse.json({ selection }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return counterpartyErrorResponse(error);
  }
}
