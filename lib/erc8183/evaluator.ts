/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { buildErc8183EvaluationReport } from "../reports/erc8183-evaluation-report.ts";
import { VEYRA_ERC8183_EVALUATOR_ABI } from "./abi.ts";
import { fetchJobSubmittedLogs, fetchOnchainJob, getArcPublicClient } from "./client.ts";
import { computeDeliverableHash, computePolicyHash } from "./deliverable.ts";
import { runDeterministicEvaluationPolicy } from "./policy.ts";
import type { Erc8183EvaluationRecord, Verdict, VeyraDeliverableV1 } from "./types.ts";
import { Decision } from "./types.ts";
import { signVerdict } from "./verdict.ts";

export interface ExecuteEvaluationInput {
  chainId: number;
  agenticCommerce: `0x${string}`;
  jobId: string;
  deliverable: VeyraDeliverableV1;
  evaluatorContract: `0x${string}`;
  attesterPrivateKey: Hex;
  relayerPrivateKey: Hex;
  rpcUrl?: string;
}

export type EvaluationExecutionResult = {
  status: "completed" | "rejected" | "retryable";
  decision: "complete" | "reject" | null;
  reportHash?: `0x${string}`;
  settlementTxHash?: `0x${string}`;
  failureCategory?: string;
  failureMessage?: string;
  verdictDigest?: `0x${string}`;
  canonicalReport?: Record<string, unknown>;
};

