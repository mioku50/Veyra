/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAddress, isAddress } from "viem";
import {
  issueMarketplaceClearance,
  selectMarketplaceCounterparty,
} from "../counterparty-selection/marketplace.ts";
import type {
  MarketplaceRankedCandidate,
  MarketplaceSelection,
  MarketplaceSelectionClearance,
} from "../counterparty-selection/marketplace.ts";
import { isExecutableTrustDecision } from "../trust-gate/types.ts";
import type { TrustDecision, TrustDecisionLevel } from "../trust-gate/types.ts";
import { priceX402Call, quoteX402Call, type X402PricedTerms, type X402Quote } from "../x402/execution.ts";
import { buildRequestBody } from "../x402/request-body.ts";
import { marketplaceCandidateId } from "../counterparty-selection/marketplace-source.ts";
import type { JsonSchema } from "../seller/json-schema.ts";
import {
  compareTerms,
  hashTerms,
  usdcFromAtomic,
  type NovaResearchTerms,
  type TermsChange,
} from "./research-terms.ts";
import type { NovaSignal } from "./types.ts";
import { networkName } from "./network.ts";
import { actionFor, type NovaAction, type NovaActionType } from "./action.ts";
import { paidResearchReadiness, assessmentOf } from "./value.ts";
import type { sharpenIntent } from "./intent.ts";

/**
 * What it would cost to look deeper, and who would be paid.
 *
 * Veyra already knows how to do this: discover candidates from Circle's
 * catalogue, probe each one's live 402 challenge for free, rank them on
 * evidence, and refuse the ones policy will not allow. That whole engine runs
 * here unchanged. What this module adds is the translation -- from a line in
 * somebody's morning brief into a question a paid endpoint can answer, and back
 * from a ranked selection into four numbers a person can decide on.
 *
 * Nothing here spends anything. It cannot: the proposal is evidence, and the
 * payment is a signature the owner's own wallet makes afterwards.
 */

/** The most a single investigation may propose. A brief is a place to read, not
 *  a place to be surprised by a bill; anything dearer than this belongs on the
 *  developer surface where the whole market is visible. */
export const RESEARCH_BUDGET_USDC = 0.05;

/** Enough to see a market rather than a winner, few enough to probe them all
 *  inside a request a person is waiting on. */
const RESEARCH_CANDIDATE_LIMIT = 8;

/**
 * The wallet used when nobody has connected one.
 *
 * A proposal is read-only, but the engine wants a requester: it reads that
 * wallet's Circle Gateway balance to decide which candidates it could actually
 * settle. The zero address funds nothing, which is exactly the right answer for
 * somebody who has not connected a wallet -- it means "assume no deposit", and
 * the vanilla-first rule below then does the work.
 */
const NO_WALLET = "0x0000000000000000000000000000000000000000" as const;

export type NovaResearchProposal = {
  researchNeed?: { goal: string; missing: string; expectedResult: string };
  signalId: string;
  /** What Nova would ask, in the words it would ask it. */
  question: string;
  capability: string;
  provider: string;
  resource: string;
  costUsdc: number;
  /** 0-100, from the same evidence the developer surface shows. */
  trustScore: number;
  funding: "wallet" | "gateway_deposit";
  /** "Direct USDC" or "Circle Gateway deposit", as a person would read it. */
  paymentLabel: string;
  payableNow: boolean | null;
  decision: TrustDecisionLevel;
  /** Veyra's verdict in one sentence. */
  verdict: string;
  maxExposureUsdc: number;
  /** Whether Veyra checks the answer against the declared schema after paying.
   *  The reassuring half of the evaluator tier, and the half a reader can see. */
  verifiedAfterPaying: boolean;
  /** Why this one, in the order that decided it. */
  reasons: string[];
  /** How many were looked at to get here. */
  probed: number;
  /** Set when evidence's first choice was passed over, and why. */
  routingNote: string | null;
  /** Whether the subject is the thing being learned about or the thing being
   *  dealt with. An interaction is never routed to anybody else. */
  actionType: NovaActionType;
  /** What the card is named after, when it is named after something. */
  subjectLabel: string | null;
  /** The provider whose work this is, for research. Null for an interaction,
   *  where the provider and the subject are the same party. */
  performedVia: string | null;
  expiresAt: string;
  /** A fingerprint of the seven facts above. Carried back on approval so the
   *  market can be checked against what this card actually said, rather than
   *  against whatever it says by the time somebody presses the button. */
  termsHash: string;
};

/**
 * What the proposal committed to, kept on the server.
 *
 * None of this is decoration on the card: it is what makes the approval
 * checkable. The request body especially -- x402 prices per call, so a proposal
 * that did not pin the body priced a different request than the one it would
 * have paid for.
 */
export type NovaResearchPlan = {
  terms: NovaResearchTerms;
  query: string;
  requestBody: unknown;
  /** Set when no input schema was published and the shape is Veyra's guess. */
  requestNote: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  candidateId: string;
  method: "GET" | "POST";
  verificationRequired: boolean;
  maxExposureUsdc: number;
};

export type NovaResearchOutcome =
  | { ok: true; proposal: NovaResearchProposal; plan: NovaResearchPlan }
  | { ok: false; reason: string; detail: string };

