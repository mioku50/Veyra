/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecutionMandate } from "../execution/types.ts";
import { MANDATE_VERSION_V2 } from "../execution/canonical.ts";
/* The owner's day and the zone it is read in moved to the execution layer, so
   that shadow and live spending measure the same Tuesday. Re-exported here
   because this is where the rest of Nova has always asked for them. */
import { budgetPeriodFor, isValidTimezone, type OwnerDay } from "../execution/budget-day.ts";

export { budgetPeriodFor, isValidTimezone };
/** A day, as the owner's clock reads it rather than as UTC does. */
export type BudgetPeriod = OwnerDay;
import { isExecutableTrustDecision } from "../trust-gate/types.ts";
import type { NovaResearchProposal } from "./research.ts";

/**
 * Shadow autonomy: Nova acting as if it could spend, stopping before it can.
 *
 * The whole path runs for real -- a scheduled pass, a model noticing something,
 * a question written for it, live discovery, a live quote, Veyra's trust
 * decision, and the owner's signed mandate evaluated against all of it. Then it
 * stops, one step before the only step that costs anything. No payment
 * authorization is built, no EIP-3009 signature is produced, no wallet is
 * touched, and nothing here can move money even if every check passed.
 *
 * It exists because the honest way to decide whether an agent should be funded
 * is to watch what it would have done. A week of real decisions answers three
 * questions nothing else can: whether Nova's judgement is worth paying for,
 * what the limits should actually be, and whether the policy path works at all
 * -- and it answers them with nothing at risk.
 *
 * This file is the deterministic half. It reads a proposal and a mandate and
 * returns a verdict; it performs no I/O, calls no model, and given the same
 * inputs returns the same answer forever. The model decides what is worth
 * asking. It does not decide what is worth paying, and it cannot reach this
 * function's inputs except by producing a proposal that the market priced.
 */

/**
 * Why a decision went the way it did.
 *
 * Every check is named, and the names are stable: they are written to the
 * decision table and counted in the morning brief, so renaming one silently
 * rewrites history. Add rather than rename.
 */
export const AUTONOMY_CHECKS = [
  "capability_allowed",
  "rail_allowed",
  "network_matches_mandate",
  "veyra_decision_allows",
  "trust_at_least_minimum",
  "within_per_action_limit",
  "within_daily_budget",
  "within_total_budget",
  "attempts_remaining",
  "payable_unattended",
  "evaluator_where_required",
] as const;
export type AutonomyCheckCode = (typeof AUTONOMY_CHECKS)[number];

export type AutonomyCheck = {
  code: AutonomyCheckCode;
  ok: boolean;
  /** The line the card shows, in the words a person reads. */
  detail: string;
};

/**
 * Why there is no decision to make at all.
 *
 * Distinct from a check failing. A check that fails is Veyra doing its job on a
 * real proposal; these mean the agent is not in shadow autonomy in the first
 * place, and counting them among the denials would make a brief report refusals
 * that never happened.
 */
export type AutonomyReadiness =
  | { ready: true; mandate: VerifiedMandate }
  | { ready: false; reason: AutonomyBlock; detail: string };

export const AUTONOMY_BLOCKS = [
  "no_mandate",
  "mandate_version_predates_autonomy",
  "mandate_expired",
  "mandate_revoked",
  "mandate_timezone_unusable",
  "mandate_sets_terms_shadow_cannot_check",
] as const;
export type AutonomyBlock = (typeof AUTONOMY_BLOCKS)[number];

/**
 * A mandate that has been through {@link mandateReadiness}.
 *
 * Branded, and the brand cannot be written by hand. The evaluator below takes
 * only this type, so there is no call site where an unchecked mandate -- one
 * that is expired, revoked, signed under v1, or not in AUTOPILOT -- can be
 * handed to the thing that says "would allow".
 */
declare const checked: unique symbol;
export type VerifiedMandate = ExecutionMandate & { readonly [checked]: true };

export type AutonomyUsage = {
  /** USDC that would have been spent inside this period. */
  spentUsdc: number;
  /** USDC that would have been spent over the mandate's whole life. */
  spentTotalUsdc: number;
  /** Decisions inside this period that reached the point of paying. */
  attempts: number;
};

