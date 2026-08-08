import assert from "node:assert/strict";
import { keccak256, stringToBytes } from "viem";
import { idempotencyKeyHash, selectionRequestHash } from "../lib/counterparty-selection/canonical.ts";
import { rankCounterpartyCandidate } from "../lib/counterparty-selection/engine.ts";
import { validateSelectionRequest } from "../lib/counterparty-selection/service.ts";
import { freshnessFromAge } from "../lib/counterparty-selection/policy.ts";
import { calculateCounterpartyMultiplier, calculateEvidenceWeight } from "../lib/reputation/engine.ts";
import type { CandidateRankingInput } from "../lib/counterparty-selection/types.ts";

assert.throws(() => validateSelectionRequest({ capability: "xx", budgetUsdc: 1, candidates: [{ agentId: "1" }], winner: "1" }), /client_derived_fields_forbidden/);
assert.throws(() => validateSelectionRequest({ capability: "xx", budgetUsdc: 1, candidates: [{ agentId: "1" }], publishProof: true }), /proof_requires_explicit_action/);
assert.throws(() => validateSelectionRequest({ capability: "xx", budgetUsdc: 1, candidates: [{ agentId: "1" }], network: "eip155:1" }), /network_unsupported/);
assert.throws(() => validateSelectionRequest({ capability: "xx", budgetUsdc: 1, candidates: [] }), /candidate_count_invalid/);
assert.throws(() => validateSelectionRequest({ capability: "xx", budgetUsdc: 1, candidates: Array.from({ length: 11 }, (_, i) => ({ agentId: String(i + 1) })) }), /candidate_count_invalid/);
assert.throws(() => validateSelectionRequest({ capability: "xx", budgetUsdc: 1, candidates: [{ agentId: "1" }], task: "Authorization: Bearer this-is-a-secret-token-123456" }), /sensitive_input_rejected/);
assert.throws(() => validateSelectionRequest({ capability: "xx", budgetUsdc: 1, candidates: [{ agentId: "1", trustScore: 100 }] }), /candidate_input_invalid/);
assert.throws(() => validateSelectionRequest({ capability: "xx", budgetUsdc: 1, candidates: [{ agentId: "1" }, { agentId: "1" }] }), /duplicate_candidate_input/);

const a = { capability: "github_due_diligence", task: "review", budgetUsdc: 0.1, candidates: [{ agentId: "1" }] };
const b = { capability: "github_due_diligence", task: "different", budgetUsdc: 0.1, candidates: [{ agentId: "1" }] };
assert.notEqual(selectionRequestHash(a), selectionRequestHash(b), "Changed payload must conflict under one idempotency key");
assert.notEqual(idempotencyKeyHash("tenant:a", "same-key"), idempotencyKeyHash("tenant:b", "same-key"), "Idempotency keys must be tenant-bound");

const rankingInput: CandidateRankingInput = {
  identity: { agentId: "1", ownerAddress: "0x0000000000000000000000000000000000000001", registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e", metadataUri: "https://example.com", serviceIds: [], source: "erc8004", verifiedOnchain: true },
  evidence: {
    identity: undefined as never, snapshotHash: keccak256(stringToBytes("s")), snapshotCreatedAt: new Date().toISOString(), trustScore: 99, snapshotConfidence: 1, snapshotCoverage: 1,
    dimensions: { reputationQuality: 99, executionReliability: 99, evaluatorSuccess: 99, economicReliability: 99, serviceQuality: 99 },
    evidenceCounts: { total: 10, execution: 2, evaluator: 2, economic: 2, serviceQuality: 2, independentCounterparties: 4 },
    sources: [{ source: "reputation", observedAt: new Date().toISOString(), ageSeconds: 0, freshness: "fresh", evidenceCount: 10 }], riskSignals: [], positiveSignals: [], services: [], evidenceHash: keccak256(stringToBytes("e")),
  },
  trustDecision: { decisionId: "vtd_0000000000000001", decision: "ALLOW", subject: { agentId: "1" }, trust: { score: 99, confidence: 1, coverage: 1, snapshotHash: keccak256(stringToBytes("s")), snapshotAgeSeconds: 0 }, request: { action: "service_purchase", requestedValueUsdc: 1 }, policy: { version: "v1", maxValueUsdc: 10, evaluatorRequired: false }, reasons: [], riskSignals: [], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), canonicalHash: keccak256(stringToBytes("d")) },
  requestedBudgetUsdc: 1, capability: "required", capabilityMatch: "none", requireExactCapability: true, advertisedPriceUsdc: 2, priceKind: "advertised",
};
const excluded = rankCounterpartyCandidate(rankingInput);
assert.equal(excluded.eligibility, "INELIGIBLE");
assert.equal(excluded.recommendedMaxExposureUsdc, 0);

const selfEvidence = {
  evidenceId: "self", agentId: "1", type: "erc8004_feedback" as const, tier: 4 as const,
  sourceId: "real-source", score: 100, positive: true, confidence: 1,
  counterpartyAddress: rankingInput.identity.ownerAddress, verifiedOnchain: true,
  arcProofVerified: true, sybilRisk: "none" as const, observedAt: new Date().toISOString(),
  canonicalHash: keccak256(stringToBytes("self")),
};
assert.equal(calculateEvidenceWeight(selfEvidence, {
  agentId: "1", chainId: 5_042_002, identityRegistry: rankingInput.identity.registryAddress,
  owner: rankingInput.identity.ownerAddress, verifiedOnchain: true,
}, 1).weight, 0, "Self-rating evidence must have zero weight");
assert.ok(calculateCounterpartyMultiplier(4) < calculateCounterpartyMultiplier(1), "Repeated one-counterparty feedback must diminish");
assert.equal(freshnessFromAge(90_000), "stale", "Stale evidence cannot be presented as fresh");

const zeroCoverage = structuredClone(rankingInput);
zeroCoverage.capabilityMatch = "generic";
zeroCoverage.requireExactCapability = false;
zeroCoverage.advertisedPriceUsdc = undefined;
zeroCoverage.evidence.snapshotCoverage = 0;
zeroCoverage.evidence.snapshotConfidence = 100;
zeroCoverage.evidence.evidenceCounts = { total: 0, execution: 0, evaluator: 0, economic: 0, serviceQuality: 0, independentCounterparties: 0 };
const zeroCoverageResult = rankCounterpartyCandidate(zeroCoverage);
assert.equal(zeroCoverageResult.confidence, 0, "A high upstream score with zero evidence coverage cannot retain confidence");
assert.equal(zeroCoverageResult.rankingScore, 0);

console.log("Counterparty selection negative tests passed.");
