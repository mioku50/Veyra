/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaArcIdentity } from "./identity.ts";
import type { NovaShadowView } from "./types.ts";
import type { ShadowSummary } from "./autonomy.ts";
import type { NovaDerivedStanding } from "./standing.ts";

/**
 * The sentences that claim a state, kept next to the state they claim.
 *
 * Most of what has been wrong on this page lately was not wrong logic. The
 * numbers were right and the words beside them were stale: a heading reading
 * "Nova is not an identity on Arc yet" sitting directly above a panel reading
 * "ERC-8004 Agent #895012"; "1 of 6" where six was attempts and one was a pass
 * over three payments; "nothing else changes" written about a token transfer
 * that in fact moves nothing anyone would miss. Every one of them was found on
 * a screenshot, because a string is not checked against the thing it describes.
 *
 * So the claims move here and stop accepting loose numbers. A function in this
 * file takes a whole state or nothing: there is no argument position where
 * attempts can be handed to a sentence about payments, and no way to ask for
 * the claimed-identity wording while holding no identity. The states are
 * unions, so a caller that renders one case renders all of that case.
 *
 * Ordinary prose stays in the components. This is not a copy layer. It is the
 * subset of copy that asserts a fact, which is the subset that can be false.
 */

/**
 * A sentence with its figures marked.
 *
 * The page sets numbers apart from the words around them, which is why a claim
 * is not a plain string: prose alone would send the component back to re-derive
 * each figure in order to style it, and a figure re-derived beside a sentence
 * is the whole bug this file exists to prevent. `plain` is what the invariant
 * tests read and the page renders the same array, so a test that passes has
 * read the words on the screen rather than a second copy of them.
 */
export type ClaimPart = string | { figure: string };
export type Claim = readonly ClaimPart[];

export function plain(claim: Claim): string {
  return claim.map((part) => (typeof part === "string" ? part : part.figure)).join("");
}

const figure = (value: string | number): ClaimPart => ({ figure: String(value) });

/**
 * Where this agent stands with Arc, as one value with three cases.
 *
 * Built only by `arcIdentityState`. Each case carries the evidence it is
 * allowed to talk about, which is why `claimed` holds no counters: once an
 * identity exists the counters have stopped being the reason for anything, and
 * a sentence quoting them would be arguing eligibility for something already
 * owned.
 */
export type ArcIdentityState =
  | { kind: "not_earned"; passed: number; attested: number }
  | { kind: "earned_not_claimed"; passed: number; attested: number }
  | { kind: "claimed"; agentId: string; owner: string; registry: string; chainId: number };

/**
 * An identity that exists outranks every counter.
 *
 * The first Nova was minted under the older, weaker rule. Deriving its state
 * from standing alone would have the page tell an owner they have not earned
 * the identity they are looking at -- the original bug with the operands
 * swapped.
 */
export function arcIdentityState(
  identity: NovaArcIdentity | null,
  standing: NovaDerivedStanding,
): ArcIdentityState {
  if (identity) {
    return {
      kind: "claimed",
      agentId: identity.agentId,
      owner: identity.owner,
      registry: identity.registry,
      chainId: identity.chainId,
    };
  }
  return {
    kind: standing.readyForArcIdentity ? "earned_not_claimed" : "not_earned",
    passed: standing.verifiedResearch,
    attested: standing.attestedOnArc,
  };
}

const count = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function identityHeadline(state: ArcIdentityState, name: string): Claim {
  switch (state.kind) {
    case "claimed":
      return [`${name} · ERC-8004 Agent #`, figure(state.agentId)];
    case "earned_not_claimed":
      return [`${name} has earned an identity on Arc and has not claimed it yet.`];
    case "not_earned":
      return [`${name} is not an identity on Arc yet.`];
  }
}

/**
 * Why the page is showing what it is showing.
 *
 * The unclaimed cases name both halves of the rule on purpose. Eligibility used
 * to be credited to verified purchases alone -- "has earned eligibility through
 * 1 verified activity" -- while the gate had already started requiring an
 * attestation too, so the sentence explained a rule the code no longer used.
 */
