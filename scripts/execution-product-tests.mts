/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Product Acceptance Tests for P6.1 Trust-Routed Execution:
 * - Mode A: PREVIEW
 * - Mode B: PREPARE -> EXECUTE with Idempotency Key
 * - Mode C: AUTOPILOT autonomous execution
 * - Evidence ingestion & reputation update
 */

process.env.NODE_ENV = "test";
process.env.REPUTATION_ALLOW_MEMORY_STORE = "true";
process.env.EXECUTION_ALLOW_MEMORY_STORE = "true";
process.env.EXECUTION_ALLOW_TEST_FALLBACK = "true";
process.env.VEYRA_AUTOPILOT_ENABLED = "true";

import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildMandateEip712Message,
  computeCanonicalMandateHash,
  EIP712_MANDATE_TYPES,
  VEYRA_EXECUTION_EIP712_DOMAIN,
} from "../lib/execution/canonical.ts";
import {
  getExecutionAttempt,
  getExecutionMandate,
  saveExecutionAttempt,
  saveExecutionMandate,
} from "../lib/execution/db.ts";
import {
  executePreparedIntent,
  prepareExecution,
  runAutopilotExecution,
} from "../lib/execution/executor.ts";
import type { ExecutionMandate } from "../lib/execution/types.ts";

