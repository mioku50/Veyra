/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Standing, counted from what was actually bought.
 */

import assert from "node:assert/strict";
import { priorWith, standingFrom, RATE_NEEDS_ATTEMPTS } from "../lib/nova/standing.ts";
import type { NovaInvestigation } from "../lib/nova/types.ts";

let seq = 0;
function attempt(over: Partial<NovaInvestigation>): NovaInvestigation {
  seq += 1;
  return {
    researchId: `r${seq}`, signalId: `s${seq}`, status: "verified",
    question: "?", proposal: {}, authorisedUsdc: 0.007, provider: "Exa",
    executionPublicId: `vexec_${seq}`, paidUsdc: 0.007, transaction: "0xabc",
    verification: { verdict: "PASS", summary: "ok" }, reading: null, arcProof: null,
    result: null, failure: null, settledAt: `2026-09-${10 + seq}T00:00:00.000Z`,
    ...over,
  } as NovaInvestigation;
}

/* Three counters off one purchase is one fact printed three times. Standing is
   read from the purchases themselves, so a proposal nobody paid for moves
   nothing at all. */
const pending = standingFrom([attempt({ status: "proposed", paidUsdc: null })]);
assert.equal(pending.veyraDecisions, 0, "a proposal is not an attempt");
assert.equal(pending.spentUsdc, 0);
assert.equal(pending.providers.length, 0);
assert.equal(pending.readyForArcIdentity, false);

const mixed = standingFrom([
  attempt({ provider: "Exa", status: "verified", paidUsdc: 0.007, arcProof: { transaction: "0x1" } as never }),
  attempt({ provider: "Sponge", status: "paid_unverified", paidUsdc: 0.01, verification: { verdict: "FAIL", summary: "no" } }),
  attempt({ provider: "StableEnrich", status: "unpaid", paidUsdc: 0, verification: null }),
]);
assert.equal(mixed.veyraDecisions, 3, "every settled attempt counts, paid or not");
assert.equal(mixed.verifiedResearch, 1);
assert.equal(mixed.spentUsdc.toFixed(4), "0.0170", "and only money that moved is spent");
assert.equal(mixed.attestedOnArc, 1);
assert.equal(mixed.observedOutcomes, 2, "two payments moved; the refused one did not");
assert.ok(mixed.veyraDecisions > mixed.observedOutcomes && mixed.observedOutcomes > mixed.verifiedResearch,
  "attempt, payment and result are three different numbers, and the funnel narrows");
assert.equal(mixed.readyForArcIdentity, true);
assert.deepEqual(mixed.providers.map((p) => p.provider), ["StableEnrich", "Sponge", "Exa"], "newest first");

/* The per-counterparty record is the only thing here that can change a
   decision, so it has to be right about which way each attempt went. */
const sponge = mixed.providers.find((p) => p.provider === "Sponge");
assert.equal(sponge?.paid, 1);
assert.equal(sponge?.passed, 0);
assert.equal(sponge?.failedAfterPaying, 1);
const refused = mixed.providers.find((p) => p.provider === "StableEnrich");
assert.equal(refused?.paid, 0);
assert.equal(refused?.nothingMoved, 1);
assert.equal(refused?.spentUsdc, 0, "a signature that moved nothing spent nothing");

/* A record is not a rate. With one attempt behind it there is nothing to
   average, and "0% success" over a single bad morning invents a confidence
   nobody has. */
for (const [provider, expect] of [
  ["Exa", /passed its check/],
  ["Sponge", /did not pass its check/],
  ["StableEnrich", /nothing moved/],
] as const) {
  const line = priorWith(mixed, provider);
  assert.ok(line, `${provider} has a record`);
  assert.match(line.sentence, expect);
  assert.doesNotMatch(line.sentence, /%/, "never a percentage");
  assert.match(line.sentence, /\bonce\b/, "one attempt is said as once, not as 1");
}
assert.equal(priorWith(mixed, "Exa")?.tone, "good");
assert.equal(priorWith(mixed, "Sponge")?.tone, "warn");
assert.equal(priorWith(mixed, "StableEnrich")?.tone, "idle");

/* Nothing shown for a seller never dealt with: a first encounter is not a
   warning, and writing "no history" on every card would make it read as one. */
assert.equal(priorWith(mixed, "Alchemy"), null);
assert.equal(priorWith(mixed, null), null);

/* Enough attempts and the sentence may generalise -- not before. */
const repeated = standingFrom(Array.from({ length: RATE_NEEDS_ATTEMPTS }, () =>
  attempt({ provider: "Exa", status: "verified", paidUsdc: 0.007 })));
assert.match(priorWith(repeated, "Exa")!.sentence, /every answer passed/);
assert.match(priorWith(mixed, "Exa")!.sentence, /the answer passed/, "one attempt speaks only for itself");

/* A seller that has both is reported as both, rather than rounded to a verdict. */
const both = standingFrom([
  attempt({ provider: "Exa", status: "verified", paidUsdc: 0.007 }),
  attempt({ provider: "Exa", status: "paid_unverified", paidUsdc: 0.007, verification: { verdict: "FAIL", summary: "no" } }),
]);
assert.match(priorWith(both, "Exa")!.sentence, /1 passed the check, 1 did not/);
assert.equal(priorWith(both, "Exa")!.tone, "warn");

console.log("[nova-standing-test] passed: standing counted from settled purchases rather than three proxies for one of them, a per-counterparty record bought with the owner's own money, and counts that never turn into a rate before there is anything to average");
