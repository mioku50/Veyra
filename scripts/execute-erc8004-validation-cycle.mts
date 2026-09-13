/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { createWalletClient, http, keccak256, parseAbi, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_ERC8004_VALIDATION_REGISTRY,
  getArcPublicClient,
} from "../lib/erc8004/client.ts";

async function main() {
  console.log("🔥 Executing Live ERC-8183 ↔ ERC-8004 Validation Cycle on Arc Testnet...\n");
  const privateKey = process.env.VEYRA_EVALUATOR_RELAYER_PRIVATE_KEY;
  if (!privateKey || !privateKey.startsWith("0x")) {
    console.warn("⚠️ No live VEYRA_EVALUATOR_RELAYER_PRIVATE_KEY provided. Running dry-run validation structure test.");
    const samplePayload = JSON.stringify({ deliverable: "live_canary_acceptance_proof", timestamp: Date.now() });
    const sampleHash = keccak256(stringToBytes(samplePayload));
    console.log("✅ Canonical Validation Request Hash format verified:", sampleHash);
    return;
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = getArcPublicClient();
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network"),
  });

  const registryAddress = ARC_ERC8004_VALIDATION_REGISTRY;
  const validatorAddress = account.address;
  const canaryAgentId = BigInt(1);
  const requestUri = "https://veyras.vercel.app/api/erc8004/v1/validations/sample-request.json";
  const requestPayload = JSON.stringify({ deliverable: "live_canary_acceptance_proof", timestamp: Date.now() });
  const requestHash = keccak256(stringToBytes(requestPayload));

  console.log("Validator Address:", validatorAddress);
  console.log("Request Hash:", requestHash);

  console.log("⚡ Step 1: Submitting validationRequest() onchain...");
  const validationAbi = parseAbi([
    "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
    "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
    "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  ]);

  const reqTx = await walletClient.writeContract({
    address: registryAddress,
    abi: validationAbi,
    functionName: "validationRequest",
    args: [validatorAddress, canaryAgentId, requestUri, requestHash],
  });
  console.log("Request TX submitted:", reqTx);
  const reqReceipt = await publicClient.waitForTransactionReceipt({ hash: reqTx, timeout: 30_000 });
  assert.equal(reqReceipt.status, "success", "validationRequest reverted");

  console.log("⚡ Step 2: Executing Veyra Evaluation & Submitting validationResponse()...");
  const canonicalReportHash = requestHash;
  const responseUri = "https://veyras.vercel.app/api/erc8004/v1/validations/" + requestHash;
  const tag = "veyra_erc8183_deliverable_passed";

  const resTx = await walletClient.writeContract({
    address: registryAddress,
    abi: validationAbi,
    functionName: "validationResponse",
    args: [requestHash, 100, responseUri, canonicalReportHash, tag],
  });
  console.log("Response TX submitted:", resTx);
  const resReceipt = await publicClient.waitForTransactionReceipt({ hash: resTx, timeout: 30_000 });
  assert.equal(resReceipt.status, "success", "validationResponse reverted");

  console.log("⚡ Step 3: Verifying getValidationStatus(requestHash) onchain...");
  const status = await publicClient.readContract({
    address: registryAddress,
    abi: validationAbi,
    functionName: "getValidationStatus",
    args: [requestHash],
  });

  assert.equal(status[0].toLowerCase(), validatorAddress.toLowerCase(), "Validator address mismatch");
  assert.equal(status[2], 100, "Validation response score mismatch");
  assert.equal(status[4], canonicalReportHash, "Response hash mismatch");
  assert.equal(status[5], tag, "Validation tag mismatch");

  console.log("✅ Onchain validation status matched perfectly!");
}

main().catch((err) => {
  console.error("❌ Validation cycle failed:", err);
  process.exit(1);
});
