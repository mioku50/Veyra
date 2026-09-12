/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { keccak256, stringToBytes } from "viem";
import { saveReputationEvidence } from "./db.ts";
import type { CanonicalAgentIdentity, ReputationEvidence } from "./types.ts";

export async function ingestErc8004IdentityEvidence(
  identity: CanonicalAgentIdentity,
  registrationTx?: string
): Promise<ReputationEvidence> {
  const sourceId = registrationTx || identity.identityRegistry;
  const canonicalHash = keccak256(
    stringToBytes(`erc8004_identity_${identity.agentId}_${identity.owner}_${sourceId}`)
  );

  const evidence: ReputationEvidence = {
    evidenceId: `ev_id_${canonicalHash.substring(2, 18)}`,
    agentId: identity.agentId,
    type: "erc8004_feedback",
    tier: 1,
    sourceId,
    score: 100,
    positive: true,
    confidence: 1.0,
    verifiedOnchain: identity.verifiedOnchain,
    arcProofVerified: identity.verifiedOnchain,
    sybilRisk: "none",
    observedAt: new Date().toISOString(),
    canonicalHash,
  };

  await saveReputationEvidence(evidence);
  return evidence;
}

export async function ingestErc8183JobOutcomeEvidence(params: {
  agentId: string;
  jobId: string;
  deliverableHash: string;
  verdictPassed: boolean;
  score: number;
  economicValueUsdc?: number;
  clientAddress?: string;
  arcProofTx?: string;
  observedAt?: string;
}): Promise<ReputationEvidence> {
  const canonicalHash = keccak256(
    stringToBytes(`erc8183_job_${params.jobId}_${params.deliverableHash}_${params.verdictPassed}`)
  );

  const isTier4 = Boolean(params.arcProofTx && params.verdictPassed);

  const evidence: ReputationEvidence = {
    evidenceId: `ev_job_${canonicalHash.substring(2, 18)}`,
    agentId: params.agentId,
    type: params.verdictPassed ? "erc8183_job_completed" : "erc8183_job_rejected",
    tier: params.verdictPassed ? (isTier4 ? 4 : 3) : 3,
    sourceId: params.jobId,
    sourceHash: params.deliverableHash,
    score: params.score,
    positive: params.verdictPassed,
    confidence: 1.0,
    economicValueUsdc: params.economicValueUsdc || 0,
    counterpartyAddress: params.clientAddress,
    verifiedOnchain: true,
    arcProofVerified: Boolean(params.arcProofTx),
    sybilRisk: "none",
    observedAt: params.observedAt || new Date().toISOString(),
    canonicalHash,
  };

  await saveReputationEvidence(evidence);
  return evidence;
}

export async function ingestErc8004ValidationEvidence(params: {
  agentId: string;
  requestHash: string;
  validatorAddress: string;
  responseScore: number;
  responseHash: string;
  tag: string;
  observedAt?: string;
}): Promise<ReputationEvidence> {
  const canonicalHash = keccak256(
    stringToBytes(`erc8004_val_${params.requestHash}_${params.validatorAddress}_${params.responseScore}`)
  );

  const positive = params.responseScore >= 80;

  const evidence: ReputationEvidence = {
    evidenceId: `ev_val_${canonicalHash.substring(2, 18)}`,
    agentId: params.agentId,
    type: "erc8004_validation",
    tier: 2,
    sourceId: params.requestHash,
    sourceHash: params.responseHash,
    score: params.responseScore,
    positive,
    confidence: 0.95,
    counterpartyAddress: params.validatorAddress,
    verifiedOnchain: true,
    arcProofVerified: true,
    sybilRisk: "none",
    observedAt: params.observedAt || new Date().toISOString(),
    canonicalHash,
  };

  await saveReputationEvidence(evidence);
  return evidence;
}

export async function ingestX402PaymentEvidence(params: {
  agentId: string;
  paymentId: string;
  success: boolean;
  amountUsdc: number;
  clientAddress?: string;
  observedAt?: string;
}): Promise<ReputationEvidence> {
  const canonicalHash = keccak256(
    stringToBytes(`x402_pay_${params.paymentId}_${params.success}_${params.amountUsdc}`)
  );

  const evidence: ReputationEvidence = {
    evidenceId: `ev_x402_${canonicalHash.substring(2, 18)}`,
    agentId: params.agentId,
    type: params.success ? "x402_payment_success" : "x402_payment_failure",
    tier: 3,
    sourceId: params.paymentId,
    score: params.success ? 100 : 0,
    positive: params.success,
    confidence: 1.0,
    economicValueUsdc: params.amountUsdc,
    counterpartyAddress: params.clientAddress,
    verifiedOnchain: true,
    arcProofVerified: false,
    sybilRisk: "none",
    observedAt: params.observedAt || new Date().toISOString(),
    canonicalHash,
  };

  await saveReputationEvidence(evidence);
  return evidence;
}

export async function ingestVeyraReportEvidence(params: {
  agentId: string;
  reportId: string;
  reportType: "veyra_agent_trust" | "api_quality" | "treasury_health" | "project_360";
  reportHash: string;
  score: number;
  passed: boolean;
  observedAt?: string;
}): Promise<ReputationEvidence> {
  const canonicalHash = keccak256(
    stringToBytes(`veyra_rep_${params.reportId}_${params.reportType}_${params.reportHash}`)
  );

  const evidence: ReputationEvidence = {
    evidenceId: `ev_report_${canonicalHash.substring(2, 18)}`,
    agentId: params.agentId,
    type: params.reportType,
    tier: 2,
    sourceId: params.reportId,
    sourceHash: params.reportHash,
    score: params.score,
    positive: params.passed,
    confidence: 0.9,
    verifiedOnchain: false,
    arcProofVerified: true,
    sybilRisk: "none",
    observedAt: params.observedAt || new Date().toISOString(),
    canonicalHash,
  };

  await saveReputationEvidence(evidence);
  return evidence;
}
