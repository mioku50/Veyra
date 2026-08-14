/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

export type ExecutionMode = "PREVIEW" | "PREPARE" | "AUTOPILOT";

export type ExecutionRail = "erc8183" | "x402";

export type ExecutionState =
  | "DRAFT"
  | "PREPARED"
  | "AUTHORIZED"
  | "EXECUTING"
  | "SUBMITTED"
  | "EVALUATING"
  | "SETTLING"
  | "EVIDENCE_PENDING"
  | "COMPLETED_UNPROVEN"
  | "COMPLETED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED"
  | "SETTLEMENT_FAILED"
  | "EVALUATION_REJECTED";

export interface ExecutionMandate {
  mandateId: string;
  ownerWallet: `0x${string}`;
  subjectAgentId: string;
  subjectWallet: `0x${string}`;
  mode: ExecutionMode;
  network: string; // e.g. "eip155:5042002"
  allowedCapabilities: string[];
  allowedRails: ExecutionRail[];
  maxPerTransactionUsdc: number;
  maxPerDayUsdc: number;
  maxTotalUsdc: number;
  minimumTrustScore: number;
  minimumConfidence: number;
  requireVerifiedIdentity: boolean;
  evaluatorThresholdUsdc: number;
  canonicalHash: string;
  signature: `0x${string}`;
  nonce: number;
  version: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  createdAt: string;
}

export type SanitizedExecutionMandate = Omit<ExecutionMandate, "signature" | "nonce">;

export function sanitizeMandate(mandate: ExecutionMandate): SanitizedExecutionMandate {
  const { signature: _sig, nonce: _nonce, ...sanitized } = mandate;
  return sanitized;
}

export interface ExecutionMandateInput {
  ownerWallet: `0x${string}`;
  subjectAgentId: string;
  subjectWallet: `0x${string}`;
  mode: ExecutionMode;
  network: string;
  allowedCapabilities: string[];
  allowedRails: ExecutionRail[];
  maxPerTransactionUsdc: number;
  maxPerDayUsdc: number;
  maxTotalUsdc: number;
  minimumTrustScore: number;
  minimumConfidence: number;
  requireVerifiedIdentity?: boolean;
  evaluatorThresholdUsdc?: number;
  expiresAt: string;
  nonce?: number;
  version?: string;
}

export interface ExecutionMandateUsage {
  mandateId: string;
  periodStart: string;
  periodEnd: string;
  usedUsdc: number;
  reservedUsdc: number;
  executionCount: number;
  updatedAt: string;
}

export interface ExecutionAttempt {
  executionId: string;
  mandateId?: string | null;
  selectionId: string;
  clearanceId?: string | null;
  rail: ExecutionRail;
  counterpartyAgentId: string;
  counterpartyWallet: `0x${string}`;
  capability: string;
  requestedAmountUsdc: number;
  authorizedAmountUsdc: number;
  actualSettledAmountUsdc?: number | null;
  state: ExecutionState;
  failureCode?: string | null;
  createTx?: string | null;
  completeTx?: string | null;
  paymentTx?: string | null;
  evaluationId?: string | null;
  selectionHash: string;
  clearanceDigest?: string | null;
  evidenceHash?: string | null;
  idempotencyKey?: string | null;
  canonicalHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreparedExecution {
  executionId: string;
  mode: ExecutionMode;
  rail: ExecutionRail;
  selectionId: string;
  mandateId?: string | null;
  counterpartyAgentId: string;
  counterpartyWallet: `0x${string}`;
  capability: string;
  requestedAmountUsdc: number;
  authorizedAmountUsdc: number;
  requiredEvaluator?: string | null;
  clearance?: any | null;
  preparedPayload?: any;
  canonicalHash: string;
  expiresAt: string;
}

export interface ExecutionResult {
  executionId: string;
  rail: ExecutionRail;
  counterparty: {
    agentId: string;
    wallet: `0x${string}`;
  };
  capability: string;
  requestedAmountUsdc: number;
  authorizedAmountUsdc: number;
  actualSettledAmountUsdc: number;
  status: "COMPLETED" | "COMPLETED_UNPROVEN" | "REJECTED" | "FAILED";
  failureCode?: string | null;
  createTx?: string | null;
  completeTx?: string | null;
  paymentTx?: string | null;
  evaluationId?: string | null;
  evaluationVerdict?: "Complete" | "Reject" | null;
  evidenceHash?: string | null;
  arcProofTx?: string | null;
  newReputationSnapshot?: {
    trustScore: number;
    confidence: string;
    snapshotHash: string;
  } | null;
  completedAt: string;
}
