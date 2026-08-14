/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Negative and Adversarial Security Tests for P6.1 Trust-Routed Execution:
 * 1. Per-transaction spending cap violation
 * 2. Revoked mandate rejection
 * 3. Expired mandate rejection
 * 4. Disallowed capability rejection
 * 5. Disallowed rail rejection
 * 6. Sybil risk detection rejection
 * 7. Illegal state transition rejection
 */

import assert from "node:assert/strict";
import { checkMandateEligibility } from "../lib/execution/mandate.ts";
import { validateStateTransition, InvalidStateTransitionError } from "../lib/execution/state-machine.ts";
import type { ExecutionMandate } from "../lib/execution/types.ts";

async function runNegativeTests() {
  console.log("=== Starting P6.1 Execution Negative & Adversarial Tests ===\n");

  const validMandate: ExecutionMandate = {
    mandateId: "vman_neg_test",
    ownerWallet: "0x1111111111111111111111111111111111111111",
    subjectAgentId: "agent_neg_buyer",
    subjectWallet: "0x1111111111111111111111111111111111111111",
    mode: "AUTOPILOT",
    network: "eip155:5042002",
    allowedCapabilities: ["github_due_diligence"],
    allowedRails: ["erc8183"],
    maxPerTransactionUsdc: 2.0,
    maxPerDayUsdc: 10.0,
    maxTotalUsdc: 50.0,
    minimumTrustScore: 70,
    minimumConfidence: 60,
    requireVerifiedIdentity: true,
    evaluatorThresholdUsdc: 0,
    canonicalHash: "0x",
    signature: "0x",
    nonce: 0,
    version: "v1",
    issuedAt: "2026-08-15T12:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    createdAt: "2026-08-15T12:00:00Z",
  };

  // 1. Transaction spending cap violation
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 5.0, // Exceeds 2.0
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.some((r) => r.includes("PER_TRANSACTION_CAP_EXCEEDED")));
    console.log("✅ Per-transaction spending cap violation successfully rejected.");
  }

  // 2. Revoked mandate rejection
  {
    const revokedMandate: ExecutionMandate = {
      ...validMandate,
      revokedAt: new Date().toISOString(),
    };
    const res = checkMandateEligibility(revokedMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.includes("MANDATE_REVOKED"));
    console.log("✅ Revoked mandate execution successfully rejected.");
  }

  // 3. Expired mandate rejection
  {
    const expiredMandate: ExecutionMandate = {
      ...validMandate,
      expiresAt: "2020-01-01T00:00:00Z",
    };
    const res = checkMandateEligibility(expiredMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.includes("MANDATE_EXPIRED"));
    console.log("✅ Expired mandate execution successfully rejected.");
  }

  // 4. Disallowed capability rejection
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "unauthorized_drain_funds",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.some((r) => r.includes("CAPABILITY_NOT_ALLOWED")));
    console.log("✅ Disallowed capability execution successfully rejected.");
  }

  // 5. Disallowed rail rejection
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "github_due_diligence",
      rail: "x402", // only erc8183 is allowed
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.some((r) => r.includes("RAIL_NOT_ALLOWED")));
    console.log("✅ Disallowed settlement rail execution successfully rejected.");
  }

  // 6. Insufficient trust score rejection
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 40, // min is 70
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.some((r) => r.includes("INSUFFICIENT_TRUST_SCORE")));
    console.log("✅ Sub-threshold trust score candidate successfully rejected.");
  }

  // 7. Identity requirement violation
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: false,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.includes("ERC8004_IDENTITY_REQUIRED"));
    console.log("✅ Unverified identity candidate successfully rejected.");
  }

  // 8. Illegal state transition violation
  {
    assert.throws(
      () => validateStateTransition("COMPLETED", "EXECUTING", "vexec_test"),
      InvalidStateTransitionError
    );
    assert.throws(
      () => validateStateTransition("DRAFT", "COMPLETED", "vexec_test"),
      InvalidStateTransitionError
    );
    console.log("✅ Illegal execution state transitions strictly rejected.");
  }

  // 9. Autopilot disabled when VEYRA_AUTOPILOT_ENABLED !== "true"
  {
    const oldVal = process.env.VEYRA_AUTOPILOT_ENABLED;
    delete process.env.VEYRA_AUTOPILOT_ENABLED;
    const { runAutopilotExecution, ExecutionError } = await import("../lib/execution/executor.ts");
    await assert.rejects(
      async () => {
        await runAutopilotExecution({
          mandateId: "vman_neg_test",
          capability: "github_due_diligence",
          task: {},
          requestedBudgetUsdc: 1.0,
        });
      },
      (err: any) => err instanceof ExecutionError && err.code === "AUTOPILOT_DISABLED",
      "Autopilot must be rejected when VEYRA_AUTOPILOT_ENABLED is not 'true'"
    );
    if (oldVal !== undefined) process.env.VEYRA_AUTOPILOT_ENABLED = oldVal;
    console.log("✅ Autopilot default-off security check successfully verified.");
  }

  // 10. Cross-wallet authorization 404 check
  {
    const { assertMandateAccess } = await import("../lib/execution/auth.ts");
    const { ExecutionError } = await import("../lib/execution/executor.ts");
    const caller = { wallet: "0x2222222222222222222222222222222222222222" as const, source: "test_auth" as const };
    assert.throws(
      () => assertMandateAccess(caller, "0x1111111111111111111111111111111111111111"),
      (err: any) => err instanceof ExecutionError && err.status === 404,
      "Cross-wallet access must throw 404 MANDATE_NOT_FOUND"
    );
    console.log("✅ Cross-wallet mandate access correctly rejected with 404.");
  }

  // 11. Sanitized mandate verification (no signature leaked)
  {
    const { sanitizeMandate } = await import("../lib/execution/types.ts");
    const sanitized = sanitizeMandate(validMandate);
    assert.equal((sanitized as any).signature, undefined, "Sanitized mandate must not expose signature");
    assert.equal((sanitized as any).nonce, undefined, "Sanitized mandate must not expose nonce");
    console.log("✅ Sanitized mandate model verified (signature omitted).");
  }

  console.log("\n🎉 ALL P6.1 Negative & Adversarial Security Tests Passed Successfully!");
}

runNegativeTests().catch((err) => {
  console.error("❌ Negative tests failed:", err);
  process.exit(1);
});
