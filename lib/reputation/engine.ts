/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { keccak256, stringToBytes } from "viem";
import {
  AGENT_REPUTATION_WEIGHTS,
  type AgentReputationDimensions,
  type CanonicalAgentIdentity,
  type ReputationConfidenceLevel,
  type ReputationEvidence,
  type ReputationExplanation,
  type ReputationSnapshot,
  type ReputationStatusLabel,
  type SanitizedEvidenceItem,
  getTrustDisplayLabel,
} from "./types.ts";

export function calculateTemporalDecay(observedAt: string, now: Date = new Date()): number {
  const ageMs = now.getTime() - new Date(observedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays <= 30) return 1.0;
  if (ageDays <= 90) return 0.9;
  if (ageDays <= 180) return 0.75;
  if (ageDays <= 365) return 0.55;
  return 0.35;
}

export function calculateTierWeight(tier: 0 | 1 | 2 | 3 | 4): number {
  switch (tier) {
    case 0:
      return 0.1;
    case 1:
      return 0.35;
    case 2:
      return 0.65;
    case 3:
      return 0.85;
    case 4:
      return 1.0;
  }
}

export function calculateSybilMultiplier(risk: "none" | "low" | "medium" | "high"): number {
  switch (risk) {
    case "none":
      return 1.0;
    case "low":
      return 0.75;
    case "medium":
      return 0.4;
    case "high":
      return 0.05;
  }
}

export function calculateCounterpartyMultiplier(interactionIndex: number): number {
  if (interactionIndex <= 1) return 1.0;
  if (interactionIndex === 2) return 0.7;
  if (interactionIndex === 3) return 0.5;
  return 0.3;
}

export function calculateEvidenceWeight(
  evidence: ReputationEvidence,
  identity: CanonicalAgentIdentity,
  interactionIndex: number,
  now: Date = new Date()
): { weight: number; reason?: string } {
  // Self-rating check
  if (
    evidence.counterpartyAddress &&
    identity.owner &&
    evidence.counterpartyAddress.toLowerCase() === identity.owner.toLowerCase()
  ) {
    return { weight: 0, reason: "self_rating" };
  }

  // Canary isolation check
  if (evidence.reason === "canary_isolation" || evidence.sourceId.includes("canary")) {
    return { weight: 0, reason: "canary_isolation" };
  }

  const baseTier = calculateTierWeight(evidence.tier);
  const temporalDecay = calculateTemporalDecay(evidence.observedAt, now);
  const sybilMult = calculateSybilMultiplier(evidence.sybilRisk);
  const counterpartyMult = calculateCounterpartyMultiplier(interactionIndex);
  const econMultiplier = Math.min(2.5, Math.log10(1 + (evidence.economicValueUsdc || 0)));

  const weight = baseTier * (1 + econMultiplier) * temporalDecay * sybilMult * counterpartyMult * evidence.confidence;

  return { weight };
}

