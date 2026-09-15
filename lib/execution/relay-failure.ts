/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether a failed HTTP call could have delivered its payment authorization.
 *
 * Both halves of Veyra's x402 relay used to answer this the same way: the call
 * threw, therefore nothing was paid, therefore FAILED and release the budget.
 * That is true of a hostname that does not resolve and false of a socket that
 * died waiting for the response -- and in the second case the PAYMENT-SIGNATURE
 * header, with a nonce the seller can redeem on chain at its leisure, has
 * already left this machine. Recording "no money moved" there is not caution.
 * It is an assertion Veyra cannot see far enough to make.
 *
 * So the question is answered by where in the connection the failure happened,
 * and anything not positively known to be too early is treated as too late.
 */
export type RelayFailure =
  /** The request never reached the peer: no socket, no TLS, no bytes. */
  | "not_dispatched"
  /** It may have. Nothing can be assumed about the money. */
  | "possibly_dispatched";

/**
 * Failures that can only occur before the first byte of a request is written.
 *
 * Deliberately a short list of causes with unambiguous meanings. Name
 * resolution, connect and TLS handshake all complete before undici writes
 * headers, so a failure in any of them proves the seller saw nothing.
 *
 * What is missing from this list matters more than what is in it. ECONNRESET,
 * EPIPE, ETIMEDOUT, the undici headers and body timeouts and every abort land
 * in the other bucket, because each of them can happen with the request already
 * on the wire.
 */
const BEFORE_ANY_BYTES = new Set([
  // DNS
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  // Connect
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EACCES",
  "UND_ERR_CONNECT_TIMEOUT",
  // TLS handshake
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  // Never left this process at all
  "ERR_INVALID_URL",
  "ERR_INVALID_PROTOCOL",
]);

/** Refused by our own egress rules, so no request was ever made. */
const REFUSED_LOCALLY = new Set(["SSRFProtectionError"]);

/**
 * Walks the cause chain for a code.
 *
 * fetch reports almost everything as `TypeError: fetch failed` and hangs the
 * real reason off `cause`, sometimes more than one level down. Reading only the
 * top-level error would put every network failure in the unknown bucket, which
 * is safe but useless -- a hostname typo would hold a budget reservation open.
 */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") codes.push(candidate.code);
    if (typeof candidate.name === "string") codes.push(candidate.name);
    current = candidate.cause;
  }
  return codes;
}

export function classifyRelayFailure(error: unknown): RelayFailure {
  const codes = codesOf(error);
  if (codes.some((code) => REFUSED_LOCALLY.has(code))) return "not_dispatched";
  if (codes.some((code) => BEFORE_ANY_BYTES.has(code))) return "not_dispatched";
  /* Unknown means unknown. The expensive mistake here is one-directional: an
     unresolved attempt costs a reservation and a reconciliation read, while a
     wrongly terminal one loses a real payment out of the record. */
  return "possibly_dispatched";
}
