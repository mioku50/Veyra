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
  VEYRA_EXECUTION_EIP712_DOMAIN,
} from "../lib/execution/canonical.ts";
import {
  asCaip2, AUTONOMY_CHECKS, budgetPeriodFor, consumesAttempt, evaluateShadow, isValidTimezone,
  mandateReadiness, shadowSummaryFrom, spendOf,
  type ShadowRecord, type VerifiedMandate,
} from "../lib/nova/autonomy.ts";
import type { ExecutionMandate } from "../lib/execution/types.ts";
import { termsFromCandidate, type NovaResearchProposal } from "../lib/nova/research.ts";
import { settlementNetworkOf } from "../lib/nova/network.ts";
import { isExecutableTrustDecision, type TrustDecisionLevel } from "../lib/trust-gate/types.ts";
import { recoverMandateSigner } from "../lib/execution/mandate.ts";
import { assertMandateAuthorizesAutopilot } from "../lib/execution/executor.ts";
import {
  isPreviewMandate, mandateFrom, previewMandateSigningRequest, previewMandateTerms,
  PREVIEW_MANDATE,
} from "../lib/nova/autonomy-mandate.ts";
import { isPolicyCapability } from "../lib/nova/capability.ts";
import {
  CALIBRATION_EPOCHS, currentEpoch, epochFor, splitByCalibration,
} from "../lib/nova/calibration.ts";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";

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

/* What a shadow mandate may say. The two terms a shadow decision cannot check
   are left neutral, and readiness refuses one that does not. */
const SHADOW_TERMS = { minimumConfidence: 0, requireVerifiedIdentity: false } as const;

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
    ...fixture, ...SHADOW_TERMS, mode: "PREVIEW", version: MANDATE_VERSION_V2,
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
/* Mode gates paying, not deciding, so every mode may be shadowed. Requiring
   AUTOPILOT would have meant asking somebody to sign a real unattended-spending
   permission in order to watch a rehearsal -- a signature that would have gone
   live the moment an operational wallet existed, with no new consent. */
for (const mode of ["PREVIEW", "PREPARE", "AUTOPILOT"] as const) {
  assert.equal(mandateReadiness(mandate({ mode: mode as never }), now).ready, true,
    `${mode} permits deciding without paying`);
}

/* A term that is signed and cannot be honoured is refused, not half-applied.
   A confidence floor and a verified-identity demand are both things a shadow
   decision has nothing to check against, and showing them as limits that work
   is the failure this codebase keeps finding. */
assert.equal(
  (mandateReadiness(mandate({ minimumConfidence: 0.5 }), now) as { reason: string }).reason,
  "mandate_sets_terms_shadow_cannot_check");
assert.equal(
  (mandateReadiness(mandate({ requireVerifiedIdentity: true }), now) as { reason: string }).reason,
  "mandate_sets_terms_shadow_cannot_check");
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
  mandate: verified, proposal: proposal(), usage: idle, period, network: asCaip2("eip155:5042002"),
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

/* ------------------------------------------------ the mandate D0 actually issues */

/* Pinned, because these are the terms an owner signs and a diff is the only
   place a change to them can be noticed. Anything moving here should be a
   deliberate edit to this assertion, not a surprise in somebody's wallet. */
assert.deepEqual([...PREVIEW_MANDATE.allowedCapabilities], ["research", "data"],
  "the capability list is the one chosen against the live catalogue");
assert.deepEqual([...PREVIEW_MANDATE.allowedRails], ["x402"]);
assert.equal(PREVIEW_MANDATE.mode, "PREVIEW", "a rehearsal cannot be signed as autopilot");
assert.equal(PREVIEW_MANDATE.subjectWallet, "0x0000000000000000000000000000000000000000");
assert.equal(PREVIEW_MANDATE.maxPerTransactionUsdc, 0.01);
assert.equal(PREVIEW_MANDATE.maxPerDayUsdc, 0.03);
assert.equal(PREVIEW_MANDATE.maxTotalUsdc, 0.15);
assert.equal(PREVIEW_MANDATE.maxAutonomousAttemptsPerDay, 3);
assert.equal(PREVIEW_MANDATE.minimumTrustScore, 90);
assert.equal(PREVIEW_MANDATE.evaluatorThresholdUsdc, 0);

