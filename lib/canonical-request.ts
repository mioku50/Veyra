/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { keccak256, stringToBytes } from "viem";

/**
 * One way to hash a request body, for everything that has to agree about one.
 *
 * Three places need to say "this is the same request as before": an x402 quote
 * proving that the body being paid for is the body that was priced, the signed
 * execution-auth header binding the bytes it authorizes, and the unattended
 * envelope that will eventually authorize a spend without a person watching.
 *
 * They need to agree exactly, and the ordinary way to get that wrong is to
 * write `JSON.stringify` in each of them. That is not a canonical form: key
 * order follows insertion, `undefined` is dropped in objects but becomes null
 * in arrays, and two encoders that both "use JSON" will disagree on the first
 * body whose keys were built in a different order. A signature that verifies in
 * one place and not the other is worse than no binding at all, because the
 * failure is intermittent and reads as a bug in the wallet.
 *
 * So: one function, one version tag inside the preimage so a future v2 cannot
 * collide with v1, and a deliberately narrow input domain. Anything that did
 * not come out of `JSON.parse` is refused rather than silently given a shape --
 * a Date is `{}` to `Object.entries` and `"2026-..."` to `JSON.stringify`, and
 * guessing which one a caller meant is how the two consumers drift apart again.
 */

export const CANONICAL_REQUEST_VERSION = "veyra.canonical-request.v1";

/** Deep enough for any request body a seller publishes a schema for, shallow
 *  enough that a cycle or a hostile payload cannot exhaust the stack. */
const MAX_DEPTH = 64;

export class CanonicalRequestError extends Error {
  readonly code: string;
  constructor(message: string, code = "canonical_request_unrepresentable") {
    super(message);
    this.name = "CanonicalRequestError";
    this.code = code;
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalRequestError(`Request body nests deeper than ${MAX_DEPTH} levels.`);
  }
  if (value === null || value === undefined) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalRequestError("A request body cannot contain NaN or Infinity.");
      }
      /* JSON.stringify prints the shortest string that round-trips, which is
         the only number formatting two independent implementations can be
         expected to agree on. Negative zero is folded to zero, because -0 and 0
         are the same JSON number and must not hash differently. */
      return JSON.stringify(value === 0 ? 0 : value);
    case "string":
      // Deliberately JSON.stringify: its escaping rules are fully specified,
      // including surrogate handling, and reimplementing them would be the
      // second encoder this module exists to avoid.
      return JSON.stringify(value);
    case "bigint":
      throw new CanonicalRequestError("A request body cannot contain a BigInt; JSON has no such type.");
    default:
      break;
  }

  if (Array.isArray(value)) {
    // Order is meaning in an array, so it is preserved. A hole or an explicit
    // undefined becomes null, exactly as JSON.stringify would.
    return `[${value.map((item) => canonicalize(item, depth + 1)).join(",")}]`;
  }

  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      throw new CanonicalRequestError(
        "A request body may only contain values that came out of JSON.parse.",
      );
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      /* By UTF-16 code unit, which is what every JSON implementation means by
         "sorted keys". Never localeCompare: its order depends on the runtime's
         locale data, so the same body would hash differently on two machines. */
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, depth + 1)}`).join(",")}}`;
  }

  throw new CanonicalRequestError(`A request body cannot contain a ${typeof value}.`);
}

/**
 * The canonical serialization, exposed for tests and for anything that needs to
 * show a reader what was hashed. Not for relaying: the bytes a seller receives
 * are the caller's own, and the hash binds the value they encode rather than
 * the encoding.
 */
export function canonicalRequestJson(body: unknown): string {
  return canonicalize(body, 0);
}

/**
 * The binding itself. `undefined` and `null` hash alike -- a request with no
 * body and a request whose body is null are the same request to any endpoint,
 * and two different answers here would make one of the two unquotable.
 */
export function canonicalRequestHash(body: unknown): `0x${string}` {
  return keccak256(stringToBytes(`${CANONICAL_REQUEST_VERSION}\n${canonicalRequestJson(body)}`));
}
