/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { keccak256, toBytes, type Hex } from "viem";
import { validateJsonSchemaValue, type JsonSchema } from "../seller/json-schema.ts";

/**
 * What Veyra checks after the money has already moved.
 *
 * REQUIRE_EVALUATOR used to be a label. The decision screen said "Needs
 * evaluator", offered "Authorize & pay", and then nothing evaluated anything -
 * which quietly inverted the product's own fail-closed promise. A tier that
 * demands verification has to actually verify, and the verdict of that
 * verification is what decides whether the purchase counts as successful.
 *
 * Every check here is deterministic and local to the exchange. Nothing is
 * asked of a model, because the question is not "is this answer good" - it is
 * "did the counterparty deliver what it was paid for, and can that be proven
 * later". A check that cannot be run returns null rather than passing.
 */

export type VerificationSeverity = "critical" | "major" | "minor";

export type VerificationCheck = {
  id: string;
  /** null means the check could not be run, which is never a pass. */
  passed: boolean | null;
  severity: VerificationSeverity;
  detail: string;
};

export type PostCallVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export type PostCallVerification = {
  verdict: PostCallVerdict;
  /** Whether the trust decision made this verification mandatory. */
  required: boolean;
  checks: VerificationCheck[];
  /** Commits to exactly what was delivered, so a later dispute has something
   *  to point at that neither side can rewrite. */
  responseHash: Hex;
  verifiedAt: string;
  summary: string;
};

export const POST_CALL_VERIFICATION_VERSION = "veyra-post-call-verification-v1" as const;

function looksLikeErrorEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!("error" in record) && !("errors" in record)) return false;
  const error = record.error ?? record.errors;
  // `{"error": null}` and `{"error": false}` are success envelopes in the wild.
  return error !== null && error !== false && error !== "" && error !== undefined;
}

/**
 * What the endpoint itself said went wrong, quoted rather than summarised.
 *
 * A live purchase showed nine verification lines and not one of them carried
 * the sentence that actually explained it — the endpoint had replied
 * `Required parameter(s) not provided: q. No payment was charged.` Withholding
 * the seller's own words made a one-line fix look like an unexplained loss.
 */
function errorEnvelopeMessage(value: unknown): string | null {
  const record = value as Record<string, unknown> | null;
  if (!record) return null;
  for (const key of ["message", "error", "detail", "description"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) return field.trim().slice(0, 300);
  }
  return null;
}

