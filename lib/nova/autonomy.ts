/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecutionMandate } from "../execution/types.ts";
import { MANDATE_VERSION_V2 } from "../execution/canonical.ts";
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
  "mandate_mode_not_autopilot",
  "mandate_expired",
  "mandate_revoked",
  "mandate_timezone_unusable",
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

/** A day, as the owner's clock reads it rather than as UTC does. */
export type BudgetPeriod = {
  /** Inclusive ISO instant of local midnight. */
  start: string;
  /** Exclusive ISO instant of the next local midnight. */
  end: string;
  timezone: string;
};

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

export function isValidTimezone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** How far the zone's clock is from UTC at one instant, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  /* Some ICU builds render midnight as hour 24 of the previous day. */
  const hour = read("hour") % 24;
  const asIfUtc = Date.UTC(read("year"), read("month") - 1, read("day"), hour, read("minute"), read("second"));
  return asIfUtc - instant.getTime();
}

/**
 * The owner's day containing this instant.
 *
 * A daily budget measured in UTC resets at 01:00 or 02:00 for most of Europe,
 * which is inside the window an unattended agent actually works in: a run at
 * 00:30 and a run at 02:30 would draw on two different days without anybody
 * having agreed to that. So the zone is a signed field of the mandate and the
 * day is computed from it.
 *
 * The offset is read twice because it can differ across the boundary. On the
 * night a zone springs forward, the second read is what makes the period start
 * at the first instant that exists rather than at one that does not.
 */
export function budgetPeriodFor(at: Date, timeZone: string): BudgetPeriod {
  const zone = isValidTimezone(timeZone) ? timeZone : "UTC";
  const offset = offsetMsAt(at, zone);
  const civil = new Date(at.getTime() + offset);

  const boundary = (dayShift: number): number => {
    const asIfUtc = Date.UTC(
      civil.getUTCFullYear(),
      civil.getUTCMonth(),
      civil.getUTCDate() + dayShift,
    );
    const first = asIfUtc - offset;
    const corrected = offsetMsAt(new Date(first), zone);
    return corrected === offset ? first : asIfUtc - corrected;
  };

  return {
    start: new Date(boundary(0)).toISOString(),
    end: new Date(boundary(1)).toISOString(),
    timezone: zone,
  };
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
  if (mandate.mode !== "AUTOPILOT") {
    return {
      ready: false,
      reason: "mandate_mode_not_autopilot",
      detail: `This mandate is for ${mandate.mode.toLowerCase()}, not for acting unattended.`,
    };
  }
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
  /** The chain the money would move on, as a CAIP-2 string. */
  network?: string;
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

  const decisionOk = proposal.decision === "ALLOW" || proposal.decision === "ALLOW_WITH_LIMITS";
  add("veyra_decision_allows", decisionOk, decisionOk
    ? `Veyra's own decision is ${proposal.decision}`
    : `Veyra's own decision is ${proposal.decision}`);

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
