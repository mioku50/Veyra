/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { NovaSignal } from "./types.ts";

/**
 * The edition of the reading rules in lib/nova/free-research.ts.
 *
 * It lives here, next to the field that records it, because the page needs it
 * too: a card read under an older edition is a card asserting something the
 * current rules would not say, and the owner is the one who has to be told
 * that before they act on it.
 *
 * 2: project state is a baseline and not the list of everything that matters.
 * Under 1, four confirmed facts about ERC-8183, ERC-8004 and a wallet turned
 * into a checklist, and eight readings in a row answered "does not change
 * ERC-8183 or ERC-8004" to material the owner's goal asked for -- including a
 * compatibility guide that had been significant before the context existed.
 *
 * 3: a significant reading carries proposed work, not a topic to study.
 *
 * 4: an event nobody can act on is not significant. Under 3, an ecosystem
 * addition came back significant with no confirmed statement behind it, a
 * relativeToWork that began "no direct connection to the project state", and
 * an action that was to go and read the source it had just been given -- the
 * same abstraction one level down from the topic it replaced.
 *
 * 5: every returned string is written in the language of the goal. The rule
 * existed and was followed about half the time by the model this edition ships
 * with; restated per field, it held in nine runs out of nine.
 *
 * This bump also does a second job the mechanism does not model. A stored
 * reading records which rules produced it but not which model did, and the
 * model changed with this edition -- so every judgement made by the previous
 * one is retired here as a side effect of the edition, rather than by a rule
 * that would have caught it on its own.
 */
export const READING_RULES = 5;

export type PublicMaterial = {
  id: string;
  title: string;
  url: string;
  text: string;
  publishedAt: string | null;
  fetchedAt: string;
};
/**
 * What this event asks of the owner, written as work rather than as a subject.
 *
 * "Study the three sponsorship models on Arc" describes possible work; it is
 * not the work. These four parts are what a person needs to start: what they
 * already have, what the event changes, what is still not established, and one
 * action concrete enough to be finished.
 *
 * The dangerous half is the first one. A model told two facts about a project
 * will cheerfully generalise them into a verdict about the whole of it -- "your
 * paths are Arc-compatible" from "native USDC differences are handled" -- so
 * `established` is not prose the model wrote. The model chooses which of the
 * owner's confirmed statements it is relying on, by index, and the server
 * copies in the owner's own words. The same trick as citations, for the same
 * reason: a claim nobody can check is worse than no claim.
 *
 * Nothing here is a finding. Nova has not read the owner's code, and the
 * status line that says so is fixed in the page rather than a field the model
 * can fill in.
 */
export type ValueWorkPlan = {
  /** The owner's confirmed statements this work builds on, in their words. */
  established: string[];
  /** What the sources and that state do not settle, and what would settle it. */
  unverified: string;
  /** One action, named against something checkable. */
  action: string;
};

export type ValueAssessment = {
  version: 1;
  goal: string;
  significant: boolean;
  whatChanged: string;
  whyItMatters: string;
  nextStep: string;
  citations: Array<{ sourceId: string; quote: string }>;
  /** A hypothesis about further work, never a financial permission. */
  gap: { question: string; missing: string; expectedResult: string } | null;
  /** Proposed work, on a significant reading. Null when the event names none,
   *  and never a claim that the work was done -- see ValueWorkPlan. */
  plan?: ValueWorkPlan | null;
  /** The owner-confirmed project statements this reading was given, copied in
   *  as they stood. A finding read against a project state is only as good as
   *  that state, and a month later nobody can reconstruct which one it was. */
  projectContext?: string[];
  /** What the event changes relative to that state -- the difference between
   *  "Arc supports sponsored transactions" and "this is the piece you were
   *  missing in July". Null when no context was supplied. */
  relativeToWork?: string | null;
  /** A statement about the owner's project the material implies. Held as a
   *  question for the owner; Nova cannot confirm its own inference, because a
   *  confirmed one would be judged as fact by every later reading. */
  contextProposal?: { statement: string; why: string } | null;
  /** Which edition of the reading rules produced this: READING_RULES above.
   *
   *  A stored judgement is only as good as the instructions behind it, and
   *  changing those instructions silently leaves every earlier card asserting
   *  something the current rules would not say. Bumping this makes the next
   *  passes reconsider them, a budget at a time. */
  rules?: number;
  sources: PublicMaterial[];
  sourcesUnavailable?: string[];
  generatedAt: string;
  writtenBy: string;
};

export function normalizeGoal(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Goal must be text.");
  const goal = value.trim().replace(/\s+/g, " ");
  if (goal.length > 600) throw new Error("Keep your goal under 600 characters.");
  return goal || null;
}

export function assessmentOf(signal: Pick<NovaSignal, "evidence">): ValueAssessment | null {
  const value = signal.evidence?.valueAssessment as ValueAssessment | undefined;
  return value?.version === 1 && Array.isArray(value.sources) && Array.isArray(value.citations) ? value : null;
}

export function isBackgroundKind(kind: string): boolean {
  return kind === "repository_activity" || kind === "capability_available";
}

export function paidResearchReadiness(signal: NovaSignal, goal?: string | null, now = new Date()): { ready: boolean; reason: string; detail: string } {
  if (isBackgroundKind(signal.kind)) return { ready: false, reason: "background_activity", detail: "Activity counts and API listings are background observations. They do not establish a reason to buy research." };
  const assessment = assessmentOf(signal);
  if (!goal?.trim()) return { ready: false, reason: "goal_required", detail: "Set a concrete goal in My Agent before considering a paid investigation." };
  if (!assessment || assessment.goal !== goal.trim()) return { ready: false, reason: "free_research_required", detail: "Read the public sources for your current goal first. Nova has not yet established a useful reason to buy more information." };
  const age = now.getTime() - Date.parse(assessment.generatedAt);
  if (!Number.isFinite(age) || age < 0 || age > 24 * 3_600_000) return { ready: false, reason: "free_research_stale", detail: "Refresh the public-source analysis before considering a purchase." };
  if (assessment.sourcesUnavailable?.length || new Set(assessment.sources.map(s => s.url)).size < 2) return { ready: false, reason: "free_source_coverage_incomplete", detail: "Check additional public sources before considering a paid tool. One source or an unavailable reference is not evidence that paid data is needed." };
  if (!assessment.significant || !assessment.gap || !assessment.citations.length || !assessment.sources.length) return { ready: false, reason: "no_paid_research_need", detail: "The public-source analysis does not establish an additional research need. No paid tool was requested." };
  return { ready: true, reason: "gap_identified", detail: assessment.gap.missing };
}
