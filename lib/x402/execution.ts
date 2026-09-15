/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import { isAddress } from "viem";
import {
  closeBrowserX402Attempt,
  markBrowserX402Executing,
  openBrowserX402Attempt,
} from "../execution/browser-x402-ledger.ts";
import { classifyRelayFailure } from "../execution/relay-failure.ts";
import type { ExecutionState } from "../execution/types.ts";
import { readAuthorizationUsed } from "../execution/settlement-resolver.ts";
import { challengeSchemas, decodePaymentRequiredHeader, parseChallengeAccepts } from "../providers/x402-probe.ts";
import type { JsonSchema } from "../seller/json-schema.ts";
import { fetchWithSsrfProtection, SSRFProtectionError } from "../seller/ssrf.ts";
import {
  challengeResource,
  decodePaymentResponse,
  encodePaymentHeader,
  evmChainIdFromCaip2,
  PAYMENT_SIGNATURE_HEADER,
  selectPayableAccept,
  X402PaymentError,
  type TransferAuthorization,
  type X402Accept,
} from "./browser-payment.ts";
import { verifyPostCall, type PostCallVerification } from "./post-call-verification.ts";
import { checkRequestBody } from "./request-body.ts";
import { loadEndpointObservations, summariseEndpointHistory } from "./trust-api/observations.ts";
import { normalizeResourceUrl, resourceKeyFor } from "./trust-api/resource.ts";
import { isUsdcAsset } from "./usdc-assets.ts";

/**
 * One x402 purchase, from quote to settled result.
 *
 * This is the only place either surface pays anything. /run had it inline and
 * Nova was about to grow a second copy, which is the version of this mistake
 * that actually hurts: two payment paths do not diverge in some visible way,
 * they diverge in one of the seven checks below, on the surface nobody is
 * testing, months later.
 *
 * Split in two because a signature happens in between and it happens in the
 * user's wallet, not here. Veyra never holds a key on either side of that gap:
 * `quote` reads a public challenge and hands back something to sign, `settle`
 * carries a signature it cannot alter. The EIP-3009 authorization commits to
 * the amount, the recipient and a validity window, so nothing in this file can
 * change any of them -- the checks exist to catch a malformed caller, not to
 * protect the user from this server. Their signature already does that.
 */

/** Ceiling in USDC that any single browser-signed call may quote, independent
 *  of what a decision authorized. A bug upstream should not be able to present
 *  a life-changing number to a wallet. */
export const X402_ABSOLUTE_MAX_USDC = 5;

const MAX_RESULT_BYTES = 200_000;

export type X402QuoteRequest = {
  resource: string;
  method: "GET" | "POST";
  requestBody: unknown;
  maxAmountUsdc: number;
  /** The catalog's declared request schema, when the caller carries one. */
  inputSchema?: Record<string, unknown> | null;
};

export type X402Quote = {
  resource: string;
  method: "GET" | "POST";
  accept: X402Accept;
  quotedUsdc: number;
  maxAmountUsdc: number;
  nonce: `0x${string}`;
  resourceDescriptor: unknown;
  inputSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
  quotedAt: string;
};

export type X402QuoteOutcome =
  | { kind: "quoted"; quote: X402Quote }
  /** The endpoint answered without asking for payment. Nothing to sign. */
  | { kind: "free"; status: number; body: string }
  | {
      kind: "refused";
      status: number;
      code: string;
      message: string;
      /** Returned on a schema refusal so the caller can repair the body rather
       *  than guess a second time. */
      inputSchema?: JsonSchema | null;
    };

function refuse(code: string, message: string, status = 400): X402QuoteOutcome {
  return { kind: "refused", code, message, status };
}

/**
 * Quotes a resource for a payment the *user's* wallet will sign.
 *
 * The server fetches the live 402 challenge -- a browser cannot, because sellers
 * do not send CORS headers -- and returns the exact terms to sign. It never
 * holds a key and never sees one: the reply is public information plus a nonce.
 *
 * The price is read from the challenge raised by *this* request body, because
 * x402 prices per call: the same endpoint quoted 0 for an empty body and 1000
 * atomic units for a real one.
 */
