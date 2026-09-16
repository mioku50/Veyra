/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import {
  asTransferAuthorization,
  settleX402Call,
} from "@/lib/x402/execution";

export const dynamic = "force-dynamic";

/**
 * Relays a payment the user already signed, and returns what they bought.
 *
 * A door, not a mechanism: the relay, the ledger writes and the post-call
 * verification are in lib/x402/execution.ts, shared with Nova. This checks who
 * is calling and that the two objects the browser carried back are shaped like
 * what they claim to be, then hands over.
 */

function badRequest(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSelectionRequest(request, "quotes:create");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return badRequest("invalid_body", "A JSON body is required.");
  }

  const authorization = asTransferAuthorization(body.authorization);
  if (!authorization) return badRequest("authorization_invalid", "A complete signed authorization is required.");

  /* The accept, the endpoint, the price, the capability, the counterparty, the
     clearance and whether the tier demanded verification all used to arrive
     here, from the caller whose payment they governed. They are read from the
     quote and the decision now. What is left is a quote id, a signature over
     terms Veyra itself recorded, and the body the seller has to receive --
     which is hashed and compared rather than believed. */
  const outcome = await settleX402Call({
    quoteId: typeof body.quoteId === "string" ? body.quoteId : "",
    ownerWallet: auth.tenant.requesterWallet,
    requestBody: body.requestBody,
    authorization,
    signature: typeof body.signature === "string" ? body.signature as `0x${string}` : "0x",
  });

  if (outcome.kind === "refused") {
    return badRequest(outcome.code, outcome.message, outcome.status);
  }

  if (outcome.kind === "payment_rejected") {
    return NextResponse.json({
      settled: false,
      executionId: outcome.executionId,
      status: 402,
      code: "payment_rejected",
      message: outcome.message,
      settlement: outcome.settlement,
      body: outcome.body,
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(outcome.result, { status: 200, headers: { "Cache-Control": "no-store" } });
}