export async function executeOffchainJobEvaluation(
  input: ExecuteEvaluationInput,
): Promise<EvaluationExecutionResult> {
  const publicClient = getArcPublicClient(input.rpcUrl);
  const jobIdBigInt = BigInt(input.jobId);

  // Step 1: Fetch Onchain Job
  let onchainJob;
  try {
    onchainJob = await fetchOnchainJob(input.agenticCommerce, jobIdBigInt, publicClient);
  } catch (error) {
    return {
      status: "retryable",
      decision: null,
      failureCategory: "rpc_read_failed",
      failureMessage: `Failed to fetch onchain job: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Step 2: Fetch JobSubmitted logs
  let submittedLogs: Array<{ jobId: bigint; deliverableHash: `0x${string}`; blockNumber: bigint; transactionHash: Hex }> = [];
  try {
    submittedLogs = await fetchJobSubmittedLogs(input.agenticCommerce, jobIdBigInt, publicClient);
  } catch (err) {
    // Log fetch failure is transient
    return {
      status: "retryable",
      decision: null,
      failureCategory: "log_fetch_failed",
      failureMessage: `Failed to fetch JobSubmitted logs: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const onchainDeliverableHash = submittedLogs.length > 0 ? submittedLogs[0].deliverableHash : undefined;

  // Step 3: Run Deterministic Policy Engine
  const statusNumMap: Record<string, number> = {
    Open: 0,
    Funded: 1,
    Submitted: 2,
    Completed: 3,
    Rejected: 4,
    Expired: 5,
  };

  const policyResult = await runDeterministicEvaluationPolicy({
    deliverable: input.deliverable,
    onchainJob: {
      jobId: jobIdBigInt,
      client: onchainJob.client,
      provider: onchainJob.provider,
      evaluator: onchainJob.evaluator,
      budget: onchainJob.budget,
      expiredAt: onchainJob.expiredAt,
      status: statusNumMap[onchainJob.status] ?? 0,
      description: onchainJob.description,
    },
    onchainDeliverableHash,
    onchainSubmittedEventCount: submittedLogs.length,
    expectedEvaluatorContract: input.evaluatorContract,
    allowlistedCommerceAddress: input.agenticCommerce,
    targetChainId: 5042002,
    currentChainId: input.chainId,
  });

  if (policyResult.outcome === "TRANSIENT_ERROR") {
    return {
      status: "retryable",
      decision: null,
      failureCategory: policyResult.failureCategory ?? "transient_error",
      failureMessage: policyResult.failureMessage ?? "Transient network or RPC failure during evaluation.",
    };
  }

  console.log("🔍 Policy Evaluation Checks:");
  for (const c of policyResult.checks) {
    console.log(`  [${c.passed ? "PASS" : "FAIL"}] ${c.id}: ${c.message}`);
  }

  const decisionType: "complete" | "reject" = policyResult.outcome === "PASS" ? "complete" : "reject";
  const decisionEnum = decisionType === "complete" ? Decision.Complete : Decision.Reject;

  const policyHash = computePolicyHash(input.deliverable.policyId);
  const deliverableHash = computeDeliverableHash(input.deliverable);

  // Step 4: Build Canonical Report
  const report = buildErc8183EvaluationReport({
    chainId: input.chainId,
    agenticCommerce: input.agenticCommerce,
    evaluatorContract: input.evaluatorContract,
    jobId: input.jobId,
    client: onchainJob.client,
    provider: onchainJob.provider,
    budget: onchainJob.budget.toString(),
    expiry: Number(onchainJob.expiredAt),
    description: onchainJob.description,
    deliverableHash,
    contentHash: input.deliverable.contentHash,
    contentUri: input.deliverable.contentUri,
    policyId: input.deliverable.policyId,
    policyHash,
    decision: decisionType,
    checks: policyResult.checks,
    evidence: policyResult.parsedDeliverable?.evidence,
  });

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = nowSec + BigInt(300); // 5 minutes validity

  const verdict: Verdict = {
    agenticCommerce: input.agenticCommerce,
    jobId: jobIdBigInt,
    deliverableHash,
    reportHash: report.reportHash,
    policyHash,
    decision: decisionEnum,
    evaluatedAt: nowSec,
    validUntil,
    nonce: BigInt(Date.now()),
  };

  // Step 5: Sign Verdict EIP-712
  let signed;
  try {
    signed = await signVerdict(input.chainId, input.evaluatorContract, verdict, input.attesterPrivateKey);
  } catch (err) {
    return {
      status: "retryable",
      decision: null,
      failureCategory: "attestation_signing_failed",
      failureMessage: `Failed to sign verdict: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 6: Submit Onchain Verdict via Relayer
  const relayerAccount = privateKeyToAccount(input.relayerPrivateKey);
  const walletClient = createWalletClient({
    account: relayerAccount,
    chain: arcTestnet,
    transport: http(input.rpcUrl || "https://rpc.testnet.arc.network"),
  });

  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      address: input.evaluatorContract,
      abi: VEYRA_ERC8183_EVALUATOR_ABI,
      functionName: "executeVerdict",
      args: [
        {
          agenticCommerce: verdict.agenticCommerce,
          jobId: verdict.jobId,
          deliverableHash: verdict.deliverableHash,
          reportHash: verdict.reportHash,
          policyHash: verdict.policyHash,
          decision: verdict.decision,
          evaluatedAt: verdict.evaluatedAt,
          validUntil: verdict.validUntil,
          nonce: verdict.nonce,
        },
        signed.signature,
      ],
    });
  } catch (err) {
    console.error("❌ Relayer submission error details:", err);
    return {
      status: "retryable",
      decision: null,
      failureCategory: "relayer_submission_failed",
      failureMessage: `Relayer transaction submission failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 7: Wait for Transaction Receipt
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") {
      return {
        status: "retryable",
        decision: null,
        failureCategory: "transaction_reverted",
        failureMessage: `Settlement transaction ${txHash} reverted onchain.`,
      };
    }
  } catch (err) {
    return {
      status: "retryable",
      decision: null,
      failureCategory: "transaction_receipt_timeout",
      failureMessage: `Timed out waiting for settlement receipt ${txHash}`,
    };
  }

  // Final Report with settlementTxHash
  const finalReport = {
    ...report,
    settlementTxHash: txHash,
  };

  return {
    status: decisionType === "complete" ? "completed" : "rejected",
    decision: decisionType,
    reportHash: report.reportHash,
    settlementTxHash: txHash,
    verdictDigest: signed.digest,
    canonicalReport: finalReport as unknown as Record<string, unknown>,
  };
}
