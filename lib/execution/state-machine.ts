/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecutionState } from "./types.ts";

export const ALLOWED_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  DRAFT: ["PREPARED", "CANCELLED", "REJECTED"],
  PREPARED: ["AUTHORIZED", "EXECUTING", "CANCELLED", "EXPIRED", "REJECTED"],
  AUTHORIZED: ["EXECUTING", "CANCELLED", "EXPIRED", "REJECTED"],
  EXECUTING: [
    "SUBMITTED",
    "EVALUATING",
    "SETTLING",
    "EVIDENCE_PENDING",
    "COMPLETED_UNPROVEN",
    "SETTLED_SERVICE_FAILED",
    "COMPLETED",
    "FAILED",
    "SETTLEMENT_FAILED",
    "EVALUATION_REJECTED",
  ],
  SUBMITTED: [
    "EVALUATING",
    "SETTLING",
    "EVIDENCE_PENDING",
    "COMPLETED_UNPROVEN",
    "SETTLED_SERVICE_FAILED",
    "COMPLETED",
    "FAILED",
    "SETTLEMENT_FAILED",
    "EVALUATION_REJECTED",
  ],
  EVALUATING: [
    "SETTLING",
    "EVIDENCE_PENDING",
    "COMPLETED_UNPROVEN",
    "SETTLED_SERVICE_FAILED",
    "COMPLETED",
    "FAILED",
    "SETTLEMENT_FAILED",
    "EVALUATION_REJECTED",
  ],
  SETTLING: [
    "EVIDENCE_PENDING",
    "COMPLETED_UNPROVEN",
    "SETTLED_SERVICE_FAILED",
    "COMPLETED",
    "SETTLEMENT_FAILED",
    "FAILED",
  ],
  EVIDENCE_PENDING: ["COMPLETED", "COMPLETED_UNPROVEN", "SETTLED_SERVICE_FAILED", "FAILED"],
  COMPLETED_UNPROVEN: ["COMPLETED"],
  SETTLED_SERVICE_FAILED: [], // Terminal
  COMPLETED: [], // Terminal
  REJECTED: [], // Terminal
  EXPIRED: [], // Terminal
  CANCELLED: [], // Terminal
  FAILED: [], // Terminal
  SETTLEMENT_FAILED: [], // Terminal
  EVALUATION_REJECTED: [], // Terminal
};

export const TERMINAL_STATES: Set<ExecutionState> = new Set([
  "COMPLETED",
  "COMPLETED_UNPROVEN",
  "SETTLED_SERVICE_FAILED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
  "SETTLEMENT_FAILED",
  "EVALUATION_REJECTED",
]);

export class InvalidStateTransitionError extends Error {
  constructor(from: ExecutionState, to: ExecutionState, executionId: string) {
    super(`Invalid execution state transition from ${from} to ${to} for execution ${executionId}`);
    this.name = "InvalidStateTransitionError";
  }
}

/**
 * Validates whether a state transition is legal according to the deterministic state machine.
 */
export function validateStateTransition(
  currentState: ExecutionState,
  targetState: ExecutionState,
  executionId: string
): boolean {
  if (currentState === targetState) {
    return true; // No-op transition allowed
  }

  const allowed = ALLOWED_TRANSITIONS[currentState];
  if (!allowed || !allowed.includes(targetState)) {
    throw new InvalidStateTransitionError(currentState, targetState, executionId);
  }

  return true;
}

export function isTerminalState(state: ExecutionState): boolean {
  return TERMINAL_STATES.has(state);
}
