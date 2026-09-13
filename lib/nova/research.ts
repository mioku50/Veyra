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
import { selectMarketplaceCounterparty } from "../counterparty-selection/marketplace.ts";
import type { MarketplaceSelection } from "../counterparty-selection/marketplace.ts";
import { isExecutableTrustDecision } from "../trust-gate/types.ts";
import type { TrustDecisionLevel } from "../trust-gate/types.ts";
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
};

export type NovaResearchOutcome =
  | { ok: true; proposal: NovaResearchProposal }
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
function vanillaFirst(selection: MarketplaceSelection) {
  const showable = selection.candidates.filter((candidate) =>
    isExecutableTrustDecision(candidate.trustDecision));
  const wallet = showable.find((candidate) => candidate.marketplace.funding === "wallet");
  if (wallet) return { winner: wallet, note: null as string | null };

  const first = showable[0] ?? null;
  if (!first) return { winner: null, note: null as string | null };
  return {
    winner: first,
    note: "Nothing here settles from a wallet balance, so this one needs a Circle Gateway deposit before it can be paid.",
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

  const { winner, note } = vanillaFirst(selection);
  if (!winner) {
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
  /* The winner's own ceiling, not the selection's: vanillaFirst may have chosen
     a different candidate than the engine recommended, and quoting the
     recommendation's exposure next to another counterparty's price would be a
     number that belongs to neither. */
  const maxExposureUsdc = winner.recommendedMaxExposureUsdc || winner.marketplace.priceUsdc;

  return {
    ok: true,
    proposal: {
      signalId: input.signal.signalId,
      question,
      capability,
      provider: winner.marketplace.provider?.name ?? "Unknown provider",
      resource: winner.marketplace.resource,
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
      routingNote: note ?? selection.recommendation.routingNote,
      expiresAt: selection.expiresAt,
    },
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
