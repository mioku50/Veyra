/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shadow autonomy: the mandate that gained two fields without moving, the day
 * measured on the owner's clock, and the decision that says every reason.
 */

import assert from "node:assert/strict";
import {
  buildMandateEip712Message, computeCanonicalMandateHash, mandateTypesFor,
  EIP712_MANDATE_TYPES, EIP712_MANDATE_TYPES_V2, MANDATE_VERSION_V2,
} from "../lib/execution/canonical.ts";
import {
  AUTONOMY_CHECKS, budgetPeriodFor, consumesAttempt, evaluateShadow, isValidTimezone,
  mandateReadiness, shadowSummaryFrom, spendOf,
  type ShadowRecord, type VerifiedMandate,
} from "../lib/nova/autonomy.ts";
import type { ExecutionMandate } from "../lib/execution/types.ts";
import type { NovaResearchProposal } from "../lib/nova/research.ts";

/* ------------------------------------------------------------------ v1 froze */

/**
 * The golden hash was taken from the committed file before v2 was written, by
 * checking the previous revision out and running the same fixture through it.
 * It is the whole point of versioning rather than extending: a wallet that
 * showed somebody nine limits cannot afterwards be said to have shown eleven,
 * and this is the assertion that says so in a way that fails loudly.
 */
const V1_GOLDEN = "0xc0d7ae35b9bf4f238ac854393044c8c3a0cc582b98d2e1c0f748baaf7d9d0707";
const V1_KEYS = "mandateId,ownerWallet,subjectAgentId,subjectWallet,mode,network,capabilitiesHash,"
  + "railsHash,maxPerTransactionUsdc,maxPerDayUsdc,maxTotalUsdc,minimumTrustScore,minimumConfidence,"
  + "requireVerifiedIdentity,evaluatorThresholdUsdc,nonce,version,issuedAt,expiresAt";

const fixture = {
  mandateId: "mnd_fixed_for_the_golden_hash",
  ownerWallet: "0x9b57b2aCf3242db458B5EadD5e2026eaccB33dAD" as `0x${string}`,
  subjectAgentId: "nva_t12w6so1sfo5qdsclujv",
  subjectWallet: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  mode: "PREPARE", network: "eip155:8453",
  allowedCapabilities: ["research", "search"], allowedRails: ["x402"],
  maxPerTransactionUsdc: 0.005, maxPerDayUsdc: 0.02, maxTotalUsdc: 0.1,
  minimumTrustScore: 90, minimumConfidence: 0.5,
  requireVerifiedIdentity: true, evaluatorThresholdUsdc: 0,
  nonce: 0, issuedAt: "2026-09-14T00:00:00.000Z", expiresAt: "2026-12-14T00:00:00.000Z",
};

const v1 = buildMandateEip712Message({ ...fixture, version: "v1" });
assert.equal(Object.keys(v1).join(","), V1_KEYS, "a v1 message grew or lost a field");
assert.equal(computeCanonicalMandateHash(v1), V1_GOLDEN,
  "v1 no longer hashes the way it did when people signed it");

/* And the default is still v1: an unversioned mandate is not quietly upgraded
   into one that grants unattended spending. */
const unversioned = buildMandateEip712Message(fixture);
assert.equal(computeCanonicalMandateHash(unversioned), V1_GOLDEN, "the default version moved");

const v2 = buildMandateEip712Message({
  ...fixture, version: MANDATE_VERSION_V2,
  budgetTimezone: "Europe/Berlin", maxAutonomousAttemptsPerDay: 4,
});
assert.ok("budgetTimezone" in v2 && "maxAutonomousAttemptsPerDay" in v2, "v2 carries both fields");
assert.notEqual(computeCanonicalMandateHash(v2), V1_GOLDEN, "v2 is a different statement");
assert.equal(mandateTypesFor("v1"), EIP712_MANDATE_TYPES);
assert.equal(mandateTypesFor(MANDATE_VERSION_V2), EIP712_MANDATE_TYPES_V2);
assert.equal(mandateTypesFor(undefined), EIP712_MANDATE_TYPES, "unknown versions are not v2");
/* The two extra fields sit next to the limits they qualify, which is where a
   person reading a wallet prompt will look for them. */