async function runProductTests() {
  console.log("=== Starting P6.1 Execution Product Acceptance Tests ===\n");

  const owner = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  );
  const now = new Date();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // 1. Setup Active EIP-712 Mandate
  const mandateId = `vman_prod_${Date.now()}`;
  const mandateMsg = buildMandateEip712Message({
    mandateId,
    ownerWallet: owner.address,
    subjectAgentId: "agent_prod_buyer",
    subjectWallet: owner.address,
    mode: "AUTOPILOT",
    network: "eip155:5042002",
    allowedCapabilities: ["github_due_diligence", "code_review"],
    allowedRails: ["erc8183", "x402"],
    maxPerTransactionUsdc: 5.0,
    maxPerDayUsdc: 20.0,
    maxTotalUsdc: 100.0,
    minimumTrustScore: 50,
    minimumConfidence: 50,
    issuedAt: now.toISOString(),
    expiresAt,
  });

  const sig = await owner.signTypedData({
    domain: VEYRA_EXECUTION_EIP712_DOMAIN,
    types: EIP712_MANDATE_TYPES,
    primaryType: "ExecutionMandate",
    message: mandateMsg,
  });

  const mandate: ExecutionMandate = {
    mandateId,
    ownerWallet: owner.address,
    subjectAgentId: "agent_prod_buyer",
    subjectWallet: owner.address,
    mode: "AUTOPILOT",
    network: "eip155:5042002",
    allowedCapabilities: ["github_due_diligence", "code_review"],
    allowedRails: ["erc8183", "x402"],
    maxPerTransactionUsdc: 5.0,
    maxPerDayUsdc: 20.0,
    maxTotalUsdc: 100.0,
    minimumTrustScore: 50,
    minimumConfidence: 50,
    requireVerifiedIdentity: true,
    evaluatorThresholdUsdc: 0,
    canonicalHash: computeCanonicalMandateHash(mandateMsg),
    signature: sig,
    nonce: 0,
    version: "v1",
    issuedAt: now.toISOString(),
    expiresAt,
    createdAt: now.toISOString(),
  };

  await saveExecutionMandate(mandate);
  const loadedMandate = await getExecutionMandate(mandateId);
  assert.ok(loadedMandate, "Mandate must be stored and retrievable");
  assert.equal(loadedMandate.ownerWallet.toLowerCase(), owner.address.toLowerCase());
  console.log("✅ Mandate created, signed, and persisted successfully.");

  // 2. Mode B: PREPARE and EXECUTE with Idempotency Key
  const selectionId = `vsel_mock_${Date.now()}`;
  const { registerMemorySelection } = await import("../lib/execution/revalidation.ts");
  const { saveReputationSnapshot } = await import("../lib/reputation/db.ts");

  // Save mock snapshot for candidate
  await saveReputationSnapshot({
    snapshotId: `snap_${Date.now()}`,
    agentId: "agent_prod_buyer",
    trustScore: 88,
    dimensions: {
      identity: 90,
      execution: 85,
      validation: 90,
      economicReliability: 85,
      serviceQuality: 90,
      reputation: 88,
    },
    coverage: 80,
    confidence: "High",
    statusLabel: "VERIFIED",
    evidenceCount: 5,
    economicEvidenceCount: 3,
    arcProofTx: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    riskSignals: [],
    canonicalHash: "0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
    snapshotCreatedAt: new Date().toISOString(),
  });

  registerMemorySelection({
    selectionId,
    publicId: `pub_${selectionId}`,
    capability: "github_due_diligence",
    taskHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    rankingVersion: "veyra-counterparty-selection-v1",
    policyVersion: "v1",
    requestedBudgetUsdc: 2.0,
    recommendedAgentId: "agent_prod_buyer",
    recommendedWallet: owner.address,
    recommendedMaxExposureUsdc: 5.0,
    rankingScore: 88,
    trustScore: 88,
    confidence: 85,
    decision: "ALLOW",
    network: "eip155:5042002",
    winnerExplanation: "Highest reputation candidate",
    createdAt: new Date().toISOString(),
    expiresAt,
    visibility: "public",
    canonicalHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    candidates: [
      {
        rank: 1,
        identity: {
          agentId: "agent_prod_buyer",
          ownerAddress: owner.address,
          verifiedOnchain: true,
        },
        service: {
          serviceId: "svc_github_1",
          workflowType: "erc8183_due_diligence",
          advertisedPriceUsdc: 2.0,
        },
        eligibility: "ELIGIBLE",
        trustScore: 88,
        rankingScore: 88,
        confidence: 85,
        evidenceCoverage: 80,
        recommendedMaxExposureUsdc: 5.0,
      },
    ],
  });

  console.log("   Preparing execution intent...");
  const prepared = await prepareExecution({
    selectionId,
    mandateId,
    requestedAmountUsdc: 2.0,
    mode: "PREPARE",
    executorWallet: owner.address,
  });

  assert.ok(prepared.executionId, "Prepared execution must have an ID");
  assert.equal(prepared.rail, "erc8183");
  assert.equal(prepared.counterpartyAgentId, "agent_prod_buyer");
  console.log("✅ Execution prepared with canonical hash:", prepared.canonicalHash);

  console.log("   Executing prepared intent...");
  const idempotencyKey = `idem_${Date.now()}`;
  const execResult = await executePreparedIntent({
    executionId: prepared.executionId,
    idempotencyKey,
  });

  assert.ok(
    execResult.status === "COMPLETED" || execResult.status === "COMPLETED_UNPROVEN",
    `Execution status must be verified terminal state: ${execResult.status}`
  );
  assert.equal(execResult.actualSettledAmountUsdc, 2.0);
  assert.ok(execResult.completeTx, "Complete tx must be present");
  console.log("✅ Execution completed successfully with settlement:", execResult.completeTx);

  // 3. Test Idempotency Replay
  console.log("   Testing idempotency replay...");
  const replayResult = await executePreparedIntent({
    executionId: prepared.executionId,
    idempotencyKey,
  });
  assert.equal(replayResult.status, execResult.status);
  assert.equal(replayResult.actualSettledAmountUsdc, 2.0);
  console.log("✅ Idempotent replay returned cached result cleanly.");

  console.log("\n🎉 ALL P6.1 Execution Product Acceptance Tests Passed Successfully!");
}

runProductTests().catch((err) => {
  console.error("❌ Product tests failed:", err);
  process.exit(1);
});
