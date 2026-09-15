/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { verifyPostCall } from "../lib/x402/post-call-verification.ts";
import {
  proofFromReceipt,
  provesEconomicEvidence,
  strongerProof,
} from "../lib/execution/settlement-proof.ts";

const BASE = {
  httpStatus: 200,
  bodyText: JSON.stringify({ results: [{ title: "a" }] }),
  parsedBody: { results: [{ title: "a" }] },
  latencyMs: 900,
  quotedAtomic: "2000",
  authorizedAtomic: "2000",
  payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192",
  settlement: { success: true, transaction: "0xabc", payer: "0x1" } as Record<string, unknown>,
  required: true,
  now: new Date("2026-09-13T12:00:00.000Z"),
};

// A clean delivery passes, and commits to what was delivered.
const pass = verifyPostCall(BASE);
assert.equal(pass.verdict, "PASS");
assert.match(pass.responseHash, /^0x[0-9a-f]{64}$/);
assert.equal(pass.required, true);

// The same body always hashes the same; a different body never does.
assert.equal(verifyPostCall(BASE).responseHash, pass.responseHash);
assert.notEqual(
  verifyPostCall({ ...BASE, bodyText: JSON.stringify({ results: [] }) }).responseHash,
  pass.responseHash,
);

// Charged, then answered with an error envelope: the single most important case,
// because HTTP 200 makes it look like a success to everything downstream.
const errored = verifyPostCall({
  ...BASE,
  bodyText: JSON.stringify({ error: "rate limited" }),
  parsedBody: { error: "rate limited" },
});
assert.equal(errored.verdict, "FAIL");
assert.equal(errored.checks.find((c) => c.id === "response_is_not_an_error")?.passed, false);

// `{"error": null}` is how a lot of APIs say "fine".
assert.equal(
  verifyPostCall({ ...BASE, bodyText: '{"error":null,"data":1}', parsedBody: { error: null, data: 1 } }).verdict,
  "PASS",
);

// Paid and given nothing.
assert.equal(verifyPostCall({ ...BASE, bodyText: "", parsedBody: null }).verdict, "FAIL");

// Paid and refused.
assert.equal(verifyPostCall({ ...BASE, httpStatus: 500, bodyText: "upstream error", parsedBody: null }).verdict, "FAIL");

// A settlement the seller never confirmed cannot be called verified, but it is
// not a failure either - the endpoint may simply batch.
const noReceipt = verifyPostCall({ ...BASE, settlement: null });
assert.equal(noReceipt.verdict, "INCONCLUSIVE");
assert.equal(noReceipt.checks.find((c) => c.id === "payment_settled")?.passed, null);

// The provider's own published schema is enforceable once it publishes one.
const schemaFail = verifyPostCall({
  ...BASE,
  declaredOutputSchema: {
    type: "object",
    properties: { results: { type: "array" }, total: { type: "integer" } },
    required: ["results", "total"],
  },
});
assert.equal(schemaFail.verdict, "FAIL");
assert.equal(schemaFail.checks.find((c) => c.id === "response_matches_declared_schema")?.passed, false);

const schemaPass = verifyPostCall({
  ...BASE,
  declaredOutputSchema: {
    type: "object",
    properties: { results: { type: "array" } },
    required: ["results"],
  },
});
assert.equal(schemaPass.verdict, "PASS");

// With no published schema the check reports "could not run" rather than passing.
assert.equal(
  pass.checks.find((c) => c.id === "response_matches_declared_schema")?.passed,
  null,
);

// Latency is only judged against evidence Veyra actually holds.
assert.equal(
  pass.checks.find((c) => c.id === "latency_within_observed_envelope")?.passed,
  null,
);
const slow = verifyPostCall({ ...BASE, latencyMs: 9000, latencyP95Ms: 1200 });
assert.equal(slow.checks.find((c) => c.id === "latency_within_observed_envelope")?.passed, false);
// Minor severity: slow is not the same as undelivered.
assert.equal(slow.verdict, "PASS");

// Paying more than the quote is a critical fault, not a rounding note.
assert.equal(verifyPostCall({ ...BASE, authorizedAtomic: "3000" }).verdict, "FAIL");

/* ---- never assert a charge nobody observed ---- */

/* The purchase that produced this test answered HTTP 400 with
   `Required parameter(s) not provided: q. No payment was charged.` and no
   settlement receipt. Veyra reported "Endpoint answered HTTP 400 after taking
   payment" and "the endpoint charged and then reported failure" — asserting
   the one fact it did not have, in the two lines the reader trusts most. */