export function computeAgentReputation(
  identity: CanonicalAgentIdentity,
  evidenceList: ReputationEvidence[],
  now: Date = new Date()
): ReputationExplanation {
  // Filter duplicates
  const seenCanonicalHashes = new Set<string>();
  const uniqueEvidenceList: ReputationEvidence[] = [];

  for (const item of evidenceList) {
    if (!seenCanonicalHashes.has(item.canonicalHash)) {
      seenCanonicalHashes.add(item.canonicalHash);
      uniqueEvidenceList.push(item);
    }
  }

  // Track counterparty interaction counts for diminishing returns
  const counterpartyCounts = new Map<string, number>();

  // Group evidence by dimension
  const categoryEvidence: Record<keyof AgentReputationDimensions, ReputationEvidence[]> = {
    identity: [],
    execution: [],
    validation: [],
    economicReliability: [],
    serviceQuality: [],
    reputation: [],
  };

  // Default initial identity signal if registered onchain
  if (identity.verifiedOnchain) {
    categoryEvidence.identity.push({
      evidenceId: `identity-onchain-${identity.agentId}`,
      agentId: identity.agentId,
      type: "erc8004_feedback",
      tier: 1,
      sourceId: identity.identityRegistry,
      score: 100,
      positive: true,
      confidence: 1.0,
      verifiedOnchain: true,
      arcProofVerified: true,
      sybilRisk: "none",
      observedAt: now.toISOString(),
      canonicalHash: keccak256(stringToBytes(`identity-${identity.agentId}-${identity.owner}`)),
    });
  }

  for (const item of uniqueEvidenceList) {
    if (item.type === "erc8004_feedback") {
      categoryEvidence.reputation.push(item);
    } else if (item.type === "erc8004_validation") {
      categoryEvidence.validation.push(item);
    } else if (item.type === "erc8183_job_completed" || item.type === "erc8183_job_rejected") {
      categoryEvidence.execution.push(item);
    } else if (item.type === "erc8183_evaluation") {
      categoryEvidence.validation.push(item);
    } else if (item.type === "x402_payment_success" || item.type === "x402_payment_failure") {
      categoryEvidence.economicReliability.push(item);
    } else if (
      item.type === "veyra_agent_trust" ||
      item.type === "api_quality" ||
      item.type === "treasury_health" ||
      item.type === "project_360"
    ) {
      categoryEvidence.serviceQuality.push(item);
    } else if (item.type === "arc_proof") {
      categoryEvidence.execution.push(item);
    }
  }

  const dimensions: AgentReputationDimensions = {
    identity: 0,
    execution: 0,
    validation: 0,
    economicReliability: 0,
    serviceQuality: 0,
    reputation: 0,
  };

  const activeDimensions: (keyof AgentReputationDimensions)[] = [];
  const topPositiveEvidence: string[] = [];
  const riskSignals: string[] = [];

  let totalCompletedJobs = 0;
  let totalPassedEvaluations = 0;
  let totalSettlements = 0;
  let uniqueCounterparties = new Set<string>();

  for (const key of Object.keys(categoryEvidence) as (keyof AgentReputationDimensions)[]) {
    const items = categoryEvidence[key];
    if (items.length === 0) {
      dimensions[key] = 0;
      continue;
    }

    activeDimensions.push(key);
    let weightedScoreSum = 0;
    let totalWeightSum = 0;

    for (const item of items) {
      const cpKey = (item.counterpartyAddress || "unknown").toLowerCase();
      const count = (counterpartyCounts.get(cpKey) || 0) + 1;
      counterpartyCounts.set(cpKey, count);

      if (item.counterpartyAddress && item.counterpartyAddress.toLowerCase() !== identity.owner.toLowerCase()) {
        uniqueCounterparties.add(item.counterpartyAddress.toLowerCase());
      }

      const { weight } = calculateEvidenceWeight(item, identity, count, now);

      if (weight <= 0) continue;

      const itemScore = item.score !== undefined ? item.score : item.positive ? 100 : 0;
      weightedScoreSum += itemScore * weight;
      totalWeightSum += weight;

      if (item.positive) {
        if (item.type === "erc8183_job_completed") totalCompletedJobs++;
        if (item.type === "erc8183_evaluation") totalPassedEvaluations++;
        if (item.type === "x402_payment_success") totalSettlements++;
      } else {
        if (item.type === "erc8183_job_rejected") {
          riskSignals.push("ERC-8183 deliverable rejected by evaluator");
        }
        if (item.type === "x402_payment_failure") {
          riskSignals.push("x402 payment settlement failure detected");
        }
      }
    }

    dimensions[key] = totalWeightSum > 0 ? Math.round(weightedScoreSum / totalWeightSum) : 0;
  }

  // Calculate Coverage
  const totalCategoryTypes = Object.keys(AGENT_REPUTATION_WEIGHTS).length;
  const activeCategoryTypes = activeDimensions.length;
  const coverage = Math.round((activeCategoryTypes / totalCategoryTypes) * 100);

  // Dynamic weight normalization across active dimensions
  let trustScore = 0;
  if (activeDimensions.length > 0) {
    let rawWeightedSum = 0;
    let activeWeightSum = 0;

    for (const key of activeDimensions) {
      const weight = AGENT_REPUTATION_WEIGHTS[key];
      rawWeightedSum += dimensions[key] * weight;
      activeWeightSum += weight;
    }

    trustScore = Math.round(rawWeightedSum / activeWeightSum);
  }

  // Determine Confidence
  let confidence: ReputationConfidenceLevel = "Low";
  if (coverage >= 85) confidence = "Very High";
  else if (coverage >= 65) confidence = "High";
  else if (coverage >= 30) confidence = "Medium";

  // Determine Status Label via deterministic trust display logic
  const statusLabel = getTrustDisplayLabel(trustScore, confidence, uniqueEvidenceList.length);

  // Build top positive explanations
  if (identity.verifiedOnchain) topPositiveEvidence.push("ERC-8004 Identity verified onchain");
  if (totalCompletedJobs > 0) topPositiveEvidence.push(`${totalCompletedJobs} verified ERC-8183 jobs completed`);
  if (totalPassedEvaluations > 0) topPositiveEvidence.push(`${totalPassedEvaluations} Veyra evaluations passed`);
  if (totalSettlements > 0) topPositiveEvidence.push(`${totalSettlements} successful settlements recorded`);
  if (uniqueCounterparties.size > 0) topPositiveEvidence.push(`${uniqueCounterparties.size} independent counterparties`);

  if (topPositiveEvidence.length === 0) {
    topPositiveEvidence.push("Canonical agent identity active on Arc Testnet");
  }

  if (riskSignals.length === 0 && coverage < 50) {
    riskSignals.push("Limited external reputation history");
  }

  return {
    trustScore,
    confidence,
    coverage,
    statusLabel,
    dimensions,
    topPositiveEvidence,
    riskSignals,
  };
}