/* Every value in the list is a capability, and no discovery term can be one.
   "search" was in this list and is not a capability at all -- it authorised
   nothing while looking like a permission. */
for (const capability of PREVIEW_MANDATE.allowedCapabilities) {
  assert.ok(isPolicyCapability(capability), `${capability} is not a policy capability`);
}
assert.ok(!isPolicyCapability("search"), "a discovery term must never pass as one");
assert.ok(!isPolicyCapability("arc"));
assert.ok(!PREVIEW_MANDATE.allowedCapabilities.includes("payments" as never),
  "an agent that may pay to read must not also be able to pay to move money");

/* --------------------------------------------- a day starts when a day starts */

/* A budget day is a boundary, and a boundary that moves is not one. The zone
   offset was computed from an Intl rendering with no millisecond field, so it
   came back short by the instant's own milliseconds and carried them into the
   day's start. Two passes a second apart got two different budget days, which
   is exactly what `alreadyDecided` and the unique index behind it match on --
   so the backoff never fired and production re-decided the same signals three
   times in twenty minutes. */
for (const zone of ["Europe/Berlin", "UTC", "America/New_York", "Asia/Kolkata", "Pacific/Chatham"]) {
  const base = new Date("2026-09-15T10:11:36.000Z");
  const clean = budgetPeriodFor(base, zone);
  for (const ms of [1, 253, 770, 826, 999]) {
    const shifted = budgetPeriodFor(new Date(base.getTime() + ms), zone);
    assert.deepEqual(shifted, clean,
      `${zone}: the day must not move with the millisecond it was asked on`);
  }
  assert.equal(new Date(clean.start).getTime() % 1000, 0,
    `${zone}: a budget day starts on a whole second`);
  assert.equal(
    (new Date(clean.end).getTime() - new Date(clean.start).getTime()) % 60_000, 0,
    `${zone}: and is a whole number of minutes long`);
}

/* The real row that exposed it: Europe/Berlin, mid-September, no DST turn in
   sight, and the period still came back as 22:00:00.826. */
assert.equal(
  budgetPeriodFor(new Date("2026-09-15T10:11:36.826Z"), "Europe/Berlin").start,
  "2026-09-14T22:00:00.000Z");

/* ------------------------------------------------- one predicate, not a copy */

/* Shadow used to keep its own list of the decisions it would act on, and the
   list disagreed with isExecutableTrustDecision about REQUIRE_EVALUATOR --
   which meant research could price and show a card that shadow would then
   refuse on a rule the card never mentioned. Asserted across every tier rather
   than on the one that broke, because the point is that there is no second
   list to drift, not that this tier is handled. */
const EVERY_TIER: TrustDecisionLevel[] = [
  "ALLOW", "ALLOW_WITH_LIMITS", "REQUIRE_EVALUATOR", "REVIEW_REQUIRED", "DENY",
];
for (const tier of EVERY_TIER) {
  const shadow = evaluateShadow({
    mandate: verified, usage: idle, period,
    proposal: proposal({ decision: tier, verifiedAfterPaying: tier !== "ALLOW" }),
  });
  assert.equal(
    !shadow.failed.includes("veyra_decision_allows"),
    isExecutableTrustDecision(tier),
    `shadow and the marketplace must agree about ${tier}`,
  );
}

/* The tier that was being refused, allowed -- and allowed against the
   verification rather than against the label. */
const evaluatorTier = evaluateShadow({
  mandate: verified, usage: idle, period,
  proposal: proposal({ decision: "REQUIRE_EVALUATOR", verifiedAfterPaying: true }),
});
assert.equal(evaluatorTier.verdict, "WOULD_ALLOW",
  "REQUIRE_EVALUATOR is executable, and the settle path checks the answer");
assert.match(
  evaluatorTier.checks.find((check) => check.code === "veyra_decision_allows")!.detail,
  /checked after paying/,
  "and says so, rather than naming a tier and leaving the reader to guess");