/**
 * The question a signal is worth asking.
 *
 * A catalogue entry already knows what it does, so its own capability is the
 * honest query. A repository does not -- "22 new commits in LangChain" is not a
 * capability anyone sells -- so it becomes a research question, which is a
 * capability the market does sell.
 */
export function researchRequestFor(signal: NovaSignal): { capability: string; query: string; question: string } {
  const action = actionFor(signal);
  return { capability: action.requiredCapability, query: action.query, question: action.intent };
}

/**
 * Prefers a counterparty this person can pay from their wallet balance.
 *
 * The shared engine only routes around a Gateway candidate once it knows the
 * deposit is short. That is right for the developer surface, where a deposit is
 * a normal thing to have. It is wrong here: the person being asked to approve
 * one tenth of a cent has not heard of Circle Gateway, and "approve $0.001"
 * followed by "first, fund a deposit" is not an approval, it is a dead end
 * wearing a button.
 *
 * So Nova takes the best wallet-payable candidate the engine already ranked and
 * already allowed. It never promotes something policy refused, and it never
 * re-ranks: it walks the same order and skips a rail, which is the same thing
 * routeToPayableRail does, with the threshold moved to where a human is.
 */
/**
 * What Nova is willing to put in front of a person.
 *
 * Veyra already answers this, and the answer is isExecutableTrustDecision. Nova
 * had its own list, and the list was wrong twice over.
 *
 * First it allowed only ALLOW and ALLOW_WITH_LIMITS, which against the live
 * catalogue meant every question came back "Veyra checked eight providers and
 * would not authorise any of them" -- three questions, two subject kinds, three
 * refusals. A young catalogue has no payment history, so almost nothing reaches
 * the top two tiers.
 *
 * Then it excluded REQUIRE_EVALUATOR on the reasoning that it means an ERC-8183
 * job. It does not, not here: on a marketplace candidate that tier sets
 * postCallVerificationRequired, and the settle route already verifies the
 * response against the declared schema after paying. Veyra calls it executable;
 * Nova was refusing to show what Veyra allows.
 *
 * So the shared predicate decides, and there is no second list to drift. DENY
 * and REVIEW_REQUIRED are what it excludes, and both are right to exclude:
 * Veyra will not execute either, and a Pay button on something Veyra will not
 * execute is a button that exists to fail.
 */
function preferWalletPayable(candidates: MarketplaceRankedCandidate[]) {
  const showable = candidates.filter((candidate) =>
    isExecutableTrustDecision(candidate.trustDecision));
  const wallet = showable.find((candidate) => candidate.marketplace.funding === "wallet");
  if (wallet) return { candidate: wallet, note: null };

  const first = showable[0] ?? null;
  if (!first) return null;
  return {
    candidate: first,
    note: "Nothing here settles from a wallet balance, so this one needs a Circle Gateway deposit before it can be paid.",
  };
}

/** The same counterparty as last time, or nobody. Used when re-reading the
 *  market for an approval: the question there is whether *this* endpoint still
 *  offers what it offered, and answering it with a different endpoint would be
 *  the silent substitution the whole revalidation exists to prevent. */
function pinnedTo(resource: string) {
  return (candidates: MarketplaceRankedCandidate[]) => {
    const match = candidates.find((candidate) => candidate.marketplace.resource === resource);
    return match ? { candidate: match, note: null } : null;
  };
}

export function termsFromCandidate(candidate: MarketplaceRankedCandidate, capability: string): NovaResearchTerms {
  return {
    provider: candidate.marketplace.provider?.name ?? "Unknown provider",
    resource: candidate.marketplace.resource,
    capability,
    priceAtomic: String(Math.round(candidate.marketplace.priceUsdc * 1e6)),
    payTo: candidate.marketplace.payTo,
    network: candidate.marketplace.network,
    funding: candidate.marketplace.funding,
  };
}

/** What Veyra decided, counted, so a refusal can say what it refused. */
function refusalDetail(selection: MarketplaceSelection): string {
  if (selection.probed === 0) return "Nothing in the catalogue answers this question yet.";
  const counts = new Map<string, number>();
  for (const candidate of selection.candidates) {
    counts.set(candidate.trustDecision, (counts.get(candidate.trustDecision) ?? 0) + 1);
  }
  const denied = counts.get("DENY") ?? 0;
  const review = counts.get("REVIEW_REQUIRED") ?? 0;
  const parts: string[] = [];
  if (denied > 0) parts.push(`${denied} refused outright`);
  if (review > 0) parts.push(`${review} with too little evidence to act on`);
  const tail = parts.length > 0 ? `: ${parts.join(", ")}.` : ".";
  return `${BRAND_NAME} probed ${selection.probed} ${selection.probed === 1 ? "provider" : "providers"} and would not put any of them in front of you${tail}`;
}

const BRAND_NAME = "Veyra";

/**
 * What the money does, and where.
 *
 * The chain is named because the card carries an interest chip -- ARC, AI,
 * Research -- in the same few inches, and somebody who picked Arc as an
 * interest and then reads "Direct USDC" next to the word ARC has been given
 * every reason to think the payment settles there. It does not: Circle's
 * catalogue publishes 1139 resources and none of them are on Arc. Arc is where
 * the decision is signed, not where this money moves, and the card should not
 * make a reader work that out.
 */
