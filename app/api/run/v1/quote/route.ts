/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { fetchWithSsrfProtection, SSRFProtectionError } from "@/lib/seller/ssrf";
import { decodePaymentRequiredHeader } from "@/lib/providers/x402-probe";
import { isUsdcAsset } from "@/lib/x402/usdc-assets";
import {
  challengeResource,
  selectPayableAccept,
  X402PaymentError,
  type X402Accept,
} from "@/lib/x402/browser-payment";

export const dynamic = "force-dynamic";

/**
 * Quotes a resource for a payment the *user's* wallet will sign.
 *
 * The server fetches the live 402 challenge — a browser cannot, because sellers
 * do not send CORS headers — and hands back the exact EIP-712 payload to sign.
 * It never holds a key and never sees one: the reply is public information plus
 * a nonce.
 *
 * The price is read from the challenge raised by *this* request body, because
 * x402 prices per call: the same endpoint quoted 0 for an empty body and 1000
 * atomic units for a real one.
 */

/** Ceiling in USDC that any single browser-signed call may quote, independent
 *  of what a decision authorized. A bug upstream should not be able to present
 *  a life-changing number to a wallet. */
const ABSOLUTE_MAX_USDC = 5;

/* Asset identity is the contract address, never the EIP-712 domain name: a
   Circle Gateway accept is domain-separated by "GatewayWalletBatched" while
   paying in ordinary USDC. See lib/x402/usdc-assets.ts. */

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

  const resource = typeof body.resource === "string" ? body.resource.trim() : "";
  if (!resource) return badRequest("resource_required", "resource is required.");

  const method = body.method === "GET" ? "GET" : "POST";
  const maxAmountUsdc = Number(body.maxAmountUsdc);
  if (!Number.isFinite(maxAmountUsdc) || maxAmountUsdc <= 0 || maxAmountUsdc > ABSOLUTE_MAX_USDC) {
    return badRequest(
      "max_amount_invalid",
      `maxAmountUsdc must be between 0 and ${ABSOLUTE_MAX_USDC}.`,
    );
  }
  /* Deliberately not filtered to the wallet's current chain. The clearance is
     issued on Arc while most of the x402 catalog sits on Base, so the honest
     answer is which chain this call must be paid on — the caller then asks the
     wallet to switch for one signature. Filtering here would report a payable
     endpoint as unpayable. */

  const requestBody = body.requestBody === undefined ? {} : body.requestBody;

  let response: Response;
  try {
    response = await fetchWithSsrfProtection(resource, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: method === "POST" ? JSON.stringify(requestBody) : undefined,
    });
  } catch (error) {
    if (error instanceof SSRFProtectionError) {
      return badRequest("resource_not_allowed", "That resource address is not allowed.", 422);
    }
    return badRequest("resource_unreachable", "The endpoint did not answer.", 502);
  }

  // Already free, or already paid for: there is nothing to sign.
  if (response.status !== 402) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({
      paymentRequired: false,
      status: response.status,
      body: text.slice(0, 20_000),
    });
  }

  const headerChallenge = decodePaymentRequiredHeader(response.headers.get("payment-required"));
  const challenge = headerChallenge ?? await response.json().catch(() => null);

  let accept: X402Accept;
  try {
    accept = selectPayableAccept(challenge, {
      // USDC is six decimals on every chain it is deployed to, and the asset
      // check below refuses anything that is not USDC, so this conversion is
      // exact rather than assumed.
      maxAtomic: BigInt(Math.floor(maxAmountUsdc * 1e6)),
    });
  } catch (error) {
    if (error instanceof X402PaymentError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: 422 });
    }
    throw error;
  }

  if (!isUsdcAsset(accept.chainId, accept.asset)) {
    return badRequest(
      "asset_not_usdc",
      `This endpoint prices in ${accept.asset} on chain ${accept.chainId}, which is not the USDC contract Veyra quotes.`,
      422,
    );
  }

  const quotedUsdc = Number(accept.amountAtomic) / 1e6;

  return NextResponse.json({
    paymentRequired: true,
    resource,
    // The challenge's own resource descriptor, echoed back when the payment is
    // relayed. v2 publishes an object here, not the URL.
    resourceDescriptor: challengeResource(challenge),
    method,
    accept,
    quotedUsdc,
    maxAmountUsdc,
    // 32 bytes, generated here so a replayed quote cannot reuse an old one.
    nonce: `0x${randomBytes(32).toString("hex")}`,
    quotedAt: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
