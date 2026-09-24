/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import { isAddress, keccak256, stringToBytes } from "viem";
import { CanonicalRequestError, canonicalRequestHash } from "../canonical-request.ts";
import {
  closeBrowserX402Attempt,
  markBrowserX402Executing,
  openBrowserX402Attempt,
} from "../execution/browser-x402-ledger.ts";
import { classifyRelayFailure } from "../execution/relay-failure.ts";
import type { ExecutionState } from "../execution/types.ts";
import { proofFromReceipt } from "../execution/settlement-proof.ts";
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
import {
  advanceX402Quote,
  claimX402Quote,
  createX402Quote,
  fetchX402Selection,
  type X402Decision,
} from "./decision-store.ts";
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

/** How long Veyra will still carry a signature made against a quote.
 *
 *  Not the authorization's own validity window, which belongs to the chain and
 *  which Circle's batched rail requires to be a week. This is how long this
 *  server is willing to relay, and it is capped again by the decision's expiry:
 *  a permission to spend must not outlive the evidence it was granted on. */
export const X402_QUOTE_TTL_MS = 180_000;

export type X402QuoteRequest = {
  /** The decision this purchase is authorized by. Everything the server needs
   *  is read from it: the endpoint, the method, the ceiling, the tier. */
  selectionId: string;
  /** The authenticated caller. Never a field in the request body. */
  ownerWallet: `0x${string}`;
  requestBody: unknown;
};

