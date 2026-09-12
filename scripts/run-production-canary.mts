/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, keccak256, stringToBytes } from "viem";
import { arcTestnet } from "viem/chains";
import fs from "node:fs";
import path from "node:path";
import { ERC8183_AGENTIC_COMMERCE_ABI, VEYRA_ERC8183_EVALUATOR_ABI } from "../lib/erc8183/abi.ts";
import { prepareDeliverableCommitment } from "../lib/erc8183/deliverable.ts";
import { executeOffchainJobEvaluation } from "../lib/erc8183/evaluator.ts";

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const COMMERCE_ADDRESS = "0x0747EEf0706327138c69792bF28Cd525089e4583" as `0x${string}`;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL),
});

async function main() {
  console.log("🐤 Running Real Arc Testnet Production Canary for P5.0 Veyra ERC-8183 Evaluator...\n");

  const envPath = path.join(process.cwd(), ".env.local");
  const envContent = fs.readFileSync(envPath, "utf-8");

  function getEnvVal(key: string): string {
    const match = envContent.match(new RegExp(`${key}=(0x[a-fA-F0-9]+|.+)`));
    if (!match || !match[1]) throw new Error(`Missing ${key} in .env.local`);
    return match[1].trim();
  }

  const clientKey = getEnvVal("BUYER_PRIVATE_KEY") as `0x${string}`;
  const providerKey = getEnvVal("SELLER_PRIVATE_KEY") as `0x${string}`;
  const attesterKey = getEnvVal("ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY") as `0x${string}`;
  const relayerKey = getEnvVal("ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY") as `0x${string}`;
  const evaluatorAddress = getEnvVal("NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS") as `0x${string}`;

  const clientAccount = privateKeyToAccount(clientKey);
  const providerAccount = privateKeyToAccount(providerKey);
  const attesterAccount = privateKeyToAccount(attesterKey);
  const relayerAccount = privateKeyToAccount(relayerKey);

  console.log("📍 Roles & Accounts:");
  console.log("Client Address:   ", clientAccount.address);
  console.log("Provider Address: ", providerAccount.address);
  console.log("Attester Address: ", attesterAccount.address);
  console.log("Relayer Address:  ", relayerAccount.address);
  console.log("Evaluator Address:", evaluatorAddress);
  console.log("Commerce Address: ", COMMERCE_ADDRESS);

  // Step 1: Create Job onchain as Client
  console.log("\n1️⃣  Creating ERC-8183 Job on Arc Testnet...");
  const clientWallet = createWalletClient({
    account: clientAccount,
    chain: arcTestnet,
    transport: http(RPC_URL),
  });

  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 86400); // 24h
  const description = "Veyra P5.0 Real Onchain Production Canary";

  const createTxHash = await clientWallet.writeContract({
    address: COMMERCE_ADDRESS,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "createJob",
    args: [providerAccount.address, evaluatorAddress, expiredAt, description, "0x0000000000000000000000000000000000000000"],
  });

  console.log("Create Job Tx Hash:", createTxHash);
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTxHash });
  console.log("Create Job Block Number:", createReceipt.blockNumber);

  // Decode JobCreated event to get jobId
  let jobId: bigint | null = null;
  for (const log of createReceipt.logs) {
    if (log.address.toLowerCase() === COMMERCE_ADDRESS.toLowerCase() && log.topics[1]) {
      jobId = BigInt(log.topics[1]);
      break;
    }
  }

  if (jobId === null) {
    throw new Error("Failed to extract jobId from JobCreated event");
  }

  console.log("✅ Onchain ERC-8183 Job Created! Job ID:", jobId.toString());

  // RPC rate-limit cooldown
  await new Promise((r) => setTimeout(r, 3000));

  // Step 2: Prepare Deliverable & Submit as Provider
  console.log("\n2️⃣  Preparing Deliverable Commitment V1 & Submitting Onchain as Provider...");
  const contentUri = "https://raw.githubusercontent.com/mioku50/Veyra/main/public/canary-deliverable.json";
  const res = await fetch(contentUri);
  const rawText = await res.text();
  const contentHash = keccak256(stringToBytes(rawText));

  const commitment = prepareDeliverableCommitment({
    contentUri,
    contentHash,
    contentType: "application/json",
    schemaId: "veyra://schemas/structured-deliverable-v1",
    policyId: "structured-deliverable-v1",
  });

  console.log("Deliverable Hash:", commitment.deliverableHash);
  console.log("Policy Hash:     ", commitment.policyHash);

  const providerWallet = createWalletClient({
    account: providerAccount,
    chain: arcTestnet,
    transport: http(RPC_URL),
  });

  const submitTxHash = await providerWallet.writeContract({
    address: COMMERCE_ADDRESS,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "submit",
    args: [jobId, commitment.deliverableHash, "0x"],
  });

  console.log("Submit Tx Hash:", submitTxHash);
  await publicClient.waitForTransactionReceipt({ hash: submitTxHash });
  console.log("✅ Deliverable submitted onchain!");

  // RPC rate-limit & block confirmation cooldown
  await new Promise((r) => setTimeout(r, 5000));

  // Step 3: Run Veyra Offchain Evaluation Engine & Execute Verdict Onchain
  console.log("\n3️⃣  Running Veyra Offchain Evaluation Engine & Attester EIP-712 Signing...");
  const evaluationResult = await executeOffchainJobEvaluation({
    chainId: 5042002,
    agenticCommerce: COMMERCE_ADDRESS,
    jobId: jobId.toString(),
    deliverable: commitment.deliverable,
    evaluatorContract: evaluatorAddress,
    attesterPrivateKey: attesterKey,
    relayerPrivateKey: relayerKey,
  });

  console.log("Evaluation Status:", evaluationResult.status);
  console.log("Decision:         ", evaluationResult.decision);
  console.log("Report Hash:      ", evaluationResult.reportHash);
  console.log("Verdict Digest:   ", evaluationResult.verdictDigest);
  console.log("Complete Tx Hash: ", evaluationResult.settlementTxHash);

  if (
    (evaluationResult.status !== "completed" && evaluationResult.status !== "rejected") ||
    !evaluationResult.settlementTxHash
  ) {
    throw new Error(`Evaluation execution failed: ${evaluationResult.failureCategory}`);
  }

  console.log("\n🎉 REAL ONCHAIN ERC-8183 PRODUCTION CANARY PASSED FULL END-TO-END!");

  // Return Summary Object
  const summary = {
    evaluatorContractAddress: evaluatorAddress,
    attesterPublicAddress: attesterAccount.address,
    relayerPublicAddress: relayerAccount.address,
    deploymentTx: "0xf8c85eb143b58bba59388c6cb048cd1e406e9d6f71c89375f74271ba926340ab",
    erc8183JobId: jobId.toString(),
    evaluationPublicId: `vev_${jobId.toString()}_canary`,
    evaluationCanonicalHash: evaluationResult.reportHash,
    completeTx: evaluationResult.settlementTxHash,
    settlementStatus: "Completed",
    arcscanEvaluatorLink: `https://testnet.arcscan.app/address/${evaluatorAddress}`,
    arcscanCompleteTxLink: `https://testnet.arcscan.app/tx/${evaluationResult.settlementTxHash}`,
  };

  console.log("\n=================== PRODUCTION CANARY RESULT SUMMARY ===================");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error("❌ Production Canary failed:", err);
  process.exit(1);
});
