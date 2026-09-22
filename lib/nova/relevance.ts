/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaPreferences, NovaRelevance, NovaSignalKind, ObservedChange } from "./types.ts";

/** Deterministic topic/preferences ranking and financial-change alerts.
 * Public events additionally need a source-supported goal assessment in the
 * brief selector. Model significance is product judgment, never spend policy.
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
  /** The subject's own name, for an exact match against what is followed.
   *  A label is a thing a person picked off a list; matching it as a substring
   *  of a sentence would make "Arc" follow every mention of architecture. */
  subjectLabel?: string | null;
  /** What this person has told Nova, and what Nova has learned from dismissals. */
  preferences?: NovaPreferences;
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
  official_publication: 48,
  endpoint_recovered: 40,
  capability_available: 30,
  repository_activity: 34,
};

const THRESHOLD = { high: 70, medium: 45, low: 25 } as const;

/**
 * The lowest score a band can hold.
 *
 * A stored signal keeps its band and not the number behind it, so ranking one
 * against a freshly scored candidate needs a floor to stand on. Using the
 * floor is deliberately pessimistic: a stored "high" ranks below a fresh
 * "high" that actually scored higher, and still above any "medium".
 */
export function scoreFloorFor(relevance: NovaRelevance): number {
  return relevance === "high" ? THRESHOLD.high : relevance === "medium" ? THRESHOLD.medium : relevance === "low" ? THRESHOLD.low : 0;
}

/**
 * The category a kind belongs to, as a person would name it.
 *
 * This is the canonical copy: scoring needs it to match a category preference
 * exactly, and the memory writer needs it to record one. Deriving the phrase
 * from the kind rather than from the signal's wording is what keeps "what Nova
 * knows about you" a category someone would recognise instead of a fragment of
 * a sentence they happened to scroll past.
 *
 * Null is the important half. A changed payee is never learned away, and
 * neither is a rail change or an endpoint going dark: where someone's money
 * goes is not a matter of taste, and a product where three impatient clicks
 * switch that warning off has quietly become a different product. It is null in
 * both directions -- if a payee change cannot be turned off, nothing may claim
 * credit for turning it up either.
 */
const CATEGORY_PHRASE: Partial<Record<NovaSignalKind, string>> = {
  repository_activity: "commits",
  repository_release: "releases",
  official_publication: "announcements",
  capability_available: "new capabilities",
  price_changed: "price changes",
  endpoint_recovered: "recoveries",
};

export function categoryPhraseFor(kind: string): string | null {
  return CATEGORY_PHRASE[kind as NovaSignalKind] ?? null;
}

/**
 * Does a learned preference apply to this change?
 *
 * Two ways, because preferences come from two different statements. "Ignore
 * commits" is about the category, and is matched on the category exactly --
 * matching it through the prose was the first version and it silently did
 * nothing for four of the five categories, because a capability signal never
 * contains the words "new capabilities". "Not interesting" is about the topic,
 * and that only exists in the subject's own words.
 */
function preferenceApplies(phrase: string, category: string | null, shown: string): boolean {
  if (category && phrase.trim().toLowerCase() === category) return true;
  return matchedKeywords(shown, [phrase]).length > 0;
}

/**
 * The topic to stop showing, taken from a publication the owner dismissed.
 *
 * "Not interesting" on an announcement used to learn nothing at all. The
 * subject of an announcement is its feed, so learning the subject would have
 * silenced the publisher, and one shrug at one article is not a request to
 * stop reading Arc -- so the branch was skipped and the press did nothing. An
 * owner whose every card is an announcement had no way to say "this one, not
 * that one".
 *
 * Only a product name is learned. The first version took the longest word of
 * the headline, and run against the owner's thirteen real headlines it was
 * right once: it learned "discontinuing" from a Circle deprecation notice --
 * which would have demoted every later deprecation notice, the one kind of
 * announcement nobody should be able to shrug away -- and "transactions" and
 * "balances", the owner's own subject matter. A word with a capital inside it
 * (cirBTC, StableFX, OpenWiki) is a name somebody gave a thing, and "less of
 * that thing" is what a dismissal of it means.
 *
 * Never a word the owner watches for, never a word of the publisher's own
 * name, and when no name survives, nothing is learned -- which is what
 * happened before. The words are the publisher's headline, not Nova's prose.
 * The weight starts at one dismissal, only demotes, never touches a payee
 * change, and the owner can forget it from what Nova knows about them.
 */
const NAMED = /[a-z][A-Z]/;

export function dismissedTopicFrom(headline: string, watchedFor: string[], publisher = ""): string | null {
  const excluded = new Set([
    ...watchedFor.map(word => word.trim().toLowerCase()),
    ...tokenize(publisher),
  ].filter(Boolean));
  for (const word of headline.split(/[\s:;,.!?()\[\]"“”]+/)) {
    const bare = word.replace(/['’]s$/i, "");
    if (!NAMED.test(bare)) continue;
    const token = [...tokenize(bare)][0];
    if (!token || token.length < 4 || excluded.has(token)) continue;
    return token;
  }
  return null;
}

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

  const preferences = input.preferences;
  const shown = `${text} ${input.change.headline}`.toLowerCase();

  /* Told, not inferred. "Useful" is the person naming a category they want more
     of, so unlike the keyword pass this is allowed to match Nova's own headline:
     the phrase came from the signal's kind, which is machine-derived, not from
     the sentence Nova wrote. Capped, so no amount of approval can outrank a
     payee change. */
  const category = categoryPhraseFor(input.change.kind);
  const favoured = (preferences?.favoured ?? []).filter((phrase) =>
    preferenceApplies(phrase, category, shown));
  if (favoured.length > 0) {
    score += Math.min(20, 10 * favoured.length);
    reasons.push(`you find ${favoured[0]} useful`);
  }

  /* Following is about one thing, not a category, so it is matched on the
     subject's own name and nothing else. It is the strongest lever a person
     has, and deliberately so: it is the only way to say "this repository
     matters to me" when the category it belongs to does not. */
  const label = (input.subjectLabel ?? "").trim().toLowerCase();
  if (label && (preferences?.followed ?? []).some((entry) => entry.trim().toLowerCase() === label)) {
    score += 28;
    reasons.push(`you follow ${input.subjectLabel}`);
  }

  /* What this person has dismissed, or banned outright.
     Matched against the subject AND the headline, because a preference is
     learned from items as they were shown. Unlike interest keywords this can
     only ever demote, so matching Nova's own wording here cannot inflate
     anything -- and it still never overrides a payee change.

     Weighted, because one shrug and "never show me this again" are different
     statements. Flattening them would let a single impatient click bury a topic
     as thoroughly as a deliberate decision. */
  if (input.change.kind !== "payee_changed") {
    let worst: { phrase: string; weight: number } | null = null;
    for (const entry of preferences?.ignored ?? []) {
      if (!preferenceApplies(entry.phrase, category, shown)) continue;
      if (!worst || entry.weight > worst.weight) worst = entry;
    }
    if (worst) {
      score -= worst.weight;
      reasons.push(`you usually dismiss ${worst.phrase}`);
    }
  }

  if (input.change.kind === "repository_activity") reasons.push("commit activity is background context, not evidence of importance");
  const relevance: NovaRelevance = input.change.kind === "repository_activity" ? "noise" :
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
