/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaSignal } from "./types.ts";
import { policyCapabilityFor } from "./capability.ts";

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
  /**
   * What kind of paid action this is -- the value a mandate authorises.
   *
   * One of POLICY_CAPABILITIES, or "unclassified" when the endpoint publishes
   * nothing Veyra can read a kind out of. It used to be the discovery term,
   * which is a different question entirely: see discoveryTerm.
   */
  requiredCapability: string;
  /**
   * The word this subject was found by, kept for finding things like it.
   *
   * Good at discovery and useless as a permission. Circle's search matches
   * anywhere in a row, so searching "payment" returns every x402 listing that
   * mentions payment -- which is all of them -- and the agent's own terms
   * include Arc, USDC and stablecoin, which are topics and not actions at all.
   */
  discoveryTerm: string;
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
      /* Reading a repository and writing up what changed is research whoever
         is paid to do it, and unlike an endpoint there is nothing here to
         classify: a repository publishes no route and sells nothing. */
      requiredCapability: "research",
      discoveryTerm: "research",
      /* Discovery searches descriptions of services, not the web. "project
         update" found domain/webhook update APIs; the project belongs in the
         research intent, while the catalog query names the service we need. */
      query: "web search",
    };
  }

  /* Everything a catalogue listing can produce -- it appeared, its price moved,
     its payee moved, its rail moved, it stopped answering -- is a fact about
     that endpoint. None of them is a question another seller can be paid to
     answer, and the price printed on the card is this endpoint's price. */
  const term = typeof subjectContext.capability === "string" && subjectContext.capability.trim()
    ? subjectContext.capability.trim()
    : "research";

  /* The permission is read from the endpoint, never from the word that found
     it. Stored on the signal, `capability` is the discovery term, and on the
     live catalogue that term said "payments" for a CAPTCHA solver, a meme
     generator, Messari's news feed and eight Apollo people-search routes --
     none of which takes a payment. A mandate built on those values would say
     one thing and authorise another. */
  const capability = policyCapabilityFor({
    resource: typeof subjectContext.resource === "string" ? subjectContext.resource : "",
    description: typeof subjectContext.description === "string" ? subjectContext.description : null,
    provider: typeof subjectContext.provider === "string" ? subjectContext.provider : null,
  });

  return {
    actionType: "interact_with_subject",
    subject: signal.subjectKind === "x402_resource"
      ? { kind: "x402_resource", ref: signal.subjectRef ?? null, label }
      : null,
    intent: `What is ${label} for, and is it worth paying for?`,
    requiredCapability: capability,
    discoveryTerm: term,
    query: label,
  };
}
