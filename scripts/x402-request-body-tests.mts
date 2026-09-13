/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { buildRequestBody, checkRequestBody } from "../lib/x402/request-body.ts";
import { challengeSchemas, parseChallengeAccepts } from "../lib/providers/x402-probe.ts";

/* ---- no published schema: say so, do not pretend ---- */

// This is the real case that cost a call: Circle's catalog entry for
// np.orthogonal.com/serper/search carries no `input`, so Veyra posted
// {"query": ...} — and the
// endpoint answered HTTP 400 after taking the call.
const guessed = buildRequestBody({ intent: "Research Ambient", capability: "web_search" });
assert.equal(guessed.guessed, true);
assert.deepEqual(guessed.body, { query: "Research Ambient" });
assert.ok(guessed.note && /best guess/i.test(guessed.note), "a guess must be labelled a guess");

// An empty intent still produces something sendable, from the capability.
assert.deepEqual(
  buildRequestBody({ intent: "   ", capability: "web_search" }).body,
  { query: "web search" },
);

/* ---- published schema: use the provider's own vocabulary ---- */

const serperish = buildRequestBody({
  intent: "Research Ambient",
  capability: "web_search",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" }, num: { type: "integer", default: 10 } },
    required: ["q"],
  },
});
assert.equal(serperish.guessed, false);
assert.equal(serperish.intentField, "q", "the schema names the field, not Veyra");
// Only what the provider requires is sent. `num` declares a default but is
// optional, and the server applies its own default better than Veyra can guess
// that it wants one at all.
assert.deepEqual(serperish.body, { q: "Research Ambient" });
assert.equal(serperish.note, null);

// A default on a *required* field is honoured, because the request is invalid
// without it and the schema itself says what it should be.
assert.deepEqual(
  buildRequestBody({
    intent: "x", capability: "c",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" }, format: { type: "string", default: "json" } },
      required: ["q", "format"],
    },
  }).body,
  { format: "json", q: "x" },
);

// A differently-named query field is still found.
assert.equal(
  buildRequestBody({
    intent: "x", capability: "c",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  }).intentField,
  "prompt",
);

// A required field nothing can supply is reported rather than silently omitted.
const incomplete = buildRequestBody({
  intent: "x", capability: "c",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" }, apiVersion: { type: "string" } },
    required: ["q", "apiVersion"],
  },
});
assert.ok(incomplete.note && /apiVersion/.test(incomplete.note));

/* ---- the guard that stops money going to a rejected request ---- */

const schema: Record<string, unknown> = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

assert.deepEqual(checkRequestBody({ q: "hello" }, schema), { ok: true, checked: true });

const rejected = checkRequestBody({ query: "hello" }, schema);
assert.equal(rejected.ok, false, "the exact mistake that was paid for must be refused");
assert.equal(rejected.checked, true);

// With no schema the honest answer is "not checked", never "fine".
assert.deepEqual(checkRequestBody({ anything: 1 }, null), { ok: true, checked: false });
assert.deepEqual(checkRequestBody({ anything: 1 }, {}), { ok: true, checked: false });


/* ---- the schema the catalog omits and the challenge publishes ---- */

/* Captured verbatim from np.orthogonal.com/serper/search. The catalog entry
   for this resource has no `input` field, which is why Veyra called the shape
   a guess and sent `{"query": ...}` to an endpoint that answers
   `Required parameter(s) not provided: q. No payment was charged.`
   The endpoint documents itself perfectly well — inside its own 402, under
   `accepts[].outputSchema.input.body`, which nothing was reading. */
const LIVE_402 = {
  x402Version: 2,
  error: "Payment required",
  accepts: [{
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "2000",
    payTo: "0x1563CdE0042d17F53b23d91Fd9B73ACE9Da26a09",
    maxTimeoutSeconds: 604_900,
    resource: "https://np.orthogonal.com/serper/search",
    outputSchema: {
      input: {
        body: {
          type: "object",
          properties: {
            q: { type: "string", description: "Search query" },
            gl: { type: "string", description: "Country code (e.g. us, uk, de)" },
            num: { type: "number", description: "Number of results (default 10, max 100)" },
            autocorrect: { type: "boolean", description: "Enable autocorrect (default true)" },
          },
          required: ["q"],
        },
      },
    },
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
    },
  }],
};

const published = challengeSchemas(parseChallengeAccepts(LIVE_402));
assert(published.input !== null, "the challenge publishes the request schema and it must be found");
assert.deepEqual((published.input as { required: string[] }).required, ["q"]);
// Only `input` was published; inventing an output schema would license the
// post-call check to claim it verified a promise nobody made.
assert.equal(published.output, null);

const fromChallenge = buildRequestBody({
  intent: "Research the latest developments in Ambient",
  capability: "web_research",
  inputSchema: published.input,
});
assert.deepEqual(fromChallenge.body, { q: "Research the latest developments in Ambient" });
assert.equal(fromChallenge.guessed, false, "a schema was published, so nothing here is a guess");
assert.equal(fromChallenge.note, null);
// Optional fields are left out: `autocorrect` has a documented default of true
// but the schema declares no `default`, and Veyra does not invent one.
assert.deepEqual(Object.keys(fromChallenge.body), ["q"]);

// The body that was actually sent is now refused before a wallet opens.
assert.equal(checkRequestBody({ query: "..." }, published.input).ok, false);
assert.equal(checkRequestBody(fromChallenge.body, published.input).ok, true);

// A challenge that publishes an empty schema promises nothing, and `{}` must
// not be mistaken for a contract that everything satisfies.
assert.equal(challengeSchemas([{ outputSchema: { input: { body: {} } } }]).input, null);
assert.equal(challengeSchemas([{ outputSchema: { input: {} } }]).input, null);
assert.equal(challengeSchemas([{}]).input, null);
assert.equal(challengeSchemas(null).input, null);
// GET endpoints publish query parameters rather than a body.
assert.deepEqual(
  challengeSchemas([{ outputSchema: { input: { queryParams: { type: "object", properties: { url: { type: "string" } } } } } }]).input,
  { type: "object", properties: { url: { type: "string" } } },
);

console.log("[x402-request-body-test] passed: an unpublished shape is labelled a guess, a published schema names its own field and supplies its own defaults, missing requirements are reported, and a body the schema rejects is refused before it can be paid for, and the schema an endpoint publishes inside its own 402 is read when the catalog omits it");
