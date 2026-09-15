/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecutionAttempt } from "./types.ts";

/**
 * What an execution attempt looks like to somebody who is not its owner.
 *
 * The public ledger is the product. Veyra's claim is that a purchase can be
 * checked afterwards by a stranger -- who was paid, on which chain, for how
 * much, against which decision -- so these routes stay open and this view keeps
 * every fact that makes that checkable. What it drops is the material that is
 * not evidence but permission.
 *
 * The distinction was not being drawn at all. GET /api/execution/v1 took an
 * arbitrary counterparty filter, required no authentication, and returned the
 * stored model whole. Measured against the deployed app: five rows, five
 * `authorizationSignature` values, and among them a signed EIP-3009
 * authorization for USDC on Ethereum mainnet -- `paymentTx` null, so never
 * consumed, and `authorizationValidBefore` still open for another five days.
 * $0.012, and the payee is fixed by the signature, so the loss is bounded and
 * the recipient cannot be changed. The mechanism is not bounded by anything.
 *
 * Built as an allowlist, and that is the point rather than a style. A denylist
 * leaks every field added after it was written, and the field that leaked here
 * was added to a context object years after the route was.
 */
export type PublicExecutionView = {
  executionId: string;
  mandateId: string | null;
  selectionId: string;
  clearanceId: string | null;
  clearanceDigest: string | null;
  rail: ExecutionAttempt["rail"];
  state: ExecutionAttempt["state"];
  capability: string;
  counterpartyAgentId: string;
  counterpartyWallet: string;
  requestedAmountUsdc: number;
  authorizedAmountUsdc: number;
  actualSettledAmountUsdc: number;
  failureCode: string | null;
  createTx: string | null;
  paymentTx: string | null;
  completeTx: string | null;
  evaluationId: string | null;
  selectionHash: string;
  evidenceHash: string | null;
  providerContentUri: string | null;
  providerContentHash: string | null;
  providerContentType: string | null;
  providerSubmittedAt: string | null;
  canonicalHash: string | null;
  createdAt: string;
  updatedAt: string;
  /** The payment as a reader can check it, without the part that spends it. */
  x402: {
    payerWallet: string;
    payTo: string;
    asset: string;
    network: string;
    authorizedAmountUsdc: number;
    authorizedAmountAtomic: string | null;
    authorizationValidBefore: number | null;
    resource: string | null;
    paymentRequirementsHash: string | null;
    facilitatorReference: string | null;
    requestTimestamp: string;
  } | null;
};

export function publicExecutionView(attempt: ExecutionAttempt): PublicExecutionView {
  const x402 = attempt.x402Context ?? null;
  return {
    executionId: attempt.executionId,
    mandateId: attempt.mandateId ?? null,
    selectionId: attempt.selectionId,
    clearanceId: attempt.clearanceId ?? null,
    /* The digest and not the payload. A clearance is a bearer permission: its
       signature is what an executor presents to consumeClearance, and that call
       is one-shot only once somebody has made it. The digest is the anchor a
       reader needs to check the decision against; the signature is the thing
       that acts on it. */
    clearanceDigest: attempt.clearanceDigest ?? null,
    rail: attempt.rail,
    state: attempt.state,
    capability: attempt.capability,
    counterpartyAgentId: attempt.counterpartyAgentId,
    counterpartyWallet: attempt.counterpartyWallet,
    requestedAmountUsdc: attempt.requestedAmountUsdc,
    authorizedAmountUsdc: attempt.authorizedAmountUsdc,
    actualSettledAmountUsdc: attempt.actualSettledAmountUsdc ?? 0,
    failureCode: attempt.failureCode ?? null,
    createTx: attempt.createTx ?? null,
    paymentTx: attempt.paymentTx ?? null,
    completeTx: attempt.completeTx ?? null,
    evaluationId: attempt.evaluationId ?? null,
    selectionHash: attempt.selectionHash,
    evidenceHash: attempt.evidenceHash ?? null,
    providerContentUri: attempt.providerContentUri ?? null,
    providerContentHash: attempt.providerContentHash ?? null,
    providerContentType: attempt.providerContentType ?? null,
    providerSubmittedAt: attempt.providerSubmittedAt ?? null,
    canonicalHash: attempt.canonicalHash ?? null,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    x402: x402
      ? {
          payerWallet: x402.payerWallet,
          payTo: x402.payTo,
          asset: x402.asset,
          network: x402.network,
          authorizedAmountUsdc: x402.authorizedAmountUsdc,
          authorizedAmountAtomic: x402.authorizedAmountAtomic == null
            ? null
            : String(x402.authorizedAmountAtomic),
          /* Kept, because when an authorization expires is a fact about the
             record and not a way to use it. The signature and the nonce are
             the tuple that spends it, and neither appears above. */
          authorizationValidBefore: x402.authorizationValidBefore ?? null,
          resource: x402.resource ?? null,
          paymentRequirementsHash: x402.paymentRequirementsHash ?? null,
          facilitatorReference: x402.facilitatorReference ?? null,
          requestTimestamp: x402.requestTimestamp,
        }
      : null,
  };
}
