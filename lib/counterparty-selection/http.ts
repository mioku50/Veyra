import { createMachineErrorResponse, type MachineErrorCode } from "../api/machine-errors.ts";
import { CounterpartySelectionError } from "./service.ts";

const PUBLIC_MESSAGES: Record<string, { code: MachineErrorCode; message: string; retryable?: boolean }> = {
  selection_not_found: { code: "counterparty_selection_not_found", message: "Selection not found." },
  selection_expired: { code: "counterparty_selection_expired", message: "The immutable selection has expired." },
  no_eligible_counterparty: {
    code: "counterparty_no_eligible_candidate",
    message: "No candidate satisfies the current trust and capability policy.",
  },
  candidate_registry_unavailable: {
    code: "counterparty_registry_unavailable",
    message: "Candidate identity data is temporarily unavailable.",
    retryable: true,
  },
  selection_storage_unavailable: {
    code: "provider_unavailable",
    message: "Counterparty selection storage is temporarily unavailable.",
    retryable: true,
  },
  clearance_signing_unavailable: {
    code: "counterparty_clearance_unavailable",
    message: "Trust clearance issuance is temporarily unavailable.",
    retryable: true,
  },
  clearance_onchain_verification_failed: {
    code: "counterparty_clearance_unavailable",
    message: "Trust clearance could not be verified on Arc.",
    retryable: true,
  },
  proof_unavailable: {
    code: "counterparty_proof_unavailable",
    message: "Selection proof publication is temporarily unavailable.",
    retryable: true,
  },
  idempotency_conflict: {
    code: "idempotency_conflict",
    message: "This Idempotency-Key is already bound to different selection inputs.",
  },
  idempotency_key_missing: {
    code: "idempotency_key_missing",
    message: "A valid Idempotency-Key header is required.",
  },
};

export function counterpartyErrorResponse(error: unknown) {
  if (error instanceof CounterpartySelectionError) {
    const known = PUBLIC_MESSAGES[error.code];
    if (known) {
      return createMachineErrorResponse(known.code, known.message, error.status, Boolean(known.retryable));
    }
    return createMachineErrorResponse(
      "counterparty_candidate_invalid",
      "The counterparty request is invalid.",
      error.status,
    );
  }
  console.error("counterparty_selection_request_failed", {
    errorCode: error instanceof Error ? error.name : "unknown_error",
  });
  return createMachineErrorResponse(
    "provider_unavailable",
    "The counterparty request cannot be completed right now.",
    503,
    true,
  );
}
