/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { buildRequestBody, checkRequestBody } from "../lib/x402/request-body.ts";

/* ---- no published schema: say so, do not pretend ---- */

// This is the real case that cost money: np.orthogonal.com/serper/search
// publishes no input schema at all, so Veyra posted {"query": ...} and the
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

console.log("[x402-request-body-test] passed: an unpublished shape is labelled a guess, a published schema names its own field and supplies its own defaults, missing requirements are reported, and a body the schema rejects is refused before it can be paid for");
