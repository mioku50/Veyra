/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaRelevance, NovaSignalKind, ObservedChange } from "./types.ts";

/**
 * How much a change is worth this person's attention.
 *
 * This is deterministic on purpose, and it is the same argument as the router:
 * a language model is good at understanding what someone meant and bad at being
 * accountable for it. If Nova ever has to answer "why did you show me this",
 * the answer has to be a rule someone can read, not a sample from a model.
 *
 * So the model's job is upstream -- turning a sentence into interests -- and
 * everything from here down is arithmetic anyone can check. The reason string
 * is not decoration; it is the audit trail, and it is shown.
 */

export type RelevanceInput = {
  change: ObservedChange;
  /** Words derived from the person's stated interests. */
  keywords: string[];
  /**
   * The subject in its own words: label, provider, description, capability.
   *
   * Keyword matching runs against this and never against the sentence Nova
   * generated. Scoring your own prose is a feedback loop -- the first version
   * of this scored "Circle" as an interest match because Nova had written the
   * words "Circle's catalog" into its own detail line, and every catalog entry
   * came back equally relevant.
   */
  subjectText?: string | null;
  /** Phrases this person has repeatedly dismissed, learned from behaviour. */
  ignoredPhrases?: string[];
  interest?: string | null;
};

export type RelevanceVerdict = {
  relevance: NovaRelevance;
  reason: string;
  score: number;
};

/**
 * Baselines by what kind of change it is.
 *
 * A changed payee outranks everything, including a bigger price move, because
 * it is the only signal here that can mean the money now goes somewhere else.
 * It is the thing a person cannot discover by using the endpoint, and the thing
 * they would most want to have been told.
 */
const BASE_SCORE: Record<NovaSignalKind, number> = {
  payee_changed: 90,
  endpoint_unreachable: 62,
  rail_changed: 58,
  price_changed: 52,
  repository_release: 48,
  endpoint_recovered: 40,
  capability_available: 30,
  repository_activity: 34,
};

const THRESHOLD = { high: 70, medium: 45, low: 25 } as const;

function subjectTextOf(input: RelevanceInput): string {
  return (input.subjectText ?? "").toLowerCase();
}

/**
 * Whole words only.
 *
 * Substring matching looked fine until it was run against the live catalog and
 * claimed that Exa's search endpoint matched "arc" and "ai" -- because "search"
 * contains a-r-c and "exa.ai" ends in a-i. Both reasons were printed to the
 * reader as justification. A false reason is worse than a missing one: it is
 * the product explaining itself incorrectly, in writing, unprompted.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9+#-]+/)
      .map((token) => token.replace(/^-+|-+$/g, ""))
      .filter((token) => token.length >= 2),
  );
}

/** Singular and plural are the same word to a reader, so they are here too.
 *  Not a stemmer: just the one case that shows up constantly ("commit" against
 *  "17 new commits") and would otherwise make a learned preference look broken. */
function tokenMatches(tokens: Set<string>, word: string): boolean {
  return tokens.has(word) || tokens.has(`${word}s`) || (word.endsWith("s") && tokens.has(word.slice(0, -1)));
}

function matchedKeywords(text: string, keywords: string[]): string[] {
  const tokens = tokenize(text);
  const found: string[] = [];
  for (const keyword of keywords) {
    const word = keyword.trim().toLowerCase();
    if (word.length < 2) continue;
    // A multi-word keyword still matches as a phrase.
    if (word.includes(" ") ? text.toLowerCase().includes(word) : tokenMatches(tokens, word)) {
      found.push(word);
    }
  }
  return found;
}

function priceSwingBonus(change: ObservedChange): { bonus: number; note: string | null } {
  if (change.kind !== "price_changed") return { bonus: 0, note: null };
  const before = Number(change.evidence.previousPriceAtomic);
  const after = Number(change.evidence.priceAtomic);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) {
    return { bonus: 0, note: null };
  }
  const ratio = Math.abs(after - before) / before;
  if (ratio >= 1) return { bonus: 22, note: "the price at least doubled" };
  if (ratio >= 0.25) return { bonus: 12, note: "the price moved more than a quarter" };
  /* A move of a few percent is a fact, not news. Reporting it every time would
     train a person to stop reading the ones that matter. */
  return { bonus: -14, note: "the price moved only slightly" };
}

