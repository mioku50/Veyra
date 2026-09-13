/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The three ways a paid investigation can end, and what each one is allowed to
 * write.
 *
 * Separate from nova-tests.mts because this one touches the real database: it
 * creates an agent, runs a pass, drives three settlements, asserts the
 * bookkeeping and deletes everything it made. Run it with the same environment
 * the app uses.
 *
 *     npm run nova:research:live
 *
 * The relay is stubbed, and that is the point rather than a shortcut. Two of
 * the three outcomes -- money moved and the answer failed its check, money did
 * not move at all -- cannot be reached on purpose against a live endpoint
 * without either spending or getting lucky, and they are the two that decide
 * whether this product tells the truth about what a payment bought.
 */

import assert from "node:assert/strict";
import { createNova, db, loadBrief, loadOwned, refreshNova, updateNova } from "../lib/nova/service.ts";
import { recordProposal, settleResearch, approveResearch } from "../lib/nova/investigation.ts";
import { hashTerms } from "../lib/nova/research-terms.ts";

const terms = {
  provider: "Test Provider",
  resource: "https://example.invalid/x402/test",
  capability: "research",
  priceAtomic: "7000",
  payTo: "0x1111111111111111111111111111111111111111",
  network: "eip155:8453",
  funding: "wallet" as const,
};

const proposal = {
  signalId: "", question: "Does this hold up?", capability: "research",
  provider: terms.provider, resource: terms.resource, costUsdc: 0.007,
  trustScore: 90, funding: "wallet" as const, paymentLabel: "Direct USDC",
  payableNow: true, decision: "REQUIRE_EVALUATOR" as const,
  verdict: "Allow up to $0.0070, and check the answer afterwards.",
  maxExposureUsdc: 0.007, verifiedAfterPaying: true, reasons: [],
  probed: 3, routingNote: null, expiresAt: new Date(Date.now() + 300_000).toISOString(),
  termsHash: hashTerms(terms),
};

const agent = await createNova({ name: "E2E", interests: ["Arc", "AI"] });
process.on("uncaughtException", async (e) => {
  await db().from("nova_agents").delete().eq("public_id", agent.agent.publicId);
  console.error("cleaned up after failure:", (e as Error).message);
  process.exit(1);
});
const owned = await loadOwned(agent.agent.publicId, agent.ownerSecret);
console.log("[research-live] agent", agent.agent.publicId);
// Signals come from a pass, not from creation.
const refreshed = await refreshNova({ publicId: agent.agent.publicId, ownerSecret: agent.ownerSecret, trigger: "creation" });
console.log("[research-live] refresh: kept", refreshed.refresh.signalsKept, "of", refreshed.refresh.signalsFound);

const { data: signals } = await db().from("nova_signals")
  .select("signal_id").eq("agent_id", owned.agent_id).limit(3);
const rows = (signals ?? []) as { signal_id: string }[];
assert(rows.length >= 3, "need three signals to drive three outcomes");

const WALLET = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

async function seed(signalId: string) {
  const researchId = await recordProposal({
    agentId: owned.agent_id, signalId,
    proposal: { ...proposal, signalId },
    plan: {
      terms, query: "test", requestBody: { query: "test" }, requestNote: null,
      inputSchema: null, outputSchema: null, candidateId: "cand_1",
      method: "POST", verificationRequired: true, maxExposureUsdc: 0.007,
    },
  });
  await db().from("nova_research").update({
    status: "approved", payer_wallet: WALLET, clearance_digest: "0xdigest",
    selection_id: "vms_test",
    approval: {
      quote: {
        resource: terms.resource, method: "POST",
        accept: {
          scheme: "exact", network: terms.network, amountAtomic: terms.priceAtomic,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: terms.payTo,
          maxTimeoutSeconds: 600, assetName: "USDC", assetVersion: "2",
          verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          gatewayBatched: false, chainId: 8453, raw: {},
        },
        quotedUsdc: 0.007, maxAmountUsdc: 0.05,
        nonce: `0x${"11".repeat(32)}`, resourceDescriptor: terms.resource,
        inputSchema: null, outputSchema: null, quotedAt: new Date().toISOString(),
      },
      candidateId: "cand_1", selectionId: "vms_test", decision: "REQUIRE_EVALUATOR",
      verificationRequired: true, outputSchema: null, capability: "research",
      selectionHash: "0xselection",
    },
  }).eq("research_id", researchId);
  return researchId;
}