const evaluatorUnverified = evaluateShadow({
  mandate: verified, usage: idle, period,
  proposal: proposal({ decision: "REQUIRE_EVALUATOR", verifiedAfterPaying: false }),
});
assert.deepEqual(evaluatorUnverified.failed, ["veyra_decision_allows"],
  "a tier that demands a checked answer, with nothing that would check it, is not executable");

/* --------------------------------------------- the evaluator, wired for real */

/* Of the three terms a mandate signs that shadow did not read, this is the one
   a proposal can answer: above the threshold the owner set, the answer has to
   be checked after paying, and verifiedAfterPaying is exactly that. */
const withEvaluator = mandateReadiness(
  mandate({ evaluatorThresholdUsdc: 0.002 }), now) as { mandate: VerifiedMandate };
const unchecked = evaluateShadow({
  mandate: withEvaluator.mandate, usage: idle, period,
  proposal: proposal({ costUsdc: 0.003, verifiedAfterPaying: false }),
});
assert.deepEqual(unchecked.failed, ["evaluator_where_required"],
  "over the threshold, an answer nobody would check is not allowed");
assert.equal(evaluateShadow({
  mandate: withEvaluator.mandate, usage: idle, period,
  proposal: proposal({ costUsdc: 0.001, verifiedAfterPaying: false }),
}).verdict, "WOULD_ALLOW", "and under it the term does not apply");
assert.equal(evaluateShadow({
  mandate: verified, usage: idle, period,
  proposal: proposal({ verifiedAfterPaying: false }),
}).verdict, "WOULD_ALLOW", "a zero threshold demands nothing");

/* Zero is "the owner set no threshold of their own", and the line has to read
   as that. It used to say the purchase was "under the amount that would demand
   a checked answer" -- which on $0.0030 against $0 is false, and false in the
   direction that makes an owner think they forbade something. */
const zeroThreshold = evaluateShadow({
  mandate: verified, usage: idle, period, proposal: proposal(),
}).checks.find((check) => check.code === "evaluator_where_required")!;
assert.equal(zeroThreshold.ok, true);
assert.doesNotMatch(zeroThreshold.detail, /under the amount/,
  "a threshold nobody set is not an amount this purchase is under");
assert.match(zeroThreshold.detail, /no verification threshold/);

/* ------------------------------------------------ networks are one namespace */

/**
 * The mandate spells a network as CAIP-2 and the brief spells it for a person,
 * and the two must never be compared.
 *
 * evaluateShadow was being handed `signal.settlesOn`, which is "Base", against
 * a mandate saying "eip155:8453". Every priced signal would have been denied
 * for a network mismatch, on any chain. The comparator was right and its one
 * test passed CAIP-2 in by hand, so the test proved the comparator and never
 * the wiring -- which is where the mistake was.
 */
const display = settlementNetworkOf({
  kind: "x402_resource", priceAtomic: "3000", payTo: "0x6d6E", reachable: true,
  provider: "Exa", network: "eip155:8453", funding: "wallet",
});
assert.equal(display, "Base", "the brief's network is a name");
assert.notEqual(display, "eip155:8453");
assert.doesNotMatch(String(display), /^eip155:/,
  "nothing a person reads belongs on the mandate side of a comparison");
const quoted = termsFromCandidate(
  { marketplace: { provider: { name: "Exa" }, resource: "https://x", priceUsdc: 0.003,
    payTo: "0x6d6e", network: "eip155:8453", funding: "wallet" } } as never,
  "research",
);
assert.match(quoted.network, /^eip155:\d+$/, "the quote's network is CAIP-2");
/* And the two namespaces cannot be mixed by accident any more: only asCaip2
   makes the type the comparison takes, and it refuses a display name. */
assert.equal(asCaip2(display), null, "a name a person reads is not a chain id");
assert.equal(asCaip2("eip155:8453"), "eip155:8453");
assert.equal(asCaip2(null), null);
assert.equal(asCaip2("base"), null);
assert.equal(evaluateShadow({
  mandate: verified, proposal: proposal(), usage: idle, period, network: asCaip2(quoted.network),
}).failed.includes("network_matches_mandate"), false,
  "and it is the one shadow-run passes, so a Base quote under a Base mandate passes");

/* ------------------------------------------ a v2 signature survives the trip */

