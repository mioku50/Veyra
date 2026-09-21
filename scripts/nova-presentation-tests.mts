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
  arcViewBlurb, autonomyStateClaim, declineReasonLabel, plain, purchaseStanding, purchaseSummary,
  shadowDeclineClaims, shadowNightClaim, shadowRemainingClaim, shadowSpendClaim,
  shadowVerdictClaim, transferWarning, previewOnlyWarning, EXPLAINED_BLOCKS,
  LABELLED_DECLINE_CODES, NO_MONEY_CAN_MOVE, NO_MONEY_MOVED,
  type ArcIdentityState, type Claim,
} from "../lib/nova/presentation.ts";
import { standingFrom } from "../lib/nova/standing.ts";
import {
  AUTONOMY_BLOCKS, AUTONOMY_CHECKS, shadowSummaryFrom, type ShadowRecord,
} from "../lib/nova/autonomy.ts";
import type { NovaShadowView } from "../lib/nova/types.ts";
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
must(briefSummary({ inBrief: 0, unreachable: [], watched: 1 }), /1 thing checked/, "singular");

/* 15. A blind day reported as a quiet day is a lie a daily product would tell
      every day it was broken. */
const blind = briefSummary({ inBrief: 0, unreachable: ["GitHub"], watched: 4 });
mustNot(blind, /Nothing moved/, "an unread source is not a quiet morning");
must(blind, /incomplete look/, "it says so");

/* ---- shadow autonomy: the one claim the whole phase rests on ------------ */

const period = { start: "2026-09-13T22:00:00.000Z", end: "2026-09-14T22:00:00.000Z", timezone: "Europe/Berlin" };
let shadowSeq = 0;
const shadowRecord = (over: Partial<ShadowRecord> = {}): ShadowRecord => {
  shadowSeq += 1;
  return {
    decisionId: `d${shadowSeq}`, signalId: `s${shadowSeq}`, verdict: "WOULD_ALLOW", question: "?",
    capability: "research", provider: "Exa", resource: "https://x", rail: "x402", network: null,
    trustScore: 96, wouldSpendUsdc: 0.003, checks: [], failed: [], attemptNumber: 1, period,
    ownerFeedback: null, decidedAt: "2026-09-14T03:00:00.000Z", ...over,
  };
};
const view = (over: Partial<NovaShadowView> = {}): NovaShadowView => ({
  state: "watching", blocked: null,
  summary: shadowSummaryFrom([shadowRecord()], { period, dailyBudgetUsdc: 0.02 }),
  decisions: [],
  limits: {
    perActionUsdc: 0.005, dailyUsdc: 0.02, totalUsdc: 0.15, attemptsPerDay: 4,
    minimumTrustScore: 90, timezone: "Europe/Berlin", mode: "PREVIEW",
    expiresAt: "2026-09-21T00:00:00.000Z", signedBy: "0x9b57b2aCf3242db458B5EadD5e2026eaccB33dAD",
  },
  ...over,
});

const autopilotView = view({ limits: { ...view().limits!, mode: "AUTOPILOT" } });

/* 17. Nothing describing the night may reach a person without saying that
      nothing was bought. A shadow decision read as a purchase is the only way
      this phase can actually hurt somebody. */
/* Either sentence satisfies this: PREVIEW says money cannot move, a live
   mandate says none moved tonight. What is not allowed is neither. */
must(autonomyStateClaim(view(), "Nova"), /No money (moved|can move)/, "the state says it");
must(autonomyStateClaim(autopilotView, "Nova"), /No money (moved|can move)/,
  "and so does a live one");
must(shadowNightClaim(view().summary), new RegExp(NO_MONEY_MOVED), "and so does the night");
must(shadowNightClaim(shadowSummaryFrom([], { period })), new RegExp(NO_MONEY_MOVED),
  "including a night where nothing was decided");
/* And a night with no decisions must not claim the market was empty: on the
   first real night eight things came up and none could be priced. */
mustNot(shadowNightClaim(shadowSummaryFrom([], { period })), /[Nn]othing came up/,
  "no decisions is not the same as nothing to decide about");

/* 18. Off is the ordinary state, and it promises nothing. */
const off = view({ state: "off", blocked: "no_mandate", limits: null,
  summary: shadowSummaryFrom([], { period }) });
