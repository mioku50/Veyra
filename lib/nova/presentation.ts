/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaArcIdentity } from "./identity.ts";
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
    "Nothing moved across the ", figure(state.watched),
    count(state.watched, " thing", " things"), " being watched for you.",
  ];
}