export type X402Quote = {
  /** What settle will present instead of a description of the purchase. */
  quoteId: string;
  selectionId: string;
  resource: string;
  method: "GET" | "POST";
  accept: X402Accept;
  quotedUsdc: number;
  maxAmountUsdc: number;
  nonce: `0x${string}`;
  resourceDescriptor: unknown;
  inputSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
  /** The tier's demand, decided by the engine and recorded, rather than a
   *  boolean the buyer sends about its own purchase. */
  verificationRequired: boolean;
  decision: X402Decision;
  quotedAt: string;
  expiresAt: string;
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
/**
 * What an endpoint would charge for this exact body, authorizing nothing.
 *
 * Quoting and deciding are two different acts, and until now one function did
 * both badly. A payment quote must rest on a Veyra decision -- that is the
 * whole of F4. But a decision is partly *made* by asking what things cost, and
 * an endpoint that charges per call answers a different price to an empty
 * request, so the free probe cannot stand in for it.
 *
 * So the price check is its own operation: it sends the body, reads the
 * challenge, and returns the terms without writing anything and without
 * implying that anyone may act on them. Nothing it returns can be signed
 * against -- there is no nonce and no quote id, and settle takes neither of
 * those from a caller.
 */
/**
 * Terms as observed, with nothing in them that could be acted on.
 *
 * Shaped like a quote because a card showing a price needs the same fields, and
 * deliberately missing the three that authorize: no quote id, no nonce, no
 * decision. Settle takes none of them from a caller, so a set of priced terms
 * cannot be turned into a payment by anyone holding it.
 */
export type X402PricedTerms = {
  resource: string;
  method: "GET" | "POST";
  accept: X402Accept;
  quotedUsdc: number;
  maxAmountUsdc: number;
  resourceDescriptor: unknown;
  inputSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
  quotedAt: string;
};

export type X402PriceOutcome =
  | { kind: "priced"; quote: X402PricedTerms }
  | { kind: "free"; status: number; body: string }
  | { kind: "refused"; status: number; code: string; message: string; inputSchema?: JsonSchema | null };

export async function priceX402Call(input: {
  resource: string;
  method: "GET" | "POST";
  requestBody: unknown;
  maxAmountUsdc: number;
  inputSchema?: Record<string, unknown> | null;
  /** The listing's own network, payee and asset. Priced on anything else, a
   *  card would show terms the decision taken on that listing cannot quote. */
  match?: X402AcceptMatch;
}): Promise<X402PriceOutcome> {
  const resource = input.resource.trim();
  if (!resource) return { kind: "refused", status: 400, code: "resource_required", message: "resource is required." };
  const method = input.method === "GET" ? "GET" : "POST";
  const maxAmountUsdc = Number(input.maxAmountUsdc);
  if (!Number.isFinite(maxAmountUsdc) || maxAmountUsdc <= 0 || maxAmountUsdc > X402_ABSOLUTE_MAX_USDC) {
    return { kind: "refused", status: 400, code: "max_amount_invalid", message: `maxAmountUsdc must be between 0 and ${X402_ABSOLUTE_MAX_USDC}.` };
  }
  const requestBody = input.requestBody === undefined ? {} : input.requestBody;

  const observed = await observeX402Challenge({
    resource,
    method,
    requestBody,
    maxAtomic: BigInt(Math.floor(maxAmountUsdc * 1e6)),
    catalogSchema: input.inputSchema ?? null,
    match: input.match,
  });
  if (observed.kind !== "challenged") return observed;
  return {
    kind: "priced",
    quote: {
      resource,
      method,
      accept: observed.accept,
      quotedUsdc: Number(observed.accept.amountAtomic) / 1e6,
      maxAmountUsdc,
      resourceDescriptor: observed.resourceDescriptor,
      inputSchema: observed.inputSchema,
      outputSchema: observed.outputSchema,
      quotedAt: new Date().toISOString(),
    },
  };
}

/**
 * The live 402, read once and shared by both callers above.
 *
 * Two copies of this would be two chances for the price a decision was made on
 * and the price a signature pays to come from subtly different checks.
 */
type ObservedChallenge =
  | {
      kind: "challenged";
      accept: X402Accept;
      challenge: unknown;
      paymentRequiredHeader: string | null;
      resourceDescriptor: unknown;
      inputSchema: JsonSchema | null;
      outputSchema: JsonSchema | null;
    }
  | { kind: "free"; status: number; body: string }
  | { kind: "refused"; status: number; code: string; message: string; inputSchema?: JsonSchema | null };

export type X402AcceptMatch = { network?: string | null; payTo?: string | null; asset?: string | null };

async function observeX402Challenge(input: {
  resource: string;
  method: "GET" | "POST";
  requestBody: unknown;
  maxAtomic: bigint;
  catalogSchema?: Record<string, unknown> | null;
  match?: X402AcceptMatch;
}): Promise<ObservedChallenge> {
  if (input.method === "GET" && input.requestBody != null
    && !(typeof input.requestBody === "object" && !Array.isArray(input.requestBody)
      && Object.keys(input.requestBody).length === 0)) {
    // GET transport below has no body. Never price a question that would be
    // silently discarded. Query parameters need an explicitly bound URL;
    // appending them here would change the resource approved by selection.
    return {
      kind: "refused", status: 422, code: "get_request_body_unsupported",
      message: "This GET endpoint needs its parameters in the approved URL. A request body would not be sent. Nothing was quoted or spent.",
    };
  }
  /* Refuse before spending a round trip when the catalog already publishes a
     shape this body violates. Advisory: the endpoint's own published schema,
     read out of the live challenge below, is the check that protects money. */
  if (input.catalogSchema) {
    const catalogCheck = checkRequestBody(input.requestBody, input.catalogSchema);
    if (!catalogCheck.ok) {
      return {
        kind: "refused",
        status: 422,
        code: "request_body_invalid",
        message: `The provider's published schema rejects this request at ${catalogCheck.path}: ${catalogCheck.message}. Nothing was quoted and nothing was spent.`,
      };
    }
  }

  let response: Response;
  try {
    response = await fetchWithSsrfProtection(input.resource, {
      method: input.method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: input.method === "POST" ? JSON.stringify(input.requestBody) : undefined,
    });
  } catch (error) {
    if (error instanceof SSRFProtectionError) {
      return { kind: "refused", status: 422, code: "resource_not_allowed", message: "That resource address is not allowed." };
    }
    return { kind: "refused", status: 502, code: "resource_unreachable", message: "The endpoint did not answer." };
  }

  // Already free, or already paid for: there is nothing to sign.
  if (response.status !== 402) {
    const text = await response.text().catch(() => "");
    return { kind: "free", status: response.status, body: text.slice(0, 20_000) };
  }

  const paymentRequiredHeader = response.headers.get("payment-required");
  const headerChallenge = decodePaymentRequiredHeader(paymentRequiredHeader);
  const challenge = headerChallenge ?? await response.json().catch(() => null);

  let accept: X402Accept;
  try {
    accept = selectPayableAccept(challenge, { maxAtomic: input.maxAtomic, match: input.match });
  } catch (error) {
    if (error instanceof X402PaymentError) {
      return { kind: "refused", status: 422, code: error.code, message: error.message };
    }
    throw error;
  }

  if (!isUsdcAsset(accept.chainId, accept.asset)) {
    return {
      kind: "refused",
      status: 422,
      code: "asset_not_usdc",
      message: `This endpoint prices in ${accept.asset} on chain ${accept.chainId}, which is not the USDC contract Veyra quotes.`,
    };
  }

  /* The provider's own published rules, read out of the live challenge. The
     catalog entry may declare no schema at all, so this is the check that
     actually protects the money: x402 charges for the call, not for a useful
     answer, and a malformed body is money spent on a rejection. The schema goes
     back with the refusal so the caller repairs the body rather than guessing
     a second time. */
  const published = challengeSchemas(parseChallengeAccepts(challenge));
  const publishedCheck = checkRequestBody(input.requestBody, published.input);
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
    kind: "challenged",
    accept,
    challenge,
    paymentRequiredHeader,
    resourceDescriptor: challengeResource(challenge),
    inputSchema: published.input,
    outputSchema: published.output,
  };
}