export function verifyPostCall(input: {
  httpStatus: number;
  bodyText: string;
  parsedBody: unknown;
  latencyMs: number | null;
  quotedAtomic: string;
  authorizedAtomic: string;
  payTo: string;
  settlement: Record<string, unknown> | null;
  /** Output schema the catalog declared for this resource, when it declared one. */
  declaredOutputSchema?: JsonSchema | null;
  /** p95 from Veyra's own observations, when there are enough of them. */
  latencyP95Ms?: number | null;
  required: boolean;
  now?: Date;
}): PostCallVerification {
  const checks: VerificationCheck[] = [];
  const add = (
    id: string,
    passed: boolean | null,
    severity: VerificationSeverity,
    detail: string,
  ) => { checks.push({ id, passed, severity, detail }); };

  // --- the money -----------------------------------------------------------
  const settled = input.settlement?.success;
  add(
    "payment_settled",
    settled === undefined ? null : settled === true,
    "critical",
    settled === undefined
      ? "The endpoint returned no settlement receipt, so settlement could not be confirmed from the response."
      : settled === true
        ? "The endpoint confirmed settlement."
        : "The endpoint reported that settlement did not succeed.",
  );

  const paidExactly = input.authorizedAtomic === input.quotedAtomic;
  add(
    "paid_amount_matches_quote",
    paidExactly,
    "critical",
    paidExactly
      ? `Authorized exactly the quoted ${input.quotedAtomic} atomic units.`
      : `Authorized ${input.authorizedAtomic} against a quote of ${input.quotedAtomic}.`,
  );

  const settlementPayer = typeof input.settlement?.payer === "string"
    ? input.settlement.payer
    : null;
  add(
    "settlement_receipt_present",
    typeof input.settlement?.transaction === "string" && input.settlement.transaction.length > 0
      ? true
      : input.settlement === null ? null : false,
    "minor",
    typeof input.settlement?.transaction === "string"
      ? `Settlement reference ${input.settlement.transaction}.`
      : settlementPayer
        ? "Settlement acknowledged without an onchain reference (batched settlement defers it)."
        : "No settlement reference was returned.",
  );

  // --- the goods -----------------------------------------------------------
  /* Phrasing that never claims a charge nobody observed. Reporting "after
     taking payment" on a response that carried no settlement receipt asserted
     the one fact Veyra did not have, and it was the fact the reader cared about
     most. Sellers validate the request before settling, so a rejected request
     very often costs nothing — but "often" is not "verified", and the honest
     word for an unreceipted charge is unconfirmed. */
  const settledPhrase = settled === true
    ? "after taking payment"
    : settled === false
      ? "and did not settle the payment"
      : "with no settlement receipt, so whether it charged is unconfirmed";

  const statusOk = input.httpStatus >= 200 && input.httpStatus < 300;
  add(
    "response_delivered",
    statusOk,
    "critical",
    statusOk
      ? `Endpoint answered HTTP ${input.httpStatus}.`
      : `Endpoint answered HTTP ${input.httpStatus} ${settledPhrase}.`,
  );

  const nonEmpty = input.bodyText.trim().length > 0;
  add(
    "response_non_empty",
    nonEmpty,
    "critical",
    nonEmpty
      ? `Returned ${input.bodyText.length} bytes.`
      : "Returned an empty body after payment.",
  );

  add(
    "response_parseable",
    nonEmpty ? input.parsedBody !== null : null,
    "major",
    input.parsedBody !== null
      ? "Response parsed as JSON."
      : nonEmpty
        ? "Response is not JSON; it cannot be checked against a schema."
        : "Nothing to parse.",
  );

  const errorEnvelope = looksLikeErrorEnvelope(input.parsedBody);
  add(
    "response_is_not_an_error",
    input.parsedBody === null ? null : !errorEnvelope,
    "critical",
    errorEnvelope
      ? [
          settled === true
            ? "The paid response carries an error envelope: the endpoint charged and then reported failure."
            : settled === false
              ? "The response is an error envelope, and the endpoint reported that settlement did not succeed."
              : "The response is an error envelope and no settlement receipt came back, so it is not established that anything was charged.",
          errorEnvelopeMessage(input.parsedBody),
        ].filter(Boolean).join(" The endpoint said: ")
      : "Response does not report an error.",
  );

  if (input.declaredOutputSchema) {
    const result = validateJsonSchemaValue(input.parsedBody, input.declaredOutputSchema);
    add(
      "response_matches_declared_schema",
      result.ok,
      "major",
      result.ok
        ? "Response matches the output schema the provider published."
        : `Response does not match the published output schema at ${result.path}: ${result.message}`,
    );
  } else {
    add(
      "response_matches_declared_schema",
      null,
      "major",
      "The provider publishes no output schema, so the response shape cannot be verified against a promise.",
    );
  }

  // --- how it behaved ------------------------------------------------------
  if (input.latencyMs !== null && input.latencyP95Ms !== null && input.latencyP95Ms !== undefined) {
    const within = input.latencyMs <= Math.max(input.latencyP95Ms * 1.5, input.latencyP95Ms + 500);
    add(
      "latency_within_observed_envelope",
      within,
      "minor",
      within
        ? `Took ${input.latencyMs}ms against an observed p95 of ${input.latencyP95Ms}ms.`
        : `Took ${input.latencyMs}ms, well beyond the observed p95 of ${input.latencyP95Ms}ms.`,
    );
  } else {
    add(
      "latency_within_observed_envelope",
      null,
      "minor",
      "Not enough observations of this endpoint to say whether this call was slow for it.",
    );
  }

  const responseHash = keccak256(toBytes(input.bodyText));

  const failedCritical = checks.filter((check) => check.severity === "critical" && check.passed === false);
  const unrunCritical = checks.filter((check) => check.severity === "critical" && check.passed === null);
  const failedMajor = checks.filter((check) => check.severity === "major" && check.passed === false);

  /* Whether money moved is its own question, and the summary must not answer it
     by assumption. A seller that returns no settlement receipt has told us
     nothing about the charge; saying "Paid, but..." there is the one sentence a
     reader most needs to be true, and it was being written without evidence. */
  const settlementKnown = settled === true;
  const chargeUnknown = settled === undefined;
  const opening = settlementKnown ? "Paid" : chargeUnknown ? "Possibly charged" : "Not paid";

  /* Every check already carries a sentence saying what happened. The summary
     was joining their ids instead, so the line a person read after paying was
     "the delivery failed verification: response_delivered" -- the name of the
     check that failed, where the check itself said "Endpoint answered HTTP 403
     after taking payment". The id is still the failure code on the ledger row,
     which is where a string meant for grep belongs. */
  const said = (list: VerificationCheck[]) =>
    list.map((c) => c.detail.trim()).filter(Boolean).join(" ")
      || list.map((c) => c.id).join(", ");

  let verdict: PostCallVerdict;
  let summary: string;
  if (failedCritical.length > 0) {
    verdict = "FAIL";
    summary = chargeUnknown
      ? `The delivery failed verification, and the endpoint returned no settlement receipt — so whether it charged cannot be confirmed from its response. ${said(failedCritical)}`
      : `${opening}, but the delivery failed verification. ${said(failedCritical)}`;
  } else if (failedMajor.length > 0) {
    verdict = "FAIL";
    summary = `${opening} and answered, but the response did not hold up. ${said(failedMajor)}`;
  } else if (unrunCritical.length > 0) {
    verdict = "INCONCLUSIVE";
    summary = chargeUnknown
      ? "The endpoint answered, but returned no settlement receipt, so Veyra cannot confirm whether it charged."
      : `${opening} and answered, but Veyra could not confirm every required check from what the endpoint returned.`;
  } else {
    verdict = "PASS";
    summary = "Paid, delivered, and verified against everything this endpoint can be held to.";
  }

  return {
    verdict,
    required: input.required,
    checks,
    responseHash,
    verifiedAt: (input.now ?? new Date()).toISOString(),
    summary,
  };
}
