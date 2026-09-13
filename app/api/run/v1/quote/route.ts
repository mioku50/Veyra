/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { quoteX402Call, X402_ABSOLUTE_MAX_USDC } from "@/lib/x402/execution";

export const dynamic = "force-dynamic";

/**
 * Quotes a resource for a payment the *user's* wallet will sign.
 *
 * A door, not a mechanism. Everything that touches the money lives in
 * lib/x402/execution.ts, which Nova's approval route calls too -- one payment
 * path with two entrances, rather than two payment paths that agree until the
 * day they quietly stop agreeing.
 *
 * What is left here is what a door is for: who is allowed through, and the
 * shape of the answer this surface's client already expects.
 */

export async function POST(request: NextRequest) {
  const auth = await authenticateSelectionRequest(request, "quotes:create");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: { code: "invalid_body", message: "A JSON body is required." } }, { status: 400 });
  }

  const outcome = await quoteX402Call({
    resource: typeof body.resource === "string" ? body.resource : "",
    method: body.method === "GET" ? "GET" : "POST",
    requestBody: body.requestBody,
    maxAmountUsdc: Number(body.maxAmountUsdc),
    inputSchema: body.inputSchema && typeof body.inputSchema === "object" && !Array.isArray(body.inputSchema)
      ? body.inputSchema as Record<string, unknown>
      : null,
  });

  if (outcome.kind === "refused") {
    return NextResponse.json({
      error: {
        code: outcome.code,
        message: outcome.message,
        // Carried through on a schema refusal so the client can rebuild the
        // request in the provider's own field names.
        ...(outcome.inputSchema ? { inputSchema: outcome.inputSchema } : {}),
      },
    }, { status: outcome.status });
  }

  if (outcome.kind === "free") {
    return NextResponse.json({
      paymentRequired: false,
      status: outcome.status,
      body: outcome.body,
    });
  }

  const { quote } = outcome;
  return NextResponse.json({
    paymentRequired: true,
    resource: quote.resource,
    inputSchema: quote.inputSchema,
    outputSchema: quote.outputSchema,
    resourceDescriptor: quote.resourceDescriptor,
    method: quote.method,
    accept: quote.accept,
    quotedUsdc: quote.quotedUsdc,
    maxAmountUsdc: quote.maxAmountUsdc,
    nonce: quote.nonce,
    quotedAt: quote.quotedAt,
    absoluteMaxUsdc: X402_ABSOLUTE_MAX_USDC,
  }, { headers: { "Cache-Control": "no-store" } });
}