export type ShadowDecision = {
  verdict: "WOULD_ALLOW" | "WOULD_DENY";
  checks: AutonomyCheck[];
  /** Just the failures, for counting a morning brief without re-deriving it. */
  failed: AutonomyCheckCode[];
  /** What this would have cost. Reported on a denial too: "would have spent"
   *  is only meaningful next to "and here is what we did not spend". */
  wouldSpendUsdc: number;
  /** Which attempt of the day this would be. Only a WOULD_ALLOW consumes one,
   *  so this is the number it would take, not the number it has taken. */
  attemptNumber: number;
  period: BudgetPeriod;
};

/**
 * A chain named the way a mandate names one.
 *
 * Branded, because the two spellings of a network in this codebase are a trap
 * that has already been walked into: a mandate says `eip155:8453` and the brief
 * says `Base`, and comparing them is false for every chain there is. That is
 * what was happening -- every priced signal would have been denied for a
 * network mismatch on whichever chain the mandate named -- and the check's own
 * test passed CAIP-2 in by hand, so it proved the comparator and never the
 * wiring.
 *
 * So the comparison takes a type only `asCaip2` can produce, and handing it a
 * display name no longer compiles.
 */
declare const caip2: unique symbol;
export type Caip2 = string & { readonly [caip2]: true };

/** Null for anything that is not a chain id, including a display name. A
 *  network shadow cannot parse is reported as unknown, which skips the check
 *  rather than failing it: refusing everything would be worse than admitting
 *  there is something here we cannot read. */
export function asCaip2(value: string | null | undefined): Caip2 | null {
  return typeof value === "string" && /^eip155:\d+$/.test(value) ? (value as Caip2) : null;
}

/**
 * Whether this agent is in shadow autonomy at all.
 *
 * A v1 mandate is not a smaller autonomy grant; it is not an autonomy grant. It
 * was signed before the two fields unattended spending needs existed, and
 * reading consent to act unattended into a signature given before the concept
 * did is exactly the thing this whole design refuses to do.
 */
export function mandateReadiness(
  mandate: ExecutionMandate | null,
  now: Date,
): AutonomyReadiness {
  if (!mandate) {
    return {
      ready: false,
      reason: "no_mandate",
      detail: "Nothing is authorised, because nothing has been signed.",
    };
  }
  if (mandate.version !== MANDATE_VERSION_V2) {
    return {
      ready: false,
      reason: "mandate_version_predates_autonomy",
      detail: "This mandate was signed before unattended limits existed, so it does not grant them.",
    };
  }
  /* Mode is not checked here, and that is deliberate.
   *
   * Mode gates paying, not deciding, and every mode permits Veyra to look at a
   * price and form an opinion. Shadow autonomy is what a PREVIEW mandate is
   * for, and requiring AUTOPILOT would have meant asking somebody to sign a
   * real unattended-spending permission in order to watch a rehearsal --
   * a signature that would have become live the moment an operational wallet
   * existed, with no new consent. lib/execution/executor.ts is where the mode
   * is enforced, because that is where the money is.
   */
  if (mandate.revokedAt) {
    return { ready: false, reason: "mandate_revoked", detail: "You revoked this mandate." };
  }
  if (new Date(mandate.expiresAt).getTime() <= now.getTime()) {
    return { ready: false, reason: "mandate_expired", detail: "This mandate has expired." };
  }
  if (!mandate.budgetTimezone || !isValidTimezone(mandate.budgetTimezone)) {
    /* Refused rather than defaulted to UTC. A budget day is what the owner
       signed; silently measuring it in a different zone would be Veyra
       deciding a term of their mandate for them. */
    return {
      ready: false,
      reason: "mandate_timezone_unusable",
      detail: "The budget day in this mandate names a timezone this server cannot read.",
    };
  }
  /* Terms that are signed and cannot be honoured.
   *
   * A mandate signs minimumConfidence and requireVerifiedIdentity, and a
   * shadow decision has neither number to check against: a marketplace
   * proposal carries a trust score and no confidence, and nothing in it
   * attests the seller's identity. Ignoring them would put a limit on a screen
   * that is not a limit, which is the exact failure this codebase keeps
   * finding. So a mandate that sets either one is refused rather than acted on
   * partially, and the screen that issues D0 mandates leaves both neutral.
   */
  if (mandate.minimumConfidence > 0 || mandate.requireVerifiedIdentity) {
    return {
      ready: false,
      reason: "mandate_sets_terms_shadow_cannot_check",
      detail: "This mandate sets a confidence floor or demands a verified identity, and neither "
        + "is something a shadow decision can check yet.",
    };
  }
  return { ready: true, mandate: mandate as VerifiedMandate };
}

