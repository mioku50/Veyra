/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { terminalStateFor, type BrowserX402Outcome } from "../lib/execution/browser-x402-ledger.ts";
import { classifyRelayFailure } from "../lib/execution/relay-failure.ts";
import { chainForNetwork } from "../lib/execution/settlement-resolver.ts";
import { ALLOWED_TRANSITIONS, validateStateTransition } from "../lib/execution/state-machine.ts";
import type { ExecutionAttempt, ExecutionState } from "../lib/execution/types.ts";
import { publicExecutionView } from "../lib/execution/public-view.ts";
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

/* A 402 is what the seller says, not what the chain shows.
 *
 * This used to be "SETTLEMENT_FAILED, nothing was transferred" on the strength
 * of the refusal alone -- which a seller that had already redeemed the
 * authorization could produce for free, and the money would leave the record.
 * The refusal is now graded by the token's own authorization bit. */
assert.deepEqual(
  terminalStateFor({ paymentRefused: true, authorizationUsed: false, settlementSuccess: false, httpOk: false, verification: null }),
  { state: "SETTLEMENT_FAILED", failureCode: "payment_rejected_by_seller" },
  "unspent authorization: the refusal is real and now provable",
);
assert.deepEqual(
  terminalStateFor({ paymentRefused: true, authorizationUsed: true, settlementSuccess: true, httpOk: false, verification: null }),
  { state: "SETTLED_SERVICE_FAILED", failureCode: "payment_taken_then_refused" },
  "a seller that took the money and then said no must not read as not paid",
);
assert.equal(
  terminalStateFor({ paymentRefused: true, authorizationUsed: null, settlementSuccess: null, httpOk: false, verification: null }).state,
  "SETTLEMENT_UNVERIFIED",
  "an unreadable chain is not a refusal",
);
assert.equal(
  terminalStateFor({ paymentRefused: true, settlementSuccess: null, httpOk: false, verification: null }).state,
  "SETTLEMENT_UNVERIFIED",
  "and neither is not having asked",
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

/* Only a relay that never left asserts nothing was spent.
 *
 * Both halves of this used to be FAILED. A hostname that does not resolve and
 * a socket that died waiting for the response are not the same event: in the
 * second the PAYMENT-SIGNATURE header, and the redeemable nonce inside it, has
 * already reached the seller. */
assert.deepEqual(
  terminalStateFor({ relayFailure: "not_dispatched", settlementSuccess: null, httpOk: false, verification: null }),
  { state: "FAILED", failureCode: "relay_not_dispatched" },
);
assert.equal(
  terminalStateFor({ relayFailure: "possibly_dispatched", settlementSuccess: null, httpOk: false, verification: null }).state,
  "SETTLEMENT_UNVERIFIED",
  "a lost response is not evidence that nothing was paid",
);

/* ---- where in the call it broke ---- */

assert.equal(classifyRelayFailure({ name: "SSRFProtectionError" }), "not_dispatched");
for (const code of ["ENOTFOUND", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"]) {
  assert.equal(
    classifyRelayFailure(new TypeError("fetch failed", { cause: { code } })),
    "not_dispatched",
    `${code} happens before any byte is written`,
  );
}
for (const code of ["ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "EPIPE"]) {
  assert.equal(
    classifyRelayFailure(new TypeError("fetch failed", { cause: { code } })),
    "possibly_dispatched",
    `${code} can happen with the request already on the wire`,
  );
}
assert.equal(
  classifyRelayFailure(new Error("something nobody has seen before")),
  "possibly_dispatched",
  "unknown means unknown, and unknown must not release a reservation",
);
// fetch buries the real reason, sometimes more than one level down.
assert.equal(
  classifyRelayFailure(new TypeError("fetch failed", { cause: new Error("x", { cause: { code: "ENOTFOUND" } }) })),
  "not_dispatched",
);

/* ---- and on which chain to go looking ----
   The resolver was hardcoded to Arc while the browser relay settles on Base, so
   a Base payment needing reconciliation was searched for on a chain it had
   never touched, found nothing, and stayed unresolved with its budget held. */
assert.equal(chainForNetwork("eip155:8453")?.id, 8453);
assert.equal(chainForNetwork("eip155:1")?.id, 1);
assert.equal(chainForNetwork("eip155:5042002")?.id, 5042002);
assert.equal(chainForNetwork(null)?.id, 5042002, "an attempt older than the field is an Arc one");
assert.equal(chainForNetwork("eip155:999999"), null, "guessing the chain is how you prove the wrong thing");

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
  { relayFailure: "not_dispatched", settlementSuccess: null, httpOk: false, verification: null },
  { relayFailure: "possibly_dispatched", settlementSuccess: null, httpOk: false, verification: null },
  { paymentRefused: true, settlementSuccess: null, httpOk: false, verification: null },
  { paymentRefused: true, authorizationUsed: false, settlementSuccess: false, httpOk: false, verification: null },
  { paymentRefused: true, authorizationUsed: true, settlementSuccess: true, httpOk: false, verification: null },
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

async function roundTrip(outcome: BrowserX402Outcome, rail?: { gatewayBatched: boolean; verifyingContract: `0x${string}` }) {
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
    gatewayBatched: rail?.gatewayBatched,
    verifyingContract: rail?.verifyingContract,
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
/* Which rail the signature belonged to, written down at the moment it is still
   known. Reconciliation runs hours later from this row alone, and asking the
   token about a batched nonce gets a confident, permanent, wrong "unspent". */
assert.equal(completed.x402Context?.gatewayBatched, false);

const batched = await roundTrip(
  { ...paid, verification: verification("PASS") },
  { gatewayBatched: true, verifyingContract: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE" },
);
assert.equal(batched.x402Context?.gatewayBatched, true);
assert.equal(
  batched.x402Context?.authorizationVerifyingContract,
  "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
  "the GatewayWallet, not the token -- the evidence for the flag beside it",
);

const serviceFailed = await roundTrip({ ...paid, verification: verification("FAIL", "response_non_empty") });
assert.equal(serviceFailed.state, "SETTLED_SERVICE_FAILED");
assert.equal(serviceFailed.failureCode, "response_non_empty");
// Money moved even though the goods did not: the record must say so.
assert.equal(serviceFailed.actualSettledAmountUsdc, 0.002);

const refused = await roundTrip({
  paymentRefused: true, authorizationUsed: false, settlementSuccess: false, httpOk: false, verification: null,
});
assert.equal(refused.state, "SETTLEMENT_FAILED");
assert.equal(refused.actualSettledAmountUsdc, 0, "a refused payment must not be recorded as settled");

/* The same 402 from a seller that had already redeemed the authorization. The
   only difference is what the token said, and it is the difference between a
   refund and a loss. */
const takenThenRefused = await roundTrip({
  paymentRefused: true, authorizationUsed: true, settlementSuccess: true, httpOk: false, verification: null,
});
assert.equal(takenThenRefused.state, "SETTLED_SERVICE_FAILED");
assert.equal(takenThenRefused.failureCode, "payment_taken_then_refused");
assert.equal(takenThenRefused.actualSettledAmountUsdc, 0.002, "money the seller took must appear in the record");

/* And the lost response: the relay broke after the header left. */
const lost = await roundTrip({
  relayFailure: "possibly_dispatched", settlementSuccess: null, httpOk: false, verification: null,
});
assert.equal(lost.state, "SETTLEMENT_UNVERIFIED", "a lost response leaves the charge open, not closed");

const unverified = await roundTrip({ settlementSuccess: null, httpOk: true, verification: null });
assert.equal(unverified.state, "SETTLEMENT_UNVERIFIED");
assert.equal(unverified.actualSettledAmountUsdc, 0, "an unproven payment is not a settled amount");

console.log("[execution-ledger-test] passed: full AUTHORIZED -> EXECUTING -> terminal round trip through the real store, for settled, service-failed, refused and unverifiable purchases");

/* ---- the store the states are actually written to ---- */

/* Every assertion above this line runs against the in-memory store, which
   accepts any string. The database does not: execution_attempts.state carries a
   CHECK, and for five states it did not carry them. All five describe a moment
   after the money left -- SETTLED_SERVICE_FAILED among them -- so the ledger
   could record every way a purchase fails before paying and no way it fails
   after. The write is deliberately non-fatal, so nothing surfaced; the row for
   the first payment this product ever settled just stayed at EXECUTING.

   Comparing the union against the schema is the check that would have caught
   it, and it costs a file read. */

const migrations = await import("node:fs/promises");
const migrationDir = new URL("../supabase/migrations/", import.meta.url);
const files = (await migrations.readdir(migrationDir)).sort();

let constrained: Set<string> | null = null;
for (const file of files) {
  const sql = await migrations.readFile(new URL(file, migrationDir), "utf8");
  for (const match of sql.matchAll(/state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(state\s+IN\s*\(([^)]*)\)|CONSTRAINT\s+execution_attempts_state_check\s+CHECK\s*\(state\s+IN\s*\(([^)]*)\)/gi)) {
    const body = match[1] ?? match[2] ?? "";
    constrained = new Set([...body.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
  }
}

assert.ok(constrained, "execution_attempts.state must be constrained by a migration");

const declared = Object.keys(ALLOWED_TRANSITIONS) as ExecutionState[];
const unwritable = declared.filter((state) => !constrained!.has(state));
assert.deepEqual(
  unwritable,
  [],
  `the state machine can reach states the database rejects: ${unwritable.join(", ")}`,
);

const unreachable = [...constrained].filter((state) => !declared.includes(state as ExecutionState));
assert.deepEqual(
  unreachable,
  [],
  `the database allows states no execution can reach: ${unreachable.join(", ")}`,
);

/* ---- what the public ledger may carry ---- */

/* The ledger is open on purpose: a purchase a stranger cannot check is not
   evidence. So the question is not who may read it but what is in it, and the
   stored model was being returned whole to anybody who asked with no header at
   all. Measured against the deployed app before this view existed: five rows,
   five authorizationSignature values, and among them a signed EIP-3009
   authorization for USDC on Ethereum mainnet with paymentTx null -- never
   consumed -- and five days left on its validity. */
const SIGNATURE = `0x${"ab".repeat(65)}` as `0x${string}`;
const NONCE = `0x${"cd".repeat(32)}`;
const IDEMPOTENCY = "idem_do_not_publish_this";
const CLEARANCE_SIG = `0x${"ef".repeat(65)}` as `0x${string}`;

const attempt = {
  executionId: "vexec_test", mandateId: "vman_test", selectionId: "vcs_test",
  clearanceId: "vcl_test", rail: "x402" as const, state: "SETTLEMENT_FAILED" as const,
  capability: "research", counterpartyAgentId: "x402:abc", counterpartyWallet: `0x${"1".repeat(40)}`,
  requestedAmountUsdc: 0.012, authorizedAmountUsdc: 0.012, actualSettledAmountUsdc: 0,
  failureCode: "payment_rejected_by_seller", createTx: null, paymentTx: null, completeTx: null,
  evaluationId: null, selectionHash: `0x${"2".repeat(64)}`, clearanceDigest: `0x${"3".repeat(64)}`,
  clearancePayload: { message: { any: "terms" }, signature: CLEARANCE_SIG, digest: `0x${"3".repeat(64)}` },
  evidenceHash: `0x${"4".repeat(64)}`, providerContentUri: null, providerContentHash: null,
  providerContentType: null, providerSubmittedAt: null, idempotencyKey: IDEMPOTENCY,
  canonicalHash: `0x${"5".repeat(64)}`,
  createdAt: "2026-09-14T10:02:29.422Z", updatedAt: "2026-09-14T10:02:31.423Z",
  x402Context: {
    payerWallet: `0x${"6".repeat(40)}` as `0x${string}`,
    payTo: `0x${"7".repeat(40)}` as `0x${string}`,
    asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as `0x${string}`,
    network: "eip155:1", authorizedAmountUsdc: 0.012, authorizedAmountAtomic: "12000",
    authorizationNonce: NONCE, authorizationSignature: SIGNATURE,
    authorizationValidBefore: 1789985038, resource: "https://seller.example/paid",
    paymentRequirementsHash: `0x${"8".repeat(64)}`, facilitatorReference: null,
    requestTimestamp: "2026-09-14T10:02:29.422Z",
  },
} as unknown as ExecutionAttempt;

/* Searched across the whole serialised view rather than field by field, because
   the field that leaked was nested two levels down in a context object added
   long after the route that returned it. */
const published = JSON.stringify(publicExecutionView(attempt));
for (const [what, secret] of [
  ["the payment authorization's signature", SIGNATURE],
  ["its nonce", NONCE],
  ["the idempotency key", IDEMPOTENCY],
  ["the clearance signature", CLEARANCE_SIG],
] as const) {
  assert.ok(!published.includes(secret),
    `${what} must never reach the public ledger`);
}

/* And the evidence is still there, because removing it would answer a leak by
   deleting the product. */
for (const fact of [
  "vexec_test", "payment_rejected_by_seller", "eip155:1",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "12000",
  `0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`, "https://seller.example/paid",
]) {
  assert.ok(published.includes(fact), `the public ledger still has to carry ${fact}`);
}

/* An allowlist, and asserted as one: a field added to the stored model later
   must not appear until somebody decides it should. */
const withNewField = publicExecutionView({
  ...attempt, somethingAddedLater: "must-not-publish",
} as unknown as ExecutionAttempt);
assert.ok(!JSON.stringify(withNewField).includes("must-not-publish"),
  "the view is built by naming what is kept, not by deleting what is not");

/* The expiry stays. When an authorization stops being valid is a fact about
   the record; the pair that spends it is the signature and the nonce, and
   neither is above. */
assert.equal(publicExecutionView(attempt).x402?.authorizationValidBefore, 1789985038);

/* Why a settlement can have no transaction. Without the rail on the row, a
   COMPLETED_UNPROVEN with an empty payment_tx reads as a bug rather than as the
   shape Circle's batched settlement actually has. */
assert.equal(publicExecutionView(attempt).x402?.gatewayBatched, null, "rows older than the field say nothing rather than guess");
assert.equal(
  publicExecutionView({
    ...attempt,
    x402Context: { ...(attempt as any).x402Context, gatewayBatched: true },
  } as ExecutionAttempt).x402?.gatewayBatched,
  true,
);

/* A public ledger that prints a settled amount without saying whether the chain
   or the seller is the source of it is publishing an opinion as a fact. */
assert.equal(publicExecutionView(attempt).settlementProof, null, "ungraded rows say so");
assert.equal(
  publicExecutionView({ ...attempt, settlementProof: "onchain_final" } as ExecutionAttempt).settlementProof,
  "onchain_final",
);

console.log(`[execution-ledger-test] passed: all ${declared.length} execution states are writable by the schema, and the schema allows no state the machine cannot produce, and the public ledger carries the evidence without the material that spends it`);
