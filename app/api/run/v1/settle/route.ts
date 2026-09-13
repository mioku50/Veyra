/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { fetchWithSsrfProtection, SSRFProtectionError } from "@/lib/seller/ssrf";
import type { JsonSchema } from "@/lib/seller/json-schema";
import {
  closeBrowserX402Attempt,
  markBrowserX402Executing,
  openBrowserX402Attempt,
} from "@/lib/execution/browser-x402-ledger";
import { verifyPostCall } from "@/lib/x402/post-call-verification";
import {
  loadEndpointObservations,
  summariseEndpointHistory,
} from "@/lib/x402/trust-api/observations";
import { normalizeResourceUrl, resourceKeyFor } from "@/lib/x402/trust-api/resource";
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

/** The provider's published output schema, when the caller carries one through
 *  from the catalog entry. Anything else is ignored rather than trusted. */
function asOutputSchema(value: unknown): JsonSchema | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonSchema
    : null;
}

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
  // The contract the signature is domain-separated by. It is the token for a
  // vanilla accept and Circle's GatewayWallet for a batched one, so it is
  // checked as an address rather than compared to `asset`.
  if (typeof accept.verifyingContract !== "string" || !isAddress(accept.verifyingContract)) return null;
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

  /* The authorization is real from here on, so the decision log must know about
     it regardless of how the relay turns out. Opening before the call is what
     makes a purchase that fails mid-flight visible instead of invisible. */
  const executionId = await openBrowserX402Attempt({
    selectionId: typeof body.selectionId === "string" ? body.selectionId : `vms_browser_${Date.now()}`,
    selectionHash: typeof body.selectionHash === "string" ? body.selectionHash : "0x",
    clearanceDigest: typeof body.clearanceDigest === "string" ? body.clearanceDigest : null,
    counterpartyAgentId: typeof body.counterpartyAgentId === "string"
      ? body.counterpartyAgentId
      : `x402:${new URL(resource).host}`,
    counterpartyWallet: accept.payTo,
    capability: typeof body.capability === "string" ? body.capability : "x402_purchase",
    resource,
    quotedUsdc: Number(accept.amountAtomic) / 1e6,
    authorizedUsdc: Number(authorization.value) / 1e6,
    payerWallet: authorization.from,
    payTo: accept.payTo,
    asset: accept.asset,
    network: accept.network,
    authorizedAtomic: authorization.value,
    authorizationNonce: authorization.nonce,
    authorizationSignature: signature as `0x${string}`,
    authorizationValidBefore: Number(authorization.validBefore),
  });

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

  // The relay is about to leave. AUTHORIZED can only reach EXECUTING, so this
  // is the step that makes every terminal state below legal.
  await markBrowserX402Executing(executionId);

  let response: Response;
  const startedAt = performance.now();
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
    // The signature left this server and nothing came back. Whether money moved
    // is unknown, so the attempt is closed as failed rather than abandoned
    // mid-flight in EXECUTING.
    await closeBrowserX402Attempt({
      executionId,
      relayFailed: true,
      settlementSuccess: null,
      httpOk: false,
      paidUsdc: 0,
      transaction: null,
      verification: null,
    });
    if (error instanceof SSRFProtectionError) {
      return badRequest("resource_not_allowed", "That resource address is not allowed.", 422);
    }
    return badRequest("resource_unreachable", "The endpoint did not answer.", 502);
  }

  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  const text = await response.text().catch(() => "");
  /* v2 sellers publish the receipt as `PAYMENT-RESPONSE`; only v1 prefixed it
     with `X-`. Reading one spelling dropped the settlement reference from every
     conformant v2 seller, including Veyra's own. */
  const settlement = decodePaymentResponse(
    response.headers.get("payment-response") ?? response.headers.get("x-payment-response"),
  );

  // A second 402 means the seller refused the payment rather than the request.
  if (response.status === 402) {
    await closeBrowserX402Attempt({
      executionId,
      paymentRefused: true,
      settlementSuccess: false,
      httpOk: false,
      paidUsdc: 0,
      transaction: null,
      verification: null,
    });
    return NextResponse.json({
      settled: false,
      executionId,
      status: 402,
      code: "payment_rejected",
      message: "The endpoint rejected the signed payment. Nothing was transferred.",
      settlement,
      body: text.slice(0, 4_000),
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  /* The verification the tier demanded, actually run.
     REQUIRE_EVALUATOR used to print "Needs evaluator" next to an enabled
     Authorize button and then verify nothing. A tier that requires
     verification now gets it, and its verdict is what decides whether this
     purchase counts as successful. */
  let latencyP95Ms: number | null = null;
  try {
    const key = resourceKeyFor(method, normalizeResourceUrl(resource));
    const history = summariseEndpointHistory(key, await loadEndpointObservations(key));
    latencyP95Ms = history.statisticalEvidenceAvailable ? history.metrics.latencyP95Ms : null;
  } catch {
    latencyP95Ms = null;
  }

  const verification = verifyPostCall({
    httpStatus: response.status,
    bodyText: text,
    parsedBody: parsed,
    latencyMs,
    quotedAtomic: accept.amountAtomic,
    authorizedAtomic: authorization.value,
    payTo: accept.payTo,
    settlement,
    declaredOutputSchema: asOutputSchema(body.declaredOutputSchema),
    latencyP95Ms,
    required: body.verificationRequired === true,
  });

  /* Two different facts, never conflated again. A seller can settle the x402
     authorization and then fail in its own application layer; reading payment
     off the HTTP status would lose that money from the record entirely. */
  const settlementSuccess = typeof settlement?.success === "boolean" ? settlement.success : null;
  const closed = await closeBrowserX402Attempt({
    executionId,
    settlementSuccess,
    httpOk: response.ok,
    paidUsdc: Number(authorization.value) / 1e6,
    transaction: typeof settlement?.transaction === "string" ? settlement.transaction : null,
    verification,
  });

  return NextResponse.json({
    // A purchase that was paid for but failed the verification its own tier
    // demanded is not a success, and must not be reported as one.
    settled: response.ok && verification.verdict !== "FAIL" && settlementSuccess !== false,
    executionId,
    executionState: closed?.state ?? null,
    // Payment, as the seller receipted it — not inferred from the HTTP status.
    paid: settlementSuccess,
    status: response.status,
    paidUsdc: Number(authorization.value) / 1e6,
    payTo: accept.payTo,
    network: accept.network,
    latencyMs,
    settlement,
    transaction: typeof settlement?.transaction === "string" ? settlement.transaction : null,
    verification,
    result: parsed,
    body: parsed === null ? text.slice(0, MAX_RESULT_BYTES) : null,
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