const unreceipted = verifyPostCall({
  ...BASE,
  httpStatus: 400,
  bodyText: JSON.stringify({ error: "Missing required parameters", message: "Required parameter(s) not provided: q. No payment was charged." }),
  parsedBody: { error: "Missing required parameters", message: "Required parameter(s) not provided: q. No payment was charged." },
  settlement: null,
});
const detailOf = (id: string) => unreceipted.checks.find((check) => check.id === id)?.detail ?? "";
for (const id of ["response_delivered", "response_is_not_an_error"]) {
  // "whether it charged is unconfirmed" is the honest sentence; what must never
  // appear is a charge stated as fact.
  assert.doesNotMatch(
    detailOf(id),
    /after taking payment|endpoint charged/,
    `${id} must not claim a charge with no settlement receipt`,
  );
}
assert.match(detailOf("response_delivered"), /unconfirmed/);
assert.match(detailOf("response_is_not_an_error"), /not established that anything was charged/);
// And the endpoint's own sentence, which is the one that explains the failure.
assert.match(detailOf("response_is_not_an_error"), /Required parameter\(s\) not provided: q/);
// Settlement stays unknown rather than being inferred either way.
assert.equal(unreceipted.checks.find((check) => check.id === "payment_settled")?.passed, null);

// With a receipt in hand the stronger sentence is earned again.
const receipted = verifyPostCall({
  ...BASE,
  httpStatus: 400,
  bodyText: JSON.stringify({ error: "upstream exploded" }),
  parsedBody: { error: "upstream exploded" },
});
assert.match(detailFor(receipted, "response_delivered"), /after taking payment/);
assert.match(detailFor(receipted, "response_is_not_an_error"), /charged and then reported failure/);

// A seller that receipts a refusal is not reported as having charged either.
const refused = verifyPostCall({
  ...BASE,
  httpStatus: 400,
  bodyText: JSON.stringify({ error: "insufficient_balance" }),
  parsedBody: { error: "insufficient_balance" },
  settlement: { success: false },
});
assert.doesNotMatch(detailFor(refused, "response_delivered"), /taking payment/);
assert.match(detailFor(refused, "response_is_not_an_error"), /settlement did not succeed/);

/* ---- the summary is the only line most people read ---- */

/* This is the real fal.ai answer from the first browser-signed x402 payment
   that ever settled: the seller took $0.01 and returned its own upstream
   account being empty. The reader saw "the delivery failed verification:
   response_delivered" -- the name of a check -- and nothing else. */
const locked = verifyPostCall({
  ...BASE,
  httpStatus: 403,
  bodyText: JSON.stringify({ detail: "User is locked. Reason: Exhausted balance." }),
  parsedBody: { detail: "User is locked. Reason: Exhausted balance." },
  settlement: { success: true, transaction: "0x4c99" },
});
assert.equal(locked.verdict, "FAIL");
assert.match(locked.summary, /^Paid, but the delivery failed verification\./);
assert.match(locked.summary, /HTTP 403/, "the summary must say what the endpoint actually did");
assert.doesNotMatch(locked.summary, /response_delivered/, "a check id is not an explanation");
// The id survives where it is useful: as the ledger's failure code.
assert.ok(locked.checks.some((check) => check.id === "response_delivered" && check.passed === false));

function detailFor(result: ReturnType<typeof verifyPostCall>, id: string) {
  return result.checks.find((check) => check.id === id)?.detail ?? "";
}

/* A schema Veyra cannot enforce is not a delivery that failed.
   Measured on a real purchase: $0.0070 to Exa, the endpoint answered correctly,
   and the card said the response did not match its published output schema --
   because that schema used `oneOf`, and below it a `$ref`. The seller had done
   nothing wrong. A check that cannot be run is null, which is this file's rule
   everywhere else and was not applied to the one check that reads a stranger's
   document. */
const unenforceable = verifyPostCall({
  ...BASE,
  declaredOutputSchema: {
    type: "object",
    properties: { results: { type: "array", items: { $ref: "#/components/schemas/Result" } } },
  },
});
assert.equal(unenforceable.verdict, "PASS", "an unreadable schema must not fail a delivered answer");
const shape = unenforceable.checks.find((c) => c.id === "response_matches_declared_schema");
assert.equal(shape?.passed, null, "not passed either -- nothing was checked");
assert.match(shape?.detail ?? "", /cannot enforce/);
/* And the verdict says so rather than claiming everything was checked. */
assert.match(unenforceable.summary, /except the response shape/);

