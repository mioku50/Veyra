/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { keccak256, stringToBytes } from "viem";
import { computeAgentReputation, calculateTemporalDecay, calculateTierWeight, calculateCounterpartyMultiplier } from "../lib/reputation/engine.ts";
import type { CanonicalAgentIdentity, ReputationEvidence } from "../lib/reputation/types.ts";

async function runTestVectors() {
  console.log("⚡ Running P5.3 Reputation Engine Deterministic Test Vectors (A-G)...\n");

  const canonicalIdentity: CanonicalAgentIdentity = {
    agentId: "101",
    chainId: 5042002,
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    owner: "0x1111111111111111111111111111111111111111",
    metadataUri: "https://agent-commerce-six.vercel.app/.well-known/veyra-agent.json",
    verifiedOnchain: true,
  };

  const now = new Date("2026-08-07T12:00:00Z");

  // -------------------------------------------------------------
  // Test Vector A: New Agent (Identity only)
  // -------------------------------------------------------------
  console.log("⚡ Vector A: Testing New Agent (Identity only)...");
  const resA = computeAgentReputation(canonicalIdentity, [], now);
  assert.equal(resA.statusLabel, "Limited Evidence", "Vector A should yield Limited Evidence");
  assert.equal(resA.confidence, "Low", "Vector A confidence should be Low");
  assert.ok(resA.coverage < 30, "Vector A coverage should be < 30%");
  console.log("✅ Vector A PASSED: New Agent yields Limited Evidence and Low Confidence.");

  // -------------------------------------------------------------
  // Test Vector B: Reliable Agent
  // -------------------------------------------------------------
  console.log("\n⚡ Vector B: Testing Reliable Agent (High activity & completed jobs)...");
  const evidenceB: ReputationEvidence[] = [];

  for (let i = 1; i <= 10; i++) {
    const cp = `0x222222222222222222222222222222222222200${i}`;
    evidenceB.push({
      evidenceId: `b_job_${i}`,
      agentId: "101",
      type: "erc8183_job_completed",
      tier: 4,
      sourceId: `job_${i}`,
      score: 100,
      positive: true,
      confidence: 1.0,
      economicValueUsdc: 50,
      counterpartyAddress: cp,
      verifiedOnchain: true,
      arcProofVerified: true,
      sybilRisk: "none",
      observedAt: now.toISOString(),
      canonicalHash: keccak256(stringToBytes(`job_${i}`)),
    });

    evidenceB.push({
      evidenceId: `b_val_${i}`,
      agentId: "101",
      type: "erc8183_evaluation",
      tier: 2,
      sourceId: `val_${i}`,
      score: 100,
      positive: true,
      confidence: 1.0,
      counterpartyAddress: cp,
      verifiedOnchain: true,
      arcProofVerified: true,
      sybilRisk: "none",
      observedAt: now.toISOString(),
      canonicalHash: keccak256(stringToBytes(`val_${i}`)),
    });

    evidenceB.push({
      evidenceId: `b_pay_${i}`,
      agentId: "101",
      type: "x402_payment_success",
      tier: 3,
      sourceId: `pay_${i}`,
      score: 100,
      positive: true,
      confidence: 1.0,
      economicValueUsdc: 50,
      counterpartyAddress: cp,
      verifiedOnchain: true,
      arcProofVerified: false,
      sybilRisk: "none",
      observedAt: now.toISOString(),
      canonicalHash: keccak256(stringToBytes(`pay_${i}`)),
    });
  }

  const resB = computeAgentReputation(canonicalIdentity, evidenceB, now);
  assert.ok(resB.trustScore >= 85, `Vector B score should be >= 85 (got ${resB.trustScore})`);
  assert.equal(resB.statusLabel, "Highly Trusted", "Vector B status should be Highly Trusted");
  console.log(`✅ Vector B PASSED: Reliable Agent Trust Score = ${resB.trustScore} / 100 (${resB.statusLabel}).`);

  // -------------------------------------------------------------
  // Test Vector C: Sybil Feedback
  // -------------------------------------------------------------
  console.log("\n⚡ Vector C: Testing Sybil Feedback (50 feedback entries from same counterparty)...");
  const evidenceC: ReputationEvidence[] = [];
  const sybilCp = "0x9999999999999999999999999999999999999999";

  for (let i = 1; i <= 50; i++) {
    evidenceC.push({
      evidenceId: `c_fb_${i}`,
      agentId: "101",
      type: "erc8004_feedback",
      tier: 0,
      sourceId: `sybil_fb_${i}`,
      score: 100,
      positive: true,
      confidence: 0.2,
      counterpartyAddress: sybilCp,
      verifiedOnchain: false,
      arcProofVerified: false,
      sybilRisk: "high",
      observedAt: now.toISOString(),
      canonicalHash: keccak256(stringToBytes(`sybil_fb_${i}`)),
    });
  }

  const resC = computeAgentReputation(canonicalIdentity, evidenceC, now);
  assert.ok(resC.coverage < 50, "Vector C coverage should remain low due to missing execution/economic data");
  assert.notEqual(resC.statusLabel, "Highly Trusted", "Sybil feedback alone must NOT yield Highly Trusted");
  console.log(`✅ Vector C PASSED: Sybil feedback prevented artificial reputation inflation (Coverage: ${resC.coverage}%).`);

  // -------------------------------------------------------------
  // Test Vector D: High Activity but Poor Execution
  // -------------------------------------------------------------
  console.log("\n⚡ Vector D: Testing High Activity with High Rejection Ratio...");
  const evidenceD: ReputationEvidence[] = [...evidenceB];

  // Add 15 rejected jobs
  for (let i = 1; i <= 15; i++) {
    evidenceD.push({
      evidenceId: `d_rej_${i}`,
      agentId: "101",
      type: "erc8183_job_rejected",
      tier: 3,
      sourceId: `rej_${i}`,
      score: 0,
      positive: false,
      confidence: 1.0,
      counterpartyAddress: `0x333333333333333333333333333333333333300${i}`,
      verifiedOnchain: true,
      arcProofVerified: true,
      sybilRisk: "none",
      observedAt: now.toISOString(),
      canonicalHash: keccak256(stringToBytes(`rej_${i}`)),
    });
  }

  const resD = computeAgentReputation(canonicalIdentity, evidenceD, now);
  assert.ok(resD.trustScore < resB.trustScore, "Vector D score must drop significantly compared to Vector B");
  assert.ok(resD.riskSignals.length > 0, "Vector D must record risk signals for rejections");
  console.log(`✅ Vector D PASSED: Poor execution dropped score from ${resB.trustScore} -> ${resD.trustScore}.`);

  // -------------------------------------------------------------
  // Test Vector E: Self-Rating Filter
  // -------------------------------------------------------------
  console.log("\n⚡ Vector E: Testing Self-Rating Filter...");
  const evidenceE: ReputationEvidence[] = [
    {
      evidenceId: "self_1",
      agentId: "101",
      type: "erc8004_feedback",
      tier: 1,
      sourceId: "self_fb_1",
      score: 100,
      positive: true,
      confidence: 1.0,
      counterpartyAddress: canonicalIdentity.owner, // Owner rating own agent!
      verifiedOnchain: true,
      arcProofVerified: true,
      sybilRisk: "none",
      observedAt: now.toISOString(),
      canonicalHash: keccak256(stringToBytes("self_fb_1")),
    },
  ];

  const resE = computeAgentReputation(canonicalIdentity, evidenceE, now);
  assert.equal(resE.dimensions.reputation, 0, "Vector E self-rating should result in 0 reputation dimension score");
  console.log("✅ Vector E PASSED: Self-rating successfully filtered out with 0 weight.");

  // -------------------------------------------------------------
  // Test Vector F: Duplicate Evidence (Replay Protection)
  // -------------------------------------------------------------
  console.log("\n⚡ Vector F: Testing Duplicate Evidence Replay Protection...");
  const duplicateItem: ReputationEvidence = {
    evidenceId: "dup_1",
    agentId: "101",
    type: "erc8183_job_completed",
    tier: 4,
    sourceId: "job_dup",
    score: 100,
    positive: true,
    confidence: 1.0,
    counterpartyAddress: "0x4444444444444444444444444444444444444444",
    verifiedOnchain: true,
    arcProofVerified: true,
    sybilRisk: "none",
    observedAt: now.toISOString(),
    canonicalHash: keccak256(stringToBytes("job_dup_canonical")),
  };

  const resSingle = computeAgentReputation(canonicalIdentity, [duplicateItem], now);
  const resDup = computeAgentReputation(canonicalIdentity, [duplicateItem, duplicateItem, duplicateItem], now);
  assert.equal(resSingle.trustScore, resDup.trustScore, "Replaying duplicate evidence must not alter score");
  console.log("✅ Vector F PASSED: Duplicate evidence replay protection verified.");

  // -------------------------------------------------------------
  // Test Vector G: Stale Agent Temporal Decay
  // -------------------------------------------------------------
  console.log("\n⚡ Vector G: Testing Stale Agent Temporal Decay...");
  const oldDate = new Date("2025-01-01T00:00:00Z");
  const decay400Days = calculateTemporalDecay(oldDate.toISOString(), now);
  assert.equal(decay400Days, 0.35, "Evidence older than 365 days should decay to 0.35 multiplier");
  console.log("✅ Vector G PASSED: Temporal decay correctly calculates 0.35 multiplier for 365+ day old evidence.");

  console.log("\n🎉 All 7 P5.3 Reputation Engine Test Vectors (A-G) PASSED SUCCESSFULLY!");
}

runTestVectors().catch((err) => {
  console.error("❌ Test vectors failed:", err);
  process.exit(1);
});