/**
 * What the prepare route builds, a wallet signs, and the activate route
 * verifies -- at the layer both routes use.
 *
 * activate pinned version: "v1" unconditionally, so a mandate signed under the
 * v2 struct was rebuilt and checked as v1, recovered a stranger's address and
 * was rejected as forged. Nobody could have signed a working v2 mandate.
 */
const owner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const v2Terms = {
  ...fixture, ...SHADOW_TERMS, ownerWallet: owner.address, mode: "PREVIEW",
  version: MANDATE_VERSION_V2, budgetTimezone: "Europe/Berlin", maxAutonomousAttemptsPerDay: 4,
};
const offered = buildMandateEip712Message(v2Terms);
const signature = await owner.signTypedData({
  domain: VEYRA_EXECUTION_EIP712_DOMAIN,
  types: mandateTypesFor(MANDATE_VERSION_V2) as never,
  primaryType: "ExecutionMandate",
  message: offered as never,
});
const recovered = await recoverMandateSigner(
  { ...v2Terms, allowedCapabilities: v2Terms.allowedCapabilities,
    allowedRails: v2Terms.allowedRails } as never,
  v2Terms.mandateId, signature);
assert.equal(recovered.toLowerCase(), owner.address.toLowerCase(),
  "a v2 mandate signed under the v2 struct verifies as its owner");

/* And the same bytes checked as v1 do not, which is what was happening. */
const asV1 = await recoverMandateSigner(
  { ...v2Terms, version: "v1" } as never, v2Terms.mandateId, signature);
assert.notEqual(asV1.toLowerCase(), owner.address.toLowerCase(),
  "verifying a v2 signature under the v1 struct recovers a stranger");

/* ---------------------------------------- a PREVIEW mandate never pays ------ */

/**
 * The invariant the whole shadow phase is worth signing for.
 *
 * runAutopilotExecution loaded a mandate by id and never looked at its mode,
 * revocation or expiry. So the PREVIEW mandate somebody signs for a rehearsal
 * would have authorised a live payment the moment an operational wallet
 * existed and VEYRA_AUTOPILOT_ENABLED was set -- no new signature, no new
 * consent. It is enforced next to the money now, and asserted here.
 */
const live = {
  mandateId: "mnd_live", mode: "AUTOPILOT",
  expiresAt: "2026-12-14T00:00:00.000Z", revokedAt: null,
};
assert.doesNotThrow(() => assertMandateAuthorizesAutopilot(live, now));

for (const mode of ["PREVIEW", "PREPARE"]) {
  assert.throws(
    () => assertMandateAuthorizesAutopilot({ ...live, mode }, now),
    /MANDATE_MODE_FORBIDS_AUTOPILOT|does not authorise unattended payment/,
    `${mode} must never authorise a live payment`,
  );
}
assert.throws(() => assertMandateAuthorizesAutopilot(
  { ...live, revokedAt: "2026-09-13T00:00:00Z" }, now), /revoked/);
assert.throws(() => assertMandateAuthorizesAutopilot(
  { ...live, expiresAt: "2026-09-13T00:00:00Z" }, now), /expired/);

/* And the two halves agree on what D0 signs: a PREVIEW v2 mandate is ready to
   be shadowed and is refused by the thing that pays. */
const d0 = mandate({ mode: "PREVIEW" as never });
assert.equal(mandateReadiness(d0, now).ready, true, "shadow accepts it");
assert.throws(() => assertMandateAuthorizesAutopilot(d0 as never, now),
  /does not authorise unattended payment/, "and money refuses it");

/* ------------------------------------------- the mandate the screen offers */

const d0Terms = previewMandateTerms({
  mandateId: "vman_d0", ownerWallet: owner.address, agentPublicId: "nva_t12w6so1sfo5qdsclujv",
  budgetTimezone: "Europe/Berlin", now,
});

assert.equal(d0Terms.mode, "PREVIEW");
assert.equal(d0Terms.version, MANDATE_VERSION_V2);
/* Nova has no operational wallet, and inventing an address to fill a signed
   field would put a name in the document that names nothing. */
