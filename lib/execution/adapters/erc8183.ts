/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createWalletClient, http, parseEventLogs, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { getArcPublicClient } from "../../erc8183/client.ts";
import { executeOffchainJobEvaluation } from "../../erc8183/evaluator.ts";
import type { ExecutionRailAdapter, NormalizedRailResult, RailExecutionParams } from "./types.ts";

const VEYRA_TRUST_GATE_ABI = [
  {
    name: "consumeClearance",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "clearance",
        type: "tuple",
        components: [
          { name: "decisionId", type: "bytes32" },
          { name: "subject", type: "address" },
          { name: "executor", type: "address" },
          { name: "counterparty", type: "address" },
          { name: "actionHash", type: "bytes32" },
          { name: "requestedAmount", type: "uint256" },
          { name: "maxAmount", type: "uint256" },
          { name: "snapshotHash", type: "bytes32" },
          { name: "policyVersion", type: "bytes32" },
          { name: "evaluator", type: "address" },
          { name: "issuedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "consumedClearances",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ERC8183_COMMERCE_ABI = [
  {
    name: "createJob",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "expiredAt", type: "uint64" },
      { name: "description", type: "string" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    name: "submitJob",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "deliverableHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      { indexed: true, name: "jobId", type: "uint256" },
      { indexed: true, name: "client", type: "address" },
      { indexed: true, name: "provider", type: "address" },
      { indexed: false, name: "evaluator", type: "address" },
      { indexed: false, name: "budget", type: "uint256" },
      { indexed: false, name: "expiredAt", type: "uint64" },
      { indexed: false, name: "description", type: "string" },
    ],
  },
] as const;

export class Erc8183ExecutionAdapter implements ExecutionRailAdapter {
  readonly rail = "erc8183" as const;

  async prepare(params: RailExecutionParams): Promise<any> {
    return {
      rail: "erc8183",
      jobContract: process.env.NEXT_PUBLIC_ERC8183_CONTRACT_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583",
      providerWallet: params.counterpartyWallet,
      evaluatorAddress: params.evaluatorAddress || process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7",
      maxAmountUsdc: params.amountUsdc,
      selectionHash: params.selectionHash,
      clearanceDigest: params.clearanceDigest,
    };
  }

  async execute(params: RailExecutionParams): Promise<NormalizedRailResult> {
    const isTestMode = process.env.NODE_ENV === "test" && process.env.EXECUTION_ALLOW_TEST_FALLBACK === "true";

    // Validate recipient
    if (!params.counterpartyWallet || params.counterpartyWallet === "0x0000000000000000000000000000000000000000") {
      return {
        executionId: params.executionId,
        rail: "erc8183",
        success: false,
        failureCode: "INVALID_COUNTERPARTY_WALLET",
        actualSettledAmountUsdc: 0,
        evidenceType: "erc8183_job_rejected",
      };
    }

    const evaluatorContract = (params.evaluatorAddress ||
      process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS ||
      "0x0d2c04580e081e222bbe5bf9818af337e2633eb7") as `0x${string}`;
    const agenticCommerce = (process.env.NEXT_PUBLIC_ERC8183_CONTRACT_ADDRESS ||
      "0x0747EEf0706327138c69792bF28Cd525089e4583") as `0x${string}`;
    const trustGateAddress = (process.env.NEXT_PUBLIC_VEYRA_TRUST_GATE_ADDRESS ||
      "0x1cD66BCd4FCB73a079c05635840Fde029Ce6BEbB") as `0x${string}`;

    const attesterPk = (process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY ||
      process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY) as `0x${string}` | undefined;
    const relayerPk = (process.env.ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY ||
      process.env.CANARY_DEPLOYER_PRIVATE_KEY) as `0x${string}` | undefined;
    const rpcUrl = process.env.ARC_TESTNET_RPC_URL;

    // Controlled deterministic harness for explicit unit/negative test mode only
    if (isTestMode) {
      const mockTx = `0x${Buffer.from(`tx_erc8183_${params.executionId}`).toString("hex").padEnd(64, "0")}` as `0x${string}`;
      const mockJobId = `job_test_${params.executionId.slice(0, 8)}`;
      return {
        executionId: params.executionId,
        rail: "erc8183",
        success: true,
        actualSettledAmountUsdc: params.amountUsdc,
        externalReference: mockJobId,
        createTx: mockTx,
        completeTx: mockTx,
        evaluationId: `eval_${params.executionId}`,
        evaluationVerdict: "Complete",
        evidenceType: "erc8183_job_completed",
        rawResult: {
          status: "completed",
          decision: "complete",
          jobId: mockJobId,
          amountUsdc: params.amountUsdc,
        },
      };
    }

    // Real Execution Path
    if (attesterPk && relayerPk && rpcUrl) {
      const publicClient = getArcPublicClient(rpcUrl);
      const relayerAccount = privateKeyToAccount(relayerPk);
      const walletClient = createWalletClient({
        account: relayerAccount,
        chain: arcTestnet,
        transport: http(rpcUrl),
      });

      try {
        // Step 1: Real Clearance Consumption on VeyraTrustGate
        if (params.taskPayload?.clearance && params.taskPayload?.clearanceSignature) {
          const consumeTxHash = await walletClient.writeContract({
            address: trustGateAddress,
            abi: VEYRA_TRUST_GATE_ABI,
            functionName: "consumeClearance",
            args: [params.taskPayload.clearance, params.taskPayload.clearanceSignature],
          });
          const consumeReceipt = await publicClient.waitForTransactionReceipt({ hash: consumeTxHash });
          if (consumeReceipt.status !== "success") {
            return {
              executionId: params.executionId,
              rail: "erc8183",
              success: false,
              failureCode: "CLEARANCE_CONSUMPTION_REVERTED",
              actualSettledAmountUsdc: 0,
              evidenceType: "erc8183_job_rejected",
            };
          }
        }

        // Step 2: Create Real Onchain Job
        const budgetAtomic = parseUnits(params.amountUsdc.toFixed(6), 6);
        const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

        const createTxHash = await walletClient.writeContract({
          address: agenticCommerce,
          abi: ERC8183_COMMERCE_ABI,
          functionName: "createJob",
          args: [
            params.counterpartyWallet,
            evaluatorContract,
            budgetAtomic,
            expiredAt,
            `Veyra Job ${params.executionId} (${params.capability})`,
          ],
        });

        const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTxHash });
        if (createReceipt.status !== "success") {
          return {
            executionId: params.executionId,
            rail: "erc8183",
            success: false,
            failureCode: "ERC8183_CREATE_JOB_REVERTED",
            actualSettledAmountUsdc: 0,
            evidenceType: "erc8183_job_rejected",
          };
        }

        // Extract real numeric jobId from JobCreated event log
        const logs = parseEventLogs({
          abi: ERC8183_COMMERCE_ABI,
          eventName: "JobCreated",
          logs: createReceipt.logs,
        });

        const realJobId = logs.length > 0 ? logs[0].args.jobId.toString() : "";
        if (!realJobId) {
          return {
            executionId: params.executionId,
            rail: "erc8183",
            success: false,
            failureCode: "ERC8183_JOB_ID_NOT_FOUND",
            actualSettledAmountUsdc: 0,
            evidenceType: "erc8183_job_rejected",
          };
        }

        // Step 3: Submit Deliverable onchain
        const deliverable = {
          version: 1 as const,
          contentUri: `ipfs://bafkreib${params.executionId.slice(0, 20)}`,
          contentHash: `0x${Buffer.from(`del_${params.executionId}`).toString("hex").padEnd(64, "0")}` as `0x${string}`,
          contentType: "application/json" as const,
          schemaId: "veyra://schemas/structured-deliverable-v1" as const,
          policyId: "structured-deliverable-v1" as const,
        };

        const submitTxHash = await walletClient.writeContract({
          address: agenticCommerce,
          abi: ERC8183_COMMERCE_ABI,
          functionName: "submitJob",
          args: [BigInt(realJobId), deliverable.contentHash],
        });
        await publicClient.waitForTransactionReceipt({ hash: submitTxHash });

        // Step 4: Execute Offchain Independent Evaluation & Onchain Verdict Settlement
        const evalResult = await executeOffchainJobEvaluation({
          chainId: 5042002,
          agenticCommerce,
          jobId: realJobId,
          deliverable,
          evaluatorContract,
          attesterPrivateKey: attesterPk,
          relayerPrivateKey: relayerPk,
          rpcUrl,
        });

        const success = evalResult.status === "completed" && evalResult.decision === "complete";
        const actualSettled = success ? params.amountUsdc : 0;

        return {
          executionId: params.executionId,
          rail: "erc8183",
          success,
          failureCode: success ? null : evalResult.failureCategory || "EVALUATION_REJECTED",
          actualSettledAmountUsdc: actualSettled,
          externalReference: realJobId,
          createTx: createTxHash,
          completeTx: evalResult.settlementTxHash || null,
          evaluationId: evalResult.reportHash || null,
          evaluationVerdict: success ? "Complete" : "Reject",
          evidenceType: success ? "erc8183_job_completed" : "erc8183_job_rejected",
          rawResult: evalResult,
        };
      } catch (err: any) {
        return {
          executionId: params.executionId,
          rail: "erc8183",
          success: false,
          failureCode: `ERC8183_LIVE_EXECUTION_ERROR: ${err.message}`,
          actualSettledAmountUsdc: 0,
          evidenceType: "erc8183_job_rejected",
        };
      }
    }

    // Production fail-closed when live execution cannot proceed
    return {
      executionId: params.executionId,
      rail: "erc8183",
      success: false,
      failureCode: "ERC8183_KEYS_OR_RPC_UNAVAILABLE",
      actualSettledAmountUsdc: 0,
      evidenceType: "erc8183_job_rejected",
    };
  }
}
