/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { encodeEventTopics, keccak256, stringToBytes } from "viem";
import { computeContentHash, computeDeliverableHash, computePolicyHash, prepareDeliverableCommitment, VEYRA_DELIVERABLE_V1_TYPEHASH } from "../lib/erc8183/deliverable.ts";
import { runDeterministicEvaluationPolicy, validateStructuredDeliverableSchema } from "../lib/erc8183/policy.ts";
import type { VeyraDeliverableV1 } from "../lib/erc8183/types.ts";
import { Decision } from "../lib/erc8183/types.ts";
import { computeVerdictDigest, signVerdict } from "../lib/erc8183/verdict.ts";
import { buildErc8183EvaluationReport } from "../lib/reports/erc8183-evaluation-report.ts";
import { SSRFProtectionError } from "../lib/seller/ssrf.ts";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "../lib/erc8183/abi.ts";
import { deriveSettledErc8183ValueUsdc } from "../lib/reputation/erc8183-adapter.ts";

async function runAllErc8183Tests() {
  console.log("⚡ Running ERC-8183 Evaluator TypeScript tests...");

  // 1. Deliverable Hash Parity & Typehash Test
  const expectedTypehash = keccak256(
    stringToBytes("VeyraDeliverableV1(uint16 version,string contentUri,bytes32 contentHash,string contentType,string schemaId,bytes32 policyHash)")
  );
  assert.equal(VEYRA_DELIVERABLE_V1_TYPEHASH, expectedTypehash, "Typehash mismatch");

  const deliverableInput: VeyraDeliverableV1 = {
    version: 1,
    contentUri: "https://example.com/artifact.json",
    contentHash: keccak256(stringToBytes('{"hello":"world"}')),
    contentType: "application/json",
    schemaId: "veyra://schemas/structured-deliverable-v1",
    policyId: "structured-deliverable-v1",
  };

  const deliverableHash = computeDeliverableHash(deliverableInput);
  assert.ok(deliverableHash.startsWith("0x"), "Deliverable hash must be 0x hex");
  assert.equal(deliverableHash.length, 66, "Deliverable hash length must be 66");

  const prepared = prepareDeliverableCommitment(deliverableInput);
  assert.equal(prepared.deliverableHash, deliverableHash, "Prepared deliverable hash mismatch");
  assert.equal(prepared.policyHash, computePolicyHash("structured-deliverable-v1"), "Policy hash mismatch");

  // 2. Structured Deliverable Schema Validation Test
  const validSchemaPayload = {
    schemaVersion: "veyra.structured-deliverable.v1",
    title: "Market Brief Analysis",
    summary: "Stablecoin payment volume analysis",
    result: { status: "pass", score: 98 },
    evidence: [
      { type: "onchain_receipt", uri: "https://testnet.arcscan.app/tx/0x123", description: "Arc proof tx" },
    ],
    generatedAt: new Date().toISOString(),
  };

  assert.ok(validateStructuredDeliverableSchema(validSchemaPayload), "Valid schema should pass");

  const invalidSchemaPayload = {
    schemaVersion: "wrong.version",
    title: "",
    summary: "bad",
  };
  assert.ok(!validateStructuredDeliverableSchema(invalidSchemaPayload), "Invalid schema should fail");

  // 3. Policy Engine - Success Case
  const validContentJson = JSON.stringify(validSchemaPayload);
  const validContentHash = computeContentHash(validContentJson);

  const mockValidDeliverable: VeyraDeliverableV1 = {
    ...deliverableInput,
    contentHash: validContentHash,
  };

  const mockJob = {
    jobId: 1n,
    client: "0x1111111111111111111111111111111111111111",
    provider: "0x2222222222222222222222222222222222222222",
    evaluator: "0x3333333333333333333333333333333333333333",
    budget: 5_000_000n,
    expiredAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    status: 2, // Submitted in the current Arc reference implementation
    description: "Market brief job",
  };

  const computedValidDeliverableHash = computeDeliverableHash(mockValidDeliverable);

  const mockFetcherSuccess = async () => new Response(validContentJson, { status: 200 });

  const passResult = await runDeterministicEvaluationPolicy({
    deliverable: mockValidDeliverable,
    onchainJob: mockJob,
    onchainDeliverableHash: computedValidDeliverableHash,
    onchainSubmittedEventCount: 1,
    expectedEvaluatorContract: "0x3333333333333333333333333333333333333333",
    allowlistedCommerceAddress: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    targetChainId: 5042002,
    currentChainId: 5042002,
    fetcher: mockFetcherSuccess as any,
  });

  assert.equal(passResult.outcome, "PASS", "Valid policy check should PASS");
  assert.ok(passResult.checks.every((c) => c.passed), "All checks should pass");

  const fundedResult = await runDeterministicEvaluationPolicy({
    deliverable: mockValidDeliverable,
    onchainJob: { ...mockJob, status: 1 },
    onchainDeliverableHash: computedValidDeliverableHash,
    onchainSubmittedEventCount: 1,
    expectedEvaluatorContract: "0x3333333333333333333333333333333333333333",
    allowlistedCommerceAddress: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    targetChainId: 5042002,
    currentChainId: 5042002,
    fetcher: mockFetcherSuccess as any,
  });
  assert.equal(fundedResult.failureCategory, "job_not_submitted", "Funded must not be treated as Submitted");

  // 4. Policy Engine - Deterministic Failures
  // a) Content hash mismatch
  const mockFetcherBadHash = async () => new Response(JSON.stringify({ ...validSchemaPayload, title: "Tampered" }), { status: 200 });
  const failHashResult = await runDeterministicEvaluationPolicy({
    deliverable: mockValidDeliverable,
    onchainJob: mockJob,
    onchainDeliverableHash: computedValidDeliverableHash,
    onchainSubmittedEventCount: 1,
    expectedEvaluatorContract: "0x3333333333333333333333333333333333333333",
    allowlistedCommerceAddress: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    targetChainId: 5042002,
    currentChainId: 5042002,
    fetcher: mockFetcherBadHash as any,
  });
  assert.equal(failHashResult.outcome, "DETERMINISTIC_FAIL", "Content hash mismatch must fail deterministically");
  assert.equal(failHashResult.failureCategory, "content_hash_mismatch");

  // b) SSRF Attempt (non-HTTPS)
  const nonHttpsDeliverable: VeyraDeliverableV1 = {
    ...mockValidDeliverable,
    contentUri: "http://169.254.169.254/latest/meta-data",
  };
  const failSsrfResult = await runDeterministicEvaluationPolicy({
    deliverable: nonHttpsDeliverable,
    onchainJob: mockJob,
    expectedEvaluatorContract: "0x3333333333333333333333333333333333333333",
    allowlistedCommerceAddress: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    targetChainId: 5042002,
    currentChainId: 5042002,
    fetcher: mockFetcherSuccess as any,
  });
  assert.equal(failSsrfResult.outcome, "DETERMINISTIC_FAIL", "Non-HTTPS / SSRF attempt must fail deterministically");
  assert.equal(failSsrfResult.failureCategory, "non_https_uri");

  // 5. Policy Engine - Transient Error (RPC / Network Fetch failure)
  const mockFetcherNetworkError = async () => {
    throw new Error("RPC socket hangup");
  };
  const transientResult = await runDeterministicEvaluationPolicy({
    deliverable: mockValidDeliverable,
    onchainJob: mockJob,
    onchainDeliverableHash: computedValidDeliverableHash,
    onchainSubmittedEventCount: 1,
    expectedEvaluatorContract: "0x3333333333333333333333333333333333333333",
    allowlistedCommerceAddress: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    targetChainId: 5042002,
    currentChainId: 5042002,
    fetcher: mockFetcherNetworkError as any,
  });
  assert.equal(transientResult.outcome, "TRANSIENT_ERROR", "Network fetch failure must result in TRANSIENT_ERROR");

  // 6. EIP-712 Verdict Digest and Signature Test
  const testPk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // standard test pk
  const verdictStruct = {
    agenticCommerce: "0x0747EEf0706327138c69792bF28Cd525089e4583" as const,
    jobId: 1n,
    deliverableHash: computedValidDeliverableHash,
    reportHash: keccak256(stringToBytes("report-1")),
    policyHash: computePolicyHash("structured-deliverable-v1"),
    decision: Decision.Complete,
    evaluatedAt: BigInt(Math.floor(Date.now() / 1000)),
    validUntil: BigInt(Math.floor(Date.now() / 1000) + 300),
    nonce: 100n,
  };

  const digest = computeVerdictDigest(5042002, "0x3333333333333333333333333333333333333333", verdictStruct);
  assert.ok(digest.startsWith("0x"), "Digest must be 0x hex");

  const signedVerdict = await signVerdict(5042002, "0x3333333333333333333333333333333333333333", verdictStruct, testPk);
  assert.equal(signedVerdict.digest, digest, "Signed digest mismatch");
  assert.ok(signedVerdict.signature.startsWith("0x"), "Signature must be 0x hex");

  // 7. Canonical Report Generation Test
  const canonicalReport = buildErc8183EvaluationReport({
    chainId: 5042002,
    agenticCommerce: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    evaluatorContract: "0x3333333333333333333333333333333333333333",
    jobId: "1",
    client: mockJob.client,
    provider: mockJob.provider,
    budget: "5000000",
    expiry: Number(mockJob.expiredAt),
    description: mockJob.description,
    deliverableHash: computedValidDeliverableHash,
    contentHash: validContentHash,
    contentUri: mockValidDeliverable.contentUri,
    policyId: mockValidDeliverable.policyId,
    policyHash: computePolicyHash("structured-deliverable-v1"),
    decision: "complete",
    checks: passResult.checks,
    evidence: validSchemaPayload.evidence as any,
  });

  assert.equal(canonicalReport.reportType, "erc8183_evaluation");
  assert.ok(canonicalReport.reportHash.startsWith("0x"), "Report hash must start with 0x");

  assert.ok(ERC8183_AGENTIC_COMMERCE_ABI.some((item) => item.type === "function" && item.name === "setBudget"));
  assert.ok(ERC8183_AGENTIC_COMMERCE_ABI.some((item) => item.type === "function" && item.name === "fund"));

  // 8. Arc reference JobCompleted binds its indexed address to the evaluator.
  const commerceAddress = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;
  const completedJob = {
    jobId: 42n,
    client: "0x1111111111111111111111111111111111111111" as const,
    provider: "0x2222222222222222222222222222222222222222" as const,
    evaluator: "0x3333333333333333333333333333333333333333" as const,
    budget: 10_000n,
    expiredAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    status: "Completed" as const,
    description: "Completed Arc reference job",
    hook: "0x0000000000000000000000000000000000000000" as const,
  };
  const completionTopics = encodeEventTopics({
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    eventName: "JobCompleted",
    args: { jobId: completedJob.jobId, evaluator: completedJob.evaluator },
  });
  const completionReceipt = {
    status: "success",
    logs: [{ address: commerceAddress, topics: completionTopics, data: "0x" }],
  } as any;
  assert.equal(
    deriveSettledErc8183ValueUsdc({
      job: completedJob,
      receipt: completionReceipt,
      commerceAddress,
    }),
    0.01,
    "Completed economic value must require the exact evaluator-bound Arc event",
  );

  console.log("✅ All ERC-8183 Evaluator TypeScript tests passed!");
}

runAllErc8183Tests().catch((err) => {
  console.error("❌ ERC-8183 TypeScript test failed:", err);
  process.exit(1);
});
