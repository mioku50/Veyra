/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { terminalStateFor, type BrowserX402Outcome } from "../lib/execution/browser-x402-ledger.ts";
import { ALLOWED_TRANSITIONS, validateStateTransition } from "../lib/execution/state-machine.ts";
import type { ExecutionState } from "../lib/execution/types.ts";
import type { PostCallVerification } from "../lib/x402/post-call-verification.ts";

function verification(verdict: PostCallVerification["verdict"], failed?: string): PostCallVerification {
  return {
    verdict,
    required: true,
    summary: "",
    responseHash: `0x${"1".repeat(64)}`,
    verifiedAt: "2026-09-13T12:00:00.000Z",
    checks: failed ? [{ id: failed, passed: false, severity: "critical", detail: "" }] : [],
  };
}

/* ---- the mapping ---- */

const paid = { settlementSuccess: true as const, httpOk: true };

assert.deepEqual(
  terminalStateFor({ ...paid, verification: verification("PASS") }),
  { state: "COMPLETED", failureCode: null },
);

// Paid, answered, and the answer did not hold up: money gone, goods unproven.
assert.deepEqual(
  terminalStateFor({ ...paid, verification: verification("FAIL", "response_is_not_an_error") }),
  { state: "SETTLED_SERVICE_FAILED", failureCode: "response_is_not_an_error" },
);

assert.deepEqual(
  terminalStateFor({ ...paid, verification: verification("INCONCLUSIVE") }),
  { state: "COMPLETED_UNPROVEN", failureCode: null },
);

// Settled, then the seller failed in its own application layer. Reading payment
// off the HTTP status would have lost this money from the record.
assert.deepEqual(
  terminalStateFor({ settlementSuccess: true, httpOk: false, verification: null }),
  { state: "SETTLED_SERVICE_FAILED", failureCode: "endpoint_error_after_payment" },
);

// The seller refused the signed payment.
assert.equal(
  terminalStateFor({ settlementSuccess: false, httpOk: false, verification: null }).state,
  "SETTLEMENT_FAILED",
);
assert.equal(
  terminalStateFor({ paymentRefused: true, settlementSuccess: null, httpOk: false, verification: null }).state,
  "SETTLEMENT_FAILED",
);

/* No receipt at all: Veyra will not claim the money moved, and will not claim it
   did not. This holds even when the endpoint then answered with an error - a
   live purchase returned HTTP 400 with no receipt, and recording that as FAILED
   would have asserted the wallet was untouched, which nobody could see. Once the
   PAYMENT-SIGNATURE header leaves, the authorization nonce may already be spent.
   Non-terminal on purpose: the reconcile route resolves it against Arc. */
assert.deepEqual(
  terminalStateFor({ settlementSuccess: null, httpOk: true, verification: verification("INCONCLUSIVE") }),
  { state: "SETTLEMENT_UNVERIFIED", failureCode: null },
);
assert.equal(
  terminalStateFor({ settlementSuccess: null, httpOk: false, verification: verification("FAIL", "response_delivered") }).state,
  "SETTLEMENT_UNVERIFIED",
  "an error answer with no receipt still leaves the charge unknown",
);

// Only a relay that never left asserts nothing was spent.
assert.equal(
  terminalStateFor({ relayFailed: true, settlementSuccess: null, httpOk: false, verification: null }).state,
  "FAILED",
);

// The relay never came back.
assert.equal(
  terminalStateFor({ relayFailed: true, settlementSuccess: null, httpOk: false, verification: null }).state,
  "FAILED",
);

// A FAIL with no named critical check still records a reason rather than null.
assert.equal(
  terminalStateFor({ ...paid, verification: verification("FAIL") }).failureCode,
  "post_call_verification_failed",
);

/* ---- the transitions, against the real state machine ----
   This is the part that was missing. The mapping was right and the lifecycle
   rejected it: AUTHORIZED reaches only EXECUTING, CANCELLED, EXPIRED and
   REJECTED, so every success state here threw and was swallowed into a warning,
   stranding the ledger at AUTHORIZED. Only a funded purchase would have shown
   it, because the refusal path happened to be legal. */

const OUTCOMES: BrowserX402Outcome[] = [
  { ...paid, verification: verification("PASS") },
  { ...paid, verification: verification("FAIL", "response_non_empty") },
  { ...paid, verification: verification("INCONCLUSIVE") },
  { settlementSuccess: true, httpOk: false, verification: null },
  { settlementSuccess: false, httpOk: false, verification: null },
  { settlementSuccess: null, httpOk: true, verification: null },
  { settlementSuccess: null, httpOk: false, verification: null },
  { relayFailed: true, settlementSuccess: null, httpOk: false, verification: null },
  { paymentRefused: true, settlementSuccess: null, httpOk: false, verification: null },
];