const authorization = {
  from: WALLET, to: terms.payTo, value: terms.priceAtomic,
  validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 600),
  nonce: `0x${"11".repeat(32)}`,
};
const signature = `0x${"ab".repeat(65)}`;

function relay(verdict: string, paid: boolean | null, settled: boolean) {
  return async () => ({
    kind: "settled" as const,
    result: {
      settled, executionId: `vexec_${verdict.toLowerCase()}${paid ? "p" : "u"}`,
      executionState: "COMPLETED", paid, status: 200, paidUsdc: paid ? 0.007 : 0,
      payTo: terms.payTo, network: terms.network, latencyMs: 900,
      settlement: { success: paid, transaction: "0xtx" },
      transaction: "0xtx",
      verification: { verdict, summary: `${verdict} from the stub` } as any,
      result: { answer: "42" }, body: null,
    },
  });
}

// 1. verified
const r1 = await seed(rows[0].signal_id);
const out1 = await settleResearch({
  publicId: agent.agent.publicId, ownerSecret: agent.ownerSecret, researchId: r1,
  authorization, signature, settleImpl: relay("PASS", true, true) as any,
});
assert.equal(out1.status, "verified", "a passing verification is a verified investigation");

// 2. paid, verification failed
const r2 = await seed(rows[1].signal_id);
const out2 = await settleResearch({
  publicId: agent.agent.publicId, ownerSecret: agent.ownerSecret, researchId: r2,
  authorization, signature, settleImpl: relay("FAIL", true, false) as any,
});
assert.equal(out2.status, "paid_unverified", "money moved and the answer failed: not a success");
assert(out2.investigation.failure?.includes("did not pass"), "the failure must say so plainly");

// 3. nothing paid
const r3 = await seed(rows[2].signal_id);
const out3 = await settleResearch({
  publicId: agent.agent.publicId, ownerSecret: agent.ownerSecret, researchId: r3,
  authorization, signature, settleImpl: relay("INCONCLUSIVE", false, false) as any,
});
assert.equal(out3.status, "unpaid");

// ---- bookkeeping ----
const { data: memory } = await db().from("nova_memory")
  .select("kind, facet, summary, execution_public_id, signal_id")
  .eq("agent_id", owned.agent_id).eq("kind", "learning");
const learnings = (memory ?? []) as any[];
assert.equal(learnings.length, 1, "exactly one learning: only the verified one earns it");
assert.equal(learnings[0].execution_public_id, "vexec_passp", "a learning carries its receipt");
assert.equal(learnings[0].signal_id, rows[0].signal_id);

const { data: sig } = await db().from("nova_signals")
  .select("signal_id, status, execution_public_id").eq("agent_id", owned.agent_id)
  .in("signal_id", rows.map((r) => r.signal_id));
const byId = new Map((sig as any[]).map((r) => [r.signal_id, r]));
assert.equal(byId.get(rows[0].signal_id).status, "investigated");
assert.equal(byId.get(rows[1].signal_id).status !== "investigated", true, "a failed check is not an investigated item");
assert.equal(byId.get(rows[1].signal_id).execution_public_id, null, "a failed check does not count as a Veyra decision on the brief");
assert.equal(byId.get(rows[2].signal_id).execution_public_id, null, "nothing paid, nothing filed");

const brief = await loadBrief({ publicId: agent.agent.publicId, ownerSecret: agent.ownerSecret, hourOfDay: 9 });
assert.equal(brief.standing.verifiedResearch, 1);
assert.equal(brief.standing.observedOutcomes, 1);
assert.equal(brief.standing.veyraDecisions, 1, "only the verified purchase counts on the brief");
assert.equal(brief.investigations.length, 3, "every investigation comes back with the brief");