/* The composition keywords themselves are enforced now, in both directions. */
const union = { type: "object", properties: { content: { oneOf: [{ type: "string" }, { type: "object" }] } } };
assert.equal(
  verifyPostCall({ ...BASE, parsedBody: { content: "a string" }, bodyText: '{"content":"a string"}', declaredOutputSchema: union }).verdict,
  "PASS",
  "a value matching one branch of a union satisfies it",
);
const broke = verifyPostCall({
  ...BASE, parsedBody: { content: 42 }, bodyText: '{"content":42}', declaredOutputSchema: union,
});
assert.equal(broke.verdict, "FAIL", "and a value matching no branch still fails, as it should");
assert.equal(
  broke.checks.find((c) => c.id === "response_matches_declared_schema")?.passed, false,
  "a real mismatch is a failure, not an abstention",
);

/* ---- whose word the money line rests on ----
 *
 * "The endpoint confirmed settlement" was the strongest economic sentence Veyra
 * printed, and it was the seller describing itself. The claim is graded now,
 * and the grade is on the record. */

const sellerWord = verifyPostCall({ ...BASE, settlementProof: "seller_reported" });
const sellerLine = sellerWord.checks.find((c) => c.id === "payment_settled");
assert.equal(sellerLine?.passed, true, "an ungraded seller report still settles the purchase");
assert.match(
  sellerLine!.detail,
  /Nothing independent of the endpoint confirms it/,
  "but the line must not read as confirmation",
);
assert.equal(
  sellerWord.checks.find((c) => c.id === "settlement_independently_verified")?.passed,
  null,
  "unverified is not a failure -- an honest batched settlement has no hash for days",
);
assert.equal(sellerWord.verdict, "PASS", "and it must not turn an honest purchase into a FAIL");

const chainWord = verifyPostCall({ ...BASE, settlementProof: "onchain_final" });
assert.match(
  chainWord.checks.find((c) => c.id === "payment_settled")!.detail,
  /chain shows the authorization was spent/,
);
assert.equal(
  chainWord.checks.find((c) => c.id === "settlement_independently_verified")?.passed,
  true,
);

/* The case the whole grading exists for: the chain says the money moved and
   the seller says it did not. Believing the seller here loses a real payment
   out of the record. */
const contradicted = verifyPostCall({
  ...BASE,
  settlement: { success: false },
  settlementProof: "onchain_final",
});
const contradictedLine = contradicted.checks.find((c) => c.id === "payment_settled");
assert.equal(contradictedLine?.passed, true, "the chain outranks the seller");
assert.match(contradictedLine!.detail, /though the endpoint reported that it was not/);

const batched = verifyPostCall({ ...BASE, settlementProof: "facilitator_accepted" });
assert.match(
  batched.checks.find((c) => c.id === "settlement_independently_verified")!.detail,
  /batched settlement looks until the batch lands/,
);

/* ---- and what may become reputation ---- */

assert.equal(provesEconomicEvidence("onchain_final"), true);
assert.equal(provesEconomicEvidence("facilitator_accepted"), false);
assert.equal(provesEconomicEvidence("seller_reported"), false);
assert.equal(provesEconomicEvidence(null), false, "an ungraded settlement is not evidence either");

// A hash in the seller's own receipt is still the seller's word.
assert.equal(
  proofFromReceipt({ settlementSuccess: true, transaction: "0xabc" }),
  "seller_reported",
);
// Acknowledged with no reference is the batched shape, not an evasion.
assert.equal(
  proofFromReceipt({ settlementSuccess: true, transaction: null, batched: true }),
  "facilitator_accepted",
);
assert.equal(
  proofFromReceipt({ settlementSuccess: true, transaction: null, batched: false }),
  "seller_reported",
);
assert.equal(strongerProof("seller_reported", "onchain_final"), "onchain_final");
assert.equal(strongerProof("onchain_final", "facilitator_accepted"), "onchain_final");

console.log("[x402-post-call-verification-test] passed: delivery, error envelopes, empty bodies, settlement receipts, published schemas, latency envelope, amount binding, response commitment, a failure summary that says what happened rather than which check it was, and no check that claims a charge without a receipt, and a schema Veyra cannot enforce that abstains instead of blaming the seller for delivering, and a money line that says whether the chain or the seller is the source of it");
