/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.EXECUTION_ALLOW_MEMORY_STORE = "true";

const store = await import("../lib/x402/decision-store.ts");
const { canonicalRequestHash } = await import("../lib/canonical-request.ts");

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const STRANGER = "0x2222222222222222222222222222222222222222" as const;
const PAYEE = "0x3333333333333333333333333333333333333333" as const;
const OTHER_PAYEE = "0x4444444444444444444444444444444444444444" as const;
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
const USDC_ARC = "0x3600000000000000000000000000000000000000" as const;

function selection(overrides: Partial<Parameters<typeof store.recordX402Selection>[0]> = {}) {
  const now = Date.now();
  return {
    selectionId: `vms_${Math.floor(Math.random() * 1e16).toString(16).padStart(16, "0")}`,
    tenantKey: "owner:test",
    ownerWallet: OWNER,
    candidateId: "x402:example.test",
    resource: "https://example.test/search",
    method: "POST" as const,
    capability: "web_research",
    payTo: PAYEE,
    settlementNetwork: "eip155:8453",
    asset: USDC_BASE,
    maxExposureAtomic: "20000",
    decision: "ALLOW_WITH_LIMITS" as const,
    verificationRequired: true,
    policyVersion: "test-policy-v1",
    selectionHash: `0x${"aa".repeat(32)}`,
    clearanceDigest: `0x${"bb".repeat(32)}`,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
    ...overrides,
  };
}

function quoteInput(selectionId: string, overrides: Record<string, unknown> = {}) {
  return {
    selectionId,
    ownerWallet: OWNER,
    requestBodyHash: canonicalRequestHash({ query: "what changed" }),
    amountAtomic: "10000",
    payTo: PAYEE,
    asset: USDC_BASE,
    network: "eip155:8453",
    verifyingContract: USDC_BASE,
    gatewayBatched: false,
    authorizationNonce: `0x${"cc".repeat(32)}`,
    challenge: { accept: { scheme: "exact" } },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  } as Parameters<typeof store.createX402Quote>[0];
}

store.clearX402DecisionMemory();

/* A quote is only ever written against a decision that exists, is live, is
   owned by the same wallet, and names this payee, this asset, this chain and a
   ceiling this price is under. Each of these was, until now, a field the buyer
   sent about its own purchase. */
{
  const live = selection();
  assert.equal((await store.recordX402Selection(live)).stored, true);

  assert.equal(
    (await store.createX402Quote(quoteInput("vms_0000000000000000"))).ok, false,
    "a quote needs a decision that exists",
  );

  const notOwned = await store.createX402Quote(quoteInput(live.selectionId, { ownerWallet: STRANGER }));
  assert.deepEqual([notOwned.ok, (notOwned as any).reason], [false, "SELECTION_NOT_OWNED"]);

  const wrongPayee = await store.createX402Quote(quoteInput(live.selectionId, { payTo: OTHER_PAYEE }));
  assert.deepEqual(
    [wrongPayee.ok, (wrongPayee as any).reason], [false, "PAYEE_NOT_DECIDED"],
    "an endpoint that moved its payee between the decision and the price is not the endpoint that was decided on",
  );

  const wrongAsset = await store.createX402Quote(quoteInput(live.selectionId, { asset: USDC_ARC }));
  assert.deepEqual([wrongAsset.ok, (wrongAsset as any).reason], [false, "ASSET_NOT_DECIDED"]);

  const wrongChain = await store.createX402Quote(quoteInput(live.selectionId, { network: "eip155:1" }));
  assert.deepEqual([wrongChain.ok, (wrongChain as any).reason], [false, "NETWORK_NOT_DECIDED"]);

  const tooDear = await store.createX402Quote(quoteInput(live.selectionId, { amountAtomic: "20001" }));
  assert.deepEqual(
    [tooDear.ok, (tooDear as any).reason], [false, "AMOUNT_ABOVE_DECIDED_CEILING"],
    "one atomic unit over the decided ceiling is over the decided ceiling",
  );
  assert.equal(
    (await store.createX402Quote(quoteInput(live.selectionId, { amountAtomic: "20000" }))).ok, true,
    "and exactly the ceiling is not over it",
  );

  /* Veyra's willingness to relay cannot outlive the decision. This is not the
     authorization's own validity window, which the batched rail requires to be
     a week -- it is how long this server will still carry the signature. */
  const outlives = await store.createX402Quote(quoteInput(live.selectionId, {
    expiresAt: new Date(Date.parse(live.expiresAt) + 1_000).toISOString(),
  }));
  assert.deepEqual([outlives.ok, (outlives as any).reason], [false, "QUOTE_OUTLIVES_SELECTION"]);
}