const money = (value: number) => `$${value.toFixed(4)}`;

/**
 * What would have happened, and why.
 *
 * Every check runs, including the ones after the first failure. A brief that
 * stopped at the first no could only ever report one reason per decision, and
 * "over your per-action limit" hides that the trust score was also too low --
 * which matters, because raising the limit would then not have helped.
 */
export function evaluateShadow(input: {
  mandate: VerifiedMandate;
  proposal: NovaResearchProposal;
  usage: AutonomyUsage;
  period: BudgetPeriod;
  /** The rail this would settle on. x402 today; named rather than assumed. */
  rail?: string;
  /** The chain the money would move on. Only `asCaip2` makes one of these,
   *  which is what stops a display name being compared against a mandate. */
  network?: Caip2 | null;
}): ShadowDecision {
  const { mandate, proposal, usage, period } = input;
  const rail = input.rail ?? "x402";
  const cost = proposal.costUsdc;
  const checks: AutonomyCheck[] = [];
  const add = (code: AutonomyCheckCode, ok: boolean, detail: string) =>
    checks.push({ code, ok, detail });

  const capabilityOk = mandate.allowedCapabilities.includes(proposal.capability);
  add("capability_allowed", capabilityOk, capabilityOk
    ? `${proposal.capability} is allowed`
    : `${proposal.capability} is not one of the capabilities you allowed`);

  const railOk = (mandate.allowedRails as string[]).includes(rail);
  add("rail_allowed", railOk, railOk
    ? `${rail} is allowed`
    : `${rail} is not one of the rails you allowed`);

  /* Only checked when the proposal names a network. Nova's x402 purchases
     settle where the seller accepts, which is not always the chain the mandate
     was signed on, and treating "unknown" as a mismatch would deny everything
     rather than report what it could not tell. */
  const networkOk = !input.network || input.network === mandate.network;
  add("network_matches_mandate", networkOk, networkOk
    ? `settles on ${input.network ?? mandate.network}`
    : `would settle on ${input.network}, and your mandate names ${mandate.network}`);

  /* Veyra's own answer, read with Veyra's own predicate.
     This check kept a second list -- ALLOW and ALLOW_WITH_LIMITS -- beside
     isExecutableTrustDecision, and the two disagreed about REQUIRE_EVALUATOR.
     research.ts had already dropped its copy of that list for exactly this
     reason; shadow kept one, so the layer that draws the card and the layer
     that decides about it were answering the same question differently. What
     that produced is not an edge case: research only ever proposes candidates
     the shared predicate allows, so every REQUIRE_EVALUATOR card reaching here
     was priced, shown, and then refused by a rule the screen did not have.
     Both of the first real shadow decisions failed here and nowhere near a
     limit.

     The tier is not a warning. On an x402 purchase it sets
     postCallVerificationRequired, and the settle path runs verifyPostCall on
     the response before the purchase counts as successful -- so the permission
     is granted against that verification rather than against the tier's name.
     `verifiedAfterPaying` is the same flag the plan carries into settle as
     `required`, which is why it is what gets asked here.

     Today that flag is `decision !== "ALLOW"`, so on this rail the condition is
     satisfied whenever the tier appears and denies nothing by itself. Said
     plainly rather than left to be discovered: it is here so the day a
     proposal offers this tier without the verification behind it, shadow
     refuses it instead of trusting the label. */
  const verifiedAfterPaying = proposal.verifiedAfterPaying === true;
  const decisionOk = isExecutableTrustDecision(proposal.decision)
    && (proposal.decision !== "REQUIRE_EVALUATOR" || verifiedAfterPaying);
  add("veyra_decision_allows", decisionOk, decisionOk
    ? proposal.decision === "REQUIRE_EVALUATOR"
      ? "Veyra's own decision is REQUIRE_EVALUATOR, and the answer is checked after paying"
      : `Veyra's own decision is ${proposal.decision}`
    : proposal.decision === "REQUIRE_EVALUATOR"
      ? "Veyra's own decision is REQUIRE_EVALUATOR, and nothing here would check the answer afterwards"
      : `Veyra's own decision is ${proposal.decision}, which Veyra will not execute`);

  const trustOk = proposal.trustScore >= mandate.minimumTrustScore;
  add("trust_at_least_minimum", trustOk,
    `Trust ${proposal.trustScore} ${trustOk ? "≥" : "<"} ${mandate.minimumTrustScore}`);

  const perActionOk = cost <= mandate.maxPerTransactionUsdc;
  add("within_per_action_limit", perActionOk, perActionOk
    ? `${money(cost)} is under your ${money(mandate.maxPerTransactionUsdc)} per-action limit`
    : `${money(cost)} is over your ${money(mandate.maxPerTransactionUsdc)} per-action limit`);

  const dailyOk = usage.spentUsdc + cost <= mandate.maxPerDayUsdc;
  add("within_daily_budget", dailyOk, dailyOk
    ? `${money(mandate.maxPerDayUsdc - usage.spentUsdc)} left in today's budget`
    : `only ${money(Math.max(0, mandate.maxPerDayUsdc - usage.spentUsdc))} left in today's budget`);

  const totalOk = usage.spentTotalUsdc + cost <= mandate.maxTotalUsdc;
  add("within_total_budget", totalOk, totalOk
    ? `${money(mandate.maxTotalUsdc - usage.spentTotalUsdc)} left on this mandate`
    : `only ${money(Math.max(0, mandate.maxTotalUsdc - usage.spentTotalUsdc))} left on this mandate`);

  /* An attempt is one arrival at the point of paying, whether or not the money
     would then have moved. Payments are not the only cost: an endpoint that
     fails every call is free in USDC and can be retried until morning, so the
     number of arrivals is a limit of its own. */
  const cap = mandate.maxAutonomousAttemptsPerDay ?? 0;
  const attemptNumber = usage.attempts + 1;
  const attemptsOk = attemptNumber <= cap;
  add("attempts_remaining", attemptsOk, attemptsOk
    ? `attempt ${attemptNumber} of ${cap} today`
    : `all ${cap} of today's attempts are used`);

  /* A Gateway deposit needs a person. Allowing a purchase nobody can complete
     unattended would put a decision in the morning brief that could never have
     been carried out, which is a different lie from the ones above but a lie. */
  const payableOk = proposal.funding === "wallet";
  add("payable_unattended", payableOk, payableOk
    ? "settles directly in USDC"
    : "needs a Circle Gateway deposit, which cannot happen while you are away");

  /* The one term of the three that a proposal can actually answer. Above the
     threshold the owner signed, the answer has to be checked after paying --
     and `verifiedAfterPaying` is precisely whether Veyra will do that. Below
     it, the term does not apply and the check passes by saying so.

     Zero is a threshold the owner did not set, not a threshold of nothing. It
     has always passed here, and it should: the owner is asking for no
     verification beyond whatever the trust tier already demands. But the line
     it printed was "under the amount that would demand a checked answer",
     which on a $0.0100 purchase against a $0 threshold is simply false, and a
     sentence like that is how a term gets read as a prohibition it never was.
     It now says what the owner actually said. */
  const noThreshold = mandate.evaluatorThresholdUsdc <= 0;
  const evaluatorNeeded = !noThreshold && cost >= mandate.evaluatorThresholdUsdc;
  const evaluatorOk = !evaluatorNeeded || verifiedAfterPaying;
  add("evaluator_where_required", evaluatorOk, noThreshold
    ? "you set no verification threshold of your own"
    : evaluatorNeeded
      ? evaluatorOk
        ? `over ${money(mandate.evaluatorThresholdUsdc)}, and the answer would be checked`
        : `over ${money(mandate.evaluatorThresholdUsdc)}, and this answer would not be checked`
      : `under the ${money(mandate.evaluatorThresholdUsdc)} that would demand a checked answer`);

  const failed = checks.filter((check) => !check.ok).map((check) => check.code);
  return {
    verdict: failed.length === 0 ? "WOULD_ALLOW" : "WOULD_DENY",
    checks,
    failed,
    wouldSpendUsdc: cost,
    attemptNumber,
    period,
  };
}

