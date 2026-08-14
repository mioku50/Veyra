/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Example: End-to-end Trust-Routed Execution with Veyra SDK
 * Demonstrates:
 * 1. Creating and signing an EIP-712 Execution Mandate
 * 2. Counterparty discovery and selection
 * 3. Mode A (PREVIEW)
 * 4. Mode B (PREPARE -> EXECUTE with Idempotency Key)
 * 5. Mode C (AUTOPILOT autonomous execution)
 * 6. Evidence inspection and reputation feedback
 */

import { privateKeyToAccount } from "viem/accounts";
import { createVeyraClient } from "../sdk/typescript/src/index.ts";

async function main() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const client = createVeyraClient({
    baseUrl,
    credential: process.env.VEYRA_API_KEY || "mock-dev-credential",
  });

  console.log("=== Veyra Trust-Routed Execution Example ===\n");

  // Mock owner private key for local demo
  const mockOwner = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  );
  console.log(`Using Owner Wallet: ${mockOwner.address}`);

  // 1. Create Execution Mandate Challenge
  console.log("\n1. Creating Execution Mandate Challenge...");
  const mandateChallenge = await client.execution.createMandate({
    ownerWallet: mockOwner.address,
    subjectAgentId: "agent_alpha_buyer",
    subjectWallet: mockOwner.address,
    mode: "AUTOPILOT",
    allowedCapabilities: ["github_due_diligence", "code_review"],
    allowedRails: ["erc8183", "x402"],
    maxPerTransactionUsdc: 2.0,
    maxPerDayUsdc: 10.0,
    maxTotalUsdc: 50.0,
    minimumTrustScore: 70,
    minimumConfidence: 60,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });

  console.log(`   Mandate ID: ${mandateChallenge.mandateId}`);
  console.log(`   Canonical Hash: ${mandateChallenge.canonicalHash}`);

  // 2. Sign and Activate Mandate
  console.log("\n2. Signing EIP-712 Mandate with Owner Wallet...");
  const signature = await mockOwner.signTypedData({
    domain: mandateChallenge.eip712Payload.domain,
    types: mandateChallenge.eip712Payload.types,
    primaryType: mandateChallenge.eip712Payload.primaryType,
    message: mandateChallenge.eip712Payload.message,
  });

  console.log("   Activating mandate...");
  const activation = await client.execution.activateMandate(mandateChallenge.mandateId, {
    ownerWallet: mockOwner.address,
    subjectAgentId: "agent_alpha_buyer",
    subjectWallet: mockOwner.address,
    mode: "AUTOPILOT",
    allowedCapabilities: ["github_due_diligence", "code_review"],
    allowedRails: ["erc8183", "x402"],
    maxPerTransactionUsdc: 2.0,
    maxPerDayUsdc: 10.0,
    maxTotalUsdc: 50.0,
    minimumTrustScore: 70,
    minimumConfidence: 60,
    signature,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  console.log(`   Status: ${activation.status}`);

  // 3. Counterparty Discovery & Selection
  console.log("\n3. Discovering Counterparties for 'github_due_diligence'...");
  const discovery = await client.discoverCounterparties({
    capability: "github_due_diligence",
  });
  console.log(`   Found ${discovery.candidates.length} candidates.`);

  console.log("   Selecting optimal counterparty under trust constraints...");
  const selectionRes = await client.selectCounterparty({
    capability: "github_due_diligence",
    task: "Verify smart contract audit compliance for repository",
    budgetUsdc: 1.5,
    candidates: discovery.candidates.map((c) => ({ agentId: c.agentId, wallet: c.ownerAddress })),
  });
  const selection = selectionRes.selection;
  console.log(`   Recommended Agent: ${selection.recommendedAgentId}`);
  console.log(`   Trust Gate Decision: ${selection.decision}`);

  // 4. Mode B: Prepare and Execute with Idempotency Key
  console.log("\n4. Mode B: Preparing Execution Intent...");
  const prepared = await client.execution.prepare({
    selectionId: selection.selectionId,
    mandateId: mandateChallenge.mandateId,
    requestedAmountUsdc: 1.0,
    mode: "PREPARE",
    executorWallet: mockOwner.address,
  });
  console.log(`   Execution ID: ${prepared.executionId}`);
  console.log(`   Designated Rail: ${prepared.rail}`);
  console.log(`   Canonical Execution Hash: ${prepared.canonicalHash}`);

  console.log("   Executing prepared intent across rail...");
  const execResult = await client.execution.execute(prepared.executionId, {
    taskPayload: { repo: "example/repo" },
  });
  console.log(`   Execution Status: ${execResult.status}`);
  console.log(`   Actual Settled Amount: ${execResult.actualSettledAmountUsdc} USDC`);
  console.log(`   Settlement Tx: ${execResult.completeTx || execResult.paymentTx}`);

  // 5. Inspect Evidence & Proofs
  console.log("\n5. Inspecting Execution Evidence...");
  const evidence = await client.execution.getEvidence(prepared.executionId);
  console.log(`   Evidence Hash: ${evidence.evidenceHash}`);
  console.log(`   Arc Proof Anchor: ${evidence.completeTx || evidence.paymentTx}`);

  console.log("\n🎉 Trust-Routed Execution Finished Successfully!");
}

main().catch((err) => {
  console.error("Example error:", err.message);
});