const v2Names = EIP712_MANDATE_TYPES_V2.ExecutionMandate.map((field) => field.name);
assert.equal(v2Names[v2Names.indexOf("maxTotalUsdc") + 1], "budgetTimezone");
assert.equal(v2Names[v2Names.indexOf("budgetTimezone") + 1], "maxAutonomousAttemptsPerDay");

/* ------------------------------------------------------------- readiness */

const now = new Date("2026-09-14T03:00:00.000Z");
function mandate(over: Partial<ExecutionMandate> = {}): ExecutionMandate {
  return {
    ...fixture, mode: "AUTOPILOT", version: MANDATE_VERSION_V2,
    budgetTimezone: "Europe/Berlin", maxAutonomousAttemptsPerDay: 4,
    canonicalHash: "0xhash", signature: "0xsig" as `0x${string}`,
    createdAt: fixture.issuedAt, revokedAt: null,
    ...over,
  } as ExecutionMandate;
}

assert.equal(mandateReadiness(null, now).ready, false);
const noV1 = mandateReadiness(mandate({ version: "v1" }), now);
assert.equal(noV1.ready, false);
assert.equal(noV1.ready === false && noV1.reason, "mandate_version_predates_autonomy",
  "a signature given before unattended limits existed does not grant them");
assert.equal(
  (mandateReadiness(mandate({ mode: "PREPARE" as never }), now) as { reason: string }).reason,
  "mandate_mode_not_autopilot");
assert.equal(
  (mandateReadiness(mandate({ revokedAt: "2026-09-13T00:00:00Z" }), now) as { reason: string }).reason,
  "mandate_revoked");
assert.equal(
  (mandateReadiness(mandate({ expiresAt: "2026-09-13T00:00:00Z" }), now) as { reason: string }).reason,
  "mandate_expired");
/* Refused, not defaulted. A budget day is a term the owner signed, and
   measuring it in a zone they did not name would be Veyra editing it. */
assert.equal(
  (mandateReadiness(mandate({ budgetTimezone: "Mars/Olympus" }), now) as { reason: string }).reason,
  "mandate_timezone_unusable");
assert.equal(
  (mandateReadiness(mandate({ budgetTimezone: null }), now) as { reason: string }).reason,
  "mandate_timezone_unusable");

const ready = mandateReadiness(mandate(), now);
assert.equal(ready.ready, true);
const verified = (ready as { mandate: VerifiedMandate }).mandate;

/* ------------------------------------------------------------ budget days */

assert.equal(isValidTimezone("Europe/Berlin"), true);
assert.equal(isValidTimezone("Mars/Olympus"), false);
assert.equal(isValidTimezone(""), false);

const utcDay = budgetPeriodFor(new Date("2026-09-14T03:00:00Z"), "UTC");
assert.equal(utcDay.start, "2026-09-14T00:00:00.000Z");
assert.equal(utcDay.end, "2026-09-15T00:00:00.000Z");

/* Berlin in summer is UTC+2, so the owner's day begins at 22:00 the day
   before. This is the bug the field exists for: 00:30 and 02:30 UTC are the
   same night to a person in Berlin, and under a UTC budget they are two days
   -- one unattended night could spend two daily budgets. */
const early = budgetPeriodFor(new Date("2026-09-14T00:30:00Z"), "Europe/Berlin");
const later = budgetPeriodFor(new Date("2026-09-14T02:30:00Z"), "Europe/Berlin");
assert.equal(early.start, "2026-09-13T22:00:00.000Z");
assert.deepEqual(early, later, "one Berlin night is one budget day");
assert.notEqual(
  budgetPeriodFor(new Date("2026-09-14T00:30:00Z"), "UTC").start,
  budgetPeriodFor(new Date("2026-09-13T23:30:00Z"), "UTC").start,
  "and under UTC those two instants really do fall in different days");

/* Winter is UTC+1. */
assert.equal(budgetPeriodFor(new Date("2026-01-15T12:00:00Z"), "Europe/Berlin").start,
  "2026-01-14T23:00:00.000Z");

const hours = (period: { start: string; end: string }) =>
  (Date.parse(period.end) - Date.parse(period.start)) / 3_600_000;