must(autonomyStateClaim(off, "Nova"), /asks before every paid action/, "off says what off means");
mustNot(autonomyStateClaim(off, "Nova"), /would have been spent|decides as if/,
  "an agent that cannot act unattended does not describe acting unattended");
mustNot(autonomyStateClaim(view(), "Nova"), /asks before every paid action/,
  "and one that is rehearsing does not claim it still asks");

/* 17b. "No money can move" is true of PREVIEW and of nothing else. The moment
       somebody signs an AUTOPILOT mandate the sentence is false, and a screen
       that kept it would be the most expensive stale claim in the product. */
must(autonomyStateClaim(view(), "Nova"), new RegExp(NO_MONEY_CAN_MOVE), "preview says it cannot");
mustNot(autonomyStateClaim(autopilotView, "Nova"), /No money can move/,
  "a live mandate must never claim money cannot move");
must(autonomyStateClaim(autopilotView, "Nova"), new RegExp(NO_MONEY_MOVED),
  "it says only that this rehearsal moved none");

/* 17c. And the warning before the wallet opens says what the wallet will not. */
must(previewOnlyWarning(), /simulation only/, "signing limits is not turning spending on");
must(previewOnlyWarning(), /new signature/, "and enabling it later needs another signature");

/* 18b. Something signed and unusable is not the same as nothing signed. Every
       block except "no mandate" says which, or somebody who just signed limits
       reads that everything is fine while their mandate is ignored. */
for (const block of AUTONOMY_BLOCKS) {
  if (block === "no_mandate") continue;
  assert.ok(EXPLAINED_BLOCKS.has(block), `${block} has no explanation for the owner`);
  const claim = autonomyStateClaim({ ...off, blocked: block }, "Nova");
  assert.notEqual(plain(claim), plain(autonomyStateClaim(off, "Nova")),
    `${block} reads exactly like having signed nothing`);
  read(claim);
}

/* 19. Allowances and denials are opposite facts. A night that allowed nothing
      never says an amount was spent. */
const allDenied = shadowSummaryFrom([
  shadowRecord({ verdict: "WOULD_DENY", wouldSpendUsdc: 0.02, failed: ["within_per_action_limit"] }),
], { period, dailyBudgetUsdc: 0.02 });
mustNot(shadowSpendClaim(allDenied), /\$/, "nothing was allowed, so no figure is spent");
must(shadowSpendClaim(allDenied), /^nothing$/, "and it says so without printing a zero");

/* 20. An unknown budget is not an exhausted one, and prints no number. */
mustNot(shadowRemainingClaim(shadowSummaryFrom([shadowRecord()], { period })), /\$/,
  "with no daily budget declared there is no remainder to show");
must(shadowRemainingClaim(view().summary), /^\$0\.0170$/, "and with one there is");

/* 21. Every check has a name a tally can use. Adding a check without a label
      would print a raw code like within_daily_budget at somebody. */
for (const code of AUTONOMY_CHECKS) {
  /* Against the map, not against the rendered string: declineReasonLabel falls
     back to the code with its underscores removed, so an output-only assertion
     is satisfied by the fallback and proves nothing. This was caught by
     deliberately adding a check and watching the suite stay green. */
  assert.ok(LABELLED_DECLINE_CODES.has(code), `${code} has no decline label`);
  for (const count of [1, 2]) {
    assert.ok(declineReasonLabel(code, count).length > 0);
  }
}

/* 22. A decision that would have been allowed still says it was not paid for. */
must(shadowVerdictClaim("WOULD_ALLOW", "Nova"), /did not pay/,
  "'would allow' is the sentence closest to reading as a purchase");
mustNot(shadowVerdictClaim("WOULD_DENY", "Nova"), /did not pay|allow this/, "and a stop is a stop");

/* 23. The tally can exceed the number of decisions, because one decision can
      fail two ways -- and both matter to whoever is tuning the limits. */
const twoWays = shadowSummaryFrom([
  shadowRecord({ verdict: "WOULD_DENY", failed: ["within_per_action_limit", "trust_at_least_minimum"] }),
], { period });
const declines = shadowDeclineClaims(twoWays);
assert.equal(declines.length, 2, "both reasons are shown");
for (const claim of declines) read(claim);

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
