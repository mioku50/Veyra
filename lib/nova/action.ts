/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaSignal } from "./types.ts";

/**
 * What a card is actually asking to do, decided before anybody is routed.
 *
 * Veyra kept confusing two different sentences:
 *
 *   "Find out what changed in Ethereum EIPs"    -- the subject is a repository,
 *   and a research provider is a tool. Which tool is a routing decision, and a
 *   different approved provider is a legitimate answer as long as the card says
 *   whose work it is.
 *
 *   "Try this Exa endpoint"                     -- the subject IS the endpoint.
 *   There is no substitute. Buying an answer about Exa from somebody else's
 *   Reddit scraper is not a cheaper version of the same thing, it is a
 *   different thing, and it happened: twenty times the price, silently.
 *
 * So an action carries its own subject, intent, type and required capability,
 * and routing is only allowed to choose once those are fixed. The rule the
 * types exist to enforce: the object of the action is never swapped for another
 * one, not for a lower price and not for a higher trust score.
 */

export type NovaActionType =
  /** The subject is a thing to learn about. Any approved provider may do the
   *  work, and the card names which one did. */
  | "research_subject"
  /** The subject is the counterparty. Only it may be paid; if Veyra will not
   *  authorise it, the answer is no, not somebody else. */
  | "interact_with_subject";

export type NovaActionSubject = {
  kind: "x402_resource" | "github_repository";
  /** The subject's id in the source it came from. For a catalogue listing this
   *  is the candidate id, which is what pins routing to it. */
  ref: string | null;
  label: string;
};

export type NovaAction = {
  actionType: NovaActionType;
  subject: NovaActionSubject | null;
  /** The question, in the words the card will show. */
  intent: string;
  /** What the counterparty has to be able to do. For an interaction it is the
   *  subject's own capability; for research it is research. */
  requiredCapability: string;
  /** What to ask the catalogue for. */
  query: string;
};

/**
 * The action a signal implies.
 *
 * A catalogue listing is a seller: the card is named after it, the price on the
 * card is its price, and the only honest thing to do with it is deal with it.
 * A repository sells nothing -- "22 new commits in LangChain" is not a
 * capability anyone offers -- so the work has to be bought from somebody, and
 * who that is becomes a routing question with a real answer.
 */
export function actionFor(signal: NovaSignal): NovaAction {
  const subjectContext = (signal.evidence?.subject ?? {}) as Record<string, unknown>;
  const label = signal.subjectLabel ?? "this";

  if (signal.subjectKind === "github_repository") {
    return {
      actionType: "research_subject",
      subject: { kind: "github_repository", ref: signal.subjectRef ?? null, label },
      intent: `What changed in ${label}, and does it matter?`,
      requiredCapability: "research",
      query: `${label} project update`,
    };
  }

  /* Everything a catalogue listing can produce -- it appeared, its price moved,
     its payee moved, its rail moved, it stopped answering -- is a fact about
     that endpoint. None of them is a question another seller can be paid to
     answer, and the price printed on the card is this endpoint's price. */
  const capability = typeof subjectContext.capability === "string" && subjectContext.capability.trim()
    ? subjectContext.capability.trim()
    : "research";

  return {
    actionType: "interact_with_subject",
    subject: signal.subjectKind === "x402_resource"
      ? { kind: "x402_resource", ref: signal.subjectRef ?? null, label }
      : null,
    intent: `What is ${label} for, and is it worth paying for?`,
    requiredCapability: capability,
    query: label,
  };
}