// re-settling a terminal row must be refused
await assert.rejects(
  () => settleResearch({
    publicId: agent.agent.publicId, ownerSecret: agent.ownerSecret, researchId: r1,
    authorization, signature, settleImpl: relay("PASS", true, true) as any,
  }),
  /not been approved|already been settled/,
  "a settled investigation cannot be paid twice",
);

// a signature from a different wallet must be refused
const r4 = await seed(rows[0].signal_id);
await assert.rejects(
  () => settleResearch({
    publicId: agent.agent.publicId, ownerSecret: agent.ownerSecret, researchId: r4,
    authorization: { ...authorization, from: "0x0000000000000000000000000000000000000009" },
    signature, settleImpl: relay("PASS", true, true) as any,
  }),
  /different wallet/,
  "the wallet that approved is the wallet that pays",
);

/* ---- changing what it watches ---- */

/* rows[0] is investigated by now -- it went through the verified branch above --
   and rows[1..2] carry a payment that was refused. All three must survive an
   interest being dropped, because each is a receipt. */
const { data: beforeChange } = await db().from("nova_signals")
  .select("signal_id, status, nova_subjects(interest)")
  .eq("agent_id", owned.agent_id);
const openBefore = (beforeChange ?? []).filter((r: any) => r.status === "new" || r.status === "seen");
const paidBefore = (beforeChange ?? []).filter((r: any) => r.status === "investigated" || r.status === "investigating");
assert.ok(paidBefore.length > 0, "the fixture must leave at least one investigated signal to protect");

const changed = await updateNova({
  publicId: agent.agent.publicId,
  ownerSecret: agent.ownerSecret,
  interests: ["Agent payments"],
});
assert.deepEqual(changed.agent.interests, ["Agent payments"], "the new interests are what was asked for");
assert.deepEqual(
  [...changed.droppedInterests].sort(),
  ["AI", "Arc"],
  "what stopped being watched is named back, or a person cannot tell what they just lost",
);

const { data: afterChange } = await db().from("nova_signals")
  .select("signal_id, status")
  .eq("agent_id", owned.agent_id);
const byIdAfter = new Map((afterChange ?? []).map((r: any) => [r.signal_id, r.status]));

for (const row of paidBefore as any[]) {
  assert.equal(
    byIdAfter.get(row.signal_id),
    row.status,
    "an investigation is a receipt and must survive the interest that found it",
  );
}
for (const row of openBefore as any[]) {
  assert.equal(
    byIdAfter.get(row.signal_id),
    "dismissed",
    "an open signal from a dropped interest must leave the brief",
  );
}
assert.equal(changed.retiredSignals, openBefore.length, "the count reported is the count retired");

/* The subjects stay. nova_signals.subject_id is ON DELETE SET NULL, so deleting
   them would strip provenance from the investigations just protected. */
const { count: subjectsLeft } = await db().from("nova_subjects")
  .select("*", { count: "exact", head: true }).eq("agent_id", owned.agent_id);
assert.ok((subjectsLeft ?? 0) > 0, "subjects are unwatched, not deleted");

await assert.rejects(
  () => updateNova({ publicId: agent.agent.publicId, ownerSecret: agent.ownerSecret, interests: [] }),
  /at least one/,
  "an agent that cares about nothing has nothing to watch",
);
await assert.rejects(
  () => updateNova({ publicId: agent.agent.publicId, ownerSecret: "not-the-secret", interests: ["Arc"] }),
  /No such agent/,
  "only the holder of the secret may change what an agent watches",
);

await db().from("nova_agents").delete().eq("agent_id", owned.agent_id);
for (const table of ["nova_research", "nova_memory", "nova_signals", "nova_subjects", "nova_refreshes"]) {
  const { count } = await db().from(table).select("*", { count: "exact", head: true })
    .eq("agent_id", owned.agent_id);
  assert.equal(count ?? 0, 0, `${table} left orphans`);
}
console.log("[research-live] passed — verified / paid_unverified / unpaid, one learning with a receipt, no double settle, no cross-wallet signature, interests changed without losing a receipt, 0 orphans");
