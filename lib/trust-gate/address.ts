/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where the Trust Gate lives, answered once.
 *
 * Eight places read this and three of them disagreed. Six read
 * VEYRA_TRUST_GATE_ADDRESS; the executor read only the NEXT_PUBLIC_ spelling
 * and fell back to a hardcoded address when it was absent; the ERC-8183 adapter
 * read both and fell back to the same hardcoded one.
 *
 * The hardcoded address was 0x1cD66BCd4FCB73a079c05635840Fde029Ce6BEbB, an
 * earlier gate that is still on Arc and does not carry verifyClearance. So a
 * deployment that set the server-side variable and not the public one had the
 * selection layer verifying against the live gate while the executor issued
 * clearances naming a dead one -- and nothing in either path would have said
 * so, because both addresses answer.
 *
 * The default below is the gate production actually calls. It is a default and
 * not a constant: the variable still wins, so a fresh deployment needs no code
 * change. Publishing it here rather than in two call sites means the next gate
 * is one edit, and `docs/contracts.md` has something to be checked against.
 */

/** The gate production runs. Verified on Arc: carries selector 0x36d5bb2a. */
export const DEFAULT_VEYRA_TRUST_GATE_ADDRESS = "0x6C702E51B328De51621f48483f6587fb2665efAf" as const;

/**
 * The configured gate, or the deployed default.
 *
 * Both spellings are accepted because both are in use, and the server-side one
 * wins: it is the one a deployment sets when it means it, and the NEXT_PUBLIC_
 * copy is there for code that has to run in a browser bundle.
 */
export function trustGateAddress(): `0x${string}` {
  const configured = process.env.VEYRA_TRUST_GATE_ADDRESS
    || process.env.NEXT_PUBLIC_VEYRA_TRUST_GATE_ADDRESS;
  const value = configured?.trim();
  if (value && /^0x[0-9a-fA-F]{40}$/.test(value)) return value as `0x${string}`;
  return DEFAULT_VEYRA_TRUST_GATE_ADDRESS;
}
