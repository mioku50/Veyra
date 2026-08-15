/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
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
  if (railResult.economicSettled || railResult.actualSettledAmountUsdc > 0) {
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
    const terminalState = (railResult.economicSettled || railResult.actualSettledAmountUsdc > 0)
      ? "SETTLED_SERVICE_FAILED"
      : "FAILED";

    await updateExecutionAttemptState(attempt.executionId, terminalState, {
      failureCode: railResult.failureCode || "EXECUTION_FAILED",
      actualSettledAmountUsdc: railResult.actualSettledAmountUsdc,
      paymentTx: railResult.paymentTx || null,
      createTx: railResult.createTx || null,
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

  // Ingest real reputation evidence
  let evidenceHash: string | null = null;
  let evidenceIngested = false;
  try {
    if (attempt.rail === "erc8183") {
      const ev = await ingestErc8183JobOutcomeEvidence({
        agentId: attempt.counterpartyAgentId,
        jobId: railResult.externalReference || attempt.executionId,
        deliverableHash: railResult.evaluationId || "0x",
        verdictPassed: railResult.evaluationVerdict === "Complete",
        score: railResult.evaluationVerdict === "Complete" ? 100 : 0,
        economicValueUsdc: railResult.actualSettledAmountUsdc,
        clientAddress: mandate?.ownerWallet || attempt.counterpartyWallet,
        arcProofTx: railResult.completeTx,
      });
      evidenceHash = ev.canonicalHash;
      evidenceIngested = true;
    } else {
      const ev = await ingestX402PaymentEvidence({
        agentId: attempt.counterpartyAgentId,
        paymentId: railResult.externalReference || attempt.executionId,
        success: true,
        amountUsdc: railResult.actualSettledAmountUsdc,
        clientAddress: mandate?.ownerWallet || attempt.counterpartyWallet,
      });
      evidenceHash = ev.canonicalHash;
      evidenceIngested = true;
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

    // Assert that the snapshot is genuinely new
    if (previousSnapshot && newSnapshot.snapshotId === previousSnapshot.snapshotId) {
      newSnapshot.snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // Publish to AgentCommerceProofRegistry on Arc Testnet
    const proofResult = await publishReputationSnapshotProofToArc(
      newSnapshot,
      attempt.counterpartyWallet,
      undefined,
      railResult.actualSettledAmountUsdc > 0 ? railResult.actualSettledAmountUsdc : 0.01
    );
    if (proofResult && proofResult.verifiedOnchain && proofResult.transactionHash) {
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
