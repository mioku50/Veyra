/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { parseUnits, type Hex } from "viem";
import {
  ARC_ERC8004_IDENTITY_REGISTRY,
  fetchAgentIdentityOnchain,
  getArcPublicClient,
  getCanonicalVeyraAgentIdentity,
} from "../lib/erc8004/client.ts";
import { fetchJobSubmittedLogs, fetchOnchainJob } from "../lib/erc8183/client.ts";
import type { Erc8183EvaluationRecord } from "../lib/erc8183/types.ts";
import { getByoaClient } from "../lib/byoa/service.ts";
import { proofRegistryAbi } from "../lib/commerce/onchain-proof.ts";
import { fetchLatestReputationSnapshot, fetchReputationEvidenceForAgent } from "../lib/reputation/db.ts";
import {
  deriveReputationScoreFromEvaluation,
  deriveSettledErc8183ValueUsdc,
} from "../lib/reputation/erc8183-adapter.ts";

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const PROOF_REGISTRY_ADDRESS = (
  process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS
  || "0x0db0b8ddc03c3c56c0662b547822e4654167b684"
) as `0x${string}`;
const COMMERCE_ADDRESS = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;
const EVALUATOR_ADDRESS = (
  process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS
  || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7"
) as `0x${string}`;

function requireHex32(value: string | null | undefined, label: string): Hex {
  assert.ok(value && /^0x[0-9a-fA-F]{64}$/.test(value), `${label} is missing or invalid`);
  return value as Hex;
}

async function fetchLatestCompletedEvaluation(): Promise<Erc8183EvaluationRecord> {
  const { data, error } = await getByoaClient()
    .from("erc8183_evaluations")
    .select("*")
    .eq("chain_id", 5042002)
    .ilike("agentic_commerce", COMMERCE_ADDRESS)
    .ilike("evaluator_contract", EVALUATOR_ADDRESS)
    .eq("status", "completed")
    .eq("decision", "complete")
    .not("settlement_tx_hash", "is", null)
    .order("settled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Latest completed ERC-8183 evaluation query failed");
  assert.ok(data, "No completed ERC-8183 evaluation with a settlement transaction exists");
  return data as Erc8183EvaluationRecord;
}