function availabilityBonus(change: ObservedChange): { bonus: number; note: string | null } {
  if (change.kind !== "capability_available") return { bonus: 0, note: null };
  /* Being payable from the wallet balance is the difference between something a
     person can act on now and something that first needs a Gateway deposit.
     A brief that ranks them equally sends people to the dead end. */
  if (change.evidence.funding === "gateway_deposit") {
    return { bonus: -10, note: "needs a Circle Gateway deposit first" };
  }
  return { bonus: 6, note: "payable from your wallet balance" };
}

function activityBonus(change: ObservedChange): { bonus: number; note: string | null } {
  if (change.kind !== "repository_activity") return { bonus: 0, note: null };
  const commits = Number(change.evidence.commits);
  const contributors = Number(change.evidence.contributors);
  if (!Number.isFinite(commits)) return { bonus: 0, note: null };
  if (commits >= 20 && contributors >= 3) return { bonus: 20, note: "sustained work by several contributors" };
  if (commits >= 8) return { bonus: 10, note: "a real burst of commits" };
  if (commits <= 2) return { bonus: -12, note: "only a commit or two" };
  return { bonus: 0, note: null };
}

export function scoreRelevance(input: RelevanceInput): RelevanceVerdict {
  const text = subjectTextOf(input);
  const reasons: string[] = [];
  let score = BASE_SCORE[input.change.kind] ?? 30;

  const hits = matchedKeywords(text, input.keywords);
  if (hits.length > 0) {
    score += Math.min(18, 6 * hits.length);
    reasons.push(`matches ${hits.slice(0, 3).join(", ")}`);
  } else if (input.interest) {
    /* Kept, not dropped: the subject is on the list because of a stated
       interest, even when this particular sentence does not repeat the word. */
    reasons.push(`watched for ${input.interest}`);
  }

  const swing = priceSwingBonus(input.change);
  score += swing.bonus;
  if (swing.note) reasons.push(swing.note);

  const availability = availabilityBonus(input.change);
  score += availability.bonus;
  if (availability.note) reasons.push(availability.note);

  const activity = activityBonus(input.change);
  score += activity.bonus;
  if (activity.note) reasons.push(activity.note);

  /* What this person has repeatedly dismissed.
     Matched against the subject AND the headline, because a preference is
     learned from items as they were shown. Unlike interest keywords this can
     only ever demote, so matching Nova's own wording here cannot inflate
     anything -- and it still never overrides a payee change. */
  const ignored = matchedKeywords(
    `${text} ${input.change.headline}`.toLowerCase(),
    input.ignoredPhrases ?? [],
  );
  if (ignored.length > 0 && input.change.kind !== "payee_changed") {
    score -= 30;
    reasons.push(`you usually dismiss ${ignored[0]}`);
  }

  const relevance: NovaRelevance =
    score >= THRESHOLD.high ? "high"
      : score >= THRESHOLD.medium ? "medium"
        : score >= THRESHOLD.low ? "low"
          : "noise";

  return {
    relevance,
    score,
    reason: reasons.length > 0 ? reasons.join("; ") : "no strong link to your interests",
  };
}

/** Highest relevance first, then newest. Ties keep discovery order. */
export function orderByRelevance<T extends { relevance: NovaRelevance; observedAt: string }>(signals: T[]): T[] {
  const rank: Record<NovaRelevance, number> = { high: 0, medium: 1, low: 2, noise: 3 };
  return [...signals].sort((a, b) => {
    const byRank = rank[a.relevance] - rank[b.relevance];
    if (byRank !== 0) return byRank;
    return Date.parse(b.observedAt) - Date.parse(a.observedAt);
  });
}