export async function quoteX402Call(input: X402QuoteRequest): Promise<X402QuoteOutcome> {
  const resource = input.resource.trim();
  if (!resource) return refuse("resource_required", "resource is required.");

  const method = input.method === "GET" ? "GET" : "POST";
  const maxAmountUsdc = Number(input.maxAmountUsdc);
  if (!Number.isFinite(maxAmountUsdc) || maxAmountUsdc <= 0 || maxAmountUsdc > X402_ABSOLUTE_MAX_USDC) {
    return refuse("max_amount_invalid", `maxAmountUsdc must be between 0 and ${X402_ABSOLUTE_MAX_USDC}.`);
  }
  /* Deliberately not filtered to the wallet's current chain. The clearance is
     issued on Arc while most of the x402 catalog sits on Base, so the honest
     answer is which chain this call must be paid on -- the caller then asks the
     wallet to switch for one signature. Filtering here would report a payable
     endpoint as unpayable. */

  const requestBody = input.requestBody === undefined ? {} : input.requestBody;

  /* Refuse to quote a request the provider's own schema calls invalid. x402
     charges for the call, not for a useful answer, so a malformed body is money
     spent on a rejection -- and that is not a theoretical risk, it happened. */
  const bodyCheck = checkRequestBody(
    requestBody,
    input.inputSchema && typeof input.inputSchema === "object" && !Array.isArray(input.inputSchema)
      ? input.inputSchema as Record<string, unknown>
      : null,
  );
  if (!bodyCheck.ok) {
    return refuse(
      "request_body_invalid",
      `The provider's published schema rejects this request at ${bodyCheck.path}: ${bodyCheck.message}. Nothing was quoted and nothing was spent.`,
      422,
    );
  }

  let response: Response;
  try {
    response = await fetchWithSsrfProtection(resource, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: method === "POST" ? JSON.stringify(requestBody) : undefined,
    });
  } catch (error) {
    if (error instanceof SSRFProtectionError) {
      return refuse("resource_not_allowed", "That resource address is not allowed.", 422);
    }
    return refuse("resource_unreachable", "The endpoint did not answer.", 502);
  }

  // Already free, or already paid for: there is nothing to sign.
  if (response.status !== 402) {
    const text = await response.text().catch(() => "");
    return { kind: "free", status: response.status, body: text.slice(0, 20_000) };
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
      return refuse(error.code, error.message, 422);
    }
    throw error;
  }

  if (!isUsdcAsset(accept.chainId, accept.asset)) {
    return refuse(
      "asset_not_usdc",
      `This endpoint prices in ${accept.asset} on chain ${accept.chainId}, which is not the USDC contract Veyra quotes.`,
      422,
    );
  }

  /* The last line of defence, and the only one that sees both the live
     challenge and the body about to be paid for. Sellers publish the request
     schema inside `accepts[].outputSchema.input`, which the catalog entry may
     omit entirely -- so a body that passed the check above on "no schema, not
     checked" can still be refused here on the provider's own published rules.
     The schema is returned with the refusal so the caller can repair the body
     rather than guess again. */
  const published = challengeSchemas(parseChallengeAccepts(challenge));
  const publishedCheck = checkRequestBody(requestBody, published.input);
  if (!publishedCheck.ok) {
    return {
      kind: "refused",
      status: 422,
      code: "request_body_invalid",
      message: `The provider's published schema rejects this request at ${publishedCheck.path}: ${publishedCheck.message}. Nothing was quoted and nothing was spent.`,
      inputSchema: published.input,
    };
  }

  return {
    kind: "quoted",
    quote: {
      resource,
      method,
      accept,
      quotedUsdc: Number(accept.amountAtomic) / 1e6,
      maxAmountUsdc,
      // 32 bytes, generated here so a replayed quote cannot reuse an old one.
      nonce: `0x${randomBytes(32).toString("hex")}`,
      // The challenge's own resource descriptor, echoed back when the payment is
      // relayed. v2 publishes an object here, not the URL.
      resourceDescriptor: challengeResource(challenge),
      // Published by the endpoint itself, so the caller can validate and display
      // the request shape even when the catalog entry declares none.
      inputSchema: published.input,
      outputSchema: published.output,
      quotedAt: new Date().toISOString(),
    },
  };
}

/* ---- settlement ---- */

export type X402SettleRequest = {
  resource: string;
  method: "GET" | "POST";
  requestBody: unknown;
  accept: X402Accept;
  authorization: TransferAuthorization;
  signature: `0x${string}`;
  resourceDescriptor?: unknown;
  /** The tier asked for verification; this is what makes it happen rather than
   *  merely be announced. */
  verificationRequired?: boolean;
  declaredOutputSchema?: unknown;
  /** Files this purchase against the decision that authorized it, instead of
   *  leaving the decision log blank while money moves. */
  selectionId?: string | null;
  selectionHash?: string | null;
  clearanceDigest?: string | null;
  counterpartyAgentId?: string | null;
  capability?: string | null;
};