async function main() {
  assert.notEqual(
    process.env.REPUTATION_ALLOW_MEMORY_STORE,
    "true",
    "REPUTATION_ALLOW_MEMORY_STORE must not be true for live acceptance",
  );

  console.log("=======================================================");
  console.log("Veyra Reputation Strict Live Acceptance");
  console.log("=======================================================\n");

  const publicClient = getArcPublicClient(RPC_URL);
  assert.equal(await publicClient.getChainId(), 5042002, "Live acceptance must run on Arc Testnet");

  const identityRecord = await getCanonicalVeyraAgentIdentity(publicClient);
  assert.ok(identityRecord?.agent_id, "Canonical ERC-8004 identity is missing");
  assert.equal(identityRecord.chain_id, 5042002, "Canonical identity uses another chain");
  assert.equal(
    identityRecord.registry_address.toLowerCase(),
    ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase(),
    "Canonical identity uses another registry",
  );
  const identity = await fetchAgentIdentityOnchain(
    BigInt(identityRecord.agent_id),
    ARC_ERC8004_IDENTITY_REGISTRY,
    publicClient,
  );
  assert.equal(identity.owner.toLowerCase(), identityRecord.owner_address.toLowerCase());

  const evaluation = await fetchLatestCompletedEvaluation();
  const score = deriveReputationScoreFromEvaluation({
    status: evaluation.status,
    decision: evaluation.decision,
  });
  const completionTx = requireHex32(evaluation.settlement_tx_hash, "ERC-8183 settlement transaction");
  const completionReceipt = await publicClient.getTransactionReceipt({ hash: completionTx });
  const job = await fetchOnchainJob(COMMERCE_ADDRESS, BigInt(evaluation.job_id), publicClient);
  assert.equal(job.client.toLowerCase(), evaluation.client_wallet.toLowerCase(), "Evaluation client differs from job client");
  assert.equal(job.provider.toLowerCase(), evaluation.provider_wallet.toLowerCase(), "Evaluation provider differs from job provider");
  assert.equal(job.evaluator.toLowerCase(), EVALUATOR_ADDRESS.toLowerCase(), "Job uses another evaluator");
  const submittedLogs = await fetchJobSubmittedLogs(
    COMMERCE_ADDRESS,
    BigInt(evaluation.job_id),
    publicClient,
  );
  assert.equal(submittedLogs.length, 1, "Exactly one canonical JobSubmitted log is required");
  assert.equal(
    submittedLogs[0].deliverableHash.toLowerCase(),
    evaluation.deliverable_hash.toLowerCase(),
    "Evaluation deliverable differs from the canonical JobSubmitted event",
  );

  const actualSettledValueUsdc = deriveSettledErc8183ValueUsdc({
    job,
    receipt: completionReceipt,
    commerceAddress: COMMERCE_ADDRESS,
  });
  assert.ok(actualSettledValueUsdc > 0, "Actual ERC-8183 settled value is not positive");

  const evidence = await fetchReputationEvidenceForAgent(identityRecord.agent_id);
  const jobEvidence = evidence.find((item) =>
    item.type === "erc8183_job_completed"
    && item.sourceId === evaluation.job_id
    && item.sourceHash?.toLowerCase() === evaluation.deliverable_hash.toLowerCase()
  );
  assert.ok(jobEvidence, "Matching ERC-8183 reputation evidence is missing");
  assert.equal(jobEvidence.score, score, "Reputation score differs from canonical evaluation score");
  assert.equal(
    parseUnits((jobEvidence.economicValueUsdc || 0).toFixed(6), 6),
    parseUnits(actualSettledValueUsdc.toFixed(6), 6),
    "Reputation evidence value differs from the actual ERC-8183 settlement",
  );
  assert.equal(jobEvidence.verifiedOnchain, true, "ERC-8183 evidence is not marked onchain-verified");

  const snapshot = await fetchLatestReputationSnapshot(identityRecord.agent_id);
  assert.ok(snapshot, "Production reputation snapshot is missing");
  assert.equal(snapshot.agentId, identityRecord.agent_id, "Snapshot belongs to another agent");
  assert.ok(snapshot.economicEvidenceCount > 0, "Snapshot contains no economic evidence");
  assert.ok(
    Date.parse(snapshot.createdAt) >= Date.parse(jobEvidence.observedAt),
    "Latest snapshot predates the settled ERC-8183 evidence",
  );
  const snapshotHash = requireHex32(snapshot.canonicalHash, "Snapshot canonical hash");
  const snapshotProofTx = requireHex32(snapshot.arcProofTx, "Snapshot Arc proof transaction");
  const proofReceipt = await publicClient.getTransactionReceipt({ hash: snapshotProofTx });
  assert.equal(proofReceipt.status, "success", "Snapshot Arc proof transaction reverted");

  const registered = await publicClient.readContract({
    address: PROOF_REGISTRY_ADDRESS,
    abi: proofRegistryAbi,
    functionName: "isRegistered",
    args: [snapshotHash],
  });
  assert.equal(registered, true, "Snapshot canonical hash is not registered on Arc");
  const proof = await publicClient.readContract({
    address: PROOF_REGISTRY_ADDRESS,
    abi: proofRegistryAbi,
    functionName: "getProof",
    args: [snapshotHash],
  });
  assert.equal(proof[1].toLowerCase(), job.client.toLowerCase(), "Arc proof buyer differs from ERC-8183 client");
  assert.equal(proof[2].toLowerCase(), job.provider.toLowerCase(), "Arc proof seller differs from ERC-8183 provider");
  assert.equal(
    proof[3],
    parseUnits(actualSettledValueUsdc.toFixed(6), 6),
    "Arc proof amount differs from actual ERC-8183 settlement",
  );
  assert.equal(proof[5].toLowerCase(), snapshotHash.toLowerCase(), "Arc proof responseHash differs from snapshot hash");

  console.log(`ERC-8004 Agent ID:       #${identityRecord.agent_id}`);
  console.log(`ERC-8183 Job ID:         ${evaluation.job_id}`);
  console.log(`Canonical Score:         ${score}`);
  console.log(`Actual Settled Value:    ${actualSettledValueUsdc} USDC`);
  console.log(`Reputation Evidence ID:  ${jobEvidence.evidenceId}`);
  console.log(`Snapshot ID:             ${snapshot.snapshotId}`);
  console.log(`Canonical Snapshot Hash: ${snapshot.canonicalHash}`);
  console.log(`Arc Proof TX:            ${snapshot.arcProofTx}`);
  console.log("\nREPUTATION LIVE ACCEPTANCE: PASS");
}

main().catch((error) => {
  console.error(
    "Reputation live acceptance failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