// The one legal step out of AUTHORIZED that the purchase path takes.
validateStateTransition("AUTHORIZED", "EXECUTING", "vexec_test");

for (const outcome of OUTCOMES) {
  const { state } = terminalStateFor(outcome);
  // Every state the purchase path can close into must be reachable from
  // EXECUTING, or the close silently fails and the record is stranded.
  validateStateTransition("EXECUTING", state, "vexec_test");
  assert.ok(
    ALLOWED_TRANSITIONS.EXECUTING.includes(state),
    `EXECUTING must allow ${state}`,
  );
}

// And the regression itself: closing straight out of AUTHORIZED must still be
// rejected, so nobody reintroduces the shortcut.
for (const state of ["COMPLETED", "COMPLETED_UNPROVEN", "SETTLED_SERVICE_FAILED", "SETTLEMENT_UNVERIFIED"] as ExecutionState[]) {
  assert.throws(
    () => validateStateTransition("AUTHORIZED", state, "vexec_test"),
    /Invalid execution state transition/,
    `AUTHORIZED must not reach ${state} directly`,
  );
}

console.log("[execution-ledger-test] passed: settlement receipt separated from delivery, terminal mapping, and every closing state reachable from EXECUTING under the real state machine");

/* ---- the full round trip, through the real store and the real validator ----
   The mapping test above proves the intent; this proves the lifecycle actually
   accepts it. It runs against the in-memory store so it needs no credentials,
   but it goes through the same updateExecutionAttemptState - and therefore the
   same validateStateTransition - that production uses. */

process.env.NODE_ENV = "test";
process.env.EXECUTION_ALLOW_MEMORY_STORE = "true";

const ledger = await import("../lib/execution/browser-x402-ledger.ts");
const db = await import("../lib/execution/db.ts");

assert.equal(db.isMemoryStoreAllowed(), true, "the round trip needs the memory store");

async function roundTrip(outcome: BrowserX402Outcome) {
  const executionId = await ledger.openBrowserX402Attempt({
    selectionId: "vms_roundtrip",
    selectionHash: "0x",
    clearanceDigest: null,
    counterpartyAgentId: "x402:example.test",
    counterpartyWallet: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192",
    capability: "web_research",
    resource: "https://example.test/search",
    quotedUsdc: 0.002,
    authorizedUsdc: 0.002,
    payerWallet: "0x9b57000000000000000000000000000000003dad",
    payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    network: "eip155:8453",
    authorizedAtomic: "2000",
    authorizationNonce: `0x${"11".repeat(32)}`,
    authorizationSignature: `0x${"22".repeat(65)}`,
    authorizationValidBefore: Math.floor(Date.now() / 1000) + 600,
  });
  assert.ok(executionId, "the attempt must be created");
  assert.equal((await db.getExecutionAttempt(executionId!))?.state, "AUTHORIZED");

  await ledger.markBrowserX402Executing(executionId);
  assert.equal((await db.getExecutionAttempt(executionId!))?.state, "EXECUTING");

  await ledger.closeBrowserX402Attempt({
    ...outcome,
    executionId,
    paidUsdc: 0.002,
    transaction: "0xdeadbeef",
  });
  return (await db.getExecutionAttempt(executionId!))!;
}

const completed = await roundTrip({ ...paid, verification: verification("PASS") });
assert.equal(completed.state, "COMPLETED", "a funded success must actually reach COMPLETED");
assert.equal(completed.actualSettledAmountUsdc, 0.002);
assert.equal(completed.paymentTx, "0xdeadbeef");
// The reconciliation context has to survive, or settlement can never be
// independently verified against Arc afterwards.
assert.equal(completed.x402Context?.payerWallet, "0x9b57000000000000000000000000000000003dad");
assert.equal(completed.x402Context?.authorizedAmountAtomic, "2000");

const serviceFailed = await roundTrip({ ...paid, verification: verification("FAIL", "response_non_empty") });
assert.equal(serviceFailed.state, "SETTLED_SERVICE_FAILED");
assert.equal(serviceFailed.failureCode, "response_non_empty");
// Money moved even though the goods did not: the record must say so.
assert.equal(serviceFailed.actualSettledAmountUsdc, 0.002);

const refused = await roundTrip({ paymentRefused: true, settlementSuccess: false, httpOk: false, verification: null });
assert.equal(refused.state, "SETTLEMENT_FAILED");
assert.equal(refused.actualSettledAmountUsdc, 0, "a refused payment must not be recorded as settled");

const unverified = await roundTrip({ settlementSuccess: null, httpOk: true, verification: null });
assert.equal(unverified.state, "SETTLEMENT_UNVERIFIED");
assert.equal(unverified.actualSettledAmountUsdc, 0, "an unproven payment is not a settled amount");

console.log("[execution-ledger-test] passed: full AUTHORIZED -> EXECUTING -> terminal round trip through the real store, for settled, service-failed, refused and unverifiable purchases");
