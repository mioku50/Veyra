import { NextRequest, NextResponse } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { counterpartyErrorResponse } from "@/lib/counterparty-selection/http";
import { discoverCounterparties, CounterpartySelectionError } from "@/lib/counterparty-selection/service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await authenticateSelectionRequest(request, "workflows:read");
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new CounterpartySelectionError("discovery_input_invalid");
    }
    const allowed = ["capability", "network", "maxPriceUsdc", "limit"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      throw new CounterpartySelectionError("client_derived_fields_forbidden");
    }
    const result = await discoverCounterparties(body);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return counterpartyErrorResponse(error);
  }
}
