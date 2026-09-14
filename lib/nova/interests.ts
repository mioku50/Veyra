/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaSubjectKind } from "./types.ts";

/**
 * Turning what a person says into something that can be observed.
 *
 * "Arc" is an interest. It is not observable. What is observable is a specific
 * x402 resource in Circle's catalog and a specific repository on GitHub, both
 * of which have a state Veyra can read twice and compare.
 *
 * Keeping those apart is the whole defence against a feed that invents things.
 * An interest can be anything a person types; a subject has to be a thing with
 * an address. Every line in the brief traces back through a subject to a real
 * observation, and if no subject can be resolved for an interest, Nova says it
 * is watching nothing for that interest rather than producing plausible prose.
 */

export type InterestDefinition = {
  id: string;
  label: string;
  /** What to ask Circle's x402 catalog for. These are capability terms, matched
   *  against the catalog's own capability strings. */
  capabilityTerms: string[];
  /** Public repositories whose activity is genuine evidence for this interest.
   *  Shown to the person by name: Nova watching something you cannot see would
   *  be indistinguishable from Nova making it up. */
  repositories: Array<{ ref: string; label: string }>;
  /** Words that make an unrelated signal relevant to this interest. */
  keywords: string[];
};

export const INTEREST_CATALOG: readonly InterestDefinition[] = [
  {
    id: "agent-payments",
    label: "Agent payments",
    capabilityTerms: ["payment", "x402", "settlement"],
    repositories: [
      { ref: "coinbase/x402", label: "x402" },
      { ref: "circlefin/stablecoin-evm", label: "Circle USDC" },
    ],
    keywords: ["x402", "payment", "usdc", "settle", "invoice", "escrow", "gateway"],
  },
  {
    id: "arc",
    label: "Arc",
    capabilityTerms: ["arc", "usdc", "stablecoin"],
    repositories: [
      { ref: "circlefin/stablecoin-evm", label: "Circle USDC" },
      { ref: "circlefin/evm-cctp-contracts", label: "Circle CCTP" },
    ],
    keywords: ["arc", "circle", "usdc", "cctp", "stablecoin", "gateway"],
  },
  {
    id: "ai",
    label: "AI",
    capabilityTerms: ["inference", "llm", "completion", "embedding"],
    repositories: [{ ref: "langchain-ai/langchain", label: "LangChain" }],
    keywords: ["llm", "model", "inference", "agent", "prompt", "embedding", "ai"],
  },
  {
    id: "research",
    label: "Research & search",
    capabilityTerms: ["web_search", "search", "research", "scrape"],
    repositories: [],
    keywords: ["search", "research", "crawl", "scrape", "index", "retrieval"],
  },
  {
    id: "onchain",
    label: "Onchain data",
    capabilityTerms: ["blockchain", "onchain", "price", "market_data"],
    repositories: [
      { ref: "foundry-rs/foundry", label: "Foundry" },
      { ref: "ethereum/ERCs", label: "Ethereum ERCs" },
    ],
    keywords: ["chain", "block", "token", "wallet", "contract", "erc", "price"],
  },
  {
    id: "agent-standards",
    label: "Agent standards",
    capabilityTerms: ["identity", "reputation", "attestation"],
    repositories: [
      { ref: "ethereum/ERCs", label: "Ethereum ERCs" },
      { ref: "ethereum/EIPs", label: "Ethereum EIPs" },
    ],
    keywords: ["erc-8004", "erc-8183", "identity", "reputation", "attestation", "evaluator"],
  },
] as const;

export const MAX_INTERESTS = 6;

/** Subjects per agent, and why the ceiling exists: every subject is a live HTTP
 *  read on every refresh, and a brief that takes a minute to assemble is a brief
 *  nobody waits for. Small and fast beats exhaustive and abandoned. */
export const SUBJECT_LIMITS = {
  /** Floor, for an agent with one or two interests. */
  perAgent: 12,
  /** Ceiling, whatever the interest count. Past this a refresh stops being
   *  something a person waits for. */
  perAgentMax: 24,
  x402PerInterest: 3,
  /** How many the catalogue is asked for per query, before filtering. Larger
   *  than what is kept, so the filters spend surplus rather than the share. */
  candidatesPerQuery: 12,
  /** How many endpoints one seller may hold across the whole agent. Orthogonal
   *  publishes enough of the catalogue to win every query it appears in. */
  perProvider: 2,
  repositoriesPerInterest: 2,
} as const;

