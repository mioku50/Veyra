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
 * Moves the attempt into EXECUTING before the relay leaves.
 *
 * The state machine allows AUTHORIZED to reach only EXECUTING, CANCELLED,
 * EXPIRED or REJECTED — terminal success states are reachable only from
 * EXECUTING. Closing straight out of AUTHORIZED therefore threw, and because
 * the close swallows its errors the ledger would have been stranded at
 * AUTHORIZED forever on the first successful purchase. The refusal path
 * happened to work (REJECTED is legal from AUTHORIZED), which is exactly why
 * nothing caught it until a funded success was attempted.
 */
export async function markBrowserX402Executing(executionId: string | null): Promise<void> {
  if (!executionId) return;
  try {
    await updateExecutionAttemptState(executionId, "EXECUTING", {});
  } catch (error) {
    console.warn("execution_attempt_not_marked_executing", {
      executionId,
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
  }
}

export type BrowserX402Outcome = {
  /** The seller's settlement receipt: true settled, false refused, null silent.
   *  Null is not a failure — Circle's batched rail legitimately defers the
   *  onchain reference — but it is not proof of payment either. */
  settlementSuccess: boolean | null;
  /** Whether the goods came back. Separate from payment on purpose: a seller
   *  can settle the x402 authorization and then fail in its own application
   *  layer, and calling that "not paid" would lose the money in the record. */
  httpOk: boolean;
  /** The seller answered the payment itself with another 402. */
  paymentRefused?: boolean;
  /** The relay never completed: nothing is known about the money. */
  relayFailed?: boolean;
  verification: PostCallVerification | null;
};

/**
 * The terminal state, decided by what actually happened rather than by whether
 * the HTTP call returned.
 *
 * Money moved is read from the settlement receipt, never from the HTTP status.
 * A response that was paid for and failed its required verification lands in
 * SETTLED_SERVICE_FAILED — money gone, goods not proven — which is a distinct
 * and far more useful fact than "completed". A payment Veyra cannot prove
 * either way lands in SETTLEMENT_UNVERIFIED, which is not terminal: the
 * reconciliation route resolves it against Arc from the context recorded above.
 */
export function terminalStateFor(input: BrowserX402Outcome): {
  state: ExecutionState;
  failureCode: string | null;
} {
  if (input.relayFailed) {
    return { state: "FAILED", failureCode: "relay_failed" };
  }
  if (input.paymentRefused || input.settlementSuccess === false) {
    return { state: "SETTLEMENT_FAILED", failureCode: "payment_rejected_by_seller" };
  }
  if (input.settlementSuccess === null) {
    /* No receipt. Once the PAYMENT-SIGNATURE header leaves this server the
       authorization nonce may already have been consumed, and that is true
       whether or not the seller then answered with an error. Recording FAILED
       would assert no money moved, which Veyra cannot see. SETTLEMENT_UNVERIFIED
       is not terminal: the reconciliation route resolves it against Arc from the
       nonce and signature stored with the attempt. */
    return { state: "SETTLEMENT_UNVERIFIED", failureCode: null };
  }
  if (!input.httpOk) {
    return { state: "SETTLED_SERVICE_FAILED", failureCode: "endpoint_error_after_payment" };
  }
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

export async function closeBrowserX402Attempt(input: BrowserX402Outcome & {
  executionId: string | null;
  paidUsdc: number;
  transaction: string | null;
}): Promise<{ state: ExecutionState; failureCode: string | null } | null> {
  if (!input.executionId) return null;
  const outcome = terminalStateFor(input);
  try {
    await updateExecutionAttemptState(input.executionId, outcome.state, {
      actualSettledAmountUsdc: input.settlementSuccess === true ? input.paidUsdc : 0,
      paymentTx: input.transaction,
      failureCode: outcome.failureCode,
      evidenceHash: input.verification?.responseHash ?? null,
    });
  } catch (error) {
    /* Non-fatal on purpose: a ledger that is down must not strand a purchase
       the user already signed for. But the name alone said "Error", which is
       what a constraint violation and an illegal transition both report, and
       the row it failed to close was the one holding a real payment. The
       message is what tells the two apart without a forensic session. */
    console.warn("execution_attempt_not_closed", {
      executionId: input.executionId,
      targetState: outcome.state,
      errorName: error instanceof Error ? error.name : "unknown_error",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
  }
  return outcome;
}
