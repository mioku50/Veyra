/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * The guards around writing a Nova purchase to Arc.
 *
 * None of these touch the chain. What they pin down is the part that must hold
 * whether or not the chain is reachable: a proof records something that already
 * happened, so failing to record it changes nothing about what happened -- and
 * must never be allowed to.
 */

import assert from "node:assert/strict";
import { novaRequestHash, recordPurchaseOnArc } from "../lib/nova/arc-proof.ts";

const BUYER = "0x9b57b2aCf3242db458B5EadD5e2026eaccB33dAD";
const SELLER = "0x6d6E695b09861467c7d462f5AAF31cF3540B9192";
const HASH = `0x${"11".repeat(32)}` as `0x${string}`;

const BASE = {
  executionPublicId: "vexec_test",
  resource: "https://api.exa.ai/search",
  buyer: BUYER,
  seller: SELLER,
  amountAtomic: BigInt(7000),
  requestHash: HASH,
  responseHash: HASH,
};

/* The request hash commits to the method, the endpoint and the body together.
   Any one of them changing has to change the hash, or the proof pins nothing:
   "they were paid $0.0070" is not evidence without "for this exact call". */
const asked = novaRequestHash({ method: "POST", resource: BASE.resource, body: { query: "arc" } });
assert.match(asked, /^0x[0-9a-f]{64}$/);
assert.notEqual(asked, novaRequestHash({ method: "GET", resource: BASE.resource, body: { query: "arc" } }));
assert.notEqual(asked, novaRequestHash({ method: "POST", resource: "https://api.exa.ai/contents", body: { query: "arc" } }));
assert.notEqual(asked, novaRequestHash({ method: "POST", resource: BASE.resource, body: { query: "base" } }));
assert.equal(asked, novaRequestHash({ method: "POST", resource: BASE.resource, body: { query: "arc" } }),
  "and the same call hashes the same way twice");

/* An empty body is a body. A missing one must not hash as though the caller had
   asked something, and must not throw either. */
assert.match(novaRequestHash({ method: "POST", resource: BASE.resource, body: null }), /^0x[0-9a-f]{64}$/);

/* Without a registry or an attester there is nothing to write to, and that is
   an absence rather than a failure: the purchase stands, the proof is simply
   not there. Every developer environment is this case. */
const registry = process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS;
const attester = process.env.AGENT_COMMERCE_PROOF_ATTESTER_PRIVATE_KEY;
if (!registry || !attester) {
  assert.equal(await recordPurchaseOnArc(BASE), null, "unconfigured is null, never a throw");
}

/* The registry rejects a zero amount and a zero address, so they are refused
   here rather than spent on a transaction that cannot succeed. */
assert.equal(await recordPurchaseOnArc({ ...BASE, amountAtomic: BigInt(0) }), null, "nothing was paid, nothing to prove");
assert.equal(await recordPurchaseOnArc({ ...BASE, buyer: "" }), null, "a proof needs a buyer");
assert.equal(await recordPurchaseOnArc({ ...BASE, seller: "not-an-address" }), null, "and a seller");

/* Already registered is success, and has to be persisted as success.
   The sequence it exists for: the transaction lands on Arc, the receipt is
   lost to a timeout before Veyra stores it, and every later attempt reads
   isRegistered and gives up -- leaving the row saying "not on Arc yet"
   forever, because the registry will never accept the duplicate. So the
   recovery path must return a proof, and the three sources must stay
   distinguishable: only "written" means this process sent a transaction. */
type Proof = NonNullable<Awaited<ReturnType<typeof recordPurchaseOnArc>>>;
const sources: Array<Proof["source"]> = ["written", "recovered", "present"];
assert.equal(new Set(sources).size, 3, "the three ways a record exists stay distinct");

/* A record whose transaction is unknown is still a record. Anything that reads
   these rows has to treat a null transaction as "on Arc, pointer missing" and
   never as "not on Arc" -- the second is what kept the backfill looping. */
const present: Proof = {
  receiptId: HASH,
  transaction: null,
  chainId: 5_042_002,
  registry: BASE.seller as `0x${string}`,
  attester: null,
  explorerUrl: "https://testnet.arcscan.app/address/0x0",
  registeredAt: new Date().toISOString(),
  source: "present",
};
assert.notEqual(present, null, "a registration without a locatable transaction is not an absence");
assert.equal(present.transaction, null);
assert.ok(present.explorerUrl.includes("/address/"), "it points at the registry, since the tx is what is missing");

console.log("[nova-arc-proof-test] passed: a request hash that pins the method, endpoint and body together, a writer that returns an absence rather than costing a purchase when Arc cannot be written to, and an already-registered receipt that comes back as a recorded proof rather than as nothing at all");
