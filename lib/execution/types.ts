/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettlementProof } from "./settlement-proof.ts";

export type ExecutionMode = "PREVIEW" | "PREPARE" | "AUTOPILOT";

export type ExecutionRail = "erc8183" | "x402";

export type ExecutionState =
  | "DRAFT"
  | "PREPARED"
  | "AUTHORIZED"
  | "EXECUTING"
  | "WAITING_FOR_PROVIDER"
  | "SUBMITTED"
  | "EVALUATING"
  | "SETTLING"
  | "SETTLEMENT_UNVERIFIED"
  | "EVIDENCE_PENDING"
  | "COMPLETED_UNPROVEN"
  | "SETTLED_SERVICE_FAILED"
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
  /** v2 only. The IANA zone a "day" is measured in, so a daily budget resets
   *  on the owner's midnight rather than on UTC's. Null under v1, where the
   *  field was never signed and must not be invented. */
  budgetTimezone?: string | null;
  /** v2 only. How many times Nova may reach the point of paying in one budget
   *  day, whether or not money moved. Null under v1. */
  maxAutonomousAttemptsPerDay?: number | null;
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
  budgetTimezone?: string | null;
  maxAutonomousAttemptsPerDay?: number | null;
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

export interface X402ReconciliationContext {
  payerWallet: `0x${string}`;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  network: string; // e.g. "eip155:5042002"
  authorizedAmountUsdc: number;
  authorizedAmountAtomic?: string | number | null;
  authorizationNonce?: string | null;
  authorizationSignature?: `0x${string}` | null;
  authorizationValidBefore?: number | null;
  /** The contract the EIP-712 domain bound this authorization to. A vanilla
   *  EIP-3009 accept is domain-separated by the token itself; Circle's batched
   *  scheme is separated by the GatewayWallet, and the token then knows nothing
   *  whatever about the nonce. Recorded so a row says which it was rather than
   *  leaving a later reader to assume. */
  authorizationVerifyingContract?: string | null;
  /** True when the accept was Circle's batched Gateway scheme, whose spend is
   *  netted into a periodic batch and has no transaction of its own. Absent on
   *  rows written before the field, all of which were vanilla. */
  gatewayBatched?: boolean | null;
  resource?: string | null;
  paymentRequirementsHash?: string | null;
  facilitatorReference?: string | null;
  requestTimestamp: string;
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
  clearancePayload?: {
    message: any;
    signature: `0x${string}`;
    digest: `0x${string}`;
  } | null;
  evidenceHash?: string | null;
  providerContentUri?: string | null;
  providerContentHash?: string | null;
  providerContentType?: string | null;
  providerSubmittedAt?: string | null;
  x402Context?: X402ReconciliationContext | null;
  idempotencyKey?: string | null;
  /** Where the claim that this payment settled comes from. Only the chain's
   *  own answer counts as evidence about a seller; the rest is evidence from
   *  one. Null on rows written before the column. */
  settlementProof?: SettlementProof | null;
  /** The budget day this attempt reserved against, fixed when the reservation
   *  was taken. Reconciliation settles into this and never into the day it
   *  happens to run on -- those are the same day only if nothing took longer
   *  than the hours left until midnight. Null on rows older than the column. */
  budgetPeriodStart?: string | null;
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
  clearance?: {
    message: any;
    signature: `0x${string}`;
    digest: `0x${string}`;
  } | null;
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
  status: "COMPLETED" | "COMPLETED_UNPROVEN" | "SETTLED_SERVICE_FAILED" | "SETTLEMENT_UNVERIFIED" | "REJECTED" | "FAILED";
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
