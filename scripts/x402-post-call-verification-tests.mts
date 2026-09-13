/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { verifyPostCall } from "../lib/x402/post-call-verification.ts";

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

function detailFor(result: ReturnType<typeof verifyPostCall>, id: string) {
  return result.checks.find((check) => check.id === id)?.detail ?? "";
}

console.log("[x402-post-call-verification-test] passed: delivery, error envelopes, empty bodies, settlement receipts, published schemas, latency envelope, amount binding, response commitment, and no check that claims a charge without a receipt");