function paymentLabelFor(funding: "wallet" | "gateway_deposit", network: string): string {
  const chain = networkName(network);
  const rail = funding === "wallet" ? "Direct USDC" : "Circle Gateway deposit";
  return chain ? `${rail} on ${chain}` : rail;
}

/**
 * A verdict a person can act on.
 *
 * The engine's own explanation is written for somebody reading a selection
 * next to its evidence. Here there is no evidence on screen, so the sentence
 * has to carry its own weight: what was decided, and what it costs at most.
 */
function verdictFor(decision: TrustDecisionLevel, authorisedUsdc: number): string {
  switch (decision) {
    case "ALLOW":
      return `Allow. $${authorisedUsdc.toFixed(4)} leaves your wallet, and nothing more.`;
    case "ALLOW_WITH_LIMITS":
      return `Allow, for $${authorisedUsdc.toFixed(4)} and no more.`;
    case "REQUIRE_EVALUATOR":
      /* On an x402 call this tier does not mean an evaluator contract -- it
         means the answer is checked against the endpoint's declared schema
         after the money moves, which the settle path already does. Saying
         "evaluator" to a reader would name a thing they will never see. */
      return `Allow $${authorisedUsdc.toFixed(4)}, and check the answer afterwards.`;
    case "REVIEW_REQUIRED":
      return "Worth a look before you pay. The evidence is thinner than Veyra likes.";
    default:
      return "Refused. Veyra will not authorise this counterparty.";
  }
}

/**
 * The first counterparty Veyra allows, Nova can pay, and can actually ask.
 *
 * Walks the engine's ranking, wallet-payable rails first -- the same order the
 * selection was given -- and stops at the first candidate whose request body
 * the endpoint's own 402 challenge accepts. Three attempts, because a person is
 * waiting and a catalogue where the top three all refuse a plain question is
 * telling you something a fourth call will not change.
 *
 * The quote is kept. It is the only thing that knows what this exact request
 * costs, and using the catalogue's number on the card instead would make every
 * approval report a price change that never happened.
 */
type PayableOutcome =
  | {
      kind: "payable";
      winner: MarketplaceRankedCandidate;
      request: ReturnType<typeof buildRequestBody>;
      quote: X402PricedTerms;
      /** Set only for research bought from somebody other than the subject. */
      skipped: string | null;
    }
  /**
   * The object of the action cannot be paid, and nothing may stand in for it.
   *
   * Three outcomes, not one. They used to share the code `subject_refused`, and
   * a calibration week cannot use that number: "the card is stale", "Veyra
   * looked at this endpoint and said no" and "the endpoint is real and will not
   * take a plain question" are a defect, a policy decision and a fact about the
   * market. Exactly the distinction `unpriced` already draws between
   * nothing_askable and nothing_allowed, missing one level down.
   */
  /** Not in the catalogue any more, or never reachable: the card has gone stale. */
  | { kind: "subject_missing"; refusal: string }
  /** Found, and Veyra will not authorise it. A decision, not a failure. */
  | { kind: "subject_policy_refused"; refusal: string }
  /** Found and authorised, and it cannot be asked this question. */
  | { kind: "subject_unaskable"; refusal: string }
  /** Nothing in the shortlist could be asked. */
  | { kind: "none" };

