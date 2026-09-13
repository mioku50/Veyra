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
import { quoteX402Call, type X402Quote } from "../x402/execution.ts";
import { buildRequestBody } from "../x402/request-body.ts";
import type { JsonSchema } from "../seller/json-schema.ts";
import {
  compareTerms,
  hashTerms,
  usdcFromAtomic,
  type NovaResearchTerms,
  type TermsChange,
} from "./research-terms.ts";
import type { NovaSignal } from "./types.ts";

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
  const subject = (signal.evidence?.subject ?? {}) as Record<string, unknown>;
  const capability = typeof subject.capability === "string" && subject.capability.trim()
    ? subject.capability.trim()
    : "research";
  const label = signal.subjectLabel ?? "this";

  if (signal.subjectKind === "github_repository") {
    return {
      capability: "research",
      query: `${label} project update`,
      question: `What changed in ${label}, and does it matter?`,
    };
  }

  return {
    capability,
    query: label,
    question: `What is ${label} for, and is it worth paying for?`,
  };
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

/** "Direct USDC" is what the money does. "Vanilla x402" is what we call it. */
function paymentLabelFor(funding: "wallet" | "gateway_deposit"): string {
  return funding === "wallet" ? "Direct USDC" : "Circle Gateway deposit";
}

/**
 * A verdict a person can act on.
 *
 * The engine's own explanation is written for somebody reading a selection
 * next to its evidence. Here there is no evidence on screen, so the sentence
 * has to carry its own weight: what was decided, and what it costs at most.
 */
function verdictFor(decision: TrustDecisionLevel, maxExposureUsdc: number): string {
  switch (decision) {
    case "ALLOW":
      return `Allow. At most $${maxExposureUsdc.toFixed(4)} leaves your wallet.`;
    case "ALLOW_WITH_LIMITS":
      return `Allow, with a ceiling of $${maxExposureUsdc.toFixed(4)}.`;
    case "REQUIRE_EVALUATOR":
      /* On an x402 call this tier does not mean an evaluator contract -- it
         means the answer is checked against the endpoint's declared schema
         after the money moves, which the settle path already does. Saying
         "evaluator" to a reader would name a thing they will never see. */
      return `Allow up to $${maxExposureUsdc.toFixed(4)}, and check the answer afterwards.`;
    case "REVIEW_REQUIRED":
      return "Worth a look before you pay. The evidence is thinner than Veyra likes.";
    default:
      return "Refused. Veyra will not authorise this counterparty.";
  }
}

export async function proposeResearch(input: {
  signal: NovaSignal;
  /** The owner's wallet when one is connected, which makes the Gateway balance
   *  a real read rather than an assumption. */
  wallet?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<NovaResearchOutcome> {
  const { capability, query, question } = researchRequestFor(input.signal);
  const requesterWallet = input.wallet && isAddress(input.wallet)
    ? getAddress(input.wallet)
    : NO_WALLET;

  let selection: MarketplaceSelection;
  try {
    selection = await selectMarketplaceCounterparty({
      request: {
        capability,
        query,
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

  const winner = selection.recommendation.candidateId
    ? selection.candidates.find((candidate) =>
        candidate.identity.agentId === selection.recommendation.candidateId) ?? null
    : null;
  if (!winner || !isExecutableTrustDecision(winner.trustDecision)) {
    return {
      ok: false,
      reason: "nothing_allowed",
      /* Deliberately not "no results". Veyra looked and refused, which is a
         different fact and the more useful one: it is the product doing its
         job, not failing at it. */
      detail: refusalDetail(selection),
    };
  }

  const decision = winner.trustDecision;
  /* The winner's own ceiling, not the selection's recommendation object: they
     are the same counterparty now, but quoting a number that belongs to a
     different one is the failure this used to have and is cheap to keep out. */
  const maxExposureUsdc = winner.recommendedMaxExposureUsdc || winner.marketplace.priceUsdc;
  const terms = termsFromCandidate(winner, capability);

  /* What will actually be sent, decided now rather than at approval time. x402
     prices per call, so the body IS part of the price: quoting one shape and
     paying for another would make the number on the card a number about a
     different request. */
  const request = buildRequestBody({
    intent: question,
    capability,
    inputSchema: (winner.marketplace.inputSchema ?? null) as JsonSchema | null,
  });

  return {
    ok: true,
    proposal: {
      signalId: input.signal.signalId,
      question,
      capability,
      provider: terms.provider,
      resource: terms.resource,
      costUsdc: winner.marketplace.priceUsdc,
      trustScore: Math.round(winner.trustScore ?? 0),
      funding: winner.marketplace.funding,
      paymentLabel: paymentLabelFor(winner.marketplace.funding),
      payableNow: winner.marketplace.payableNow,
      decision,
      verdict: verdictFor(decision, maxExposureUsdc),
      maxExposureUsdc,
      verifiedAfterPaying: decision !== "ALLOW",
      reasons: reasonsFor(winner),
      probed: selection.probed,
      routingNote: selection.recommendation.routingNote,
      expiresAt: selection.expiresAt,
      termsHash: hashTerms(terms),
    },
    plan: {
      terms,
      query,
      requestBody: request.body,
      requestNote: request.guessed ? request.note : null,
      inputSchema: (winner.marketplace.inputSchema ?? null) as Record<string, unknown> | null,
      outputSchema: (winner.marketplace.outputSchema ?? null) as Record<string, unknown> | null,
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
  const quoted = await quoteX402Call({
    resource: shown.resource,
    method: input.method === "GET" ? "GET" : "POST",
    requestBody: input.requestBody,
    maxAmountUsdc: RESEARCH_BUDGET_USDC,
    inputSchema: input.inputSchema ?? null,
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