export async function quoteX402Call(input: X402QuoteRequest): Promise<X402QuoteOutcome> {
  /* The decision comes first, and everything else comes from it.
   *
   * This used to take the endpoint, the method and the ceiling from the caller,
   * price whatever it was handed, and leave the question of whether Veyra had
   * approved any of it to the settle step -- which asked the same caller. The
   * product's one sentence, that no payment happens without a Veyra decision,
   * was a convention rather than a mechanism. */
  const selectionId = typeof input.selectionId === "string" ? input.selectionId.trim() : "";
  if (!selectionId) return refuse("selection_required", "A Veyra decision is required before a price can be quoted.");

  const selection = await fetchX402Selection(selectionId);
  if (!selection) {
    return refuse(
      "selection_not_found",
      "No Veyra decision with that id. Decide again before paying.",
      404,
    );
  }
  if (selection.ownerWallet.toLowerCase() !== input.ownerWallet.toLowerCase()) {
    /* Not found rather than forbidden: whether somebody else holds a decision
       is not information this caller is entitled to. */
    return refuse("selection_not_found", "No Veyra decision with that id.", 404);
  }
  if (Date.parse(selection.expiresAt) <= Date.now()) {
    /* A recoverable outcome, not a failure. The decision is short-lived on
       purpose -- its whole value is that the evidence under it was fresh -- so
       the honest answer is to decide again, and the caller is told exactly
       that rather than being handed a stale permission to spend. */
    return refuse(
      "selection_expired",
      "That decision has expired. Veyra must look at this counterparty again before it can be paid.",
      409,
    );
  }

  const resource = selection.resource;
  const method = selection.method;
  /* The ceiling is the decision's, in atomic units, and it is never widened by
     anything a caller sends. The absolute per-call ceiling still applies on top
     of it: a bug upstream must not be able to put a life-changing number in
     front of a wallet. */
  const decidedAtomic = BigInt(selection.maxExposureAtomic);
  const absoluteAtomic = BigInt(Math.floor(X402_ABSOLUTE_MAX_USDC * 1e6));
  const maxAtomic = decidedAtomic < absoluteAtomic ? decidedAtomic : absoluteAtomic;
  if (maxAtomic <= BigInt(0)) {
    return refuse("decision_grants_no_exposure", "That decision authorizes no spend.", 409);
  }

  const requestBody = input.requestBody === undefined ? {} : input.requestBody;

  /* The binding, computed once here and checked once at settle. Everything that
     hashes a request body in this codebase goes through the same function, so a
     quote and the signature that pays for it cannot disagree about what "the
     same request" means. */
  let requestBodyHash: `0x${string}`;
  try {
    requestBodyHash = canonicalRequestHash(requestBody);
  } catch (error) {
    return refuse(
      "request_body_unrepresentable",
      error instanceof CanonicalRequestError ? error.message : "That request body cannot be hashed.",
      422,
    );
  }

  /* The accept is chosen from the decision's own terms. The decision already
     binds network, payee and asset, and the quote store refuses anything
     else; choosing by price alone picked whichever of several equal offers
     the seller listed first, and refused the purchase over it. */
  const observed = await observeX402Challenge({
    resource, method, requestBody, maxAtomic,
    match: { network: selection.settlementNetwork, payTo: selection.payTo, asset: selection.asset },
  });
  if (observed.kind === "free") return observed;
  if (observed.kind === "refused") {
    return observed.inputSchema
      ? { kind: "refused", status: observed.status, code: observed.code, message: observed.message, inputSchema: observed.inputSchema }
      : refuse(observed.code, observed.message, observed.status);
  }
  const { accept, paymentRequiredHeader, resourceDescriptor, inputSchema, outputSchema } = observed;

  // 32 bytes, generated here so a replayed quote cannot reuse an old one.
  const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  /* Capped by the decision, never beyond it. */
  const expiresAt = new Date(Math.min(
    Date.now() + X402_QUOTE_TTL_MS,
    Date.parse(selection.expiresAt),
  )).toISOString();

  /* Written before anything is returned, and written by a function that reads
     the decision itself: payee, asset, chain, ceiling and expiry are compared
     inside the same transaction as the insert, so a quote that is not bound to
     a live decision does not exist for an instant. */
  const created = await createX402Quote({
    selectionId,
    ownerWallet: input.ownerWallet,
    requestBodyHash,
    amountAtomic: accept.amountAtomic,
    payTo: accept.payTo,
    asset: accept.asset,
    network: accept.network,
    verifyingContract: accept.verifyingContract,
    gatewayBatched: accept.gatewayBatched,
    paymentRequirementsHash: paymentRequiredHeader
      ? keccak256(stringToBytes(paymentRequiredHeader))
      : null,
    authorizationNonce: nonce,
    challenge: {
      accept: accept as unknown as Record<string, unknown>,
      resourceDescriptor,
      inputSchema,
      outputSchema,
    },
    expiresAt,
  });

  if (!created.ok) {
    return refuse(
      QUOTE_REFUSAL_CODES[created.reason] ? created.reason.toLowerCase() : "quote_not_authorized",
      QUOTE_REFUSAL_CODES[created.reason]
        ?? "Veyra's decision does not authorize this payment.",
      created.reason === "QUOTE_STORE_UNAVAILABLE" ? 503 : 409,
    );
  }

  return {
    kind: "quoted",
    quote: {
      quoteId: created.quoteId,
      selectionId,
      resource,
      method,
      accept,
      quotedUsdc: Number(accept.amountAtomic) / 1e6,
      maxAmountUsdc: Number(maxAtomic) / 1e6,
      nonce,
      resourceDescriptor,
      inputSchema,
      outputSchema,
      verificationRequired: created.verificationRequired,
      decision: created.decision,
      quotedAt: new Date().toISOString(),
      expiresAt: created.expiresAt,
    },
  };
}

