/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { computeCanonicalExecutionHash } from "./canonical.ts";
import { saveExecutionAttempt, updateExecutionAttemptState } from "./db.ts";
import type { ExecutionAttempt, ExecutionState, X402ReconciliationContext } from "./types.ts";
import type { PostCallVerification } from "../x402/post-call-verification.ts";

/**
 * Puts the browser purchase into the same ledger every other execution lives in.
 *
 * The decision log was empty on a deployment that had really signed decisions
 * and really settled payments, because the browser flow returned a result to
 * the screen and told nobody. A decision nobody recorded is not auditable, and
 * an audit trail with a hole in it is worse than one that is merely short.
 *
 * Two calls: one when the user signs (the authorization exists from that moment,
 * whatever happens next), one when the outcome is known.
 */

export const BROWSER_X402_MANDATE_ID = null;

export async function openBrowserX402Attempt(input: {
  selectionId: string;
  selectionHash: string;
  clearanceDigest: string | null;
  counterpartyAgentId: string;
  counterpartyWallet: `0x${string}`;
  capability: string;
  resource: string;
  quotedUsdc: number;
  authorizedUsdc: number;
  payerWallet: `0x${string}`;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  network: string;
  authorizedAtomic: string;
  authorizationNonce: string;
  authorizationSignature: `0x${string}`;
  authorizationValidBefore: number;
}): Promise<string | null> {
  const executionId = `vexec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const attempt: ExecutionAttempt = {
    executionId,
    mandateId: BROWSER_X402_MANDATE_ID,
    selectionId: input.selectionId,
    clearanceId: input.clearanceDigest,
    rail: "x402",
    counterpartyAgentId: input.counterpartyAgentId,
    counterpartyWallet: input.counterpartyWallet,
    capability: input.capability,
    requestedAmountUsdc: input.quotedUsdc,
    authorizedAmountUsdc: input.authorizedUsdc,
    // The signature exists; the money has not moved yet.
    state: "AUTHORIZED",
    selectionHash: input.selectionHash,
    clearanceDigest: input.clearanceDigest,
    /* Filled completely on purpose: this is what lets the existing reconcile
       route verify the settlement against Arc later, independently of whatever
       the seller said in its response. */
    x402Context: {
      payerWallet: input.payerWallet,
      payTo: input.payTo,
      asset: input.asset,
      network: input.network,
      authorizedAmountUsdc: input.authorizedUsdc,
      authorizedAmountAtomic: input.authorizedAtomic,
      authorizationNonce: input.authorizationNonce,
      authorizationSignature: input.authorizationSignature,
      authorizationValidBefore: input.authorizationValidBefore,
      resource: input.resource,
      requestTimestamp: now,
    } satisfies X402ReconciliationContext,
    canonicalHash: "",
    createdAt: now,
    updatedAt: now,
  };

  attempt.canonicalHash = computeCanonicalExecutionHash({
    executionId,
    mandateId: null,
    selectionId: input.selectionId,
    selectionHash: input.selectionHash,
    rail: "x402",
    counterpartyAgentId: input.counterpartyAgentId,
    counterpartyWallet: input.counterpartyWallet,
    capability: input.capability,
    requestedAmountUsdc: input.quotedUsdc,
    authorizedAmountUsdc: input.authorizedUsdc,
    clearanceDigest: input.clearanceDigest,
    createdAt: now,
  });

  try {
    await saveExecutionAttempt(attempt);
    return executionId;
  } catch (error) {
    // A ledger that is down must not stop a purchase the user already signed
    // for. The gap is reported, not hidden, and never turned into a refusal.
    console.warn("execution_attempt_not_opened", {
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
    return null;
  }
}

/**
 * The terminal state, decided by what actually happened rather than by whether
 * the HTTP call returned. A response that was paid for and failed its required
 * verification lands in SETTLED_SERVICE_FAILED — money gone, goods not proven —
 * which is a distinct and much more useful fact than "completed".
 */
export function terminalStateFor(input: {
  paid: boolean;
  httpOk: boolean;
  verification: PostCallVerification | null;
}): { state: ExecutionState; failureCode: string | null } {
  if (!input.paid) return { state: "REJECTED", failureCode: "payment_rejected" };
  if (!input.httpOk) return { state: "SETTLED_SERVICE_FAILED", failureCode: "endpoint_error_after_payment" };
  if (input.verification?.verdict === "FAIL") {
    return {
      state: "SETTLED_SERVICE_FAILED",
      failureCode: input.verification.checks.find((check) => check.passed === false)?.id
        ?? "post_call_verification_failed",
    };
  }
  if (input.verification?.verdict === "INCONCLUSIVE") {
    return { state: "COMPLETED_UNPROVEN", failureCode: null };
  }
  return { state: "COMPLETED", failureCode: null };
}

export async function closeBrowserX402Attempt(input: {
  executionId: string | null;
  paid: boolean;
  httpOk: boolean;
  paidUsdc: number;
  transaction: string | null;
  verification: PostCallVerification | null;
}): Promise<void> {
  if (!input.executionId) return;
  const { state, failureCode } = terminalStateFor(input);
  try {
    await updateExecutionAttemptState(input.executionId, state, {
      actualSettledAmountUsdc: input.paid ? input.paidUsdc : 0,
      paymentTx: input.transaction,
      failureCode,
      evidenceHash: input.verification?.responseHash ?? null,
    });
  } catch (error) {
    console.warn("execution_attempt_not_closed", {
      executionId: input.executionId,
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
  }
}