/**
 * Whether a WOULD_ALLOW consumed the day's allowance.
 *
 * Only an allow does. A denial never reached the point where an authorization
 * would have been built, so charging the day for it would let a mandate too
 * strict to ever allow anything exhaust itself against its own refusals.
 */
export function consumesAttempt(decision: ShadowDecision): boolean {
  return decision.verdict === "WOULD_ALLOW";
}

export function spendOf(decision: ShadowDecision): number {
  return decision.verdict === "WOULD_ALLOW" ? decision.wouldSpendUsdc : 0;
}

/** One recorded decision, as everything downstream reads it. */
export type ShadowRecord = {
  decisionId: string;
  signalId: string;
  /** Which signed mandate this was decided under. Written to the row since the
   *  table existed and dropped on the way back, which left no way to tell a
   *  decision made under one set of limits from a decision made under another
   *  -- and a calibration run is exactly a set of decisions under one. */
  mandateHash: string;
  verdict: "WOULD_ALLOW" | "WOULD_DENY";
  question: string;
  capability: string;
  provider: string | null;
  resource: string | null;
  rail: string;
  network: string | null;
  trustScore: number | null;
  wouldSpendUsdc: number;
  checks: AutonomyCheck[];
  failed: string[];
  attemptNumber: number;
  period: BudgetPeriod;
  ownerFeedback: "useful" | "not_worth_it" | null;
  decidedAt: string;
};