assert.equal(d0Terms.subjectWallet, "0x0000000000000000000000000000000000000000");
/* Where the money would move, which is not where the signature lives. */
assert.equal(d0Terms.network, "eip155:8453");
assert.equal(VEYRA_EXECUTION_EIP712_DOMAIN.chainId, 5042002, "signed in the Arc domain");
/* Neutral, because a shadow decision cannot check either of them. */
assert.equal(d0Terms.minimumConfidence, 0);
assert.equal(d0Terms.requireVerifiedIdentity, false);
assert.equal(
  Math.round((Date.parse(d0Terms.expiresAt) - Date.parse(d0Terms.issuedAt)) / 86_400_000),
  PREVIEW_MANDATE.daysValid);
assert.ok(isPreviewMandate(d0Terms));

const request = previewMandateSigningRequest(d0Terms);

/**
 * The response has to survive JSON, and the wallet has to sign the same thing.
 *
 * An EIP-712 uint256 is a bigint here and JSON has no bigint, so sending the
 * message as built made NextResponse.json throw -- every attempt to sign
 * answered 500, and the library tests never saw it because they never
 * serialised anything. The route sends decimal strings, and these two
 * assertions are the ones that were missing: the payload is serialisable, and
 * a wallet signing the serialised form signs the identical digest.
 */
const wirePayload = {
  terms: d0Terms,
  signing: {
    domain: request.domain, types: request.wireTypes,
    primaryType: request.primaryType, message: request.wireMessage,
  },
};

/**
 * And the domain type has to be in it.
 *
 * eth_signTypedData_v4 does not infer EIP712Domain; viem does. Without the
 * entry MetaMask hashes an empty domain struct -- a separator belonging to no
 * chain -- so the owner signs, the server recovers a stranger, and the page
 * tells them their own signature is not theirs. Every test here would have
 * passed, because they all go through viem. lib/x402/browser-payment.ts
 * documents the same trap from the last time.
 */
assert.ok("EIP712Domain" in wirePayload.signing.types, "the wallet is told what a domain is");
assert.deepEqual(
  (wirePayload.signing.types.EIP712Domain as ReadonlyArray<{ name: string }>).map((f) => f.name),
  Object.keys(request.domain),
  "and the declaration matches the domain field for field, in order, as EIP-712 requires",
);
assert.doesNotThrow(() => JSON.stringify(wirePayload), "the route's response must be JSON");
for (const value of Object.values(request.wireMessage)) {
  assert.notEqual(typeof value, "bigint", "no bigint may reach the wire");
}
const overTheWire = JSON.parse(JSON.stringify(wirePayload)) as typeof wirePayload;
assert.equal(
  hashTypedData({
    domain: overTheWire.signing.domain as never, types: overTheWire.signing.types as never,
    primaryType: "ExecutionMandate", message: overTheWire.signing.message as never,
  }),
  hashTypedData({
    domain: request.domain, types: request.types as never,
    primaryType: "ExecutionMandate", message: request.message as never,
  }),
  "what the browser signs and what the server verifies are the same digest",
);

const d0Signature = await owner.signTypedData({
  domain: request.domain, types: request.types as never,
  primaryType: request.primaryType, message: request.message as never,
});
const d0Mandate = mandateFrom(d0Terms, d0Signature, request.canonicalHash, now);
assert.equal(
  (await recoverMandateSigner(d0Mandate, d0Terms.mandateId, d0Signature)).toLowerCase(),
  owner.address.toLowerCase(), "what the screen offers is what the wallet can sign");

/* The two halves of the phase, on the same signature. */
assert.equal(mandateReadiness(d0Mandate, now).ready, true, "shadow will act on it");
assert.throws(() => assertMandateAuthorizesAutopilot(d0Mandate, now),
  /does not authorise unattended payment/,
  "and no amount of it authorises a payment -- real autonomy needs a new signature");

/* Terms that are not the offer are refused before the signature is even
   checked, because "that is not what the card said" is a better answer than a
   signature error. */
