import { NextRequest, NextResponse } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { counterpartyErrorResponse } from "@/lib/counterparty-selection/http";
import { selectCounterparty, CounterpartySelectionError } from "@/lib/counterparty-selection/service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await authenticateSelectionRequest(request, "quotes:create");
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new CounterpartySelectionError("selection_input_invalid");
    }
    const idempotencyKey = request.headers.get("idempotency-key") || "";
    const { selection, replayed } = await selectCounterparty({
      request: body,
      tenant: auth.tenant,
      idempotencyKey,
      baseUrl: request.nextUrl.origin,
    });
    return NextResponse.json({
      selection,
      replayed,
      paymentCreated: false,
      jobCreated: false,
      proofPublished: Boolean(selection.proof),
    }, { status: replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return counterpartyErrorResponse(error);
  }
}