async function firstPayable(input: {
  selection: MarketplaceSelection;
  action: NovaAction;
  fetchImpl?: typeof fetch;
  attempts?: number;
}): Promise<PayableOutcome> {
  const showable = input.selection.candidates.filter((candidate) =>
    isExecutableTrustDecision(candidate.trustDecision));
  const byRail = [
    ...showable.filter((candidate) => candidate.marketplace.funding === "wallet"),
    ...showable.filter((candidate) => candidate.marketplace.funding !== "wallet"),
  ];
  /* Ask the endpoint the signal is about, if it can be asked.
     "Exa contents is available for $0.0010" produced a question about Exa and
     bought an answer from somebody else's Reddit scraper for twenty times the
     price. The generic ranking is right when there is no obvious subject -- a
     repository does not sell anything -- and wrong the moment there is one: the
     thing best placed to say what Exa contents is for is Exa contents. */
  const subjectRef = input.action.subject?.ref ?? null;
  const subject = subjectRef
    ? byRail.find((candidate) => candidate.marketplace.candidateId === subjectRef) ?? null
    : null;

  /* The object of the action is never swapped for another one.
     An interaction is named after its counterparty: the card says "Exa contents
     is available for $0.0010", the price on it is Exa's price, and the only
     honest thing to do with it is deal with Exa. Buying an answer about Exa
     from somebody else's Reddit scraper is not a cheaper version of that, it is
     a different thing -- and it happened, at twenty times the price, with no
     note on the card at all. If Veyra will not authorise the endpoint, the
     answer is no. Not somebody else.

     Research is the other case, and it is genuinely a routing decision: a
     repository sells nothing, so the work has to be bought from somebody, and
     any approved provider may do it as long as the card says whose work it
     is. */
  if (input.action.actionType === "interact_with_subject") {
    if (!subject) {
      /* Reached and refused, or not reached at all. The sentence was already
         different; only the code was shared, so the difference reached a reader
         and never reached telemetry. */
      const reached = Boolean(subjectRef)
        && input.selection.candidates.some((c) => c.marketplace.candidateId === subjectRef);
      return reached
        ? { kind: "subject_policy_refused", refusal: `${BRAND_NAME} would not pay this endpoint.` }
        : { kind: "subject_missing", refusal: `${BRAND_NAME} could not reach the terms of this endpoint to authorise it.` };
    }
  }

  const ordered = subject ? [subject, ...byRail.filter((c) => c !== subject)] : byRail;

  /* The reason the first candidate was passed over, if one was. Rank-neutral
     wording, because the walk is in rank order and "a higher-ranked endpoint"
     is true of every skip -- "the best-ranked one" is true only of the first,
     and a sentence that is right most of the time is the wrong kind of
     explanation for a screen about money. */
  let skipped: string | null = null;
  /* The same reason without the routing sentence wrapped round it. An
     interaction walks one candidate, so "passed over a higher-ranked endpoint"
     describes a choice that was never available -- what a reader needs there is
     the reason itself. */
  let blocked: string | null = null;
  const note = (reason: string) => {
    skipped ??= `${BRAND_NAME} passed over a higher-ranked endpoint: ${reason}`;
    blocked ??= reason;
  };

  /* One candidate for an interaction, by definition. The walk exists to find a
     usable seller among several; here there is only ever one that is allowed to
     be paid, and "try the next one" is the bug. */
  const walk = input.action.actionType === "interact_with_subject"
    ? [subject!]
    : ordered.slice(0, input.attempts ?? 4);

  for (const candidate of walk) {
    /* A path template Nova cannot fill. Circle's catalogue publishes these
       literally -- x402.api.agentmail.to/v0/domains/{domain_id} -- and they are
       endpoints for a caller that already knows which record it means. Nova
       does not, and POSTing to a path with braces in it buys an error. */
    if (/[{}]/.test(candidate.marketplace.resource)) {
      note("it answers about one specific record, and a brief has no way to say which.");
      continue;
    }

    const request = buildRequestBody({
      intent: input.action.intent,
      capability: input.action.discoveryTerm,
      inputSchema: (candidate.marketplace.inputSchema ?? null) as JsonSchema | null,
    });
    /* An endpoint whose published vocabulary has nowhere to put the question.
       Alchemy's token-price call declares `{addresses: [{address, network}]}`
       and no required list, so the body built from it was `{}` -- schema-valid,
       carrying not one word of what was asked. It quoted cleanly, because the
       402 middleware sits in front of the handler and never sees the body, and
       the handler answered the paid call with "Required argument [HttpRequest
       request] not specified" for a tenth of a cent that nobody refunded.

       Quoting is not enough of a check: it proves the endpoint sells something,
       not that it was asked anything. If the intent cannot be expressed in the
       provider's own field names, this endpoint cannot answer this question,
       and no amount of verification afterwards recovers the money. */
    if (request.guessed || request.intentField === null) {
      note("its published inputs have nowhere to put a question, so it cannot be asked this one.");
      continue;
    }

    /* Priced, not quoted. This loop is deciding which endpoint to use, and a
       quote now requires a decision to already exist -- the price is part of
       what makes the decision, so asking for one here would be circular.
       Nothing this returns can be signed against: it mints no nonce and no
       quote id, and settle accepts neither from a caller. */
    const quoted = await priceX402Call({
      resource: candidate.marketplace.resource,
      method: candidate.marketplace.method,
      requestBody: request.body,
      maxAmountUsdc: RESEARCH_BUDGET_USDC,
      inputSchema: candidate.marketplace.inputSchema,
    });

    if (quoted.kind === "free") {
      note("it answers without charging, so there is nothing here to authorise or verify.");
      continue;
    }
    if (quoted.kind === "refused") {
      note("it will not accept a plain question -- it wants parameters only its own callers would know.");
      continue;
    }
    /* A challenge that asks for nothing. No amount for a wallet to cap, and
       nothing for the post-call check to compare against. "Pay $0.0000" is not
       an offer, it is a bug with a button. The developer surface can still
       choose it; a brief cannot. */
    if (BigInt(quoted.quote.accept.amountAtomic) <= BigInt(0)) {
      note("it asks for a payment of nothing, which is not something Veyra can authorise or verify.");
      continue;
    }

    return {
      kind: "payable",
      winner: candidate,
      request,
      quote: quoted.quote,
      /* Only when the ranking was actually departed from. Silently substituting
         a counterparty is the kind of unexplained decision this product exists
         to refuse -- including when the reason is mundane. */
      /* No note when the subject's own endpoint won, or when the ranking
         stood: a sentence apologising for a substitution that did not happen is
         the screen explaining itself incorrectly. */
      /* The subject note survives even when the ranking stood, because there it
         is not an apology for departing from the order -- it is the reason the
         order does not contain the thing the card is named after. */
      /* Research bought from somebody other than the subject is named on the
         card. An interaction has nothing to say here: its provider IS its
         subject, which is the whole point. */
      skipped: candidate === walk[0] ? null : skipped,
    };
  }

  /* An interaction that got this far reached its subject and could not ask it.
     Reporting that as `nothing_askable` would file it with the research cards,
     where it means something else: there the shortlist had several sellers and
     none took a question, here the one endpoint the card is named after did
     not. */
  if (input.action.actionType === "interact_with_subject") {
    return {
      kind: "subject_unaskable",
      refusal: blocked
        ? `${BRAND_NAME} reached this endpoint, and ${blocked}`
        : `${BRAND_NAME} reached this endpoint and could not put the question to it.`,
    };
  }
  return { kind: "none" };
}

