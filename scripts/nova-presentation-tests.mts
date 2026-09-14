/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Invariants on the sentences that claim a state.
 *
 * Not snapshots. A snapshot of copy fails every time the copy improves, so it
 * trains whoever runs it to accept the new output without reading it -- which
 * is the opposite of a guard. These assert promises instead: what a sentence
 * must say given the state it was handed, and what it must never say. They stay
 * silent through a rewrite and fail when the meaning drifts.
 *
 * Every case here is a mistake that actually shipped.
 */

import assert from "node:assert/strict";
import {
  agentAccessState, arcIdentityState, briefSummary, identityExplanation, identityHeadline,
  arcViewBlurb, plain, purchaseStanding, purchaseSummary, transferWarning,
  type ArcIdentityState, type Claim,
} from "../lib/nova/presentation.ts";
import { standingFrom } from "../lib/nova/standing.ts";
import type { NovaArcIdentity, NovaDerivedStanding, NovaInvestigation } from "../lib/nova/types.ts";

const seen: Claim[] = [];
function read(claim: Claim): string {
  seen.push(claim);
  return plain(claim);
}
function must(claim: Claim, phrase: RegExp, why: string) {
  assert.match(read(claim), phrase, why);
}
function mustNot(claim: Claim, phrase: RegExp, why: string) {
  assert.doesNotMatch(read(claim), phrase, why);
}

function standing(over: Partial<NovaDerivedStanding> = {}): NovaDerivedStanding {
  return {
    verifiedResearch: 0, veyraDecisions: 0, observedOutcomes: 0, readyForArcIdentity: false,
    spentUsdc: 0, attestedOnArc: 0, providers: [], ...over,
  };
}
const minted: NovaArcIdentity = {
  registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", agentId: "895012", chainId: 5042002,
  owner: "0x9b57b2aCf3242db458B5EadD5e2026eaccB33dAD", transaction: "0xabc",
  registeredAt: "2026-09-14T00:00:00.000Z",
};

/* 1. The heading that sat above "ERC-8004 Agent #895012" and contradicted it. */
const claimed = arcIdentityState(minted, standing());
assert.equal(claimed.kind, "claimed");
mustNot(identityHeadline(claimed, "Nova"), /not an identity/i,
  "a claimed identity cannot be described as absent");
mustNot(identityExplanation(claimed, "Nova"), /not an identity on Arc|earn|eligib/i,
  "nothing is being earned once it is owned");

/* 2. And it names the thing it is talking about. */
must(identityHeadline(claimed, "Nova"), /895012/, "the headline names the agent id");

/* 3. The production case: minted under the older rule, standing empty. An
      identity that exists outranks every counter, or the page argues with the
      panel under it all over again. */
assert.equal(arcIdentityState(minted, standing({ verifiedResearch: 0 })).kind, "claimed");

/* 4. Eligibility is two halves, and the sentence used to credit one. */
const earned = arcIdentityState(null, standing({
  verifiedResearch: 1, attestedOnArc: 1, readyForArcIdentity: true,
}));
assert.equal(earned.kind, "earned_not_claimed");
must(identityExplanation(earned, "Nova"), /delivery check/, "names the purchase half");
must(identityExplanation(earned, "Nova"), /on Arc/, "names the attestation half");
mustNot(identityHeadline(earned, "Nova"), /has an identity on Arc\b(?! and has not)/,
  "eligible is not claimed");

/* 5. A purchase that nobody outside Veyra can read is a different situation
      from no purchase at all, and the page has a different next step for it. */
const halfway = arcIdentityState(null, standing({ verifiedResearch: 1, attestedOnArc: 0 }));
assert.equal(halfway.kind, "not_earned");
must(identityExplanation(halfway, "Nova"), /nothing on Arc yet/, "says which half is missing");
must(identityExplanation(halfway, "Nova"), /1 purchase/, "and that the other half is there");

const nothing = arcIdentityState(null, standing());
mustNot(identityExplanation(nothing, "Nova"), /\bhas 0\b|has 1 purchase/,
  "with no purchases the page does not describe purchases");

/* 6. Exhaustive: the claimed wording and the absent wording never coexist. */
const states: ArcIdentityState[] = [claimed, earned, halfway, nothing];
for (const state of states) {
  const text = [identityHeadline, identityExplanation, arcViewBlurb]
    .map((write) => plain(write(state, "Nova"))).join(" ");
  const saysAbsent = /not an identity/i.test(text);
  const saysOwned = /Agent #/.test(text);
  assert.ok(!(saysAbsent && saysOwned), `${state.kind} claims both at once`);
  seen.push(arcViewBlurb(state, "Nova"));
}

