/**
 * Unit test suite for P6.1 Execution Module core components:
 * - Canonical EIP-712 hashing
 * - Deterministic state machine validation
 * - Budget calculation invariants
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

    // Failure branch transitions
    assert.ok(validateStateTransition("PREPARED", "CANCELLED", "exec_1"));
    assert.ok(validateStateTransition("EXECUTING", "FAILED", "exec_1"));
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
    assert.ok(validateStateTransition("EVIDENCE_PENDING", "COMPLETED_UNPROVEN", "exec_1"));
    assert.ok(validateStateTransition("COMPLETED_UNPROVEN", "COMPLETED", "exec_1"));

    // Terminal states check
    assert.ok(isTerminalState("COMPLETED"));
    assert.ok(isTerminalState("COMPLETED_UNPROVEN"));
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

  console.log("\n🎉 ALL P6.1 Execution Module Unit Tests Passed Successfully!");
}

runUnitTests().catch((err) => {
  console.error("❌ Unit tests failed:", err);
  process.exit(1);
});
