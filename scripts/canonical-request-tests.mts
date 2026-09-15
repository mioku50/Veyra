/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  CANONICAL_REQUEST_VERSION,
  CanonicalRequestError,
  canonicalRequestHash,
  canonicalRequestJson,
} from "../lib/canonical-request.ts";

/* The property the whole thing exists for: two callers that built the same
   request in different orders must produce the same binding. JSON.stringify
   does not, which is why this function does. */
const keysInOneOrder = { alpha: 1, beta: [2, 3], gamma: { delta: true } };
const keysInAnother = { gamma: { delta: true }, beta: [2, 3], alpha: 1 };
assert.notEqual(
  JSON.stringify(keysInOneOrder), JSON.stringify(keysInAnother),
  "the test is worthless unless JSON.stringify really does disagree here",
);
assert.equal(
  canonicalRequestHash(keysInOneOrder), canonicalRequestHash(keysInAnother),
  "key order is not meaning, and must not change the hash",
);
assert.equal(canonicalRequestJson(keysInOneOrder), '{"alpha":1,"beta":[2,3],"gamma":{"delta":true}}');

// Nested, because the failure that matters is one level down from the one a
// hand-written comparison would check.
assert.equal(
  canonicalRequestHash({ outer: { b: 1, a: 2 } }),
  canonicalRequestHash({ outer: { a: 2, b: 1 } }),
);

// Order IS meaning in an array.
assert.notEqual(canonicalRequestHash([1, 2]), canonicalRequestHash([2, 1]));

/* No body and a null body are the same request to any endpoint. Answering
   differently would make one of the two impossible to quote. */
assert.equal(canonicalRequestHash(undefined), canonicalRequestHash(null));

// An empty object is not a null body.
assert.notEqual(canonicalRequestHash({}), canonicalRequestHash(null));

/* Numbers that are the same JSON number must hash the same, and numbers that
   are not must not. -0 is 0; "1" is not 1. */
assert.equal(canonicalRequestHash({ n: -0 }), canonicalRequestHash({ n: 0 }));
assert.equal(canonicalRequestHash({ n: 1.0 }), canonicalRequestHash({ n: 1 }));
assert.notEqual(canonicalRequestHash({ n: 1 }), canonicalRequestHash({ n: "1" }));
assert.notEqual(canonicalRequestHash({ n: 1 }), canonicalRequestHash({ n: true }));

// Dropped in objects, null in arrays -- the same split JSON makes.
assert.equal(canonicalRequestJson({ a: 1, b: undefined }), '{"a":1}');
assert.equal(canonicalRequestJson([1, undefined, 2]), "[1,null,2]");

// Unicode and escaping are JSON's own rules, not a second implementation.
assert.equal(canonicalRequestJson({ "ключ": "значение\n\"x\"" }), '{"ключ":"значение\\n\\"x\\""}');
assert.equal(canonicalRequestJson({ "é": 1 }), '{"é":1}');

/* Sorted by UTF-16 code unit, which is what every JSON implementation means by
   sorted keys. A locale-aware sort would order these differently and the same
   body would hash differently on two machines. */
assert.equal(canonicalRequestJson({ b: 1, A: 2, a: 3, "10": 4, "2": 5 }), '{"10":4,"2":5,"A":2,"a":3,"b":1}');

/* The version is inside the preimage, so a future canonicalization cannot
   collide with this one. Asserted by hashing the preimage by hand. */
const { keccak256, stringToBytes } = await import("viem");
assert.equal(
  canonicalRequestHash({ a: 1 }),
  keccak256(stringToBytes(`${CANONICAL_REQUEST_VERSION}\n{"a":1}`)),
  "the version tag must be part of what is hashed, not a comment about it",
);

// Anything that did not come out of JSON.parse is refused rather than guessed.
for (const [what, value] of [
  ["a Date", new Date()],
  ["a Map", new Map()],
  ["a class instance", new (class { x = 1 })()],
  ["a function", () => 1],
  ["a symbol", Symbol("s")],
  ["a BigInt", BigInt(1)],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
] as const) {
  assert.throws(
    () => canonicalRequestHash({ value }),
    (err: unknown) => err instanceof CanonicalRequestError,
    `${what} must be refused, not silently given a shape`,
  );
}

// A cycle must be refused by the depth bound rather than by a stack overflow.
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
assert.throws(() => canonicalRequestHash(cyclic), (err: unknown) => err instanceof CanonicalRequestError);

// Deep but legal still works, so the bound is not an ambush on a real body.
let deep: unknown = 1;
for (let i = 0; i < 60; i += 1) deep = { n: deep };
assert.match(canonicalRequestHash(deep), /^0x[0-9a-f]{64}$/);

console.log("[canonical-request-test] passed: one canonical form for the body that a quote priced, a header authorizes and an envelope will spend against -- key order and -0 do not change it, array order and type do, and anything JSON.parse could not have produced is refused rather than guessed");
