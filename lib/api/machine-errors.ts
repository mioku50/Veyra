/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server.js";
import { randomUUID } from "node:crypto";

export type MachineErrorCode =
  | "agent_trust_input_required"
  | "agent_not_found"
  | "agent_access_denied"
  | "agent_registry_unavailable"
  | "agent_trust_service_unavailable"
  | "contract_not_found"
  | "contract_provider_unavailable"
  | "endpoint_invalid"
  | "endpoint_private_network_blocked"
  | "endpoint_unreachable"
  | "endpoint_response_too_large"
  | "insufficient_trust_evidence"
  | "invalid_wallet"
  | "invalid_repository"
  | "repository_not_found"
  | "repository_inaccessible"
  | "credential_missing"
  | "credential_revoked"
  | "scope_denied"
  | "workflow_disabled"
  | "quote_expired"
  | "quote_not_found"
  | "quote_already_used"
  | "idempotency_key_missing"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "idempotency_store_unavailable"
  | "invalid_request"
  | "payment_required"
  | "payment_invalid"
  | "spending_limit_exceeded"
  | "watchlist_invalid"
  | "watchlist_not_found"
  | "watchlist_limit_exceeded"
  | "recheck_not_found"
  | "recheck_conflict"
  | "recheck_in_progress"
  | "monitoring_unavailable"
  | "run_not_found"
  | "report_not_found"
  | "report_not_ready"
  | "report_generation_failed"
  | "verification_pending"
  | "provider_unavailable"
  | "rate_limited"
  | "evaluation_not_found"
  | "internal_error"
  | "api_quality_service_not_found"
  | "api_quality_service_unavailable"
  | "api_quality_insufficient_services"
  | "api_quality_too_many_services"
  | "api_quality_no_observations"
  | "api_quality_observation_store_unavailable"
  | "api_quality_comparison_incompatible"
  | "api_quality_probe_budget_exceeded"
  | "project_source_required"
  | "project_source_invalid"
  | "project_source_type_invalid"
  | "project_source_secret_blocked"
  | "project_input_invalid"
  | "project_sources_invalid"
  | "project_modules_invalid"
  | "project_module_source_missing"
  | "project_360_unavailable"
  | "project_360_services_unavailable"
  | "discovery_not_found"
  | "discovery_not_ready"
  | "discovery_revision_conflict"
  | "discovery_integrity_failed"
  | "discovery_failed"
  | "github_discovery_unavailable"
  | "candidate_not_selectable"
  | "duplicate_module_source"
  | "source_module_not_selected"
  | "project_quote_binding_failed"
  | "project_quote_checkout_unavailable"
  | "project_quote_quote_lookup_unavailable"
  | "project_quote_runner_configuration_unavailable"
  | "project_quote_checkout_configuration_unavailable"
  | "project_quote_policy_lookup_unavailable"
  | "project_quote_pricing_unavailable"
  | "project_quote_sponsorship_lookup_unavailable"
  | "project_quote_quote_persistence_unavailable"
  | "project_quote_integrity_failed"
  | "project_selection_integrity_failed"
  | "counterparty_selection_not_found"
  | "counterparty_selection_expired"
  | "counterparty_candidate_invalid"
  | "counterparty_no_eligible_candidate"
  | "counterparty_registry_unavailable"
  | "counterparty_clearance_unavailable"
  | "counterparty_proof_unavailable";

export interface MachineErrorResponseBody {
  error: {
    code: MachineErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

export function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function sanitizeErrorMessage(message: string): string {
  // Ensure stack traces or internal SQL errors are not leaked
  if (
    /postgres|supabase|pg_|\bSQL\b|column\s+.*does not exist|violates\s+foreign\s+key|relation\s+.*does not exist|syntax error at or near/i.test(
      message,
    ) ||
    message.includes("Error:") && message.includes("\n    at ")
  ) {
    return "An internal system error occurred. Please try again later.";
  }
  return message;
}

export function createMachineErrorResponse(
  code: MachineErrorCode,
  message: string,
  status = 400,
  retryable = false,
  requestId?: string,
): NextResponse<MachineErrorResponseBody> {
  const reqId = requestId || generateRequestId();
  const safeMessage = sanitizeErrorMessage(message);

  return NextResponse.json(
    {
      error: {
        code,
        message: safeMessage,
        retryable,
        requestId: reqId,
      },
    },
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": reqId,
      },
    },
  );
}

export function handleMachineInternalError(
  err: unknown,
  route: string,
  agentId?: string,
  requestId?: string,
): NextResponse<MachineErrorResponseBody> {
  const reqId = requestId || generateRequestId();
  const errorMessage = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  console.error(
    `[MachineAPI][500] route=${route} agentId=${agentId || "unknown"} requestId=${reqId}:`,
    errorMessage,
    stack ? `\nStack: ${stack}` : "",
  );

  return NextResponse.json(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        retryable: true,
        requestId: reqId,
      },
    },
    {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": reqId,
      },
    },
  );
}