/* An expired decision is not a decision, and re-deciding is the answer. */
{
  const stale = selection({
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  await store.recordX402Selection(stale);
  const refused = await store.createX402Quote(quoteInput(stale.selectionId));
  assert.deepEqual([refused.ok, (refused as any).reason], [false, "SELECTION_EXPIRED"]);
}

/* The resource and the method come from the decision, never from a caller --
   the catalog publishes the method per endpoint, and the browser used to send
   POST unconditionally. There is no parameter to get this wrong with. */
{
  const getOnly = selection({ method: "GET", resource: "https://example.test/lookup" });
  await store.recordX402Selection(getOnly);
  const created = await store.createX402Quote(quoteInput(getOnly.selectionId));
  assert.equal(created.ok, true);
  assert.equal((created as any).method, "GET");
  assert.equal((created as any).resource, "https://example.test/lookup");
  /* And the tier comes back from the decision rather than from a boolean the
     buyer sent about its own purchase. */
  assert.equal((created as any).verificationRequired, true);
  assert.equal((created as any).decision, "ALLOW_WITH_LIMITS");
}

/* One signature pays once. Two settles racing the same quote used to both
   relay, because nothing in the server knew a quote existed. */
{
  const live = selection();
  await store.recordX402Selection(live);
  const created = await store.createX402Quote(quoteInput(live.selectionId));
  assert.equal(created.ok, true);
  const quoteId = (created as any).quoteId as string;

  const stranger = await store.claimX402Quote(quoteId, STRANGER);
  assert.deepEqual([stranger.ok, (stranger as any).reason], [false, "QUOTE_NOT_OWNED"]);

  const first = await store.claimX402Quote(quoteId, OWNER);
  assert.equal(first.ok, true, "the first settle wins the quote");

  const second = await store.claimX402Quote(quoteId, OWNER);
  assert.deepEqual(
    [second.ok, (second as any).reason], [false, "QUOTE_ALREADY_CLAIMED"],
    "and the second relays nothing, whatever it holds",
  );
}

/* The lifecycle, and the one backwards step there is. */
{
  const live = selection();
  await store.recordX402Selection(live);
  const created = await store.createX402Quote(quoteInput(live.selectionId));
  const quoteId = (created as any).quoteId as string;
  await store.claimX402Quote(quoteId, OWNER);

  // Nothing left the process: honestly re-usable.
  assert.equal(
    await store.advanceX402Quote({ quoteId, expectedState: "CLAIMED", targetState: "QUOTED" }), true,
  );
  assert.equal((await store.fetchX402Quote(quoteId))?.state, "QUOTED");

  // Claim it again, then dispatch it. From here there is no way back: after F3
  // a broken socket is not evidence that no money moved.
  await store.claimX402Quote(quoteId, OWNER);
  assert.equal(
    await store.advanceX402Quote({ quoteId, expectedState: "CLAIMED", targetState: "DISPATCHED", executionId: "vexec_x" }),
    true,
  );
  assert.equal(
    await store.advanceX402Quote({ quoteId, expectedState: "DISPATCHED", targetState: "QUOTED" }), false,
    "a dispatched authorization must never become re-usable",
  );
  assert.equal(
    await store.advanceX402Quote({ quoteId, expectedState: "DISPATCHED", targetState: "SETTLED" }), true,
  );
  const settled = await store.fetchX402Quote(quoteId);
  assert.equal(settled?.state, "SETTLED");
  assert.equal(settled?.executionId, "vexec_x");

  // And a settled quote cannot be claimed by anyone.
  assert.equal((await store.claimX402Quote(quoteId, OWNER)).ok, false);
}

/* An expired quote is refused at the moment of claiming, not merely reported
   as old: the window is what bounds how long Veyra will carry a signature. */
{
  const live = selection();
  await store.recordX402Selection(live);
  const created = await store.createX402Quote(quoteInput(live.selectionId, {
    expiresAt: new Date(Date.now() + 40).toISOString(),
  }));
  const quoteId = (created as any).quoteId as string;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const claimed = await store.claimX402Quote(quoteId, OWNER);
  assert.deepEqual([claimed.ok, (claimed as any).reason], [false, "QUOTE_EXPIRED"]);
}

/* The body binds by value, and the binding is the shared canonical hash -- so
   the same request built in a different key order is the same request, and a
   changed one is not. */
{
  const priced = canonicalRequestHash({ query: "what changed", limit: 3 });
  assert.equal(priced, canonicalRequestHash({ limit: 3, query: "what changed" }));
  assert.notEqual(priced, canonicalRequestHash({ query: "what changed", limit: 4 }));
}

console.log("[x402-decision-enforcement-test] passed: a quote exists only against a live decision owned by the same wallet, naming the decided payee, asset and chain at or under the decided ceiling and expiring no later than it; resource, method and verification tier come from the decision and cannot be sent; and one signature is claimed once, with the only walk-back being a relay that never left");