export async function proposeResearch(input: {
  signal: NovaSignal;
  goal?: string | null;
  /** The owner's wallet when one is connected, which makes the Gateway balance
   *  a real read rather than an assumption. */
  wallet?: string | null;
  /** Context the question is written from. One model serves every agent; what
   *  makes a question this agent's is these interests and this memory. */
  agentName?: string;
  interests?: string[];
  memory?: string[];
  now?: Date;
  fetchImpl?: typeof fetch;
  /** The writing model, injectable the way the relay and the reader are. */
  generateImpl?: Parameters<typeof sharpenIntent>[0]["generate"];
}): Promise<NovaResearchOutcome> {
  const readiness = paidResearchReadiness(input.signal, input.goal, input.now);
  if (!readiness.ready) return { ok: false, reason: readiness.reason, detail: readiness.detail };
  const assessment = assessmentOf(input.signal)!;
  const base = actionFor(input.signal);
  const action: NovaAction = { ...base, intent: assessment.gap!.question };
  const { requiredCapability: capability, discoveryTerm, query, intent: question } = action;
  const subjectRefWanted = action.subject?.ref ?? null;
  const requesterWallet = input.wallet && isAddress(input.wallet)
    ? getAddress(input.wallet)
    : NO_WALLET;

  let selection: MarketplaceSelection;
  try {
    selection = await selectMarketplaceCounterparty({
      request: {
        /* The term, because this is discovery and the term is what Circle's
           catalogue answers to. The policy capability goes on the proposal
           instead, where a mandate reads it -- two questions, two values, and
           sending the wrong one to either is how "arc" ended up in a list of
           things the owner authorised Nova to pay for. */
        capability: discoveryTerm,
        query,
        /* The endpoint this card is named after, asked for by id.
           An interaction's counterparty is not a search result: the card says
           "Parallel search is available for $0.0100", that price is Parallel's,
           and if Parallel is not in the answer there is nothing here to buy.
           The label was being used as the search query, and a display name is
           not a search term -- three of five subjects fell out of their own
           discovery and the card refused with "could not reach the terms of
           this endpoint", which named the symptom and not the cause. Research
           passes null: a repository sells nothing, so who does the work is
           genuinely a routing question. */
        mustInclude: base.actionType === "interact_with_subject" ? subjectRefWanted : null,
        budgetUsdc: RESEARCH_BUDGET_USDC,
        limit: RESEARCH_CANDIDATE_LIMIT,
      },
      tenant: {
        tenantKey: `nova:${input.signal.signalId}`,
        requesterWallet,
      },
      now: input.now,
      fetchImpl: input.fetchImpl,
      /* Nova's rule, applied where the engine can act on it rather than
         afterwards on its answer. Choosing the winner here is what keeps the
         card and the clearance describing the same counterparty. */
      preferCandidate: preferWalletPayable,
      /* No clearance at proposal time. A clearance is an authorisation bound to
         a wallet and an endpoint, and issuing one before anybody has agreed to
         anything would mean the act of reading a brief produced a signed
         permission to spend. It is issued when the person approves. */
      issueClearance: false,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "lookup_failed",
      detail: error instanceof Error ? error.message : "Veyra could not reach the market just now.",
    };
  }

  /* The one Nova would pay, and one it can actually ask. Ranked order, rail
     preference first -- the same order the engine was given -- but a candidate
     is only a candidate if a request can be built for it that the endpoint's own
     published schema accepts.

     This is not belt and braces. The catalogue's declared input schema and the
     one inside the 402 challenge are different documents, and the second is the
     one that decides: Otto AI's margin endpoint lists nothing and then demands
     `asset`. Pricing that card and discovering the problem when somebody presses
     Pay is a dead end wearing a button -- and /run's answer, showing the reader
     the published schema so they can repair the body, is no answer at all on a
     surface whose whole premise is that nobody has to know what a schema is. */
  const attempt = await firstPayable({
    selection,
    action,
    fetchImpl: input.fetchImpl,
  });

  /* An interaction Veyra will not authorise ends here, and says so in one
     sentence. There is no shortlist to fall back to because there is nothing a
     fallback could mean: the card is named after this endpoint and its price is
     this endpoint's price. */
  if (attempt.kind === "subject_missing"
    || attempt.kind === "subject_policy_refused"
    || attempt.kind === "subject_unaskable") {
    /* The machine reason is the precise one. The sentence a person reads is the
       umbrella it always was -- nobody needs the taxonomy on a card, and the
       week of calibration cannot be read without it. */
    return { ok: false, reason: attempt.kind, detail: `${attempt.refusal} Nothing was paid.` };
  }

  if (attempt.kind === "none") {
    const allowed = selection.candidates.filter((candidate) =>
      isExecutableTrustDecision(candidate.trustDecision)).length;
    return {
      ok: false,
      reason: allowed > 0 ? "nothing_askable" : "nothing_allowed",
      /* Two different refusals, kept apart. "Veyra would not authorise any of
         them" and "the ones it would authorise do not answer questions" are
         different facts about the market, and collapsing them into one would
         make the policy look stricter than it is. */
      detail: allowed > 0
        ? `${BRAND_NAME} found ${allowed} ${allowed === 1 ? "endpoint" : "endpoints"} it would authorise, and none of them accepts a plain question -- they want parameters only their own callers would know. Nothing was paid.`
        /* Deliberately not "no results". Veyra looked and refused, which is a
           different fact and the more useful one: it is the product doing its
           job, not failing at it. */
        : refusalDetail(selection),
    };
  }
  const { winner, request, quote, skipped } = attempt;

  /* A payment this wallet cannot make must not be offered.
     AIsa API's live challenge settles through a Circle Gateway deposit on
     Ethereum mainnet. Veyra priced it, wrote payableNow: false, labelled it
     "Circle Gateway deposit on Ethereum" -- and left the button enabled. So a
     person signed a batched authorisation against a deposit that does not
     exist and got "Payment verification failed" from the seller.

     Knowing a payment cannot succeed and asking for a signature anyway is
     worse than not knowing: it spends the one thing this product asks people
     to trust it with, which is their willingness to sign. Only an explicit
     false refuses; null means no wallet was given, and "connect a wallet
     first" is a different sentence from "you cannot pay this". */
  if (winner.marketplace.payableNow === false) {
    return {
      ok: false,
      reason: "not_payable",
      detail: `This one settles through ${paymentLabelFor(
        quote.accept.gatewayBatched ? "gateway_deposit" : "wallet",
        quote.accept.network,
      )}, which this wallet cannot pay from right now. Nothing was signed.`,
    };
  }

  const decision = winner.trustDecision;
  /* The winner's own ceiling, not the selection's recommendation object: they
     are usually the same counterparty now, but quoting a number that belongs to
     a different one is the failure this used to have and is cheap to keep out. */
  const maxExposureUsdc = winner.recommendedMaxExposureUsdc || winner.marketplace.priceUsdc;
  /* From the challenge this exact request raised, not from the listing. x402
     prices per call, so a card built on the catalogue price would differ from
     the approval for a reason that is not a change in the market -- the
     revalidation would report a price move on every single purchase. */
  const costUsdc = quote.quotedUsdc;
  const terms: NovaResearchTerms = {
    ...termsFromCandidate(winner, capability),
    priceAtomic: quote.accept.amountAtomic,
    payTo: quote.accept.payTo,
    network: quote.accept.network,
    funding: quote.accept.gatewayBatched ? "gateway_deposit" : "wallet",
  };

  return {
    ok: true,
    proposal: {
      researchNeed: { goal: assessment.goal, missing: assessment.gap!.missing, expectedResult: assessment.gap!.expectedResult },
      signalId: input.signal.signalId,
      question,
      capability,
      /* What kind of thing this card is asking to do, said on the card rather
         than inferred from it. Routing is only allowed to choose after this is
         fixed, and the reader is entitled to the same distinction: whose work
         this is, versus who is being dealt with. */
      actionType: action.actionType,
      subjectLabel: action.subject?.label ?? null,
      /* Named only when somebody other than the subject did the work, which can
         only happen for research. An interaction's provider is its subject. */
      performedVia: action.actionType === "research_subject" ? terms.provider : null,
      provider: terms.provider,
      resource: terms.resource,
      costUsdc,
      trustScore: Math.round(winner.trustScore ?? 0),
      funding: terms.funding,
      paymentLabel: paymentLabelFor(terms.funding, terms.network),
      payableNow: winner.marketplace.payableNow,
      decision,
      /* Quoted at the exact amount, because that is what the clearance will
         authorise. Naming the tier's ceiling here told a reader that up to five
         cents could leave their wallet next to a price of one -- true of the
         policy, false of the permission Veyra actually signs. */
      verdict: verdictFor(decision, costUsdc),
      maxExposureUsdc,
      verifiedAfterPaying: decision !== "ALLOW",
      reasons: reasonsFor(winner),
      probed: selection.probed,
      /* Only research has routing to explain. An interaction was never routed:
         the winner is the subject, chosen because the card is named after it,
         and printing the engine's note about which candidate it would otherwise
         have recommended describes a decision that was not Veyra's to make. */
      routingNote: action.actionType === "interact_with_subject"
        ? null
        : skipped ?? selection.recommendation.routingNote,
      expiresAt: selection.expiresAt,
      termsHash: hashTerms(terms),
    },
    plan: {
      terms,
      query,
      requestBody: request.body,
      requestNote: request.guessed ? request.note : null,
      inputSchema: (winner.marketplace.inputSchema ?? quote.inputSchema ?? null) as Record<string, unknown> | null,
      outputSchema: (winner.marketplace.outputSchema ?? quote.outputSchema ?? null) as Record<string, unknown> | null,
      candidateId: winner.marketplace.candidateId,
      method: winner.marketplace.method,
      verificationRequired: decision !== "ALLOW",
      maxExposureUsdc,
    },
  };
}

/* ---- approval ---- */

export type NovaRevalidation =
  | {
      ok: true;
      quote: X402Quote;
      terms: NovaResearchTerms;
      termsHash: string;
      clearance: MarketplaceSelectionClearance;
      candidateId: string;
      selectionId: string;
      decision: TrustDecisionLevel;
      verificationRequired: boolean;
      outputSchema: Record<string, unknown> | null;
    }
  | {
      /** The one outcome this whole module exists for. Nothing is authorised,
       *  nothing is rerouted, and the person is shown both sets of numbers. */
      ok: false;
      reason: "market_changed";
      changes: TermsChange[];
      terms: NovaResearchTerms;
      termsHash: string;
      costUsdc: number;
      detail: string;
    }
  | { ok: false; reason: "gone" | "refused" | "unquotable" | "over_budget"; detail: string };

/**
 * Reads the market again, for the exact endpoint that was on the card.
 *
 * Two reads, because they answer different questions and only one of them
 * knows the price. The selection re-probes the listing -- who the provider is,
 * what capability it claims, which rail it settles on, and whether Veyra still
 * allows it at all. The quote raises the endpoint's own 402 challenge with the
 * exact body that will be paid for, which is the only thing that can say what
 * this call costs.
 *
 * A clearance is signed only after both have agreed with what the person was
 * shown, or after they have explicitly accepted the difference. Everything
 * before that point is read-only.
 */
export async function revalidateResearch(input: {
  shown: NovaResearchTerms;
  /** Hash of the terms the person is agreeing to. Equal to the hash of `shown`
   *  on a first approval; equal to the hash of the *new* terms when they are
   *  re-confirming a change they have just been shown. */
  acknowledged?: string | null;
  requestBody: unknown;
  inputSchema?: Record<string, unknown> | null;
  method?: "GET" | "POST";
  query: string;
  wallet: string;
  signalId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<NovaRevalidation> {
  const requesterWallet = getAddress(input.wallet);
  const shown = input.shown;

  let selection: MarketplaceSelection;
  let winnerDecision: TrustDecision | null = null;
  let selectionHash: `0x${string}` | null = null;
  let selectionExpiresAt: string | null = null;
  try {
    selection = await selectMarketplaceCounterparty({
      request: {
        capability: shown.capability,
        query: input.query,
        // The approved seller and settlement network must survive re-discovery
        // just as they do when the original proposal is prepared.
        mustInclude: marketplaceCandidateId(shown.resource, shown.payTo, shown.network),
        network: shown.network,
        budgetUsdc: RESEARCH_BUDGET_USDC,
        limit: RESEARCH_CANDIDATE_LIMIT,
      },
      tenant: { tenantKey: `nova:${input.signalId}`, requesterWallet },
      now: input.now,
      fetchImpl: input.fetchImpl,
      preferCandidate: pinnedTo(shown.resource),
      // Read-only until the comparison below has passed.
      issueClearance: false,
      onWinnerDecision: ({ decision, selectionHash: hash, expiresAt }) => {
        winnerDecision = decision;
        selectionHash = hash;
        selectionExpiresAt = expiresAt;
      },
    });
  } catch (error) {
    return {
      ok: false,
      reason: "unquotable",
      detail: error instanceof Error ? error.message : "Veyra could not reach the market just now.",
    };
  }

  const live = selection.candidates.find((candidate) =>
    candidate.marketplace.resource === shown.resource) ?? null;
  if (!live) {
    return {
      ok: false,
      reason: "gone",
      detail: "That endpoint is no longer listed in the catalogue. Nothing was paid. Ask for a fresh look and Veyra will price the market again.",
    };
  }
  if (!isExecutableTrustDecision(live.trustDecision)) {
    return {
      ok: false,
      reason: "refused",
      detail: `${BRAND_NAME} re-checked this endpoint and will no longer authorise it: ${live.trustDecision}. Nothing was paid.`,
    };
  }

  /* The live 402 challenge, raised by the body that will be paid for. The probe
     above cannot substitute for this: it sends nothing, and an endpoint that
     charges per call answers a different price to an empty request. */
  /* A paying quote, because this is the step a signature is made against. It
     is bound to the decision just re-taken above: the endpoint, the method and
     the ceiling are read from that decision rather than from anything on the
     card, and the quote it writes is what settle will claim. */
  const quoted = await quoteX402Call({
    selectionId: selection.selectionId,
    ownerWallet: requesterWallet,
    requestBody: input.requestBody,
  });
  if (quoted.kind === "free") {
    /* Not a change to confirm: there is nothing to pay, so a confirm button
       would offer to approve an amount that does not exist and would come back
       here again on the next press. */
    return {
      ok: false,
      reason: "unquotable",
      detail: "This endpoint is no longer asking to be paid for that request. Nothing was spent. Ask for a fresh look before deciding.",
    };
  }
  if (quoted.kind === "refused") {
    /* Deliberately not "market_changed" with an empty list. These are refusals
       with reasons, and dressing one as a change would offer a confirm button
       for something no confirmation can make payable. */
    if (quoted.code === "price_above_authorization") {
      return {
        ok: false,
        reason: "over_budget",
        detail: `This endpoint now asks more than the $${RESEARCH_BUDGET_USDC.toFixed(2)} ceiling ${BRAND_NAME} will authorise from a brief. Nothing was paid, and nothing else was substituted for it.`,
      };
    }
    return { ok: false, reason: "unquotable", detail: `${quoted.message} Nothing was paid.` };
  }

  const accept = quoted.quote.accept;
  const liveTerms: NovaResearchTerms = {
    provider: live.marketplace.provider?.name ?? "Unknown provider",
    resource: shown.resource,
    capability: shown.capability,
    /* From the challenge, not the listing. The listing is what the card was
       built from; the challenge is what the wallet will sign. */
    priceAtomic: accept.amountAtomic,
    payTo: accept.payTo,
    network: accept.network,
    funding: accept.gatewayBatched ? "gateway_deposit" : "wallet",
  };
  const liveHash = hashTerms(liveTerms);
  const changes = compareTerms(shown, liveTerms);
  const costUsdc = usdcFromAtomic(accept.amountAtomic);

  /* A ceiling no confirmation can click past. Everything on the card was chosen
     under this budget; a price that has left it is not the same proposition,
     and offering to confirm it would turn a safety limit into a formality. */
  if (costUsdc > RESEARCH_BUDGET_USDC) {
    return {
      ok: false,
      reason: "over_budget",
      detail: `This now costs $${costUsdc.toFixed(4)}, above the $${RESEARCH_BUDGET_USDC.toFixed(2)} ceiling ${BRAND_NAME} will authorise from a brief. Nothing was paid.`,
    };
  }

  if (changes.length > 0 && input.acknowledged !== liveHash) {
    return {
      ok: false,
      reason: "market_changed",
      changes,
      terms: liveTerms,
      termsHash: liveHash,
      costUsdc,
      detail: `${BRAND_NAME} stopped before paying. Nothing was spent, and nothing was substituted.`,
    };
  }

  if (!winnerDecision || !selectionHash || !selectionExpiresAt) {
    return {
      ok: false,
      reason: "refused",
      detail: `${BRAND_NAME} could not reconstruct a trust decision for that endpoint, so it refused to authorise anything.`,
    };
  }

  /* Signed last, and only for what the challenge just quoted. Both the
     requested value and the policy ceiling are the exact amount: a clearance
     that authorised the tier's limit would be a stronger permission than the
     verdict it accompanies, and a wider one than the person agreed to. */
  const decision: TrustDecision = winnerDecision;
  let clearance: MarketplaceSelectionClearance;
  try {
    clearance = await issueMarketplaceClearance({
      decision: {
        ...decision,
        request: {
          ...decision.request,
          requestedValueUsdc: costUsdc,
          counterparty: accept.payTo,
        },
        policy: { ...decision.policy, maxValueUsdc: costUsdc },
      },
      selectionHash,
      issuedAt: new Date().toISOString(),
      expiresAt: selectionExpiresAt,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "refused",
      detail: error instanceof Error
        ? `${BRAND_NAME} cannot sign a clearance right now, so it refused rather than authorise something it cannot attest to.`
        : "Clearance signing is unavailable.",
    };
  }

  return {
    ok: true,
    quote: quoted.quote,
    terms: liveTerms,
    termsHash: liveHash,
    clearance,
    candidateId: live.marketplace.candidateId,
    selectionId: selection.selectionId,
    decision: live.trustDecision,
    verificationRequired: live.trustDecision !== "ALLOW",
    outputSchema: (live.marketplace.outputSchema
      ?? quoted.quote.outputSchema
      ?? null) as Record<string, unknown> | null,
  };
}

/**
 * Why this one, in the order that decided it.
 *
 * Every line is something Veyra measured in the last few seconds, not a
 * property of the listing. A catalogue can claim a price; only a probe can say
 * the endpoint asked for it.
 */
function reasonsFor(winner: MarketplaceSelection["candidates"][number]): string[] {
  const reasons: string[] = [];
  const probe = winner.probe;

  if (probe?.respondedWith402) reasons.push("Answered a valid payment challenge just now");
  else if (probe?.reachable) reasons.push("Endpoint answered, but not with a payment challenge");

  if (probe && (probe.catalogDrift?.length ?? 0) === 0) {
    reasons.push("Live price and payee match the listing");
  } else if (probe?.catalogDrift?.length) {
    reasons.push(`Differs from its listing: ${probe.catalogDrift.join(", ")}`);
  }

  if (typeof probe?.latencyMs === "number") {
    reasons.push(`Answered in ${(probe.latencyMs / 1000).toFixed(2)}s`);
  }

  if (winner.marketplace.funding === "wallet") {
    reasons.push("Payable from your wallet balance, with no deposit first");
  }

  return reasons;
}