for (const tampered of [
  { ...d0Terms, maxPerTransactionUsdc: 1 },
  { ...d0Terms, maxPerDayUsdc: 10 },
  { ...d0Terms, maxAutonomousAttemptsPerDay: 999 },
  { ...d0Terms, mode: "AUTOPILOT" },
  { ...d0Terms, version: "v1" },
  { ...d0Terms, network: "eip155:5042002" },
  { ...d0Terms, subjectWallet: owner.address },
  { ...d0Terms, requireVerifiedIdentity: true },
  { ...d0Terms, minimumConfidence: 0.9 },
  { ...d0Terms, allowedRails: ["erc8183"] },
  { ...d0Terms, allowedCapabilities: ["token_transfer"] },
  { ...d0Terms, budgetTimezone: "Mars/Olympus" },
]) {
  assert.equal(isPreviewMandate(tampered), false,
    `a mandate with ${JSON.stringify(Object.entries(tampered).find(
      ([key, value]) => JSON.stringify((d0Terms as Record<string, unknown>)[key]) !== JSON.stringify(value))?.[0])} changed is not the offer`);
}

/* And a limit altered after signing does not verify, which is the guarantee
   underneath the shape check rather than a substitute for it. */
const raised = { ...d0Terms, maxPerDayUsdc: 10 };
assert.notEqual(
  (await recoverMandateSigner(raised as never, raised.mandateId, d0Signature)).toLowerCase(),
  owner.address.toLowerCase(), "changing a limit after signing recovers a stranger");

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

/* ------------------------------------------------------- one run, one mandate */

/* A calibration epoch is a signature, because a canonical hash covers every
   term: change a capability or a budget and the run that follows is a
   different run whether or not anybody says so. */
const older: ShadowRecord = record({ verdict: "WOULD_DENY", failed: ["capability_allowed"] });
const preCalibration = { ...older, mandateHash: "0xdevelopment" };
const inEpoch = { ...older, mandateHash: "0xepochone" };
const epoch = { number: 1, mandateHash: "0xepochone", startedAt: "2026-09-15T12:00:00.000Z", purpose: "limits" };

assert.deepEqual(
  splitByCalibration([preCalibration, inEpoch, preCalibration], epoch).calibration.map((r) => r.mandateHash),
  ["0xepochone"],
  "only decisions under the epoch's own mandate are evidence about its limits");
assert.equal(splitByCalibration([preCalibration, inEpoch, preCalibration], epoch).development.length, 2,
  "and the rest are kept rather than dropped");

/* With no epoch, everything is development history. Passed explicitly rather
   than left to the registry being empty, because the registry is not empty any
   more and this is the property that matters: nothing is counted towards a
   calibration run that has not begun. */
assert.equal(splitByCalibration([preCalibration, inEpoch], null).calibration.length, 0);
assert.equal(splitByCalibration([preCalibration, inEpoch], null).development.length, 2);

/* Epoch #1, pinned. It is a signature that happened, so it is a fact rather
   than a setting: if this assertion ever has to change, either the hash was
   wrong or somebody edited a run that has already been measured. */
const first = currentEpoch();
assert.ok(first, "epoch #1 has begun");
assert.equal(first.number, 1);
assert.equal(first.mandateHash,
  "0x32c4b9a9e1421b8a97afbe57704e27a250b6ff146569ea9179eecc0cacf87db1");
assert.equal(first.startedAt, "2026-09-15T12:50:15.667Z");
assert.equal(epochFor(first.mandateHash)?.number, 1);
assert.equal(epochFor("0x2b5212916e3790bf4291bec6854393fec92ffce42cec0e99cc50248bf2df31ce"), null,
  "the mandate that came before it is not an epoch, and its eight decisions are "
  + "development history");

/* Append-only, asserted rather than trusted to convention. */
assert.deepEqual(CALIBRATION_EPOCHS.map((entry) => entry.number),
  [...CALIBRATION_EPOCHS.map((entry) => entry.number)].sort((a, b) => a - b),
  "epochs are in the order they began");
assert.equal(new Set(CALIBRATION_EPOCHS.map((entry) => entry.mandateHash)).size,
  CALIBRATION_EPOCHS.length, "one mandate, one run");


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
  + "through both DST turns, every check reported on every decision, one predicate deciding "
  + "what is executable on both sides of the card, a threshold nobody set reported as one "
  + "nobody set, the terms an owner signs pinned where a diff can see them, a calibration "
  + "run bounded by the signature it was made under, "
  + "and a morning that counts what was withheld as well as what would have been "
  + "spent");