/* The EU springs forward on 2026-03-29 and falls back on 2026-10-25. A day is
   not always 24 hours, and a budget that assumed it was would be an hour wrong
   twice a year in the direction of overspending. */
assert.equal(hours(budgetPeriodFor(new Date("2026-03-29T12:00:00Z"), "Europe/Berlin")), 23);
assert.equal(hours(budgetPeriodFor(new Date("2026-10-25T12:00:00Z"), "Europe/Berlin")), 25);
assert.equal(hours(budgetPeriodFor(new Date("2026-09-14T12:00:00Z"), "Europe/Berlin")), 24);

/* A zone west of UTC, where the owner's day starts after the UTC one. */
assert.equal(budgetPeriodFor(new Date("2026-09-14T12:00:00Z"), "America/New_York").start,
  "2026-09-14T04:00:00.000Z");
/* And a half-hour zone, because they exist and integer-hour arithmetic hides. */
assert.equal(budgetPeriodFor(new Date("2026-09-14T12:00:00Z"), "Asia/Kolkata").start,
  "2026-09-13T18:30:00.000Z");

/* ------------------------------------------------------------- decisions */

const period = budgetPeriodFor(now, "Europe/Berlin");
function proposal(over: Partial<NovaResearchProposal> = {}): NovaResearchProposal {
  return {
    signalId: "sig", question: "What changed?", capability: "research", provider: "Exa",
    resource: "https://api.exa.ai/search", costUsdc: 0.003, trustScore: 96,
    funding: "wallet", paymentLabel: "Direct USDC", payableNow: true,
    decision: "ALLOW", verdict: "ok", maxExposureUsdc: 0.003, verifiedAfterPaying: true,
    reasons: [], probed: 3, routingNote: null, actionType: "learn_about_subject",
    subjectLabel: "LangChain", performedVia: "Exa", expiresAt: "2026-09-14T04:00:00Z",
    termsHash: "0xterms", ...over,
  } as NovaResearchProposal;
}
const idle = { spentUsdc: 0, spentTotalUsdc: 0, attempts: 0 };

const allowed = evaluateShadow({ mandate: verified, proposal: proposal(), usage: idle, period });
assert.equal(allowed.verdict, "WOULD_ALLOW");
assert.deepEqual(allowed.failed, []);
assert.equal(allowed.attemptNumber, 1, "the number it would take, not the number taken");
assert.equal(consumesAttempt(allowed), true);
assert.equal(spendOf(allowed), 0.003);

/* Every check runs and every code is reachable, so a morning brief counting
   reasons is counting the whole list rather than whichever one failed first. */
assert.deepEqual(allowed.checks.map((check) => check.code), [...AUTONOMY_CHECKS],
  "the decision reports exactly the declared checks, in order");

const overLimit = evaluateShadow({
  mandate: verified, proposal: proposal({ costUsdc: 0.02 }), usage: idle, period,
});
assert.equal(overLimit.verdict, "WOULD_DENY");
assert.deepEqual(overLimit.failed, ["within_per_action_limit"]);
assert.equal(consumesAttempt(overLimit), false,
  "a denial never reached the point of paying, so it does not spend the day's allowance");
assert.equal(spendOf(overLimit), 0, "and it did not spend money either");
assert.equal(overLimit.wouldSpendUsdc, 0.02,
  "though what it would have cost is still reported, or the brief cannot say what it saved");

/* Two reasons, both told. Stopping at the first would hide that raising the
   limit alone would not have helped. */
const twoFaults = evaluateShadow({
  mandate: verified, proposal: proposal({ costUsdc: 0.02, trustScore: 40 }), usage: idle, period,
});
assert.deepEqual(twoFaults.failed.sort(), ["trust_at_least_minimum", "within_per_action_limit"]);

const gateway = evaluateShadow({
  mandate: verified, proposal: proposal({ funding: "gateway_deposit" }), usage: idle, period,
});
assert.deepEqual(gateway.failed, ["payable_unattended"],
  "a purchase that needs a person cannot be allowed while the person is asleep");

const spent = evaluateShadow({
  mandate: verified, proposal: proposal(), period,
  usage: { spentUsdc: 0.018, spentTotalUsdc: 0.018, attempts: 1 },
});
assert.deepEqual(spent.failed, ["within_daily_budget"]);