/** What a refused binding means, said in the caller's terms rather than the
 *  database's. Each of these is a real disagreement between the live challenge
 *  and the decision, and none of them is retryable without deciding again. */
const SETTLE_REFUSAL_MESSAGES: Record<string, string> = {
  DAILY_CAP_EXCEEDED: "This wallet has reached what Veyra will relay for it today. Nothing was paid, and the authorization was never handed to the seller.",
  QUOTE_NOT_FOUND: "No quote with that id. Quote again before paying.",
  QUOTE_NOT_OWNED: "No quote with that id.",
  QUOTE_ALREADY_CLAIMED: "That quote has already been used. A signed authorization is relayed once and never re-sent -- if the result did not reach you, reconcile it rather than paying again.",
  QUOTE_EXPIRED: "That quote has expired. Quote again before paying.",
  QUOTE_STORE_UNAVAILABLE: "Veyra cannot confirm this authorization has not already been relayed, so it will not relay it. Retry shortly.",
};

const QUOTE_REFUSAL_CODES: Record<string, string> = {
  SELECTION_NOT_FOUND: "No Veyra decision with that id. Decide again before paying.",
  SELECTION_NOT_OWNED: "No Veyra decision with that id.",
  SELECTION_EXPIRED: "That decision has expired. Veyra must look at this counterparty again before it can be paid.",
  PAYEE_NOT_DECIDED: "This endpoint now asks to be paid at an address Veyra did not approve.",
  ASSET_NOT_DECIDED: "This endpoint now prices in a token Veyra did not approve.",
  NETWORK_NOT_DECIDED: "This endpoint now settles on a chain Veyra did not approve.",
  AMOUNT_ABOVE_DECIDED_CEILING: "This endpoint now asks for more than the decision allows.",
  QUOTE_OUTLIVES_SELECTION: "A quote cannot outlive the decision that authorized it.",
  QUOTE_STORE_UNAVAILABLE: "Veyra cannot record this authorization right now, so it will not start a payment. Retry shortly.",
};