export function identityExplanation(state: ArcIdentityState, name: string): Claim {
  switch (state.kind) {
    case "claimed":
      return [
        `${name} is a registry and an agent id on Arc, owned by the wallet that minted it. `,
        "The owner can change without the agent changing, which is why an ERC-8004 identity is ",
        "not an address.",
      ];
    case "earned_not_claimed":
      return [
        `${name} has `, figure(state.passed),
        count(state.passed, " purchase", " purchases"), " that passed the delivery check, and ",
        figure(state.attested), count(state.attested, " attestation", " attestations"),
        " recorded on Arc where anyone can read ", count(state.attested, "it", "them"),
        " without asking us. Registering now records something that already happened.",
      ];
    case "not_earned":
      /* Two different missing halves, and telling them apart is the difference
         between a next step and a shrug. */
      return state.passed >= 1
        ? [
            `${name} has `, figure(state.passed),
            count(state.passed, " purchase", " purchases"), " that passed the delivery check, and ",
            "nothing on Arc yet. Recording one there is what leaves evidence a stranger can read.",
          ]
        : [
            `${name} can be registered on Arc once there is something for that identity to point `,
            "at: one purchase that passed its delivery check, recorded on Arc where anyone can ",
            "read it.",
          ];
  }
}

/**
 * The page heading above the identity panel.
 *
 * Separate from the panel's own explanation because it is read first and in a
 * different voice, and derived from the same state because it once was not: it
 * said "Nova is not an identity on Arc yet" directly above a panel naming the
 * agent id. A heading that contradicts what is under it teaches a reader to
 * skip headings.
 */
export function arcViewBlurb(state: ArcIdentityState, name: string): Claim {
  switch (state.kind) {
    case "claimed":
      return [`${name} has an identity on Arc, and a record of what it did to earn one.`];
    case "earned_not_claimed":
      return [
        `${name} has done enough to be an identity on Arc. Claiming it records what already `,
        "happened.",
      ];
    case "not_earned":
      return [
        `${name} is not an identity on Arc yet. It becomes one by doing things that leave `,
        "evidence somebody outside here can read, not by signing up.",
      ];
  }
}

/** The four counts the receipts page reports, projected from the one place
 *  they are derived so the page cannot count them a second time and differ. */
export type PurchaseStanding = {
  attempts: number;
  paid: number;
  passed: number;
  spentUsdc: number;
  attested: number;
};

export function purchaseStanding(standing: NovaDerivedStanding): PurchaseStanding {
  return {
    attempts: standing.veyraDecisions,
    paid: standing.observedOutcomes,
    passed: standing.verifiedResearch,
    spentUsdc: standing.spentUsdc,
    attested: standing.attestedOnArc,
  };
}

/**
 * How much of what was paid for held up.
 *
 * The denominator is payments, never attempts. "1 of 6" put attempts where
 * money had not moved into the same fraction as paid calls, which reads as a
 * far worse hit rate than the money actually bought. An attempt is a decision,
 * a payment is an exposure, a pass is a result.
 */
export function purchaseSummary(standing: PurchaseStanding): Claim {
  if (standing.paid === 0) {
    return [standing.attempts === 0 ? "nothing bought yet" : "nothing paid yet"];
  }
  /* Passes are counted over settled attempts and payments over attempts where
     money moved, so a row carrying a verdict and no amount would lift the
     numerator above the denominator. It has not happened. If it does, the
     honest output is two counts rather than a fraction reading over 100%. */
  if (standing.passed > standing.paid) {
    return [figure(standing.passed), " passed, ", figure(standing.paid), " paid"];
  }
  return [figure(standing.passed), " of ", figure(standing.paid), " paid"];
}

/**
 * Who controls this agent, as opposed to who holds its token.
 *
 * `controlledByRecoveryKey` is not a setting. Access is granted by matching the
 * owner-secret digest, and that path never reads the ERC-8004 token at all.
 * `transferableInProduct` is a literal rather than a boolean so that shipping a
 * transfer flow breaks this file: the sentences below would still compile
 * against a boolean and would still be wrong.
 */
export type AgentAccessState = {
  onchainOwner: string | null;
  controlledByRecoveryKey: true;
  transferableInProduct: false;
};

export function agentAccessState(identity: NovaArcIdentity | null): AgentAccessState {
  return {
    onchainOwner: identity?.owner ?? null,
    controlledByRecoveryKey: true,
    transferableInProduct: false,
  };
}

/**
 * What a transfer would and would not do.
 *
 * This said the transfer "changes its owner on Arc, and nothing else changes",
 * which was false in the direction that costs somebody an agent: the token
 * would move and the new holder would have no way in, because the way in is the
 * recovery key. A missing feature is named as missing.
 */
export function transferWarning(access: AgentAccessState, name: string, brand: string): Claim {
  if (!access.onchainOwner) return [];
  return [
    "You own this identity onchain. Transferring the ERC-8004 token changes its owner on Arc — ",
    `but access to this ${name} still follows its recovery key, so a transfer today moves the `,
    `token and not the agent. Moving both at once needs a transfer inside ${brand}, which does `,
    "not exist yet.",
  ];
}