export type X402SettleResult = {
  settled: boolean;
  /** Null when the decision log itself could not be written. The purchase
   *  still happened; pretending otherwise is what loses money from a record. */
  executionId: string | null;
  executionState: string | null;
  /** Payment, as the seller receipted it -- not inferred from the HTTP status. */
  paid: boolean | null;
  status: number;
  paidUsdc: number;
  payTo: string;
  network: string;
  latencyMs: number;
  settlement: Record<string, unknown> | null;
  transaction: string | null;
  verification: PostCallVerification;
  result: unknown;
  body: string | null;
};

export type X402SettleOutcome =
  | { kind: "settled"; result: X402SettleResult }
  /** The seller refused the signed payment rather than the request. */
  | {
      kind: "payment_rejected";
      executionId: string | null;
      status: 402;
      message: string;
      /** What the refusal was actually recorded as. A seller that says no is
       *  not always a seller that took nothing, so this is SETTLEMENT_FAILED
       *  only when the token confirms the authorization is unspent. */
      executionState: ExecutionState | null;
      /** What this refusal may have cost. Zero only when the chain confirmed
       *  the authorization is unspent; otherwise the full authorized amount,
       *  because a budget that under-counts an unresolved charge is a budget
       *  that lets the next one through. */
      paidUsdc: number;
      settlement: Record<string, unknown> | null;
      body: string;
    }
  | { kind: "refused"; status: number; code: string; message: string };

/** The provider's published output schema, when the caller carries one through
 *  from the catalog entry. Anything else is ignored rather than trusted. */
function asOutputSchema(value: unknown): JsonSchema | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonSchema
    : null;
}