/* ---- settlement ---- */

/**
 * Everything a settle may say for itself.
 *
 * Four fields, and none of them describes the purchase. The endpoint, the
 * method, the payee, the asset, the chain, the price, the capability, the
 * counterparty, the clearance and -- the one that mattered most -- whether the
 * tier demanded verification all used to arrive here in the request body, from
 * the same caller whose payment they were supposed to govern. They are read
 * from the quote and the decision now.
 *
 * The body is still sent, because the seller needs it. It is no longer a source
 * of truth: it is hashed and compared to what the quote priced, and a mismatch
 * refuses the relay.
 */
export type X402SettleRequest = {
  quoteId: string;
  /** The authenticated caller. Never a field in the request body. */
  ownerWallet: `0x${string}`;
  requestBody: unknown;
  authorization: TransferAuthorization;
  signature: `0x${string}`;
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
  const requestBody = input.requestBody === undefined ? {} : input.requestBody;
  const { authorization, signature } = input;

  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { kind: "refused", status: 400, code: "signature_invalid", message: "A 65-byte signature is required." };
  }
  const quoteId = typeof input.quoteId === "string" ? input.quoteId.trim() : "";
  if (!quoteId) {
    return { kind: "refused", status: 400, code: "quote_required", message: "A quote id is required." };
  }

  /* Won, not read.
   *
   * The compare-and-swap is what makes one signature pay once. Two settles
   * racing the same quote used to both relay, because nothing in the server
   * knew a quote existed; the loser here is told which state it is in and
   * relays nothing. Deliberately before every other check, so a request that
   * would be refused anyway cannot be used to probe whose quotes exist. */
  const claim = await claimX402Quote(quoteId, input.ownerWallet);
  if (!claim.ok) {
    return {
      kind: "refused",
      status: claim.reason === "QUOTE_STORE_UNAVAILABLE" ? 503 : claim.reason === "QUOTE_EXPIRED" ? 422 : 409,
      code: claim.reason.toLowerCase(),
      message: SETTLE_REFUSAL_MESSAGES[claim.reason]
        ?? "This payment is not authorized by a quote Veyra can act on.",
    };
  }
  const quote = claim.quote;

  /* From here a failure must leave the quote unusable rather than reusable, so
     everything that can refuse does so through this, which walks the claim back
     only when nothing was relayed. */
  const releaseClaim = async () => {
    await advanceX402Quote({ quoteId, expectedState: "CLAIMED", targetState: "QUOTED" });
  };

  const selection = await fetchX402Selection(quote.selectionId);
  if (!selection) {
    await releaseClaim();
    return { kind: "refused", status: 409, code: "selection_not_found", message: "The decision behind this quote is gone." };
  }

  /* The body is proof, not instruction. It is sent to the seller because the
     seller needs it; what it may no longer do is describe the purchase. If it
     is not the body the quote priced, this is a different call than the one
     Veyra approved and the price it was approved at means nothing. */
  let presentedHash: string;
  try {
    presentedHash = canonicalRequestHash(requestBody);
  } catch {
    await releaseClaim();
    return { kind: "refused", status: 422, code: "request_body_unrepresentable", message: "That request body cannot be hashed." };
  }
  if (presentedHash !== quote.requestBodyHash) {
    await releaseClaim();
    return {
      kind: "refused",
      status: 409,
      code: "request_body_changed",
      message: "This is not the request that was quoted. Quote again before paying.",
    };
  }

  /* The terms, rebuilt from what Veyra observed rather than from what came
     back through the browser. */
  const accept = quote.challenge.accept as unknown as X402Accept;
  const resource = quote.resource;
  const method = quote.method;

  if (authorization.from.toLowerCase() !== selection.ownerWallet.toLowerCase()) {
    await releaseClaim();
    return {
      kind: "refused",
      status: 403,
      code: "payer_not_owner",
      message: "The signed payer is not the wallet this decision was issued to.",
    };
  }
  if (authorization.to.toLowerCase() !== quote.payTo.toLowerCase()) {
    await releaseClaim();
    return { kind: "refused", status: 400, code: "recipient_mismatch", message: "The signed recipient is not the payee Veyra approved." };
  }
  if (authorization.value !== quote.amountAtomic) {
    await releaseClaim();
    return { kind: "refused", status: 400, code: "amount_mismatch", message: "The signed amount is not the quoted amount." };
  }
  /* The nonce the quote minted, and no other. Without this a signature made
     for one quote pays another at the same endpoint and price. */
  if (authorization.nonce.toLowerCase() !== quote.authorizationNonce.toLowerCase()) {
    await releaseClaim();
    return { kind: "refused", status: 400, code: "nonce_mismatch", message: "That authorization was signed for a different quote." };
  }
  if (BigInt(authorization.value) > BigInt(Math.floor(X402_ABSOLUTE_MAX_USDC * 1e6))) {
    await releaseClaim();
    return { kind: "refused", status: 400, code: "amount_above_ceiling", message: "The signed amount exceeds the per-call ceiling." };
  }
  if (Number(authorization.validBefore) * 1000 <= Date.now()) {
    await releaseClaim();
    return { kind: "refused", status: 422, code: "authorization_expired", message: "That authorization has already expired. Quote again." };
  }

  /* The authorization is real from here on, so the decision log must know about
     it regardless of how the relay turns out. Opening before the call is what
     makes a purchase that fails mid-flight visible instead of invisible. */
  const executionId = await openBrowserX402Attempt({
    selectionId: selection.selectionId,
    selectionHash: selection.selectionHash,
    clearanceDigest: selection.clearanceDigest ?? null,
    counterpartyAgentId: selection.candidateId,
    counterpartyWallet: quote.payTo,
    capability: selection.capability,
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
    verifyingContract: quote.verifyingContract,
    gatewayBatched: quote.gatewayBatched,
  });
  /* The descriptor the challenge published, as Veyra recorded it at quote time.
     Falling back to the URL keeps a v1-shaped seller working. */
  const resourceDescriptor = quote.challenge.resourceDescriptor === undefined || quote.challenge.resourceDescriptor === null
    ? resource
    : quote.challenge.resourceDescriptor;

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
    const relayFailure = classifyRelayFailure(error);
    /* The only walk-back there is. `not_dispatched` means the failure happened
       before a byte left this process -- a hostname that does not resolve, a
       refused connection -- so the authorization was never handed to anybody
       and the quote is honestly re-usable. Anything else stays claimed and is
       marked dispatched: after F3 a broken socket is not evidence that no money
       moved, and re-relaying on that reading is how one purchase gets paid for
       twice. */
    if (relayFailure === "not_dispatched") {
      await advanceX402Quote({ quoteId, expectedState: "CLAIMED", targetState: "QUOTED" });
    } else {
      await advanceX402Quote({ quoteId, expectedState: "CLAIMED", targetState: "DISPATCHED", executionId });
      await advanceX402Quote({ quoteId, expectedState: "DISPATCHED", targetState: "SETTLEMENT_UNVERIFIED", executionId });
    }
    await closeBrowserX402Attempt({
      executionId,
      relayFailure,
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

  /* It answered, so the authorization left. Recorded before anything is read
     out of the response, because what the seller says next cannot change the
     fact that it holds a redeemable signature. */
  await advanceX402Quote({ quoteId, expectedState: "CLAIMED", targetState: "DISPATCHED", executionId });

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
      gatewayBatched: accept.gatewayBatched,
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
    await advanceX402Quote({
      quoteId,
      expectedState: "DISPATCHED",
      targetState: authorizationUsed === false ? "SETTLEMENT_FAILED" : "SETTLEMENT_UNVERIFIED",
      executionId,
    });
    return {
      kind: "payment_rejected",
      executionId,
      status: 402,
      message: authorizationUsed === true
        ? "The endpoint rejected the request after redeeming the payment. The money is gone."
        : authorizationUsed === false
        ? "The endpoint rejected the signed payment. The authorization is unspent."
        /* Batched authorizations have no public per-purchase status at all, so
           this is permanent rather than pending -- said differently because
           "yet" would send someone back to check something that will never
           change. The authorization stays live until it expires either way. */
        : accept.gatewayBatched
        ? "The endpoint rejected the signed payment. Circle's batched rail publishes no per-payment status, so whether it was redeemed cannot be established."
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

  /* Two different facts, never conflated again. A seller can settle the x402
     authorization and then fail in its own application layer; reading payment
     off the HTTP status would lose that money from the record entirely. */
  const settlementSuccess = typeof settlement?.success === "boolean" ? settlement.success : null;
  const settlementTx = typeof settlement?.transaction === "string" ? settlement.transaction : null;

  /* Whose word this is, established before anything is verified against it.
   *
   * The receipt, its success flag and the transaction hash were all written by
   * the endpoint being assessed. Veyra recorded settled purchases on the
   * strength of them and computed that seller's reputation from them -- in a
   * product whose subject is whether sellers can be taken at their word. One
   * read of the token's spent-nonce bit either agrees or it does not, and
   * either answer is worth more than the header alone. A seller that reported
   * a failed settlement is not asked about: there is nothing to corroborate. */
  const onchainSpent = settlementSuccess === false ? null : await readAuthorizationUsed({
    network: accept.network,
    asset: accept.asset,
    payer: authorization.from,
    nonce: authorization.nonce,
    gatewayBatched: accept.gatewayBatched,
  });
  const settlementProof = onchainSpent === true
    ? "onchain_final" as const
    : proofFromReceipt({
        settlementSuccess,
        transaction: settlementTx,
        batched: accept.gatewayBatched,
      });

  const verification = verifyPostCall({
    httpStatus: response.status,
    bodyText: text,
    parsedBody: parsed,
    latencyMs,
    quotedAtomic: accept.amountAtomic,
    authorizedAtomic: authorization.value,
    payTo: accept.payTo,
    settlement,
    settlementProof,
    /* The schema the endpoint itself published, as Veyra read it at quote
       time. It used to come from the buyer, which made the post-call check
       measure a delivery against a shape the buyer supplied. */
    declaredOutputSchema: asOutputSchema(quote.challenge.outputSchema ?? null),
    latencyP95Ms,
    /* The tier's demand, read from the decision that issued it. It used to be
       a boolean in the settle body: the buyer declaring whether its own
       purchase needed verifying. */
    required: selection.verificationRequired,
  });

  const closed = await closeBrowserX402Attempt({
    executionId,
    settlementSuccess,
    settlementProof,
    httpOk: response.ok,
    paidUsdc: Number(authorization.value) / 1e6,
    transaction: settlementTx,
    verification,
  });

  await advanceX402Quote({
    quoteId,
    expectedState: "DISPATCHED",
    targetState: settlementSuccess === false ? "SETTLEMENT_FAILED" : "SETTLED",
    executionId,
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
