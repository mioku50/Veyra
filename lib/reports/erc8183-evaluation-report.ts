/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { computeCanonicalReportHash } from "./canonical-report-hash.ts";
import type { EvaluationCheck, StructuredDeliverableEvidence } from "../erc8183/types.ts";

export interface BuildErc8183EvaluationReportOptions {
  chainId: number;
  agenticCommerce: string;
  evaluatorContract: string;
  jobId: string;
  client: string;
  provider: string;
  budget: string;
  expiry: number;
  description: string;
  deliverableHash: string;
  contentHash: string;
  contentUri: string;
  policyId: string;
  policyHash: string;
  decision: "complete" | "reject";
  checks: EvaluationCheck[];
  evidence?: StructuredDeliverableEvidence[];
  settlementTxHash?: string;
  evaluatedAt?: string;
}

export interface Erc8183EvaluationReport {
  reportType: "erc8183_evaluation";
  schemaVersion: 1;
  chainId: number;
  agenticCommerce: string;
  evaluatorContract: string;
  jobId: string;
  client: string;
  provider: string;
  budget: string;
  expiry: number;
  description: string;
  deliverableHash: string;
  contentHash: string;
  contentUri: string;
  policyId: string;
  policyHash: string;
  decision: "complete" | "reject";
  checks: EvaluationCheck[];
  evidence: StructuredDeliverableEvidence[];
  reportHash: `0x${string}`;
  settlementTxHash?: string;
  evaluatedAt: string;
  dataFreshness: string;
  limitations: string;
}

export function buildErc8183EvaluationReport(
  options: BuildErc8183EvaluationReportOptions,
): Erc8183EvaluationReport {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();

  // Create report without reportHash first
  const basePayload = {
    reportType: "erc8183_evaluation" as const,
    schemaVersion: 1 as const,
    chainId: options.chainId,
    agenticCommerce: options.agenticCommerce.toLowerCase(),
    evaluatorContract: options.evaluatorContract.toLowerCase(),
    jobId: options.jobId,
    client: options.client.toLowerCase(),
    provider: options.provider.toLowerCase(),
    budget: options.budget,
    expiry: options.expiry,
    description: options.description,
    deliverableHash: options.deliverableHash.toLowerCase(),
    contentHash: options.contentHash.toLowerCase(),
    contentUri: options.contentUri,
    policyId: options.policyId,
    policyHash: options.policyHash.toLowerCase(),
    decision: options.decision,
    checks: options.checks,
    evidence: options.evidence ?? [],
    evaluatedAt,
    dataFreshness: "Realtime verification on Arc Testnet chain 5042002",
    limitations:
      "Deterministic policy evaluation. Veyra acts as an offchain EIP-712 evaluator attester for ERC-8183 jobs.",
  };

  if (options.settlementTxHash) {
    (basePayload as Record<string, unknown>).settlementTxHash = options.settlementTxHash;
  }

  const { canonicalHash } = computeCanonicalReportHash(basePayload);

  return {
    ...basePayload,
    reportHash: canonicalHash,
  };
}
