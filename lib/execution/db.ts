/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { getByoaClient } from "../byoa/service.ts";
import type { BudgetPeriod, BudgetReservationResult } from "./budget.ts";
import { validateStateTransition } from "./state-machine.ts";
import type { ExecutionAttempt, ExecutionMandate, ExecutionState } from "./types.ts";

const memoryMandateStore = new Map<string, ExecutionMandate>();
const memoryAttemptStore = new Map<string, ExecutionAttempt>();
const memoryUsageStore = new Map<string, { used: number; reserved: number; totalUsed: number; totalReserved: number }>();

export function isMemoryStoreAllowed(): boolean {
  return process.env.NODE_ENV === "test" && process.env.EXECUTION_ALLOW_MEMORY_STORE === "true";
}

export function clearMemoryStores(): void {
  if (isMemoryStoreAllowed()) {
    memoryMandateStore.clear();
    memoryAttemptStore.clear();
    memoryUsageStore.clear();
  }
}

export async function saveExecutionMandate(mandate: ExecutionMandate): Promise<void> {
  if (isMemoryStoreAllowed()) {
    memoryMandateStore.set(mandate.mandateId, mandate);
    return;
  }

  const supabase = getByoaClient();
  const { error } = await supabase.from("execution_mandates").insert({
    mandate_id: mandate.mandateId,
    owner_wallet: mandate.ownerWallet.toLowerCase(),
    subject_agent_id: mandate.subjectAgentId,
    subject_wallet: mandate.subjectWallet.toLowerCase(),
    mode: mandate.mode,
    network: mandate.network,
    allowed_capabilities: mandate.allowedCapabilities,
    allowed_rails: mandate.allowedRails,
    max_per_transaction_usdc: mandate.maxPerTransactionUsdc,
    max_per_day_usdc: mandate.maxPerDayUsdc,
    max_total_usdc: mandate.maxTotalUsdc,
    minimum_trust_score: mandate.minimumTrustScore,
    minimum_confidence: mandate.minimumConfidence,
    require_verified_identity: mandate.requireVerifiedIdentity,
    evaluator_threshold_usdc: mandate.evaluatorThresholdUsdc,
    canonical_hash: mandate.canonicalHash,
    signature: mandate.signature,
    nonce: mandate.nonce,
    version: mandate.version,
    issued_at: mandate.issuedAt,
    expires_at: mandate.expiresAt,
    revoked_at: mandate.revokedAt || null,
    created_at: mandate.createdAt,
  });

  if (error) {
    throw new Error(`Database error saving mandate: ${error.message}`);
  }
}