export function asX402Accept(value: unknown): X402Accept | null {
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

export function asTransferAuthorization(value: unknown): TransferAuthorization | null {
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

/**
 * Relays a payment the user already signed, and returns what they bought.
 *
 * Veyra adds nothing to the money here. The authorization commits to the
 * amount, the recipient and a validity window, so this function cannot change
 * any of them -- it can only carry the signature to the seller or fail to.
 */
export async function settleX402Call(input: X402SettleRequest): Promise<X402SettleOutcome> {
  const resource = input.resource.trim();
  if (!resource) return { kind: "refused", status: 400, code: "resource_required", message: "resource is required." };
  const method = input.method === "GET" ? "GET" : "POST";
  const requestBody = input.requestBody === undefined ? {} : input.requestBody;
  const { accept, authorization, signature } = input;

  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { kind: "refused", status: 400, code: "signature_invalid", message: "A 65-byte signature is required." };
  }

  // The signed authorization and the accept it was built from must agree; a
  // mismatch means the caller assembled the request wrongly and the seller
  // would reject it anyway, with the user's money already committed.
  if (authorization.to.toLowerCase() !== accept.payTo.toLowerCase()) {
    return { kind: "refused", status: 400, code: "recipient_mismatch", message: "The signed recipient is not the endpoint's payee." };
  }
  if (authorization.value !== accept.amountAtomic) {
    return { kind: "refused", status: 400, code: "amount_mismatch", message: "The signed amount is not the quoted amount." };
  }
  if (BigInt(authorization.value) > BigInt(Math.floor(X402_ABSOLUTE_MAX_USDC * 1e6))) {
    return { kind: "refused", status: 400, code: "amount_above_ceiling", message: "The signed amount exceeds the per-call ceiling." };
  }
  if (Number(authorization.validBefore) * 1000 <= Date.now()) {
    return { kind: "refused", status: 422, code: "authorization_expired", message: "That authorization has already expired. Quote again." };
  }

  /* The authorization is real from here on, so the decision log must know about
     it regardless of how the relay turns out. Opening before the call is what
     makes a purchase that fails mid-flight visible instead of invisible. */
  const executionId = await openBrowserX402Attempt({
    selectionId: typeof input.selectionId === "string" ? input.selectionId : `vms_browser_${Date.now()}`,
    selectionHash: typeof input.selectionHash === "string" ? input.selectionHash : "0x",
    clearanceDigest: typeof input.clearanceDigest === "string" ? input.clearanceDigest : null,
    counterpartyAgentId: typeof input.counterpartyAgentId === "string"
      ? input.counterpartyAgentId
      : `x402:${new URL(resource).host}`,
    counterpartyWallet: accept.payTo,
    capability: typeof input.capability === "string" ? input.capability : "x402_purchase",
    resource,
    quotedUsdc: Number(accept.amountAtomic) / 1e6,
    authorizedUsdc: Number(authorization.value) / 1e6,
    payerWallet: authorization.from,
    payTo: accept.payTo,
    asset: accept.asset,
    network: accept.network,
    authorizedAtomic: authorization.value,
    authorizationNonce: authorization.nonce,
    authorizationSignature: signature,
    authorizationValidBefore: Number(authorization.validBefore),
  });

  /* The descriptor the challenge published, carried back through the browser
     untouched. Falling back to the URL keeps a v1-shaped seller working. */
  const resourceDescriptor = input.resourceDescriptor === undefined || input.resourceDescriptor === null
    ? resource
    : input.resourceDescriptor;

  const paymentHeader = encodePaymentHeader({
    accept,
    authorization,
    signature,
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
    /* Where in the call it broke decides what may be recorded.
     *
     * This used to close every one of these as FAILED, which reads as "no money
     * moved" -- an assertion this server cannot make once the PAYMENT-SIGNATURE
     * header has left it, because the nonce inside is redeemable on chain
     * whether or not a response ever came back. A hostname that does not
     * resolve is genuinely nothing; a socket that died waiting is not.
     * classifyRelayFailure is what tells the two apart, and anything it cannot
     * place goes in the cautious bucket and is reconciled against the token. */
    await closeBrowserX402Attempt({
      executionId,
      relayFailure: classifyRelayFailure(error),
      settlementSuccess: null,
      httpOk: false,
      paidUsdc: 0,
      transaction: null,
      verification: null,
    });
    if (error instanceof SSRFProtectionError) {
      return { kind: "refused", status: 422, code: "resource_not_allowed", message: "That resource address is not allowed." };
    }
    return { kind: "refused", status: 502, code: "resource_unreachable", message: "The endpoint did not answer." };
  }

  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  const text = await response.text().catch(() => "");
  /* v2 sellers publish the receipt as `PAYMENT-RESPONSE`; only v1 prefixed it
     with `X-`. Reading one spelling dropped the settlement reference from every
     conformant v2 seller, including Veyra's own. */
  const settlement = decodePaymentResponse(
    response.headers.get("payment-response") ?? response.headers.get("x-payment-response"),
  );

  /* A second 402 means the seller refused the payment rather than the request
     -- and that is a statement of its intent, not a fact about the chain. The
     authorization it was handed is redeemable by whoever holds it, and
     answering 402 costs nothing to a seller that has already redeemed it. So
     the refusal is checked against the token rather than believed. */
  if (response.status === 402) {
    const authorizationUsed = await readAuthorizationUsed({
      network: accept.network,
      asset: accept.asset,
      payer: authorization.from,
      nonce: authorization.nonce,
    });
    const closedRefusal = await closeBrowserX402Attempt({
      executionId,
      paymentRefused: true,
      authorizationUsed,
      settlementSuccess: authorizationUsed === null ? null : authorizationUsed,
      httpOk: false,
      paidUsdc: Number(authorization.value) / 1e6,
      transaction: null,
      verification: null,
    });
    return {
      kind: "payment_rejected",
      executionId,
      status: 402,
      message: authorizationUsed === true
        ? "The endpoint rejected the request after redeeming the payment. The money is gone."
        : authorizationUsed === false
        ? "The endpoint rejected the signed payment. The authorization is unspent."
        : "The endpoint rejected the signed payment. Whether the authorization was redeemed could not be checked yet.",
      executionState: closedRefusal?.state ?? null,
      paidUsdc: authorizationUsed === false ? 0 : Number(authorization.value) / 1e6,
      settlement,
      body: text.slice(0, 4_000),
    };
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
    declaredOutputSchema: asOutputSchema(input.declaredOutputSchema),
    latencyP95Ms,
    required: input.verificationRequired === true,
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

  return {
    kind: "settled",
    result: {
      // A purchase that was paid for but failed the verification its own tier
      // demanded is not a success, and must not be reported as one.
      settled: response.ok && verification.verdict !== "FAIL" && settlementSuccess !== false,
      executionId,
      executionState: closed?.state ?? null,
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
    },
  };
}
