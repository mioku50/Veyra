import { NextRequest, NextResponse } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { counterpartyErrorResponse } from "@/lib/counterparty-selection/http";
import { selectMarketplaceCounterparty } from "@/lib/counterparty-selection/marketplace";
import { CounterpartySelectionError } from "@/lib/counterparty-selection/service";

export const dynamic = "force-dynamic";

/**
 * Pre-payment trust gate for Circle x402 marketplace endpoints.
 *
 * Discovers candidates from Circle's public discovery API, probes each one's
 * live 402 challenge for free, ranks them through the existing counterparty
 * engine, and returns an EIP-712 clearance for the winner. Read-only: this
 * route never authorizes, quotes, or settles a payment - the caller does that
 * with `circle services pay` after reading the verdict.
 *
 * No Idempotency-Key: nothing is persisted, and every call re-probes the
 * endpoint so the verdict reflects the endpoint's state right now.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateSelectionRequest(request, "quotes:create");
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new CounterpartySelectionError("selection_input_invalid");
    }
    const selection = await selectMarketplaceCounterparty({
      request: body,
      tenant: auth.tenant,
    });
    return NextResponse.json({
      selection,
      paymentCreated: false,
      jobCreated: false,
      readOnly: true,
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return counterpartyErrorResponse(error);
  }
}