export async function getExecutionMandate(mandateId: string): Promise<ExecutionMandate | null> {
  if (isMemoryStoreAllowed()) {
    return memoryMandateStore.get(mandateId) || null;
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("execution_mandates")
    .select("*")
    .eq("mandate_id", mandateId)
    .maybeSingle();

  if (error) {
    throw new Error(`Database error reading mandate: ${error.message}`);
  }

  if (!data) return null;

  return {
    mandateId: data.mandate_id,
    ownerWallet: data.owner_wallet as `0x${string}`,
    subjectAgentId: data.subject_agent_id,
    subjectWallet: data.subject_wallet as `0x${string}`,
    mode: data.mode,
    network: data.network,
    allowedCapabilities: data.allowed_capabilities,
    allowedRails: data.allowed_rails,
    maxPerTransactionUsdc: Number(data.max_per_transaction_usdc),
    maxPerDayUsdc: Number(data.max_per_day_usdc),
    maxTotalUsdc: Number(data.max_total_usdc),
    minimumTrustScore: Number(data.minimum_trust_score),
    minimumConfidence: Number(data.minimum_confidence),
    requireVerifiedIdentity: data.require_verified_identity,
    evaluatorThresholdUsdc: Number(data.evaluator_threshold_usdc),
    canonicalHash: data.canonical_hash,
    signature: data.signature as `0x${string}`,
    nonce: Number(data.nonce),
    version: data.version,
    issuedAt: data.issued_at,
    expiresAt: data.expires_at,
    revokedAt: data.revoked_at,
    createdAt: data.created_at,
  };
}

export async function listExecutionMandatesByOwner(ownerWallet: string): Promise<ExecutionMandate[]> {
  const normOwner = ownerWallet.toLowerCase();
  if (isMemoryStoreAllowed()) {
    return Array.from(memoryMandateStore.values()).filter(
      (m) => m.ownerWallet.toLowerCase() === normOwner
    );
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("execution_mandates")
    .select("*")
    .eq("owner_wallet", normOwner)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Database error listing mandates: ${error.message}`);
  }

  return (data || []).map((row: any) => ({
    mandateId: row.mandate_id,
    ownerWallet: row.owner_wallet as `0x${string}`,
    subjectAgentId: row.subject_agent_id,
    subjectWallet: row.subject_wallet as `0x${string}`,
    mode: row.mode,
    network: row.network,
    allowedCapabilities: row.allowed_capabilities,
    allowedRails: row.allowed_rails,
    maxPerTransactionUsdc: Number(row.max_per_transaction_usdc),
    maxPerDayUsdc: Number(row.max_per_day_usdc),
    maxTotalUsdc: Number(row.max_total_usdc),
    minimumTrustScore: Number(row.minimum_trust_score),
    minimumConfidence: Number(row.minimum_confidence),
    requireVerifiedIdentity: row.require_verified_identity,
    evaluatorThresholdUsdc: Number(row.evaluator_threshold_usdc),
    canonicalHash: row.canonical_hash,
    signature: row.signature as `0x${string}`,
    nonce: Number(row.nonce),
    version: row.version,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }));
}

export async function revokeExecutionMandate(mandateId: string, ownerWallet: string): Promise<boolean> {
  const normOwner = ownerWallet.toLowerCase();
  if (isMemoryStoreAllowed()) {
    const existing = memoryMandateStore.get(mandateId);
    if (existing && existing.ownerWallet.toLowerCase() === normOwner) {
      existing.revokedAt = new Date().toISOString();
      memoryMandateStore.set(mandateId, existing);
      return true;
    }
    return false;
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("execution_mandates")
    .update({ revoked_at: new Date().toISOString() })
    .eq("mandate_id", mandateId)
    .eq("owner_wallet", normOwner)
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(`Database error revoking mandate: ${error.message}`);
  }

  return Boolean(data);
}

export async function saveExecutionAttempt(attempt: ExecutionAttempt): Promise<void> {
  if (isMemoryStoreAllowed()) {
    memoryAttemptStore.set(attempt.executionId, attempt);
    return;
  }

  const supabase = getByoaClient();
  const { error } = await supabase.from("execution_attempts").insert({
    execution_id: attempt.executionId,
    mandate_id: attempt.mandateId || null,
    selection_id: attempt.selectionId,
    clearance_id: attempt.clearanceId || null,
    rail: attempt.rail,
    counterparty_agent_id: attempt.counterpartyAgentId,
    counterparty_wallet: attempt.counterpartyWallet.toLowerCase(),
    capability: attempt.capability,
    requested_amount_usdc: attempt.requestedAmountUsdc,
    authorized_amount_usdc: attempt.authorizedAmountUsdc,
    actual_settled_amount_usdc: attempt.actualSettledAmountUsdc || null,
    state: attempt.state,
    failure_code: attempt.failureCode || null,
    create_tx: attempt.createTx || null,
    complete_tx: attempt.completeTx || null,
    payment_tx: attempt.paymentTx || null,
    evaluation_id: attempt.evaluationId || null,
    selection_hash: attempt.selectionHash,
    clearance_digest: attempt.clearanceDigest || null,
    evidence_hash: attempt.evidenceHash || null,
    idempotency_key: attempt.idempotencyKey || null,
    canonical_hash: attempt.canonicalHash,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt,
  });

  if (error) {
    throw new Error(`Database error saving execution attempt: ${error.message}`);
  }
}

export async function getExecutionAttempt(executionId: string): Promise<ExecutionAttempt | null> {
  if (isMemoryStoreAllowed()) {
    return memoryAttemptStore.get(executionId) || null;
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("execution_attempts")
    .select("*")
    .eq("execution_id", executionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Database error reading execution attempt: ${error.message}`);
  }

  if (!data) return null;

  return {
    executionId: data.execution_id,
    mandateId: data.mandate_id,
    selectionId: data.selection_id,
    clearanceId: data.clearance_id,
    rail: data.rail,
    counterpartyAgentId: data.counterparty_agent_id,
    counterpartyWallet: data.counterparty_wallet as `0x${string}`,
    capability: data.capability,
    requestedAmountUsdc: Number(data.requested_amount_usdc),
    authorizedAmountUsdc: Number(data.authorized_amount_usdc),
    actualSettledAmountUsdc: data.actual_settled_amount_usdc != null ? Number(data.actual_settled_amount_usdc) : null,
    state: data.state,
    failureCode: data.failure_code,
    createTx: data.create_tx,
    completeTx: data.complete_tx,
    paymentTx: data.payment_tx,
    evaluationId: data.evaluation_id,
    selectionHash: data.selection_hash,
    clearanceDigest: data.clearance_digest,
    evidenceHash: data.evidence_hash,
    idempotencyKey: data.idempotency_key,
    canonicalHash: data.canonical_hash,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export async function getExecutionAttemptByIdempotency(
  mandateId: string,
  idempotencyKey: string
): Promise<ExecutionAttempt | null> {
  if (isMemoryStoreAllowed()) {
    for (const att of memoryAttemptStore.values()) {
      if (att.mandateId === mandateId && att.idempotencyKey === idempotencyKey) {
        return att;
      }
    }
    return null;
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("execution_attempts")
    .select("*")
    .eq("mandate_id", mandateId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Database error reading idempotent execution attempt: ${error.message}`);
  }

  if (!data) return null;

  return {
    executionId: data.execution_id,
    mandateId: data.mandate_id,
    selectionId: data.selection_id,
    clearanceId: data.clearance_id,
    rail: data.rail,
    counterpartyAgentId: data.counterparty_agent_id,
    counterpartyWallet: data.counterparty_wallet as `0x${string}`,
    capability: data.capability,
    requestedAmountUsdc: Number(data.requested_amount_usdc),
    authorizedAmountUsdc: Number(data.authorized_amount_usdc),
    actualSettledAmountUsdc: data.actual_settled_amount_usdc != null ? Number(data.actual_settled_amount_usdc) : null,
    state: data.state,
    failureCode: data.failure_code,
    createTx: data.create_tx,
    completeTx: data.complete_tx,
    paymentTx: data.payment_tx,
    evaluationId: data.evaluation_id,
    selectionHash: data.selection_hash,
    clearanceDigest: data.clearance_digest,
    evidenceHash: data.evidence_hash,
    idempotencyKey: data.idempotency_key,
    canonicalHash: data.canonical_hash,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export async function updateExecutionAttemptState(
  executionId: string,
  targetState: ExecutionState,
  patch: Partial<ExecutionAttempt> = {}
): Promise<void> {
  const current = await getExecutionAttempt(executionId);
  if (!current) {
    throw new Error(`Execution attempt ${executionId} not found`);
  }

  // Validate state machine transition
  validateStateTransition(current.state, targetState, executionId);

  const updated: ExecutionAttempt = {
    ...current,
    ...patch,
    state: targetState,
    updatedAt: new Date().toISOString(),
  };

  if (isMemoryStoreAllowed()) {
    memoryAttemptStore.set(executionId, updated);
    return;
  }

  const supabase = getByoaClient();
  const updatePayload: Record<string, any> = {
    state: targetState,
    updated_at: updated.updatedAt,
  };

  if (patch.actualSettledAmountUsdc !== undefined) {
    updatePayload.actual_settled_amount_usdc = patch.actualSettledAmountUsdc;
  }
  if (patch.failureCode !== undefined) {
    updatePayload.failure_code = patch.failureCode;
  }
  if (patch.createTx !== undefined) {
    updatePayload.create_tx = patch.createTx;
  }
  if (patch.completeTx !== undefined) {
    updatePayload.complete_tx = patch.completeTx;
  }
  if (patch.paymentTx !== undefined) {
    updatePayload.payment_tx = patch.paymentTx;
  }
  if (patch.evaluationId !== undefined) {
    updatePayload.evaluation_id = patch.evaluationId;
  }
  if (patch.clearanceDigest !== undefined) {
    updatePayload.clearance_digest = patch.clearanceDigest;
  }
  if (patch.evidenceHash !== undefined) {
    updatePayload.evidence_hash = patch.evidenceHash;
  }

  const { error } = await supabase
    .from("execution_attempts")
    .update(updatePayload)
    .eq("execution_id", executionId);

  if (error) {
    throw new Error(`Database error updating execution attempt state: ${error.message}`);
  }
}

/**
 * Atomically reserves budget for a mandate via stored procedure or memory manager.
 */
export async function reserveBudgetAtomic(
  mandateId: string,
  amountUsdc: number,
  period: BudgetPeriod
): Promise<BudgetReservationResult> {
  const mandate = await getExecutionMandate(mandateId);
  if (!mandate) {
    return { success: false, reason: "MANDATE_NOT_FOUND" };
  }

  if (isMemoryStoreAllowed()) {
    const usage = memoryUsageStore.get(mandateId) || { used: 0, reserved: 0, totalUsed: 0, totalReserved: 0 };
    if (amountUsdc > mandate.maxPerTransactionUsdc) {
      return { success: false, reason: "PER_TRANSACTION_CAP_EXCEEDED" };
    }
    if (usage.totalUsed + usage.totalReserved + amountUsdc > mandate.maxTotalUsdc) {
      return { success: false, reason: "MAX_TOTAL_CAP_EXCEEDED" };
    }
    if (usage.used + usage.reserved + amountUsdc > mandate.maxPerDayUsdc) {
      return { success: false, reason: "DAILY_CAP_EXCEEDED" };
    }

    usage.reserved += amountUsdc;
    usage.totalReserved += amountUsdc;
    memoryUsageStore.set(mandateId, usage);

    return {
      success: true,
      reservedAmount: amountUsdc,
      remainingDaily: mandate.maxPerDayUsdc - (usage.used + usage.reserved),
      remainingTotal: mandate.maxTotalUsdc - (usage.totalUsed + usage.totalReserved),
    };
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase.rpc("reserve_mandate_budget", {
    p_mandate_id: mandateId,
    p_amount_usdc: amountUsdc,
    p_period_start: period.periodStart,
    p_period_end: period.periodEnd,
  });

  if (error) {
    throw new Error(`Database RPC error reserving budget: ${error.message}`);
  }

  const result = data as any;
  if (!result?.success) {
    return {
      success: false,
      reason: result?.reason || "BUDGET_RESERVATION_REJECTED",
    };
  }

  return {
    success: true,
    reservedAmount: Number(result.reserved_amount),
    remainingDaily: Number(result.remaining_daily),
    remainingTotal: Number(result.remaining_total),
  };
}

/**
 * Atomically releases reserved budget if execution fails before irreversible action.
 */
export async function releaseBudgetAtomic(
  mandateId: string,
  amountUsdc: number,
  periodStart: string
): Promise<boolean> {
  if (isMemoryStoreAllowed()) {
    const usage = memoryUsageStore.get(mandateId);
    if (usage) {
      usage.reserved = Math.max(0, usage.reserved - amountUsdc);
      usage.totalReserved = Math.max(0, usage.totalReserved - amountUsdc);
      memoryUsageStore.set(mandateId, usage);
    }
    return true;
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase.rpc("release_mandate_budget", {
    p_mandate_id: mandateId,
    p_amount_usdc: amountUsdc,
    p_period_start: periodStart,
  });

  if (error) {
    throw new Error(`Database RPC error releasing budget: ${error.message}`);
  }

  return Boolean((data as any)?.success);
}

/**
 * Atomically settles reserved budget into used budget upon verified terminal execution.
 */
export async function settleBudgetAtomic(
  mandateId: string,
  reservedAmountUsdc: number,
  settledAmountUsdc: number,
  periodStart: string
): Promise<boolean> {
  if (isMemoryStoreAllowed()) {
    const usage = memoryUsageStore.get(mandateId);
    if (usage) {
      usage.reserved = Math.max(0, usage.reserved - reservedAmountUsdc);
      usage.totalReserved = Math.max(0, usage.totalReserved - reservedAmountUsdc);
      usage.used += settledAmountUsdc;
      usage.totalUsed += settledAmountUsdc;
      memoryUsageStore.set(mandateId, usage);
    }
    return true;
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase.rpc("settle_mandate_budget", {
    p_mandate_id: mandateId,
    p_reserved_amount_usdc: reservedAmountUsdc,
    p_settled_amount_usdc: settledAmountUsdc,
    p_period_start: periodStart,
  });

  if (error) {
    throw new Error(`Database RPC error settling budget: ${error.message}`);
  }

  return Boolean((data as any)?.success);
}
