import assert from "node:assert/strict";
import { keccak256, stringToBytes } from "viem";
import { rankCounterparties, rankCounterpartyCandidate } from "../lib/counterparty-selection/engine.ts";
import { hashCanonical, selectionCanonicalHash } from "../lib/counterparty-selection/canonical.ts";
import { COUNTERPARTY_SELECTION_POLICY } from "../lib/counterparty-selection/policy.ts";
import type { CandidateRankingInput, SelectionCanonicalPayload } from "../lib/counterparty-selection/types.ts";

function fixture(overrides: Partial<CandidateRankingInput> = {}): CandidateRankingInput {
  const agentId = overrides.identity?.agentId || "101";
  return {
    identity: {
      agentId,
      ownerAddress: `0x${agentId.padStart(40, "0")}` as `0x${string}`,
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      metadataUri: `https://example.com/agents/${agentId}.json`,
      serviceIds: [],
      source: "erc8004",
      verifiedOnchain: true,
    },
    evidence: {
      identity: undefined as never,
      snapshotHash: keccak256(stringToBytes(`snapshot:${agentId}`)),
      snapshotCreatedAt: "2026-08-08T12:00:00.000Z",
      trustScore: 80,
      snapshotConfidence: 80,
      snapshotCoverage: 0.8,
      dimensions: {
        reputationQuality: 80,
        executionReliability: 70,
        evaluatorSuccess: 90,
        economicReliability: 60,
        serviceQuality: 75,
      },
      evidenceCounts: { total: 8, execution: 2, evaluator: 2, economic: 1, serviceQuality: 2, independentCounterparties: 3 },
      sources: ["identity", "reputation", "execution", "economic", "service_quality", "evaluator", "risk"].map((source) => ({
        source: source as never,
        observedAt: "2026-08-08T12:00:00.000Z",
        ageSeconds: 60,
        freshness: "fresh" as const,
        evidenceCount: 1,
      })),
      riskSignals: [],
      positiveSignals: ["Verified execution history"],
      services: [],
      evidenceHash: keccak256(stringToBytes(`evidence:${agentId}`)),
    },
    trustDecision: {
      decisionId: `vtd_${agentId.padStart(16, "0")}`,
      decision: "ALLOW",
      subject: { agentId },
      trust: { score: 80, confidence: 0.8, coverage: 0.8, snapshotHash: keccak256(stringToBytes(`snapshot:${agentId}`)), snapshotAgeSeconds: 60 },
      request: { action: "service_purchase", requestedValueUsdc: 0.1 },
      policy: { version: "trust-policy-v1", maxValueUsdc: 1, evaluatorRequired: false },
      reasons: [], riskSignals: [], issuedAt: "2026-08-08T12:00:00.000Z", expiresAt: "2026-08-08T12:05:00.000Z",
      canonicalHash: keccak256(stringToBytes(`decision:${agentId}`)),
    },
    requestedBudgetUsdc: 0.1,
    capability: "github_due_diligence",
    capabilityMatch: "exact",
    requireExactCapability: false,
    priceKind: "unknown",
    ...overrides,
  };
}

const first = rankCounterpartyCandidate(fixture());
const second = rankCounterpartyCandidate(fixture());
assert.deepEqual(first, second, "Ranking must be deterministic for identical canonical inputs");
assert.equal(COUNTERPARTY_SELECTION_POLICY.version, "veyra-counterparty-selection-v1");
assert.deepEqual(COUNTERPARTY_SELECTION_POLICY.weights, {
  reputationQuality: 0.30,
  executionReliability: 0.25,
  evaluatorSuccess: 0.15,
  economicReliability: 0.10,
  serviceQuality: 0.10,
  evidenceFreshnessCoverage: 0.10,
});
assert.equal(first.confidence, 80);
assert.equal(first.rankingScore, Math.round(first.baseQualityScore * (0.60 + 0.8 * 0.40)));

const highRawDenied = fixture({
  identity: { ...fixture().identity, agentId: "999", ownerAddress: "0x0000000000000000000000000000000000000999" },
  trustDecision: { ...fixture().trustDecision, decisionId: "vtd_0000000000000999", decision: "DENY", canonicalHash: keccak256(stringToBytes("denied")) },
  evidence: { ...fixture().evidence, trustScore: 99, dimensions: { reputationQuality: 99, executionReliability: 99, evaluatorSuccess: 99, economicReliability: 99, serviceQuality: 99 }, evidenceHash: keccak256(stringToBytes("high-denied")) },
});
const eligible = fixture({ identity: { ...fixture().identity, agentId: "100", ownerAddress: "0x0000000000000000000000000000000000000100" } });
const ranked = rankCounterparties([highRawDenied, eligible]);
assert.equal(ranked.winner?.identity.agentId, "100", "A policy-ineligible candidate must never win");
assert.equal(ranked.winner?.rank, 1, "Eligibility must be applied before assigning final rank");
assert.equal(ranked.ranked.find((item) => item.identity.agentId === "999")?.eligibility, "INELIGIBLE");
assert.equal(ranked.ranked.find((item) => item.identity.agentId === "999")?.rank, 2);

const blocklisted = rankCounterpartyCandidate(fixture({
  arcUsdcBlocklistStatus: "blocklisted",
}));
assert.equal(blocklisted.eligibility, "INELIGIBLE");
assert.equal(blocklisted.rejectionReason, "arc_usdc_blocklisted");
assert.ok(blocklisted.riskSignals.includes("arc_usdc_blocklisted"));

const missing = fixture();
missing.evidence = { ...missing.evidence, evidenceCounts: { total: 0, execution: 0, evaluator: 0, economic: 0, serviceQuality: 0, independentCounterparties: 0 } };
const missingResult = rankCounterpartyCandidate(missing);
assert.ok(missingResult.dimensions.every((item) => item.score === 0), "Missing evidence cannot be converted into positive scores");

const canonical = { b: 2, a: { z: 3, y: 1 } };
assert.equal(hashCanonical(canonical), hashCanonical({ a: { y: 1, z: 3 }, b: 2 }));
const payload = {
  schema: "veyra.counterparty-selection.v1", selectionId: "vcs_0000000000000001",
  requester: { agentId: "1", wallet: "0x0000000000000000000000000000000000000001" },
  intent: { capability: "x", taskHash: keccak256(stringToBytes("x")), requestedBudgetUsdc: "0.100000", network: "eip155:5042002", requireExactCapability: false },
  selectedCandidateSet: [], finalRanking: [],
  winner: { agentId: "1", ownerAddress: "0x0000000000000000000000000000000000000001", serviceId: null, trustDecision: "ALLOW", maxExposureUsdc: "0.100000" },
  policyVersion: "trust-policy-v1", rankingVersion: "veyra-counterparty-selection-v1",
  createdAt: "2026-08-08T12:00:00.000Z", expiresAt: "2026-08-08T12:15:00.000Z",
} satisfies SelectionCanonicalPayload;
assert.notEqual(selectionCanonicalHash(payload), selectionCanonicalHash({ ...payload, winner: { ...payload.winner, agentId: "2" } }));

console.log("Counterparty selection unit tests passed.");
