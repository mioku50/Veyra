import assert from "assert/strict";
import { evaluateTrustDecision } from "../lib/trust-gate/decision.ts";
import { computeCanonicalDecisionHash } from "../lib/trust-gate/canonical.ts";
import type { ReputationSnapshot } from "../lib/reputation/types.ts";
import type { TrustDecisionRequest } from "../lib/trust-gate/types.ts";
import { deriveReputationScoreFromEvaluation } from "../lib/reputation/erc8183-adapter.ts";

const createMockSnapshot = (overrides: Partial<ReputationSnapshot>): ReputationSnapshot => {
  return {
    snapshotId: "snap_1",
    agentId: "agent_1",
    trustScore: 90,
    confidence: "High",
    coverage: 0.7,
    statusLabel: "Highly Trusted",
    dimensions: {
      identity: 100,
      execution: 100,
      validation: 100,
      economicReliability: 100,
      serviceQuality: 100,
      reputation: 100,
    },
    evidenceCount: 10,
    economicEvidenceCount: 10,
    canonicalHash: "mock_hash",
    arcProofTx: "0xabc",
    topPositiveEvidence: [],
    riskSignals: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
};

const createMockRequest = (overrides: Partial<TrustDecisionRequest>): TrustDecisionRequest => {
  return {
    subjectAgentId: "agent_1",
    executorWallet: "0x1111111111111111111111111111111111111111",
    action: "erc8183_job",
    requestedValueUsdc: 10,
    ...overrides,
  };
};

async function runTests() {
  // 1. Score 90, High confidence, 70% coverage, fresh -> ALLOW, max 100 USDC
  {
    const req = createMockRequest({});
    const snap = createMockSnapshot({});
    const result = await evaluateTrustDecision(req, snap);
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.policy.maxValueUsdc, 100);
  }

  // 2. Score 75, Medium confidence, 55% coverage -> ALLOW_WITH_LIMITS, max 25 USDC
  {
    const req = createMockRequest({});
    const snap = createMockSnapshot({ trustScore: 75, confidence: "Medium", coverage: 0.55 });
    const result = await evaluateTrustDecision(req, snap);
    assert.equal(result.decision, "ALLOW_WITH_LIMITS");
    assert.equal(result.policy.maxValueUsdc, 25);
  }

  // 3. Score 55, Low confidence, 35% coverage -> REQUIRE_EVALUATOR, max 10 USDC
  {
    const req = createMockRequest({});
    const snap = createMockSnapshot({ trustScore: 55, confidence: "Low", coverage: 0.35 });
    const result = await evaluateTrustDecision(req, snap);
    assert.equal(result.decision, "REQUIRE_EVALUATOR");
    assert.equal(result.policy.maxValueUsdc, 10);
  }

  // 4. Score 35, Insufficient confidence -> REVIEW_REQUIRED, max 0 USDC
  {
    const req = createMockRequest({ requestedValueUsdc: 0 });
    const snap = createMockSnapshot({ trustScore: 35, confidence: "Low" as any, coverage: 0 }); // "Insufficient" not in type, use Low but coverage 0
    // Actually our type is "Low" | "Medium" | "High" | "Very High"
    const result = await evaluateTrustDecision(req, snap);
    assert.equal(result.decision, "REVIEW_REQUIRED");
    assert.equal(result.policy.maxValueUsdc, 0);
  }

  // 5. Score 20 -> DENY
  {
    const req = createMockRequest({});
    const snap = createMockSnapshot({ trustScore: 20, confidence: "Low", coverage: 0 });
    const result = await evaluateTrustDecision(req, snap);
    assert.equal(result.decision, "DENY");
  }

  // 6. Score 90 but critical sybil risk -> DENY
  {
    const req = createMockRequest({});
    const snap = createMockSnapshot({ riskSignals: ["SYBIL_RISK"] });
    const result = await evaluateTrustDecision(req, snap);
    assert.equal(result.decision, "DENY");
    assert.ok(result.reasons.includes("SYBIL_RISK"));
  }

  // 7. Request above the immutable limit must fail closed, not remain executable.
  {
    const req = createMockRequest({ requestedValueUsdc: 50 });
    const snap = createMockSnapshot({ trustScore: 75, confidence: "Medium", coverage: 0.55 });
    const result = await evaluateTrustDecision(req, snap);
    assert.equal(result.decision, "DENY");
    assert.ok(result.reasons.includes("VALUE_EXCEEDS_TRUST_LIMIT"));
  }

  // 8. No snapshot -> DENY with NO_REPUTATION_DATA
  {
    const req = createMockRequest({});
    const result = await evaluateTrustDecision(req, null);
    assert.equal(result.decision, "DENY");
    assert.ok(result.reasons.includes("NO_REPUTATION_DATA"));
  }

  // 9. Stale snapshot (> 1h for ALLOW tier) -> downgrade
  {
    const req = createMockRequest({});
    const oldDate = new Date(Date.now() - 4000 * 1000).toISOString();
    const snap = createMockSnapshot({ createdAt: oldDate });
    const result = await evaluateTrustDecision(req, snap);
    assert.equal(result.decision, "ALLOW_WITH_LIMITS");
    assert.ok(result.reasons.includes("STALE_REPUTATION"));
  }

  // 10. Canonical hash is deterministic
  {
    const req = createMockRequest({});
    const snap = createMockSnapshot({});
    const result1 = await evaluateTrustDecision(req, snap);
    const hash1 = computeCanonicalDecisionHash(result1);
    
    // Hash manually constructed decision object with same fields
    const hash2 = computeCanonicalDecisionHash({ ...result1 });
    assert.equal(hash1, hash2);
  }

  // 11. ERC-8183 score policy is canonical and rejects inconsistent states.
  {
    assert.equal(
      deriveReputationScoreFromEvaluation({ status: "completed", decision: "complete" }),
      100,
    );
    assert.equal(
      deriveReputationScoreFromEvaluation({ status: "rejected", decision: "reject" }),
      0,
    );
    assert.throws(
      () => deriveReputationScoreFromEvaluation({ status: "completed", decision: "reject" }),
      /not a consistent terminal result/,
    );
  }

  console.log("All Trust Gate tests passed!");
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