export type BriefState = {
  /** Everything the brief kept, which is everything that was not noise. */
  inBrief: number;
  /** Named sources that could not be read on this pass. */
  unreachable: string[];
  watched: number;
};

/**
 * What today's brief contains.
 *
 * Not "worth your attention". The brief keeps everything that is not noise,
 * low relevance included, so that heading sat above cards labelled "low
 * relevance" and argued with them. The brief says how much is in it; each card
 * says how much it thinks of itself.
 */
export function briefSummary(state: BriefState): Claim {
  if (state.inBrief > 0) {
    return [figure(state.inBrief), count(state.inBrief, " item", " items"), " in today's brief."];
  }
  if (state.unreachable.length > 0) {
    return [
      `Could not reach ${state.unreachable.join(" and ")}, so this is an incomplete look rather `,
      "than a quiet day.",
    ];
  }
  return [
    "No source-supported finding was selected from the ", figure(state.watched),
    count(state.watched, " thing", " things"), " checked.",
  ];
}

/* ------------------------------------------------------------------ shadow */

/**
 * Generic names for the checks, for counting rather than for one decision.
 *
 * A decision's own `detail` carries the numbers -- "Trust 62 < 90" -- because
 * it is about that purchase. A tally is about three of them at once, so it can
 * only say the kind of thing that went wrong.
 */
const DECLINE_LABELS: Record<string, [one: string, many: string]> = {
  capability_allowed: ["a capability you did not allow", "capabilities you did not allow"],
  rail_allowed: ["a rail you did not allow", "rails you did not allow"],
  network_matches_mandate: ["the wrong chain", "the wrong chain"],
  veyra_decision_allows: ["Veyra's own decision", "Veyra's own decision"],
  trust_at_least_minimum: ["trust below your minimum", "trust below your minimum"],
  within_per_action_limit: ["over your per-action limit", "over your per-action limit"],
  within_daily_budget: ["over today's budget", "over today's budget"],
  within_total_budget: ["over this mandate's total", "over this mandate's total"],
  attempts_remaining: ["today's attempts already used", "today's attempts already used"],
  payable_unattended: ["needing a deposit you would have to make", "needing deposits you would have to make"],
  evaluator_where_required: ["an unchecked answer above your evaluator threshold", "unchecked answers above your evaluator threshold"],
};

/** The codes that have been given words. A check missing from here still
 *  renders, but renders as its own name -- so the set is exported and asserted
 *  against the list of checks, because a test that only inspected the output
 *  would be satisfied by the fallback and prove nothing. */
export const LABELLED_DECLINE_CODES = new Set(Object.keys(DECLINE_LABELS));

export function declineReasonLabel(code: string, count: number): string {
  const pair = DECLINE_LABELS[code];
  if (!pair) return code.replace(/_/g, " ");
  return count === 1 ? pair[0] : pair[1];
}

/**
 * The sentence the whole phase rests on.
 *
 * Exported as one value used everywhere rather than typed out per screen. A
 * shadow decision that reached a person without this line beside it would be
 * indistinguishable from a purchase, and the difference is the entire point.
 */
export const NO_MONEY_MOVED = "No money moved.";

/**
 * The stronger sentence, and the one that is only true in PREVIEW.
 *
 * "No money moved" is about a night that has happened. This is about what the
 * signature permits, and it stops being true the moment somebody signs an
 * AUTOPILOT mandate -- so it is never written next to a mode that is not
 * PREVIEW, and there is an invariant that says so.
 */
export const NO_MONEY_CAN_MOVE = "No money can move in Preview.";

/**
 * What the wallet prompt does not say, shown before the wallet opens.
 *
 * A person about to sign spending limits is entitled to know that signing them
 * is not the thing that turns spending on. MetaMask will show an EIP-712
 * message with eleven numeric fields in it and no indication of which mode
 * they belong to.
 */
export function previewOnlyWarning(): Claim {
  return [
    "This signature authorizes simulation only. Enabling real autonomous spending later will ",
    "require a new signature.",
  ];
}

/**
 * Whether Nova is rehearsing, and what that means.
 *
 * "Off" is the ordinary state and is written as a fact, not as a fault. Most
 * agents have signed nothing, which is the correct default for a product that
 * spends other people's money.
 */
const BLOCK_REASON: Record<string, string> = {
  mandate_version_predates_autonomy:
    "The limits you signed predate unattended decisions, so they do not grant any.",
  mandate_expired: "The limits you signed have expired.",
  mandate_revoked: "You revoked the limits you signed.",
  mandate_timezone_unusable:
    "The limits you signed name a timezone this server cannot read, so there is no budget day to measure.",
  mandate_sets_terms_shadow_cannot_check:
    "The limits you signed include a confidence floor or a verified-identity requirement, and neither is something a decision here can check yet.",
};