export type ShadowSummary = {
  decisions: number;
  wouldInvestigate: number;
  wouldDecline: number;
  /** What the allowances would have cost. Denials contribute nothing here:
   *  they are counted separately, under what they saved. */
  wouldSpendUsdc: number;
  /** What the denials would have cost had they been allowed. The number the
   *  limits are worth judging by. */
  withheldUsdc: number;
  /** Why the denials were denied, most common first. */
  declinedBecause: Array<{ code: string; count: number }>;
  /** Null when no limit is known, never zero: an unknown budget and an
   *  exhausted one are opposite facts. */
  remainingTodayUsdc: number | null;
  period: BudgetPeriod | null;
};

/**
 * The morning's account of a night nobody watched.
 *
 * Counts denials by every reason they failed, not by a first cause. A decision
 * blocked by both a price ceiling and a trust floor belongs in both tallies,
 * because the owner's next move differs: raising the limit alone would have
 * changed nothing.
 */
export function shadowSummaryFrom(
  records: ShadowRecord[],
  options?: { period?: BudgetPeriod | null; dailyBudgetUsdc?: number | null },
): ShadowSummary {
  const period = options?.period ?? records[0]?.period ?? null;
  const inPeriod = period
    ? records.filter((entry) => entry.period.start === period.start)
    : records;

  const allowed = inPeriod.filter((entry) => entry.verdict === "WOULD_ALLOW");
  const denied = inPeriod.filter((entry) => entry.verdict === "WOULD_DENY");
  const total = (entries: ShadowRecord[]) =>
    entries.reduce((sum, entry) => sum + entry.wouldSpendUsdc, 0);

  const tally = new Map<string, number>();
  for (const entry of denied) {
    for (const code of entry.failed) tally.set(code, (tally.get(code) ?? 0) + 1);
  }
  const declinedBecause = [...tally.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));

  const budget = options?.dailyBudgetUsdc;
  return {
    decisions: inPeriod.length,
    wouldInvestigate: allowed.length,
    wouldDecline: denied.length,
    wouldSpendUsdc: total(allowed),
    withheldUsdc: total(denied),
    declinedBecause,
    remainingTodayUsdc: budget === null || budget === undefined
      ? null
      : Math.max(0, budget - total(allowed)),
    period,
  };
}
