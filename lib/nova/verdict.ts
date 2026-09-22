/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */

/**
 * Why, said with a rating of a reading.
 *
 * Gate V asks the owner to rate findings "and the reason", and until this
 * existed there was nowhere to put one: three real ratings, not one reason.
 * The rejections are the review's own categories -- noise, already known, work
 * nobody needed, a reading the sources do not support, a duplicate -- so a
 * review can count them instead of interpreting prose.
 *
 * Recorded for that review, and for nothing else. No reason changes ranking,
 * and the page says so: a reason that quietly retrained the scorer would be
 * personalization claimed without a demonstrated effect.
 */
export const NOVA_REASONS = {
  useful: ["acted", "informed"],
  not_interesting: ["off_goal", "known", "unneeded_work", "wrong", "duplicate"],
} as const;

export type NovaReason = (typeof NOVA_REASONS)[keyof typeof NOVA_REASONS][number];

export const REASON_LABEL: Record<NovaReason, string> = {
  acted: "Changes what I'll do",
  informed: "Good to know",
  off_goal: "Not about my goal",
  known: "Already knew it",
  unneeded_work: "Proposes work I don't need",
  wrong: "Wrong or unsupported",
  duplicate: "Duplicate",
};

/** A reason counts only with the verdict it belongs to. "Good to know" is
 *  not a reason something was useless, whatever a client sends. */
export function reasonFor(feedback: string, value: unknown): NovaReason | null {
  const allowed: unknown = (NOVA_REASONS as Record<string, unknown>)[feedback];
  // Array.isArray, not truthiness: "__proto__" is a key of every object.
  return Array.isArray(allowed) && typeof value === "string" && allowed.includes(value) ? value as NovaReason : null;
}

export const NOTE_MAX = 500;

/** The owner's own words, bounded. Stored for the review; never sent to a
 *  model, so a note is not a way to put instructions into a reading. */
export function noteFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  return note || null;
}

/** What a rating taught, in the form the owner is told it. */
export type NovaLearned = {
  facet: "cares_about" | "usually_ignores" | "follows";
  summary: string;
};

export function learnedSentence(learned: NovaLearned | null, verdict: string): string {
  const hidden = verdict === "not_interesting" || verdict === "ignore_kind" ? "Hidden. " : "";
  if (learned?.facet === "cares_about") return `${hidden}Nova will rank ${learned.summary} higher.`;
  if (learned?.facet === "usually_ignores") return `${hidden}Nova will rank cards about ${learned.summary} lower.`;
  if (learned?.facet === "follows") return `Following ${learned.summary}.`;
  /* Said, because silence here reads as "it worked". A dismissed announcement
     whose headline names no product teaches nothing, and an owner who does not
     know that will go on dismissing them and expecting fewer. */
  return hidden
    ? "Hidden. Nothing to learn from this one, so similar cards will still appear."
    : "Nothing to learn from this kind of card.";
}
