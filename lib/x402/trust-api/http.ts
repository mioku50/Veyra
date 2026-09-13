/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { TrustApiError } from "./resource.ts";

const PUBLIC_MESSAGES: Record<string, string> = {
  resource_required: "A `resource` URL is required.",
  resource_not_a_url: "`resource` must be an absolute URL.",
  resource_scheme_unsupported: "`resource` must be an http or https URL.",
  method_unsupported: "`method` must be GET or POST.",
  budget_invalid: "`budgetUsdc` is outside the supported range.",
  no_payable_challenge: "The endpoint published no payment option Veyra can evaluate.",
  endpoint_unreachable: "The endpoint did not answer.",
  clearance_unavailable: "Clearance signing is temporarily unavailable. Nothing was charged for a signature that was not issued.",
  outcome_unknown_clearance: "No clearance with that digest was issued by Veyra.",
  outcome_already_reported: "That clearance already has a reported outcome.",
  outcome_invalid: "The outcome report is incomplete.",
};

export function trustApiError(error: unknown) {
  if (error instanceof TrustApiError) {
    return NextResponse.json({
      error: { code: error.code, message: PUBLIC_MESSAGES[error.code] ?? error.detail ?? "Request rejected." },
    }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  console.error("trust_api_request_failed", {
    errorName: error instanceof Error ? error.name : "unknown_error",
  });
  return NextResponse.json({
    error: { code: "unavailable", message: "The Trust API cannot answer right now." },
  }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

/** Verdicts are public information about a third party; they carry no caller
 *  data and are safe to serve from a shared cache for their short life. */
export const TRUST_API_HEADERS = { "Cache-Control": "no-store" } as const;

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TrustApiError("body_invalid", 400, "A JSON object body is required.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TrustApiError) throw error;
    throw new TrustApiError("body_invalid", 400, "A JSON object body is required.");
  }
}

/** The public shape of a verdict: everything except the decision object the
 *  clearance is signed over, which is internal. */
export function publicVerdict<T extends { trustDecision: unknown }>(verdict: T) {
  const { trustDecision: _internal, ...rest } = verdict;
  return rest;
}