/** Block reasons that have been given words, asserted against AUTONOMY_BLOCKS
 *  for the same reason the decline labels are: the fallback would hide a gap. */
export const EXPLAINED_BLOCKS = new Set(Object.keys(BLOCK_REASON));

export function autonomyStateClaim(view: NovaShadowView, name: string): Claim {
  if (view.state === "off") {
    /* Something signed and not usable is not the same as nothing signed. Left
       to the plain "asks before every paid action", somebody who had just
       signed limits would read that their agent was working as intended while
       their mandate was in fact being ignored. */
    const why = view.blocked ? BLOCK_REASON[view.blocked] : null;
    return why
      ? [`${name} asks before every paid action. `, why]
      : [`${name} asks before every paid action.`];
  }
  const limits = view.limits;
  if (!limits) return [`${name} is watching, and nothing is authorised yet.`];
  const head: Claim = [
    `${name} decides as if it could pay, and stops before it can. Up to `,
    figure(`$${limits.perActionUsdc.toFixed(4)}`), " an action and ",
    figure(`$${limits.dailyUsdc.toFixed(4)}`), " a day, on your ",
    figure(limits.timezone), " clock. ",
  ];
  /* The mode decides which sentence is true. Under PREVIEW nothing can move;
     under a live mandate the honest statement is only about this rehearsal
     having moved nothing, which is a smaller claim. */
  return [...head, limits.mode === "PREVIEW" ? NO_MONEY_CAN_MOVE : NO_MONEY_MOVED];
}

/**
 * The night, in three numbers and a disclaimer.
 *
 * "Would spend" counts only the allowances. The denials are reported as what
 * they withheld, because those are opposite facts and a single figure covering
 * both would be the "1 of 6" mistake with money in it.
 */
export function shadowNightClaim(summary: ShadowSummary): Claim {
  if (summary.decisions === 0) {
    /* Not "nothing came up". Things came up on the night this was written and
       Veyra could price none of them -- no endpoint took a plain question, and
       the model that writes them was timing out. A brief that reported an
       empty market would have been the screen inventing a quiet day again. */
    return ["No decision was reached today. ", NO_MONEY_MOVED];
  }
  return [
    figure(summary.wouldInvestigate),
    summary.wouldInvestigate === 1 ? " thing" : " things",
    " allowed by spending policy, ",
    figure(summary.wouldDecline), " stopped by your limits. ",
    NO_MONEY_MOVED,
  ];
}

/**
 * What the allowances would have cost, kept apart from what was withheld.
 *
 * Bare, because it is read under a label that already says "would spend". A
 * sentence here would print "Would spend -- $0.0030 would have been spent",
 * and a row that restates its own label is how a figure ends up sounding like
 * a claim about something else.
 */
export function shadowSpendClaim(summary: ShadowSummary): Claim {
  /* Not $0.0000. Nothing was allowed, and a zero in a money column reads as a
     purchase that cost nothing rather than as an absence of purchases. */
  if (summary.wouldInvestigate === 0) return ["nothing"];
  return [figure(`$${summary.wouldSpendUsdc.toFixed(4)}`)];
}

/** What the limits kept. Null-safe about a budget nobody has declared. */
export function shadowRemainingClaim(summary: ShadowSummary): Claim {
  if (summary.remainingTodayUsdc === null) return ["no daily budget set"];
  return [figure(`$${summary.remainingTodayUsdc.toFixed(4)}`)];
}

/**
 * Why the others were stopped.
 *
 * Reported in full rather than as a headline count, because a person tuning
 * limits needs to know which limit did the stopping -- and because a decision
 * stopped by two of them appears under both, so the counts here can sum to
 * more than the number of decisions. That is correct and worth showing.
 */
export function shadowDeclineClaims(summary: ShadowSummary): Claim[] {
  return summary.declinedBecause.map((entry) => [
    figure(entry.count), " ", declineReasonLabel(entry.code, entry.count),
  ]);
}

/** One decision's verdict, in the words the card shows above its checks. */
export function shadowVerdictClaim(
  verdict: "WOULD_ALLOW" | "WOULD_DENY",
  name: string,
): Claim {
  return verdict === "WOULD_ALLOW"
    ? [`${BRAND_NAME} would allow this, and ${name} did not pay for it.`]
    : [`${BRAND_NAME} would stop this.`];
}

/* Named here rather than imported, so this module stays free of anything that
   reaches a network or a database and can be exercised on its own. */
const BRAND_NAME = "Veyra";
