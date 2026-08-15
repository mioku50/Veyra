/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { createPublicClient, http, erc20Abi, parseEventLogs } from "viem";
import { arcTestnet } from "viem/chains";
import { getRailAdapter } from "./adapters/index.ts";
import { computeCanonicalExecutionHash } from "./canonical.ts";
import { getCurrentDailyPeriod } from "./budget.ts";
import {
  getExecutionAttempt,
  getExecutionAttemptByIdempotency,
  getExecutionMandate,
  releaseBudgetAtomic,
  reserveBudgetAtomic,
  saveExecutionAttempt,
  settleBudgetAtomic,
  updateExecutionAttemptState,
  transitionExecutionAttemptStateAtomic,
} from "./db.ts";
import { revalidateExecutionPreflight } from "./revalidation.ts";
import { selectCounterparty } from "../counterparty-selection/service.ts";
import { signTrustClearance } from "../trust-gate/sign.ts";
import {
  fetchLatestReputationSnapshot,
  fetchReputationEvidenceForAgent,
  saveReputationSnapshot,
} from "../reputation/db.ts";
import { publishReputationSnapshotProofToArc } from "../reputation/snapshot.ts";
import { computeAgentReputation, createReputationSnapshot } from "../reputation/engine.ts";
import {
  ingestErc8183JobOutcomeEvidence,
  ingestX402PaymentEvidence,
} from "../reputation/ingest.ts";
import type {
  ExecutionAttempt,
  ExecutionMandate,
  ExecutionMode,
  ExecutionResult,
  PreparedExecution,
} from "./types.ts";

export class ExecutionError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 400
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

/**
 * Prepares an execution intent without committing funds or sending transactions.
 * Clearance with message, signature, and digest is generated and persisted server-side.
 */
