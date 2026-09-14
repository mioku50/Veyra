/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * What an ERC-8004 identity is, and the four things this must never do.
 */

import assert from "node:assert/strict";
import {
  IDENTITY_REGISTER_ABI,
  NOVA_IDENTITY_CHAIN_ID,
  NOVA_IDENTITY_REGISTRY,
  agentCard,
  confirmIdentity,
} from "../lib/nova/identity.ts";
import { ARC_ERC8004_IDENTITY_REGISTRY } from "../lib/erc8004/types.ts";

/* The identity is the registry and the agent id together. Neither alone names
   an agent, and the owner is not part of it at all -- which is the point: a
   wallet change must not look like a different agent. */
assert.equal(NOVA_IDENTITY_REGISTRY, ARC_ERC8004_IDENTITY_REGISTRY,
  "the official Arc registry, not one of ours");
assert.equal(NOVA_IDENTITY_CHAIN_ID, 5_042_002);

/* register(string) mints to its caller. That single fact is why the owner is
   the person: there is no argument for a recipient, so whoever signs owns it,
   and the transaction is signed in the browser. */
const register = IDENTITY_REGISTER_ABI.find((entry) => entry.name === "register");
assert.ok(register);
assert.deepEqual(register.inputs.map((i) => i.type), ["string"],
  "no recipient argument: the caller is the owner, and Veyra is never the caller");

/* Nothing is minted, so nothing is confirmed. An unminted token reverts on
   ownerOf and an RPC having a bad day does too; neither is a registration and
   neither may be recorded as one. */
for (const [why, agentId] of [
  ["not a number", "not-a-token"],
  ["empty", ""],
  ["absurd", "1".repeat(90)],
] as const) {
  const out = await confirmIdentity({ agentId, expectedOwner: "0x9b57b2aCf3242db458B5EadD5e2026eaccB33dAD" });
  assert.equal(out.ok, false, why);
}

/* A wallet that is not an address cannot be the owner of anything. */
const badOwner = await confirmIdentity({ agentId: "1", expectedOwner: "nope" });
assert.equal(badOwner.ok, false);
assert.equal(badOwner.ok === false && badOwner.reason, "wrong_owner");

/* The card is quoted onchain, so everything in it is published the moment
   somebody registers. It carries the agent's public identity and nothing from
   the brief, the memory or the purchases -- none of which is the owner's to
   have published as a side effect of claiming an identity. */
const card = agentCard({
  name: "Atlas",
  publicId: "nva_abc123",
  createdAt: "2026-09-13T00:00:00.000Z",
  origin: "https://example.test",
});
const serialised = JSON.stringify(card);
assert.equal(card.externalId, "nva_abc123", "the product identity outlives any wallet or token");
assert.match(card.registrations[0].agentRegistry, /^eip155:5042002:0x8004A818/);
for (const secret of ["ownerSecret", "owner_secret", "interests", "memory", "paidUsdc", "payer"]) {
  assert.doesNotMatch(serialised, new RegExp(secret, "i"), `the card must not carry ${secret}`);
}

console.log("[nova-identity-test] passed: an identity that is a registry and an agent id rather than an address, a register() with no recipient argument so the owner is whoever signs, a confirmation that refuses everything Arc has not shown, and a public card that publishes nothing the owner did not already make public");
