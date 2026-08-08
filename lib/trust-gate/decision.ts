import { randomBytes } from "crypto";
import { isAddress } from "viem";
import { getCanonicalAgentIdentity } from "../erc8004/client.ts";
import { fetchLatestReputationSnapshot } from "../reputation/db.ts";
import type { ReputationSnapshot } from "../reputation/types.ts";
import type {
  TrustDecisionRequest,
  TrustDecision,
  TrustRiskCode,
} from "./types.ts";
import {
  TRUST_POLICY_VERSION,
  TRUST_DECISION_EXPIRY_SECONDS,
} from "./types.ts";
import { resolvePolicy, DENY_TIER } from "./policy.ts";
import { computeCanonicalDecisionHash } from "./canonical.ts";

export async function evaluateTrustDecision(
  request: TrustDecisionRequest,
  useInMemorySnapshot?: ReputationSnapshot | null
): Promise<TrustDecision> {
  if (
    !request.subjectAgentId?.trim()
    || !request.action
    || !Number.isFinite(request.requestedValueUsdc)
    || request.requestedValueUsdc < 0
    || (request.executorWallet !== undefined && !isAddress(request.executorWallet))
  ) {
    throw new Error("Invalid trust decision request");
  }

  const identity = useInMemorySnapshot !== undefined
    ? null
    : await getCanonicalAgentIdentity(request.subjectAgentId);
  const snapshot = useInMemorySnapshot !== undefined
    ? useInMemorySnapshot 
    : (await fetchLatestReputationSnapshot(request.subjectAgentId));

  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TRUST_DECISION_EXPIRY_SECONDS * 1000).toISOString();

  if (!identity && useInMemorySnapshot === undefined) {
    const decision: TrustDecision = {
      decisionId: `vtd_${randomBytes(8).toString("hex")}`,
      decision: "DENY",
      subject: { agentId: request.subjectAgentId },
      trust: {
        score: 0,
        confidence: 0,
        coverage: 0,
        snapshotHash: "",
        snapshotAgeSeconds: 0,
      },
      request: {
        action: request.action,
        requestedValueUsdc: request.requestedValueUsdc,
        counterparty: request.counterpartyAgentId || request.counterpartyWallet,
        executor: request.executorWallet,
        serviceId: request.serviceId,
        workflowType: request.workflowType,
      },
      policy: {
        version: TRUST_POLICY_VERSION,
        maxValueUsdc: 0,
        evaluatorRequired: true,
      },
      reasons: ["IDENTITY_NOT_FOUND"],
      riskSignals: ["IDENTITY_NOT_FOUND"],
      issuedAt,
      expiresAt,
      canonicalHash: "",
    };
    decision.canonicalHash = computeCanonicalDecisionHash(decision);
    return decision;
  }

  if (!snapshot) {
    const decision: TrustDecision = {
      decisionId: `vtd_${randomBytes(8).toString("hex")}`,
      decision: "DENY",
      subject: {
        agentId: request.subjectAgentId,
        wallet:
          identity?.owner_address ||
          (useInMemorySnapshot !== undefined ? request.executorWallet : undefined),
      },
      trust: {
        score: 0,
        confidence: 0,
        coverage: 0,
        snapshotHash: "",
        snapshotAgeSeconds: 0,
      },
      request: {
        action: request.action,
        requestedValueUsdc: request.requestedValueUsdc,
        counterparty: request.counterpartyAgentId || request.counterpartyWallet,
        executor: request.executorWallet,
        serviceId: request.serviceId,
        workflowType: request.workflowType,
      },
      policy: {
        version: TRUST_POLICY_VERSION,
        maxValueUsdc: 0,
        evaluatorRequired: true,
      },
      reasons: ["NO_REPUTATION_DATA"],
      riskSignals: ["NO_REPUTATION_DATA"],
      issuedAt,
      expiresAt,
      canonicalHash: "",
    };
    decision.canonicalHash = computeCanonicalDecisionHash(decision);
    return decision;
  }

  const snapshotAgeSeconds = (Date.now() - new Date(snapshot.createdAt).getTime()) / 1000;

  let confidenceNum = 0;
  if (snapshot.confidence === "High" || snapshot.confidence === "Very High") confidenceNum = 0.9;
  else if (snapshot.confidence === "Medium") confidenceNum = 0.6;
  else if (snapshot.confidence === "Low") confidenceNum = 0.3;
  const coverageNum = snapshot.coverage > 1 ? snapshot.coverage / 100 : snapshot.coverage;

  const riskSignals: TrustRiskCode[] = [];
  
  if (snapshot.dimensions.economicReliability < 50) riskSignals.push("LOW_ECONOMIC_RELIABILITY");
  if (snapshot.dimensions.execution < 50) riskSignals.push("LOW_EXECUTION_RELIABILITY");
  if (snapshot.riskSignals.includes("sybilRisk") || snapshot.riskSignals.includes("SYBIL_RISK")) riskSignals.push("SYBIL_RISK");
  if (snapshot.riskSignals.includes("counterpartyFarming") || snapshot.riskSignals.includes("COUNTERPARTY_FARMING")) riskSignals.push("COUNTERPARTY_FARMING");
  if (!snapshot.arcProofTx) riskSignals.push("ARC_PROOF_UNVERIFIED");

  if (confidenceNum < 0.3) riskSignals.push("LOW_CONFIDENCE");
  if (coverageNum < 0.3) riskSignals.push("INSUFFICIENT_COVERAGE");
  
  if (snapshotAgeSeconds > 3600) {
     riskSignals.push("STALE_REPUTATION");
  }

  let { tier, reasons } = resolvePolicy(
    snapshot.trustScore,
    confidenceNum,
    coverageNum,
    snapshotAgeSeconds,
    riskSignals
  );

  if (request.requestedValueUsdc > tier.maxValueUsdc && tier.level !== "DENY") {
    reasons.push("VALUE_EXCEEDS_TRUST_LIMIT");
    // Every lower trust tier has an equal or smaller limit. Downgrading by one
    // tier would still return an executable decision for an over-limit amount.
    tier = DENY_TIER;
  }

  const decision: TrustDecision = {
    decisionId: `vtd_${randomBytes(8).toString("hex")}`,
    decision: tier.level,
    subject: {
      agentId: request.subjectAgentId,
      wallet:
        identity?.owner_address ||
        (useInMemorySnapshot !== undefined ? request.executorWallet : undefined),
    },
    trust: {
      score: snapshot.trustScore,
      confidence: confidenceNum,
      coverage: coverageNum,
      snapshotHash: snapshot.canonicalHash,
      snapshotAgeSeconds,
    },
    request: {
      action: request.action,
      requestedValueUsdc: request.requestedValueUsdc,
      counterparty: request.counterpartyAgentId || request.counterpartyWallet,
      executor: request.executorWallet,
      serviceId: request.serviceId,
      workflowType: request.workflowType,
    },
    policy: {
      version: TRUST_POLICY_VERSION,
      maxValueUsdc: tier.maxValueUsdc,
      evaluatorRequired: tier.evaluatorRequired,
    },
    reasons: Array.from(new Set(reasons)),
    riskSignals: Array.from(new Set(riskSignals)),
    issuedAt,
    expiresAt,
    canonicalHash: "",
  };

  decision.canonicalHash = computeCanonicalDecisionHash(decision);
  return decision;
}