/**
 * How many paid endpoints one agent watches, given what it cares about.
 *
 * A flat twelve was the whole budget however many interests were chosen, so
 * picking all six bought each of them two -- and since an endpoint already
 * being watched produces no new card, the brief for six interests looked like
 * the brief for two. A ceiling exists because every subject is a live read on
 * every refresh; it should not be a ceiling that punishes saying what you care
 * about.
 */
export function subjectBudgetFor(interestCount: number): number {
  const wanted = Math.max(1, interestCount) * SUBJECT_LIMITS.x402PerInterest;
  return Math.min(SUBJECT_LIMITS.perAgentMax, Math.max(SUBJECT_LIMITS.perAgent, wanted));
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 40);
}

export function interestKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

export function findInterest(value: string): InterestDefinition | null {
  const key = interestKey(value);
  return INTEREST_CATALOG.find(
    (entry) => entry.id === key || entry.label.toLowerCase() === key,
  ) ?? null;
}

/**
 * Accepts what the person actually typed, including interests Veyra has no
 * catalog entry for.
 *
 * An unknown interest is kept rather than dropped. Silently discarding it would
 * leave someone looking at a brief that ignores the thing they asked for, with
 * nothing on screen explaining why; kept, it becomes a plain catalog query and,
 * if that finds nothing, an honest "watching nothing for this yet".
 */
export function normalizeInterests(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = normalizeText(value);
    if (!text) continue;
    const known = findInterest(text);
    const label = known?.label ?? text;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(label);
    if (result.length >= MAX_INTERESTS) break;
  }
  return result;
}

export type PlannedSubject = {
  kind: NovaSubjectKind;
  ref: string;
  label: string;
  interest: string;
};

/**
 * The repositories Nova will watch, derived from stated interests.
 *
 * x402 subjects are not planned here: they come from the live catalog, because
 * a hard-coded endpoint list would go stale the moment a provider moved, and
 * the catalog is the thing Veyra already reads correctly.
 */
export function planRepositorySubjects(interests: string[]): PlannedSubject[] {
  const planned: PlannedSubject[] = [];
  const seen = new Set<string>();
  for (const interest of interests) {
    const definition = findInterest(interest);
    if (!definition) continue;
    let taken = 0;
    for (const repository of definition.repositories) {
      if (taken >= SUBJECT_LIMITS.repositoriesPerInterest) break;
      if (seen.has(repository.ref)) continue;
      seen.add(repository.ref);
      taken += 1;
      planned.push({
        kind: "github_repository",
        ref: repository.ref,
        label: repository.label,
        interest,
      });
    }
  }
  return planned;
}

/** The catalog queries to run for a set of interests, in the person's order. */
export function capabilityQueriesForInterests(interests: string[]): Array<{ interest: string; term: string }> {
  const seen = new Set<string>();
  const perInterest = interests.map((interest) => {
    const definition = findInterest(interest);
    const terms = definition?.capabilityTerms ?? [interestKey(interest)];
    const mine: Array<{ interest: string; term: string }> = [];
    for (const term of terms) {
      if (!term || seen.has(term)) continue;
      seen.add(term);
      mine.push({ interest, term });
    }
    return mine;
  });

  /* Round-robin, not interest by interest.
     The per-agent ceiling is shared, and asked in order the first interest's
     three capability terms could consume nine of twelve before the fourth
     interest was queried at all -- measured: somebody added Agent payments and
     Agent standards to an agent that already had Arc and AI, and the refresh
     never reached either. An interest nobody looks at is worse than an interest
     nobody offered, because the person chose it. First terms first. */
  const queries: Array<{ interest: string; term: string }> = [];
  const deepest = Math.max(0, ...perInterest.map((list) => list.length));
  for (let round = 0; round < deepest; round += 1) {
    for (const list of perInterest) {
      if (round < list.length) queries.push(list[round]);
    }
  }
  return queries;
}

/** Words that make a signal relevant to this person, across all their interests. */
export function keywordsForInterests(interests: string[]): string[] {
  const words = new Set<string>();
  for (const interest of interests) {
    const definition = findInterest(interest);
    if (definition) {
      for (const keyword of definition.keywords) words.add(keyword);
      words.add(definition.label.toLowerCase());
    } else {
      // An interest Veyra does not know still matches on its own name.
      for (const part of interestKey(interest).split(/[^a-z0-9]+/)) {
        if (part.length >= 3) words.add(part);
      }
    }
  }
  return [...words];
}