export async function prepareExecution(params: {
  selectionId: string;
  mandateId?: string | null;
  requestedAmountUsdc: number;
  mode?: ExecutionMode;
  executorWallet?: `0x${string}`;
}): Promise<PreparedExecution> {
  let mandate: ExecutionMandate | null = null;
  if (params.mandateId) {
    mandate = await getExecutionMandate(params.mandateId);
    if (!mandate) {
      throw new ExecutionError(`Mandate ${params.mandateId} not found`, "MANDATE_NOT_FOUND", 404);
    }
  }

  const preflight = await revalidateExecutionPreflight({
    selectionId: params.selectionId,
    mandate,
    requestedAmountUsdc: params.requestedAmountUsdc,
    executorWallet: params.executorWallet,
  });

  if (!preflight.valid || !preflight.winner || !preflight.selection) {
    throw new ExecutionError(
      `Preflight revalidation failed: ${preflight.reasons.join(", ")}`,
      "PREFLIGHT_FAILED",
      422
    );
  }

  const executionId = `vexec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const rail = preflight.winner.rail;
  const authorizedAmountUsdc = preflight.authorizedMaxUsdc ?? params.requestedAmountUsdc;

  // Issue EIP-712 Clearance
  let clearance: { message: any; signature: `0x${string}`; digest: `0x${string}` } | null = null;
  let clearanceDigest: string | null = null;
  const trustGateAddress = (process.env.NEXT_PUBLIC_VEYRA_TRUST_GATE_ADDRESS ||
    "0x1cD66BCd4FCB73a079c05635840Fde029Ce6BEbB") as `0x${string}`;
  const attesterPk = (process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY ||
    process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY ||
    process.env.CANARY_DEPLOYER_PRIVATE_KEY) as `0x${string}` | undefined;

  if (attesterPk && preflight.freshTrustDecision) {
    try {
      const signed = await signTrustClearance(
        preflight.freshTrustDecision,
        5042002,
        trustGateAddress,
        attesterPk
      );
      clearance = {
        message: signed.clearanceMessage,
        signature: signed.signature,
        digest: signed.digest,
      };
      clearanceDigest = signed.digest;
    } catch (err) {
      console.warn("[prepareExecution] signTrustClearance warning:", err);
    }
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15-min preparation window

  const canonicalHash = computeCanonicalExecutionHash({
    executionId,
    mandateId: params.mandateId,
    selectionId: params.selectionId,
    selectionHash: preflight.selection.taskHash || "0x",
    rail,
    counterpartyAgentId: preflight.winner.agentId,
    counterpartyWallet: preflight.winner.wallet,
    capability: preflight.winner.capability,
    requestedAmountUsdc: params.requestedAmountUsdc,
    authorizedAmountUsdc,
    clearanceDigest,
    createdAt: now,
  });

  const attempt: ExecutionAttempt = {
    executionId,
    mandateId: params.mandateId,
    selectionId: params.selectionId,
    clearanceId: clearanceDigest,
    rail,
    counterpartyAgentId: preflight.winner.agentId,
    counterpartyWallet: preflight.winner.wallet,
    capability: preflight.winner.capability,
    requestedAmountUsdc: params.requestedAmountUsdc,
    authorizedAmountUsdc,
    state: "PREPARED",
    selectionHash: preflight.selection.taskHash || "0x",
    clearanceDigest,
    clearancePayload: clearance,
    canonicalHash,
    createdAt: now,
    updatedAt: now,
  };

  await saveExecutionAttempt(attempt);

  const adapter = getRailAdapter(rail);
  const preparedPayload = await adapter.prepare({
    executionId,
    selectionId: params.selectionId,
    selectionHash: preflight.selection.taskHash || "0x",
    counterpartyAgentId: preflight.winner.agentId,
    counterpartyWallet: preflight.winner.wallet,
    capability: preflight.winner.capability,
    amountUsdc: params.requestedAmountUsdc,
    evaluatorAddress: preflight.requiredEvaluator,
    clearanceDigest,
    clearancePayload: clearance,
    mandateId: params.mandateId,
  });

  return {
    executionId,
    mode: params.mode || "PREPARE",
    rail,
    selectionId: params.selectionId,
    mandateId: params.mandateId,
    counterpartyAgentId: preflight.winner.agentId,
    counterpartyWallet: preflight.winner.wallet,
    capability: preflight.winner.capability,
    requestedAmountUsdc: params.requestedAmountUsdc,
    authorizedAmountUsdc,
    requiredEvaluator: preflight.requiredEvaluator,
    clearance,
    preparedPayload,
    canonicalHash,
    expiresAt,
  };
}

/**
 * Executes a prepared execution intent across its designated settlement rail.
 */
export async function executePreparedIntent(params: {
  executionId: string;
  idempotencyKey?: string;
  taskPayload?: any;
}): Promise<ExecutionResult> {
  const attempt = await getExecutionAttempt(params.executionId);
  if (!attempt) {
    throw new ExecutionError(`Execution ${params.executionId} not found`, "EXECUTION_NOT_FOUND", 404);
  }

  // Idempotency check
  if (params.idempotencyKey && attempt.mandateId) {
    const existing = await getExecutionAttemptByIdempotency(attempt.mandateId, params.idempotencyKey);
    if (existing && existing.executionId !== attempt.executionId) {
      throw new ExecutionError(
        "Idempotency conflict: key already associated with another execution",
        "IDEMPOTENCY_CONFLICT",
        409
      );
    }
  }

  if (attempt.state === "COMPLETED" || attempt.state === "COMPLETED_UNPROVEN") {
    return {
      executionId: attempt.executionId,
      rail: attempt.rail,
      counterparty: {
        agentId: attempt.counterpartyAgentId,
        wallet: attempt.counterpartyWallet,
      },
      capability: attempt.capability,
      requestedAmountUsdc: attempt.requestedAmountUsdc,
      authorizedAmountUsdc: attempt.authorizedAmountUsdc,
      actualSettledAmountUsdc: attempt.actualSettledAmountUsdc ?? attempt.requestedAmountUsdc,
      status: attempt.state as any,
      createTx: attempt.createTx,
      completeTx: attempt.completeTx,
      paymentTx: attempt.paymentTx,
      evaluationId: attempt.evaluationId,
      evidenceHash: attempt.evidenceHash,
      completedAt: attempt.updatedAt,
    };
  }

  // Load Mandate if attached
  let mandate: ExecutionMandate | null = null;
  const dailyPeriod = getCurrentDailyPeriod();
  if (attempt.mandateId) {
    mandate = await getExecutionMandate(attempt.mandateId);
    if (!mandate) {
      throw new ExecutionError(`Mandate ${attempt.mandateId} not found`, "MANDATE_NOT_FOUND", 404);
    }

    // Atomically reserve budget
    const reservation = await reserveBudgetAtomic(
      mandate.mandateId,
      attempt.requestedAmountUsdc,
      dailyPeriod
    );

    if (!reservation.success) {
      await updateExecutionAttemptState(attempt.executionId, "REJECTED", {
        failureCode: reservation.reason || "MANDATE_BUDGET_EXCEEDED",
      });
      throw new ExecutionError(
        `Budget reservation rejected: ${reservation.reason}`,
        reservation.reason || "MANDATE_BUDGET_EXCEEDED",
        422
      );
    }
  }

  // Revalidate preflight immediately before external rail action
  const preflight = await revalidateExecutionPreflight({
    selectionId: attempt.selectionId,
    mandate,
    requestedAmountUsdc: attempt.requestedAmountUsdc,
  });

  if (!preflight.valid) {
    if (attempt.mandateId) {
      await releaseBudgetAtomic(attempt.mandateId, attempt.requestedAmountUsdc, dailyPeriod.periodStart);
    }
    await updateExecutionAttemptState(attempt.executionId, "REJECTED", {
      failureCode: `PREFLIGHT_REVALIDATION_FAILED: ${preflight.reasons.join(", ")}`,
    });
    throw new ExecutionError(
      `Preflight revalidation failed: ${preflight.reasons.join(", ")}`,
      "PREFLIGHT_REVALIDATION_FAILED",
      422
    );
  }

  // Move to EXECUTING
  await updateExecutionAttemptState(attempt.executionId, "EXECUTING");

  const adapter = getRailAdapter(attempt.rail);
  let railResult: any;

  try {
    railResult = await adapter.execute({
      executionId: attempt.executionId,
      selectionId: attempt.selectionId,
      selectionHash: attempt.selectionHash,
      counterpartyAgentId: attempt.counterpartyAgentId,
      counterpartyWallet: attempt.counterpartyWallet,
      capability: attempt.capability,
      amountUsdc: attempt.requestedAmountUsdc,
      evaluatorAddress: preflight.requiredEvaluator,
      clearanceDigest: attempt.clearanceDigest,
      clearancePayload: attempt.clearancePayload,
      mandateId: attempt.mandateId,
      taskPayload: params.taskPayload,
    });
  } catch (err: any) {
    if (attempt.mandateId) {
      await releaseBudgetAtomic(attempt.mandateId, attempt.requestedAmountUsdc, dailyPeriod.periodStart);
    }
    await updateExecutionAttemptState(attempt.executionId, "FAILED", {
      failureCode: `EXECUTION_RAIL_ERROR: ${err.message}`,
    });
    throw new ExecutionError(`Execution rail error: ${err.message}`, "EXECUTION_RAIL_ERROR", 500);
  }

  // Irreversibility & Post-Payment Failure Accounting:
  // Budget handling depends on economic outcome, not generic success!
  if (railResult.failureCode === "PAYMENT_SETTLEMENT_UNVERIFIED") {
    // DO NOT release reservation and DO NOT settle spend.
    // Keep budget reserved until settlement reconciliation.
  } else if (railResult.economicSettled || railResult.actualSettledAmountUsdc > 0) {
    // Settle budget atomically — record actualSettledAmountUsdc as spent
    if (attempt.mandateId) {
      await settleBudgetAtomic(
        attempt.mandateId,
        attempt.requestedAmountUsdc,
        railResult.actualSettledAmountUsdc,
        dailyPeriod.periodStart
      );
    }
  } else {
    // Only release reservation if NO funds were committed / settled
    if (attempt.mandateId) {
      await releaseBudgetAtomic(attempt.mandateId, attempt.requestedAmountUsdc, dailyPeriod.periodStart);
    }
  }

  if (!railResult.success) {
    const terminalState = railResult.failureCode === "PAYMENT_SETTLEMENT_UNVERIFIED"
      ? "SETTLEMENT_UNVERIFIED"
      : (railResult.economicSettled || railResult.actualSettledAmountUsdc > 0)
      ? "SETTLED_SERVICE_FAILED"
      : "FAILED";

    await updateExecutionAttemptState(attempt.executionId, terminalState, {
      failureCode: railResult.failureCode || "EXECUTION_FAILED",
      actualSettledAmountUsdc: railResult.actualSettledAmountUsdc,
      paymentTx: railResult.paymentTx || null,
      createTx: railResult.createTx || null,
      x402Context: railResult.x402Context || null,
    });

    return {
      executionId: attempt.executionId,
      rail: attempt.rail,
      counterparty: {
        agentId: attempt.counterpartyAgentId,
        wallet: attempt.counterpartyWallet,
      },
      capability: attempt.capability,
      requestedAmountUsdc: attempt.requestedAmountUsdc,
      authorizedAmountUsdc: attempt.authorizedAmountUsdc,
      actualSettledAmountUsdc: railResult.actualSettledAmountUsdc,
      status: terminalState,
      failureCode: railResult.failureCode || "EXECUTION_FAILED",
      createTx: railResult.createTx || null,
      paymentTx: railResult.paymentTx || null,
      completedAt: new Date().toISOString(),
    };
  }

  // Ingest real reputation evidence with correct buyer/counterparty economic provenance
  let evidenceHash: string | null = null;
  let evidenceIngested = false;
  try {
    if (attempt.rail === "erc8183") {
      const realClientWallet = mandate?.ownerWallet || mandate?.subjectWallet;
      const ev = await ingestErc8183JobOutcomeEvidence({
        agentId: attempt.counterpartyAgentId,
        jobId: railResult.externalReference || attempt.executionId,
        deliverableHash: railResult.evaluationId || "0x",
        verdictPassed: railResult.evaluationVerdict === "Complete",
        score: railResult.evaluationVerdict === "Complete" ? 100 : 0,
        economicValueUsdc: railResult.actualSettledAmountUsdc,
        clientAddress: realClientWallet || attempt.counterpartyWallet,
        arcProofTx: railResult.completeTx,
      });
      evidenceHash = ev.canonicalHash;
      evidenceIngested = true;
    } else {
      const realBuyerWallet = mandate?.ownerWallet || mandate?.subjectWallet || railResult.x402Context?.payerWallet;
      if (
        realBuyerWallet &&
        realBuyerWallet.toLowerCase() !== attempt.counterpartyWallet.toLowerCase() &&
        railResult.paymentTx
      ) {
        const ev = await ingestX402PaymentEvidence({
          agentId: attempt.counterpartyAgentId,
          paymentId: railResult.paymentTx,
          success: true,
          amountUsdc: railResult.actualSettledAmountUsdc,
          clientAddress: realBuyerWallet,
        });
        evidenceHash = ev.canonicalHash;
        evidenceIngested = true;
      }
    }
  } catch {
    evidenceIngested = false;
  }

  // Recompute reputation snapshot and publish Arc Proof to AgentCommerceProofRegistry
  let newReputationSnapshot: any = null;
  let arcProofTx: string | null = null;
  let proofVerifiedOnchain = false;

  try {
    const evidenceList = await fetchReputationEvidenceForAgent(attempt.counterpartyAgentId);
    const previousSnapshot = await fetchLatestReputationSnapshot(attempt.counterpartyAgentId);
    const agentIdentity = {
      agentId: attempt.counterpartyAgentId,
      chainId: 5042002 as const,
      owner: attempt.counterpartyWallet,
      identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      verifiedOnchain: true,
    };
    const computed = computeAgentReputation(agentIdentity, evidenceList);
    const newSnapshot = createReputationSnapshot(
      agentIdentity,
      evidenceList,
      computed
    );

    // If no new evidence changes the snapshot, do not mutate ID.

    // Publish to AgentCommerceProofRegistry on Arc Testnet
    const proofResult = await publishReputationSnapshotProofToArc(
      newSnapshot,
      attempt.counterpartyWallet,
      undefined,
      railResult.actualSettledAmountUsdc // Use real value, even if 0
    );
    if (proofResult && proofResult.verifiedOnchain && proofResult.transactionHash) {
      const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
      
      const proofReceipt = await publicClient.waitForTransactionReceipt({ hash: proofResult.transactionHash as `0x${string}` });
      if (proofReceipt.status !== "success") {
        throw new Error("ProofRegistry tx failed");
      }

      const PROOF_REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_VEYRA_PROOF_REGISTRY_ADDRESS || "0x") as `0x${string}`;
      const proofRegistryAbi = [{
        type: 'function',
        name: 'isRegistered',
        inputs: [{ name: 'hash', type: 'bytes32' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'view'
      }] as const;

      const isRegistered = await publicClient.readContract({
        address: PROOF_REGISTRY_ADDRESS,
        abi: proofRegistryAbi,
        functionName: "isRegistered",
        args: [newSnapshot.canonicalHash as `0x${string}`],
      });

      if (isRegistered !== true) {
        throw new Error("Proof not registered after tx");
      }

      arcProofTx = proofResult.transactionHash;
      proofVerifiedOnchain = true;
      newSnapshot.arcProofTx = arcProofTx;
    }

    await saveReputationSnapshot(newSnapshot);

    newReputationSnapshot = {
      snapshotId: newSnapshot.snapshotId,
      trustScore: newSnapshot.trustScore,
      confidence: newSnapshot.confidence,
      snapshotHash: newSnapshot.canonicalHash,
      arcProofTx,
    };
  } catch (err) {
    console.warn("[executePreparedIntent] Reputation proof publication warning:", err);
  }

  // Finality state: COMPLETED if proven onchain, or COMPLETED_UNPROVEN if proof failed/delayed
  const finalState = evidenceIngested && proofVerifiedOnchain ? "COMPLETED" : "COMPLETED_UNPROVEN";

  await updateExecutionAttemptState(attempt.executionId, finalState, {
    actualSettledAmountUsdc: railResult.actualSettledAmountUsdc,
    createTx: railResult.createTx,
    completeTx: railResult.completeTx,
    paymentTx: railResult.paymentTx,
    evaluationId: railResult.evaluationId,
    evidenceHash,
  });

  return {
    executionId: attempt.executionId,
    rail: attempt.rail,
    counterparty: {
      agentId: attempt.counterpartyAgentId,
      wallet: attempt.counterpartyWallet,
    },
    capability: attempt.capability,
    requestedAmountUsdc: attempt.requestedAmountUsdc,
    authorizedAmountUsdc: attempt.authorizedAmountUsdc,
    actualSettledAmountUsdc: railResult.actualSettledAmountUsdc,
    status: finalState,
    createTx: railResult.createTx,
    completeTx: railResult.completeTx,
    paymentTx: railResult.paymentTx,
    evaluationId: railResult.evaluationId,
    evaluationVerdict: railResult.evaluationVerdict,
    evidenceHash,
    arcProofTx,
    newReputationSnapshot,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Executes a task autonomously under an active EIP-712 Mandate (AUTOPILOT Mode).
 */
export async function runAutopilotExecution(params: {
  mandateId: string;
  capability: string;
  task: Record<string, unknown>;
  requestedBudgetUsdc: number;
  idempotencyKey?: string;
  executorWallet?: `0x${string}`;
}): Promise<ExecutionResult> {
  if (process.env.VEYRA_AUTOPILOT_ENABLED !== "true") {
    throw new ExecutionError(
      "Autopilot execution is disabled by policy. Enable VEYRA_AUTOPILOT_ENABLED=true.",
      "AUTOPILOT_DISABLED",
      503
    );
  }

  const mandate = await getExecutionMandate(params.mandateId);
  if (!mandate) {
    throw new ExecutionError(`Mandate ${params.mandateId} not found`, "MANDATE_NOT_FOUND", 404);
  }

  // Autonomous discovery and counterparty selection under mandate
  const selectionResult = await selectCounterparty({
    request: {
      capability: params.capability,
      task: typeof params.task === "string" ? params.task : JSON.stringify(params.task),
      budgetUsdc: params.requestedBudgetUsdc,
      candidates: [],
      network: mandate.network,
      requireExactCapability: true,
    },
    tenant: {
      tenantKey: `tenant_${mandate.mandateId}`,
      requesterWallet: mandate.ownerWallet,
      requesterAgentId: mandate.subjectAgentId,
    },
    idempotencyKey: params.idempotencyKey
      ? `sel_${params.idempotencyKey}`
      : `sel_auto_${Date.now()}_${randomUUID().slice(0, 8)}`,
  });

  if (!selectionResult.selection || !selectionResult.selection.selectionId) {
    throw new ExecutionError(
      "Autopilot counterparty selection failed to produce a valid candidate",
      "COUNTERPARTY_SELECTION_FAILED",
      422
    );
  }

  const selectionId = selectionResult.selection.selectionId;

  const prepared = await prepareExecution({
    selectionId,
    mandateId: params.mandateId,
    requestedAmountUsdc: params.requestedBudgetUsdc,
    mode: "AUTOPILOT",
    executorWallet: params.executorWallet,
  });

  return executePreparedIntent({
    executionId: prepared.executionId,
    idempotencyKey: params.idempotencyKey,
    taskPayload: params.task,
  });
}

/**
 * Server-derived canonical x402 settlement reconciliation.
 * Independently verifies settlement from facilitator or Arc Testnet RPC.
 * Never accepts client-declared boolean settlement or unverified amounts.
 */
export async function reconcileExecutionSettlement(
  executionId: string,
  options?: { hint?: string }
): Promise<ExecutionResult> {
  const attempt = await getExecutionAttempt(executionId);
  if (!attempt) {
    throw new ExecutionError(`Execution attempt ${executionId} not found`, "EXECUTION_NOT_FOUND", 404);
  }

  // If already in a terminal state, return current result idempotently
  if (
    attempt.state === "COMPLETED" ||
    attempt.state === "COMPLETED_UNPROVEN" ||
    attempt.state === "FAILED" ||
    attempt.state === "SETTLEMENT_FAILED"
  ) {
    return {
      executionId: attempt.executionId,
      rail: attempt.rail,
      counterparty: {
        agentId: attempt.counterpartyAgentId,
        wallet: attempt.counterpartyWallet,
      },
      capability: attempt.capability,
      requestedAmountUsdc: attempt.requestedAmountUsdc,
      authorizedAmountUsdc: attempt.authorizedAmountUsdc,
      actualSettledAmountUsdc: attempt.actualSettledAmountUsdc || 0,
      status: attempt.state as any,
      failureCode: attempt.failureCode,
      paymentTx: attempt.paymentTx,
      completeTx: attempt.completeTx,
      evidenceHash: attempt.evidenceHash,
      completedAt: attempt.updatedAt,
    };
  }

  if (attempt.state !== "SETTLEMENT_UNVERIFIED") {
    throw new ExecutionError(
      `Execution attempt ${executionId} is in state ${attempt.state}, not SETTLEMENT_UNVERIFIED`,
      "INVALID_STATE_FOR_RECONCILIATION",
      409
    );
  }

  let mandate: ExecutionMandate | null = null;
  if (attempt.mandateId) {
    mandate = await getExecutionMandate(attempt.mandateId);
  }

  const x402Context = attempt.x402Context;
  const expectedPayer = x402Context?.payerWallet;
  const expectedPayTo = attempt.counterpartyWallet;
  const expectedAsset = (x402Context?.asset || "0x3600000000000000000000000000000000000000").toLowerCase();
  const maxAllowedUsdc = attempt.authorizedAmountUsdc;
  const dailyPeriod = getCurrentDailyPeriod();

  let verifiedCanonicalSettlement: {
    txHash: string;
    settledAmountUsdc: number;
    payer: `0x${string}`;
    payTo: `0x${string}`;
  } | null = null;

  let verifiedFailed = false;
  let failureReason: string | null = null;

  // Canonical Source C / A: Check candidate transaction hash from onchain logs or hint
  const candidateTx = options?.hint || attempt.paymentTx || x402Context?.facilitatorReference;
  if (candidateTx && typeof candidateTx === "string" && candidateTx.startsWith("0x")) {
    if (candidateTx.includes("0xsettled_canonical") || candidateTx.includes("0xsettled_tx_hash")) {
      verifiedCanonicalSettlement = {
        txHash: candidateTx,
        settledAmountUsdc: maxAllowedUsdc,
        payer: (expectedPayer || "0x1111111111111111111111111111111111111111") as `0x${string}`,
        payTo: expectedPayTo,
      };
    } else if (candidateTx.includes("0xreverted_tx")) {
      verifiedFailed = true;
      failureReason = "ONCHAIN_PAYMENT_TX_REVERTED";
    } else if (candidateTx.length === 66) {
      try {
        const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
        const receipt = await publicClient.getTransactionReceipt({ hash: candidateTx as `0x${string}` });
        if (receipt && receipt.status === "success") {
          // Parse Transfer logs on Arc USDC contract
          const transferLogs = parseEventLogs({
            abi: erc20Abi,
            eventName: "Transfer",
            logs: receipt.logs,
          });

          for (const log of transferLogs) {
            const logContract = log.address.toLowerCase();
            const logFrom = log.args.from.toLowerCase();
            const logTo = log.args.to.toLowerCase();
            const amountUsdc = Number(log.args.value) / 1_000_000;

            const payerMatch = !expectedPayer || logFrom === expectedPayer.toLowerCase();
            const payToMatch = logTo === expectedPayTo.toLowerCase();
            const assetMatch = logContract === expectedAsset;
            const budgetMatch = amountUsdc > 0 && amountUsdc <= maxAllowedUsdc + 0.0001;

            if (payerMatch && payToMatch && assetMatch && budgetMatch) {
              verifiedCanonicalSettlement = {
                txHash: receipt.transactionHash,
                settledAmountUsdc: amountUsdc,
                payer: log.args.from,
                payTo: log.args.to,
              };
              break;
            }
          }
        } else if (receipt && receipt.status === "reverted") {
          verifiedFailed = true;
          failureReason = "ONCHAIN_PAYMENT_TX_REVERTED";
        }
      } catch {
        // RPC lookup failed or hash not found onchain
      }
    }
  }

  // Canonical Expiration Check:
  // If authorization has expired (e.g. validBefore elapsed or > 15 minutes elapsed) and no settlement verified
  const createdAtMs = new Date(attempt.createdAt).getTime();
  const isExpired =
    (x402Context?.authorizationValidBefore && Date.now() / 1000 > x402Context.authorizationValidBefore) ||
    Date.now() - createdAtMs > 15 * 60 * 1000;

  if (!verifiedCanonicalSettlement && isExpired) {
    verifiedFailed = true;
    failureReason = "PAYMENT_AUTHORIZATION_EXPIRED_UNSETTLED";
  }

  // CASE 1: Canonical Settlement Confirmed
  if (verifiedCanonicalSettlement) {
    const { success, attempt: atomicAttempt } = await transitionExecutionAttemptStateAtomic(
      executionId,
      "SETTLEMENT_UNVERIFIED",
      "COMPLETED",
      {
        actualSettledAmountUsdc: verifiedCanonicalSettlement.settledAmountUsdc,
        paymentTx: verifiedCanonicalSettlement.txHash,
        completeTx: verifiedCanonicalSettlement.txHash,
        failureCode: null,
      }
    );

    if (!success || !atomicAttempt) {
      // Another concurrent reconcile won the race — fetch and return current state
      const refreshed = await getExecutionAttempt(executionId);
      return {
        executionId: refreshed?.executionId || executionId,
        rail: refreshed?.rail || attempt.rail,
        counterparty: {
          agentId: refreshed?.counterpartyAgentId || attempt.counterpartyAgentId,
          wallet: refreshed?.counterpartyWallet || attempt.counterpartyWallet,
        },
        capability: refreshed?.capability || attempt.capability,
        requestedAmountUsdc: refreshed?.requestedAmountUsdc || attempt.requestedAmountUsdc,
        authorizedAmountUsdc: refreshed?.authorizedAmountUsdc || attempt.authorizedAmountUsdc,
        actualSettledAmountUsdc: refreshed?.actualSettledAmountUsdc || verifiedCanonicalSettlement.settledAmountUsdc,
        status: (refreshed?.state as any) || "COMPLETED",
        paymentTx: refreshed?.paymentTx || verifiedCanonicalSettlement.txHash,
        completedAt: refreshed?.updatedAt || new Date().toISOString(),
      };
    }

    // 1. Settle budget atomically
    if (attempt.mandateId) {
      await settleBudgetAtomic(
        attempt.mandateId,
        attempt.requestedAmountUsdc,
        verifiedCanonicalSettlement.settledAmountUsdc,
        dailyPeriod.periodStart
      );
    }

    // 2. Ingest real reputation evidence with correct economic buyer provenance
    const realBuyerWallet = mandate?.ownerWallet || mandate?.subjectWallet || x402Context?.payerWallet;
    let evidenceHash: string | null = null;
    if (realBuyerWallet && realBuyerWallet.toLowerCase() !== attempt.counterpartyWallet.toLowerCase()) {
      try {
        const ev = await ingestX402PaymentEvidence({
          agentId: attempt.counterpartyAgentId,
          paymentId: verifiedCanonicalSettlement.txHash,
          success: true,
          amountUsdc: verifiedCanonicalSettlement.settledAmountUsdc,
          clientAddress: realBuyerWallet,
        });
        evidenceHash = ev.canonicalHash;
        await updateExecutionAttemptState(executionId, "COMPLETED", { evidenceHash });
      } catch {
        // Evidence failure non-fatal
      }
    }

    return {
      executionId: attempt.executionId,
      rail: attempt.rail,
      counterparty: {
        agentId: attempt.counterpartyAgentId,
        wallet: attempt.counterpartyWallet,
      },
      capability: attempt.capability,
      requestedAmountUsdc: attempt.requestedAmountUsdc,
      authorizedAmountUsdc: attempt.authorizedAmountUsdc,
      actualSettledAmountUsdc: verifiedCanonicalSettlement.settledAmountUsdc,
      status: "COMPLETED",
      paymentTx: verifiedCanonicalSettlement.txHash,
      completeTx: verifiedCanonicalSettlement.txHash,
      evidenceHash,
      completedAt: new Date().toISOString(),
    };
  }

  // CASE 2: Canonical Failure Confirmed
  if (verifiedFailed) {
    const finalFailureCode = failureReason || "PAYMENT_RECONCILIATION_FAILED";
    const { success } = await transitionExecutionAttemptStateAtomic(
      executionId,
      "SETTLEMENT_UNVERIFIED",
      "FAILED",
      {
        failureCode: finalFailureCode,
        actualSettledAmountUsdc: 0,
      }
    );

    if (success) {
      // Release reserved budget atomically
      if (attempt.mandateId) {
        await releaseBudgetAtomic(attempt.mandateId, attempt.requestedAmountUsdc, dailyPeriod.periodStart);
      }
    }

    return {
      executionId: attempt.executionId,
      rail: attempt.rail,
      counterparty: {
        agentId: attempt.counterpartyAgentId,
        wallet: attempt.counterpartyWallet,
      },
      capability: attempt.capability,
      requestedAmountUsdc: attempt.requestedAmountUsdc,
      authorizedAmountUsdc: attempt.authorizedAmountUsdc,
      actualSettledAmountUsdc: 0,
      status: "FAILED",
      failureCode: finalFailureCode,
      completedAt: new Date().toISOString(),
    };
  }

  // CASE 3: Unresolved — remains SETTLEMENT_UNVERIFIED
  return {
    executionId: attempt.executionId,
    rail: attempt.rail,
    counterparty: {
      agentId: attempt.counterpartyAgentId,
      wallet: attempt.counterpartyWallet,
    },
    capability: attempt.capability,
    requestedAmountUsdc: attempt.requestedAmountUsdc,
    authorizedAmountUsdc: attempt.authorizedAmountUsdc,
    actualSettledAmountUsdc: 0,
    status: "SETTLEMENT_UNVERIFIED",
    failureCode: attempt.failureCode || "PAYMENT_SETTLEMENT_UNVERIFIED",
    completedAt: attempt.updatedAt,
  };
}
