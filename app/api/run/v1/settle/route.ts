/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { fetchWithSsrfProtection, SSRFProtectionError } from "@/lib/seller/ssrf";
import {
  decodePaymentResponse,
  encodePaymentHeader,
  evmChainIdFromCaip2,
  PAYMENT_SIGNATURE_HEADER,
  type TransferAuthorization,
  type X402Accept,
} from "@/lib/x402/browser-payment";

export const dynamic = "force-dynamic";

/**
 * Relays a payment the user already signed, and returns what they bought.
 *
 * Veyra adds nothing to the money here. The EIP-3009 authorization commits to
 * the amount, the recipient and a validity window, so this route cannot change
 * any of them — it can only carry the signature to the seller or fail to. The
 * checks below exist to catch a malformed client, not to protect the user from
 * this server: their signature already does that.
 */

const ABSOLUTE_MAX_USDC = 5;
const MAX_RESULT_BYTES = 200_000;

function badRequest(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function asAccept(value: unknown): X402Accept | null {
  if (!value || typeof value !== "object") return null;
  const accept = value as Record<string, unknown>;
  if (accept.scheme !== "exact") return null;
  if (evmChainIdFromCaip2(accept.network) === null) return null;
  if (typeof accept.amountAtomic !== "string" || !/^\d+$/.test(accept.amountAtomic)) return null;
  if (typeof accept.asset !== "string" || !isAddress(accept.asset)) return null;
  if (typeof accept.payTo !== "string" || !isAddress(accept.payTo)) return null;
  if (typeof accept.assetName !== "string" || typeof accept.assetVersion !== "string") return null;
  // The seller compares `accepted` against what it published, so the original
  // object has to survive the round trip through the browser intact.
  if (!accept.raw || typeof accept.raw !== "object" || Array.isArray(accept.raw)) return null;
  return accept as unknown as X402Accept;
}

function asAuthorization(value: unknown): TransferAuthorization | null {
  if (!value || typeof value !== "object") return null;
  const auth = value as Record<string, unknown>;
  for (const key of ["from", "to"]) {
    if (typeof auth[key] !== "string" || !isAddress(auth[key] as string)) return null;
  }
  for (const key of ["value", "validAfter", "validBefore"]) {
    if (typeof auth[key] !== "string" || !/^\d+$/.test(auth[key] as string)) return null;
  }
  if (typeof auth.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) return null;
  return auth as unknown as TransferAuthorization;
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
  const requestBody = body.requestBody === undefined ? {} : body.requestBody;

  const accept = asAccept(body.accept);
  if (!accept) return badRequest("accept_invalid", "A complete payment accept is required.");

  const authorization = asAuthorization(body.authorization);
  if (!authorization) return badRequest("authorization_invalid", "A complete signed authorization is required.");

  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return badRequest("signature_invalid", "A 65-byte signature is required.");
  }

  // The signed authorization and the accept it was built from must agree; a
  // mismatch means the client assembled the request wrongly and the seller
  // would reject it anyway, with the user's money already committed.
  if (authorization.to.toLowerCase() !== accept.payTo.toLowerCase()) {
    return badRequest("recipient_mismatch", "The signed recipient is not the endpoint's payee.");
  }
  if (authorization.value !== accept.amountAtomic) {
    return badRequest("amount_mismatch", "The signed amount is not the quoted amount.");
  }
  if (BigInt(authorization.value) > BigInt(Math.floor(ABSOLUTE_MAX_USDC * 1e6))) {
    return badRequest("amount_above_ceiling", "The signed amount exceeds the per-call ceiling.");
  }
  if (Number(authorization.validBefore) * 1000 <= Date.now()) {
    return badRequest("authorization_expired", "That authorization has already expired. Quote again.", 422);
  }

  /* The descriptor the challenge published, carried back through the browser
     untouched. Falling back to the URL keeps a v1-shaped seller working. */
  const resourceDescriptor = body.resourceDescriptor === undefined || body.resourceDescriptor === null
    ? resource
    : body.resourceDescriptor;

  const paymentHeader = encodePaymentHeader({
    accept,
    authorization,
    signature: signature as `0x${string}`,
    resource: resourceDescriptor,
  });

  let response: Response;
  try {
    response = await fetchWithSsrfProtection(resource, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [PAYMENT_SIGNATURE_HEADER]: paymentHeader,
      },
      body: method === "POST" ? JSON.stringify(requestBody) : undefined,
    });
  } catch (error) {
    if (error instanceof SSRFProtectionError) {
      return badRequest("resource_not_allowed", "That resource address is not allowed.", 422);
    }
    return badRequest("resource_unreachable", "The endpoint did not answer.", 502);
  }

  const text = await response.text().catch(() => "");
  const settlement = decodePaymentResponse(response.headers.get("x-payment-response"));

  // A second 402 means the seller refused the payment rather than the request.
  if (response.status === 402) {
    return NextResponse.json({
      settled: false,
      status: 402,
      code: "payment_rejected",
      message: "The endpoint rejected the signed payment. Nothing was transferred.",
      settlement,
      body: text.slice(0, 4_000),
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  return NextResponse.json({
    settled: response.ok,
    status: response.status,
    paidUsdc: Number(authorization.value) / 1e6,
    payTo: accept.payTo,
    network: accept.network,
    settlement,
    transaction: typeof settlement?.transaction === "string" ? settlement.transaction : null,
    result: parsed,
    body: parsed === null ? text.slice(0, MAX_RESULT_BYTES) : null,
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