export function createReputationSnapshot(
  identity: CanonicalAgentIdentity,
  evidenceList: ReputationEvidence[],
  explanation: ReputationExplanation,
  arcProofTx?: string,
  now: Date = new Date()
): ReputationSnapshot {
  const snapshotPayload = {
    agentId: identity.agentId,
    trustScore: explanation.trustScore,
    confidence: explanation.confidence,
    coverage: explanation.coverage,
    dimensions: explanation.dimensions,
    evidenceCount: evidenceList.length,
    timestamp: now.toISOString(),
  };

  const canonicalHash = keccak256(stringToBytes(JSON.stringify(snapshotPayload)));

  // Deterministic snapshot ID from canonical inputs
  const sortedEvidenceHashes = [...evidenceList].map(e => e.canonicalHash).sort();
  const snapshotIdHash = keccak256(
    stringToBytes(
      JSON.stringify({
        agentId: identity.agentId,
        evidenceHashes: sortedEvidenceHashes,
        computedAt: now.toISOString(),
      })
    )
  );
  const snapshotId = `vrs_${snapshotIdHash.substring(2, 18)}`;

  const economicEvidenceCount = evidenceList.filter((e) => (e.economicValueUsdc || 0) > 0 || e.tier >= 3).length;

  return {
    snapshotId,
    agentId: identity.agentId,
    trustScore: explanation.trustScore,
    confidence: explanation.confidence,
    coverage: explanation.coverage,
    statusLabel: explanation.statusLabel,
    dimensions: explanation.dimensions,
    evidenceCount: evidenceList.length,
    economicEvidenceCount,
    canonicalHash,
    arcProofTx,
    topPositiveEvidence: explanation.topPositiveEvidence,
    riskSignals: explanation.riskSignals,
    createdAt: now.toISOString(),
  };
}

export function sanitizeEvidenceForPublic(evidenceList: ReputationEvidence[]): SanitizedEvidenceItem[] {
  return evidenceList.map((item) => ({
    evidenceId: item.evidenceId,
    type: item.type,
    tier: item.tier,
    positive: item.positive,
    score: item.score,
    economicValueUsdc: item.economicValueUsdc,
    verifiedOnchain: item.verifiedOnchain,
    arcProofVerified: item.arcProofVerified,
    observedAt: item.observedAt,
    canonicalHash: item.canonicalHash,
    arcscanTxUrl:
      item.sourceId && item.sourceId.startsWith("0x") && item.sourceId.length === 66
        ? `https://testnet.arcscan.app/tx/${item.sourceId}`
        : undefined,
  }));
}
