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

console.log("[x402-post-call-verification-test] passed: delivery, error envelopes, empty bodies, settlement receipts, published schemas, latency envelope, amount binding, response commitment");