/* 7. "1 of 6": attempts in the denominator of a fraction about payments. */
const funnel = purchaseStanding(standing({
  veyraDecisions: 6, observedOutcomes: 3, verifiedResearch: 1, spentUsdc: 0.018, attestedOnArc: 1,
}));
must(purchaseSummary(funnel), /of 3/, "the denominator is payments");
mustNot(purchaseSummary(funnel), /of 6/, "never attempts");

/* 8. Nothing paid is not a zero percent success rate. */
mustNot(purchaseSummary(purchaseStanding(standing({ veyraDecisions: 4 }))), / of /,
  "no fraction where no money moved");

/* 9. A numerator above its denominator prints two counts, not 150%. */
must(purchaseSummary({ attempts: 2, paid: 1, passed: 2, spentUsdc: 0.01, attested: 0 }),
  /2 passed, 1 paid/, "inconsistent counts are reported as counts");

/* 10. And these are a projection, never a second count. */
const investigation = (over: Partial<NovaInvestigation>): NovaInvestigation => ({
  researchId: "r", signalId: "s", status: "verified", question: "?", proposal: {},
  authorisedUsdc: 0.007, provider: "Exa", executionPublicId: "vexec", paidUsdc: 0.007,
  transaction: "0x", verification: null, reading: null, arcProof: null, result: null,
  failure: null, settledAt: "2026-09-14T00:00:00.000Z", ...over,
} as NovaInvestigation);
const derived = standingFrom([investigation({}), investigation({ status: "unpaid", paidUsdc: 0 })]);
assert.deepEqual(purchaseStanding(derived), {
  attempts: derived.veyraDecisions, paid: derived.observedOutcomes,
  passed: derived.verifiedResearch, spentUsdc: derived.spentUsdc, attested: derived.attestedOnArc,
}, "the receipts page reads the counts, it does not recount them");

/* 11. The transfer sentence that was false in the expensive direction: the
      token moves and the new holder has no way in, because the way in is the
      recovery key. */
const owned = agentAccessState(minted);
assert.equal(owned.onchainOwner, minted.owner);
mustNot(transferWarning(owned, "Nova", "Veyra"), /nothing else changes|and nothing else/i,
  "a transfer does not leave everything else intact");
must(transferWarning(owned, "Nova", "Veyra"), /recovery key/,
  "it says what access actually follows");
must(transferWarning(owned, "Nova", "Veyra"), /does not exist yet/,
  "a missing feature is named as missing");

/* 12. Nothing owned, nothing to warn about. A warning on every screen would
      make the absent case look like a risk. */
assert.equal(transferWarning(agentAccessState(null), "Nova", "Veyra").length, 0);

/* 13. The brief keeps low relevance too, so it cannot call all of it notable. */
const five = briefSummary({ inBrief: 5, unreachable: [], watched: 9 });
mustNot(five, /worth your attention|notable|important/i,
  "the brief reports its size, not its verdict");
must(five, /^5 items in today/, "and reports it exactly");

/* 14. One item is an item. */
must(briefSummary({ inBrief: 1, unreachable: [], watched: 9 }), /^1 item in/, "singular");
must(briefSummary({ inBrief: 0, unreachable: [], watched: 1 }), /1 thing being/, "singular");

/* 15. A blind day reported as a quiet day is a lie a daily product would tell
      every day it was broken. */
const blind = briefSummary({ inBrief: 0, unreachable: ["GitHub"], watched: 4 });
mustNot(blind, /Nothing moved/, "an unread source is not a quiet morning");
must(blind, /incomplete look/, "it says so");

/* 16. Everything above, read as prose: no gaps left by a dropped separator and
      no figure rendered empty. */
for (const claim of seen) {
  const text = plain(claim);
  assert.doesNotMatch(text, /\s{2,}/, `double space in "${text}"`);
  assert.doesNotMatch(text, /\s[,.]/, `space before punctuation in "${text}"`);
  for (const part of claim) {
    if (typeof part !== "string") assert.ok(part.figure.length > 0, `empty figure in "${text}"`);
  }
}

console.log(`nova presentation: ${seen.length} claims, every promise held`);
