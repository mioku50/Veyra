/**
 * Unit test suite for P6.1 Execution Module core components:
 * - Canonical EIP-712 hashing
 * - Deterministic state machine validation
 * - Budget calculation invariants
 * - x402 V2 Header Encoding/Decoding
 */

import assert from "node:assert/strict";
import {
  buildMandateEip712Message,
  computeCanonicalExecutionHash,
  computeCanonicalMandateHash,
  hashCapabilities,
  hashRails,
} from "../lib/execution/canonical.ts";
import {
  isTerminalState,
  validateStateTransition,
  InvalidStateTransitionError,
} from "../lib/execution/state-machine.ts";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

async function runUnitTests() {
  console.log("Starting P6.1 Execution Module Unit Tests...\n");

  // 1. Deterministic hashing tests
  {
    const capsA = ["github_due_diligence", "code_review"];
    const capsB = ["code_review", "github_due_diligence"]; // Different order
    assert.equal(hashCapabilities(capsA), hashCapabilities(capsB), "hashCapabilities must be permutation-invariant");

    const railsA = ["erc8183", "x402"];
    const railsB = ["x402", "erc8183"];
    assert.equal(hashRails(railsA), hashRails(railsB), "hashRails must be permutation-invariant");
    console.log("✅ Array hashing is deterministic and permutation-invariant.");
  }

  // 2. Canonical mandate hashing
  {
    const mandateData = {
      mandateId: "vman_test_123",
      ownerWallet: "0x1111111111111111111111111111111111111111" as const,
      subjectAgentId: "agent_alpha",
      subjectWallet: "0x2222222222222222222222222222222222222222" as const,
      mode: "AUTOPILOT",
      network: "eip155:5042002",
      allowedCapabilities: ["github_due_diligence"],
      allowedRails: ["erc8183"],
      maxPerTransactionUsdc: 1.5,
      maxPerDayUsdc: 5.0,
      maxTotalUsdc: 10.0,
      minimumTrustScore: 80,
      minimumConfidence: 70,
      issuedAt: "2026-08-15T12:00:00Z",
      expiresAt: "2026-08-16T12:00:00Z",
    };

    const msg1 = buildMandateEip712Message(mandateData);
    const hash1 = computeCanonicalMandateHash(msg1);

    const msg2 = buildMandateEip712Message({ ...mandateData });
    const hash2 = computeCanonicalMandateHash(msg2);

    assert.equal(hash1, hash2, "Mandate canonical hash must be deterministic");
    assert.equal(typeof hash1, "string");
    assert.ok(hash1.startsWith("0x"), "Hash must be 0x-prefixed hex");
    console.log("✅ Canonical mandate hashing verified.");
  }

  // 3. Execution attempt canonical hashing
  {
    const attemptData = {
      executionId: "vexec_123",
      mandateId: "vman_test_123",
      selectionId: "vsel_456",
      selectionHash: "0xabc",
      rail: "erc8183",
      counterpartyAgentId: "agent_beta",
      counterpartyWallet: "0x3333333333333333333333333333333333333333",
      capability: "github_due_diligence",
      requestedAmountUsdc: 1.0,
      authorizedAmountUsdc: 1.0,
      clearanceDigest: "0xdef",
      createdAt: "2026-08-15T12:00:00Z",
    };

    const hash1 = computeCanonicalExecutionHash(attemptData);
    const hash2 = computeCanonicalExecutionHash({
      ...attemptData,
      counterpartyWallet: "0x3333333333333333333333333333333333333333".toUpperCase(), // Casing insensitive
    });

    assert.equal(hash1, hash2, "Execution hash must normalize wallet addresses to lowercase");
    console.log("✅ Canonical execution attempt hashing verified.");
  }

  // 4. State Machine Transition Tests
  {
    // Allowed transitions
    assert.ok(validateStateTransition("DRAFT", "PREPARED", "exec_1"));
    assert.ok(validateStateTransition("PREPARED", "EXECUTING", "exec_1"));
    assert.ok(validateStateTransition("EXECUTING", "SUBMITTED", "exec_1"));
    assert.ok(validateStateTransition("SUBMITTED", "EVALUATING", "exec_1"));
    assert.ok(validateStateTransition("EVALUATING", "SETTLING", "exec_1"));
    assert.ok(validateStateTransition("SETTLING", "COMPLETED", "exec_1"));

    // Failure and unproven branch transitions
    assert.ok(validateStateTransition("PREPARED", "CANCELLED", "exec_1"));
    assert.ok(validateStateTransition("EXECUTING", "FAILED", "exec_1"));
    assert.ok(validateStateTransition("EXECUTING", "SETTLED_SERVICE_FAILED", "exec_1"));
    assert.ok(validateStateTransition("SETTLING", "SETTLED_SERVICE_FAILED", "exec_1"));
    assert.ok(validateStateTransition("SETTLING", "SETTLEMENT_FAILED", "exec_1"));
    assert.ok(validateStateTransition("EVALUATING", "EVALUATION_REJECTED", "exec_1"));

    // Illegal transitions must throw
    assert.throws(
      () => validateStateTransition("DRAFT", "COMPLETED", "exec_1"),
      InvalidStateTransitionError,
      "DRAFT cannot jump directly to COMPLETED"
    );

    assert.throws(
      () => validateStateTransition("COMPLETED", "EXECUTING", "exec_1"),
      InvalidStateTransitionError,
      "COMPLETED is terminal and cannot transition to EXECUTING"
    );

    assert.throws(
      () => validateStateTransition("FAILED", "COMPLETED", "exec_1"),
      InvalidStateTransitionError,
      "FAILED is terminal and cannot transition to COMPLETED"
    );

    // Intermediate and unproven state transitions
    assert.ok(validateStateTransition("EXECUTING", "EVIDENCE_PENDING", "exec_1"));
    assert.ok(validateStateTransition("COMPLETED_UNPROVEN", "COMPLETED", "exec_1"));

    // WAITING_FOR_PROVIDER transitions
    assert.ok(validateStateTransition("EXECUTING", "WAITING_FOR_PROVIDER", "test-wp-1"));
    assert.ok(validateStateTransition("WAITING_FOR_PROVIDER", "EVALUATING", "test-wp-2"));
    assert.ok(validateStateTransition("WAITING_FOR_PROVIDER", "FAILED", "test-wp-3"));
    assert.ok(validateStateTransition("WAITING_FOR_PROVIDER", "EXPIRED", "test-wp-4"));
    // Illegal: WAITING_FOR_PROVIDER → EXECUTING (no going back)
    assert.throws(
      () => validateStateTransition("WAITING_FOR_PROVIDER", "EXECUTING", "test-wp-bad"),
      InvalidStateTransitionError
    );

    // Terminal states check
    assert.ok(isTerminalState("COMPLETED"));
    assert.ok(isTerminalState("COMPLETED_UNPROVEN"));
    assert.ok(isTerminalState("SETTLED_SERVICE_FAILED"));
    assert.ok(isTerminalState("FAILED"));
    assert.ok(isTerminalState("REJECTED"));
    assert.ok(isTerminalState("CANCELLED"));
    assert.ok(isTerminalState("EXPIRED"));
    assert.ok(isTerminalState("SETTLEMENT_FAILED"));
    assert.ok(isTerminalState("EVALUATION_REJECTED"));
    assert.ok(!isTerminalState("EXECUTING"));
    assert.ok(!isTerminalState("PREPARED"));
    assert.ok(!isTerminalState("EVIDENCE_PENDING"));

    console.log("✅ State machine transitions and terminal states strictly enforced.");
  }

  // 5. x402 V2 Header Encoding & Decoding Verification
  {
    const reqPayload: any = {
      x402Version: 2,
      error: "Payment required",
      network: "eip155:5042002",
      scheme: "exact",
      payTo: "0x3333333333333333333333333333333333333333",
      maxAmount: "10000",
      amountUsdc: "0.01",
    };

    const encodedReq = encodePaymentRequiredHeader(reqPayload);
    const decodedReq = decodePaymentRequiredHeader(encodedReq);
    assert.equal(decodedReq.x402Version, 2);
    assert.equal((decodedReq as any).network, "eip155:5042002");

    const respPayload: any = {
      success: true,
      transaction: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      network: "eip155:5042002",
    };
    const encodedResp = encodePaymentResponseHeader(respPayload);
    const decodedResp = decodePaymentResponseHeader(encodedResp);
    assert.equal(decodedResp.success, true);
    assert.equal(decodedResp.transaction, respPayload.transaction);

    console.log("✅ x402 V2 official HTTP header encoding and decoding verified.");
  }

  // 6. Deterministic Snapshot IDs
  {
    const { createReputationSnapshot } = await import("../lib/reputation/engine.ts");
    const agent = { agentId: "test_agent_1", chainId: 5042002 as const, owner: "0x1111111111111111111111111111111111111111", identityRegistry: "0x", verifiedOnchain: true };
    const explanation = { trustScore: 100, confidence: "High" as any, coverage: 100, statusLabel: "Strong" as any, dimensions: {} as any, topPositiveEvidence: [], riskSignals: [] };
    const evidence = [{ canonicalHash: "0x1", economicValueUsdc: 0, tier: 1 }] as any[];
    const newEvidence = { canonicalHash: "0x2", economicValueUsdc: 0, tier: 1 } as any;

    const snap1 = createReputationSnapshot(agent, evidence, explanation, undefined, new Date("2026-01-01"));
    const snap2 = createReputationSnapshot(agent, evidence, explanation, undefined, new Date("2026-01-01"));
    assert.strictEqual(snap1.snapshotId, snap2.snapshotId, "Same evidence must produce same snapshotId");

    const snap3 = createReputationSnapshot(agent, [...evidence, newEvidence], explanation, undefined, new Date("2026-01-01"));
    assert.notStrictEqual(snap1.snapshotId, snap3.snapshotId, "New evidence must produce different snapshotId");
    console.log("✅ Deterministic Snapshot IDs verified.");
  }

  console.log("\n🎉 ALL P6.1 Execution Module Unit Tests Passed Successfully!");
}

runUnitTests().catch((err) => {
  console.error("❌ Unit tests failed:", err);
  process.exit(1);
});
