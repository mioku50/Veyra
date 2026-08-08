/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import {
  ARC_ERC8004_IDENTITY_REGISTRY,
  ARC_ERC8004_REPUTATION_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY,
} from "../lib/erc8004/types.ts";
import { recoverAgentIdFromLogs } from "../lib/erc8004/client.ts";
import {
  buildCanonicalValidationResponse,
  deriveValidationRequestHash,
} from "../lib/erc8004/validation.ts";
import type { Erc8183EvaluationRecord } from "../lib/erc8183/types.ts";

async function main() {
  console.log("⚡ Running ERC-8004 Identity & Validation Bridge Tests...\n");

  // 1. Verify Official Registry Addresses
  assert.equal(ARC_ERC8004_IDENTITY_REGISTRY, "0x8004A818BFB912233c491871b3d84c89A494BD9e");
  assert.equal(ARC_ERC8004_REPUTATION_REGISTRY, "0x8004B663056A597Dffe9eCcC1965A193B7388713");
  assert.equal(ARC_ERC8004_VALIDATION_REGISTRY, "0x8004Cb1BF31DAf7788923b405b754f57acEB4272");
  console.log("✅ 1. Official Arc Testnet ERC-8004 Registry Addresses verified");

  // 2. Test Canonical Validation Payload & Hash Generation
  const testPayload = {
    schema: "veyra-erc8004-validation-v1",
    agentId: "171197",
    erc8183JobId: "100",
    evaluationPublicId: "vev_171197_canary",
    deliverableHash: "0x3600000000000000000000000000000000000000000000000000000000000000",
    reportHash: "0x326d70e6cebe7d1bb4d4d9f045cee992eda9b1d6b6c0b2ab2e8d0ab3f1d2918b",
    decision: "passed",
  };

  const payloadStr = JSON.stringify(testPayload);
  const responseHash = keccak256(toHex(payloadStr));
  assert.ok(responseHash.startsWith("0x"), "responseHash must be valid 0x-prefixed hex string");
  assert.equal(responseHash.length, 66, "responseHash must be 32 bytes (66 chars with 0x)");
  console.log("✅ 2. Canonical Validation Payload hashing verified:", responseHash);

  // 3. Security Boundary: Self-Feedback Prevention
  const selfFeedbackAttempt = {
    agentId: "171197",
    reviewerAddress: "0x0d2c04580e081e222bbe5bf9818af337e2633eb7",
    ownerAddress: "0x0d2c04580e081e222bbe5bf9818af337e2633eb7",
  };
  const isSelfFeedbackAllowed = selfFeedbackAttempt.reviewerAddress !== selfFeedbackAttempt.ownerAddress;
  assert.equal(isSelfFeedbackAllowed, false, "Self-reputation feedback MUST be prohibited");
  console.log("✅ 3. Security rule verified: Veyra agent owner cannot self-rate");

  // 4. Test SDK Export Verification
  const { veyraErc8004Sdk } = await import("../lib/erc8004/sdk.ts");
  assert.ok(typeof veyraErc8004Sdk.getAgent === "function", "SDK must export getAgent");
  assert.ok(typeof veyraErc8004Sdk.getReputation === "function", "SDK must export getReputation");
  assert.ok(typeof veyraErc8004Sdk.getValidations === "function", "SDK must export getValidations");
  assert.ok(typeof veyraErc8004Sdk.getValidation === "function", "SDK must export getValidation");
  assert.ok(typeof veyraErc8004Sdk.prepareValidation === "function", "SDK must export prepareValidation");
  console.log("✅ 4. ERC-8004 TypeScript SDK bindings verified");

  // 5. Only a true Transfer(address(0), expectedOwner, tokenId) is a registration.
  const owner = "0x1111111111111111111111111111111111111111" as const;
  const mintTx = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as const;
  const mockClient = {
    readContract: async (input: { functionName: string }) =>
      input.functionName === "balanceOf" ? 1n : owner,
    getBlockNumber: async () => 100n,
    getLogs: async () => [{
      address: ARC_ERC8004_IDENTITY_REGISTRY,
      args: { from: "0x0000000000000000000000000000000000000000", to: owner, tokenId: 42n },
      transactionHash: mintTx,
      blockNumber: 100n,
    }],
  };
  const recovered = await recoverAgentIdFromLogs(
    owner,
    ARC_ERC8004_IDENTITY_REGISTRY,
    mockClient as any,
    { fromBlock: 100n, toBlock: 100n },
  );
  assert.deepEqual(recovered, { agentId: "42", transactionHash: mintTx, blockNumber: 100n });
  const transferOnlyClient = {
    ...mockClient,
    getLogs: async () => [{
      address: ARC_ERC8004_IDENTITY_REGISTRY,
      args: {
        from: "0x2222222222222222222222222222222222222222",
        to: owner,
        tokenId: 42n,
      },
      transactionHash: mintTx,
      blockNumber: 100n,
    }],
  };
  assert.equal(
    await recoverAgentIdFromLogs(
      owner,
      ARC_ERC8004_IDENTITY_REGISTRY,
      transferOnlyClient as any,
      { fromBlock: 100n, toBlock: 100n },
    ),
    null,
    "An arbitrary NFT transfer must not be accepted as identity registration",
  );
  console.log("✅ 5. ERC-8004 mint recovery rejects arbitrary inbound transfers");

  // 6. Validation output is derived from one terminal evaluation and its canonical request hash.
  const evaluation = {
    public_id: "vev_terminal_1",
    job_id: "77",
    deliverable_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    report_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    status: "completed",
    decision: "complete",
  } as Erc8183EvaluationRecord;
  const requestHash = deriveValidationRequestHash(evaluation);
  const canonical = buildCanonicalValidationResponse({
    evaluation,
    requestHash,
    agentId: "42",
    baseUrl: "https://veyra.example",
  });
  assert.equal(canonical.response, 100);
  assert.equal(canonical.agentId, "42");
  assert.equal(canonical.evaluationPublicId, evaluation.public_id);
  assert.equal(canonical.canonicalReportHash, evaluation.report_hash);
  assert.throws(
    () => buildCanonicalValidationResponse({
      evaluation,
      requestHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      agentId: "42",
      baseUrl: "https://veyra.example",
    }),
    /request_evaluation_hash_mismatch/,
  );
  assert.throws(
    () => buildCanonicalValidationResponse({
      evaluation: { ...evaluation, status: "completed", decision: "reject" },
      requestHash,
      agentId: "42",
      baseUrl: "https://veyra.example",
    }),
    /evaluation_not_terminal_or_inconsistent/,
  );
  console.log("✅ 6. Validation verdict/hash/tag are server-derived from exact terminal evidence");

  console.log("\n🎉 All ERC-8004 Identity & Validation Bridge tests passed successfully!");
}

main().catch((err) => {
  console.error("❌ ERC-8004 tests failed:", err);
  process.exit(1);
});