const exhausted = evaluateShadow({
  mandate: verified, proposal: proposal(), period,
  usage: { spentUsdc: 0, spentTotalUsdc: 0, attempts: 4 },
});
assert.deepEqual(exhausted.failed, ["attempts_remaining"]);
assert.equal(exhausted.attemptNumber, 5);

const wrongCapability = evaluateShadow({
  mandate: verified, proposal: proposal({ capability: "token_transfer" }), usage: idle, period,
});
assert.deepEqual(wrongCapability.failed, ["capability_allowed"]);

const wrongNetwork = evaluateShadow({
  mandate: verified, proposal: proposal(), usage: idle, period, network: "eip155:5042002",
});
assert.deepEqual(wrongNetwork.failed, ["network_matches_mandate"]);

const wrongRail = evaluateShadow({
  mandate: verified, proposal: proposal(), usage: idle, period, rail: "erc8183",
});
assert.deepEqual(wrongRail.failed, ["rail_allowed"]);

const reviewed = evaluateShadow({
  mandate: verified, proposal: proposal({ decision: "REVIEW_REQUIRED" }), usage: idle, period,
});
assert.deepEqual(reviewed.failed, ["veyra_decision_allows"]);

/* ------------------------------------------------------------- the morning */

let recordSeq = 0;
function record(over: Partial<ShadowRecord> = {}): ShadowRecord {
  recordSeq += 1;
  return {
    decisionId: `d${recordSeq}`, signalId: `s${recordSeq}`, verdict: "WOULD_ALLOW",
    question: "?", capability: "research", provider: "Exa", resource: "https://x",
    rail: "x402", network: null, trustScore: 96, wouldSpendUsdc: 0.003,
    checks: [], failed: [], attemptNumber: 1, period, ownerFeedback: null,
    decidedAt: "2026-09-14T03:00:00.000Z", ...over,
  };
}

const night = shadowSummaryFrom([
  record(),
  record({ verdict: "WOULD_DENY", wouldSpendUsdc: 0.02, failed: ["within_per_action_limit"] }),
  record({ verdict: "WOULD_DENY", wouldSpendUsdc: 0.03, failed: ["within_per_action_limit"] }),
  record({ verdict: "WOULD_DENY", wouldSpendUsdc: 0.004, failed: ["trust_at_least_minimum"] }),
], { period, dailyBudgetUsdc: 0.02 });

assert.equal(night.decisions, 4);
assert.equal(night.wouldInvestigate, 1);
assert.equal(night.wouldDecline, 3);
assert.equal(night.wouldSpendUsdc.toFixed(4), "0.0030", "only allowances would have been spent");
assert.equal(night.withheldUsdc.toFixed(4), "0.0540", "and this is what the limits saved");
assert.deepEqual(night.declinedBecause, [
  { code: "within_per_action_limit", count: 2 },
  { code: "trust_at_least_minimum", count: 1 },
], "most common reason first");
assert.equal(night.remainingTodayUsdc?.toFixed(4), "0.0170");

/* A decision denied for two reasons is counted under both. Which one the owner
   raises changes nothing unless they raise the other too. */
const doubled = shadowSummaryFrom([
  record({ verdict: "WOULD_DENY", failed: ["within_per_action_limit", "trust_at_least_minimum"] }),
], { period });
assert.deepEqual(doubled.declinedBecause.map((entry) => entry.count), [1, 1]);
assert.equal(doubled.wouldDecline, 1, "but it is still one decision");

/* An unknown budget is not an exhausted one. */
assert.equal(shadowSummaryFrom([record()], { period }).remainingTodayUsdc, null);

/* Yesterday's decisions are not in today's brief. */
const yesterday = { ...period, start: "2026-09-12T22:00:00.000Z", end: "2026-09-13T22:00:00.000Z" };
const today = shadowSummaryFrom([record(), record({ period: yesterday })], { period });
assert.equal(today.decisions, 1, "a budget day is the unit the morning reports");

console.log("nova autonomy: v1 frozen at its golden hash, budget days on the owner's clock "
  + "through both DST turns, every check reported on every decision, and a morning that counts "
  + "what was withheld as well as what would have been spent");
