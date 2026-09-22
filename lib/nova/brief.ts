/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { assessmentOf, isBackgroundKind } from "./value.ts";
import { orderByRelevance } from "./relevance.ts";
import { NOVA_WITHHOLD_REASONS } from "./types.ts";
import type { NovaRelevance, NovaSignalKind, NovaWithholdReason } from "./types.ts";

/** Select a bounded brief. Raw activity stays in background history;
 * publications and releases require a goal-matched significance assessment.
 * Financial-change alerts retain their deterministic priority.
 */

/** A first look produces these. They describe the world, not a change in it. */
const FINDING_KINDS: ReadonlySet<NovaSignalKind> = new Set(["capability_available"]);

export const BRIEF_LIMITS = {
  /** What a person is shown above the fold. */
  attention: 5,
  /** Findings may fill at most this much of it. */
  findings: 3,
} as const;

export function isFinding(kind: NovaSignalKind): boolean {
  return FINDING_KINDS.has(kind);
}

/**
 * What an x402 listing is, apart from whom it pays.
 *
 * A subject is keyed by resource, network and payee together, and at least
 * one seller issues a new payee address on every catalogue read. Each read
 * then became a new subject and a fresh "available" card: Parallel search,
 * twenty-four times in eight days on one owner's agent, identical down to the
 * price. The endpoint -- what is called, how, on which chain, from which
 * balance -- is what anybody would recognise as the same thing.
 */
export function endpointOf(signal: { evidence?: Record<string, unknown> }): string | null {
  const subject = signal.evidence?.subject as Record<string, unknown> | undefined;
  const resource = subject?.resource;
  if (typeof resource !== "string" || !resource) return null;
  return [resource, subject?.method, subject?.network, subject?.funding].map(part => String(part ?? "")).join(" ");
}

/**
 * Where "new since your last visit" starts.
 *
 * A visit is a run of opens with no gap longer than {@link VISIT_GAP_MS}. The
 * brief is loaded again after a refresh, a reading or a goal change; if "new"
 * meant "since the last load", every mark would be gone the first time the
 * owner pressed a button. So the boundary moves only when a visit begins, and
 * it moves to the last moment of the visit before.
 *
 * Null through an agent's first visit. Everything is new then, which is the
 * same as nothing being marked.
 */
export const VISIT_GAP_MS = 30 * 60_000;

export function visitBoundary(input: { lastOpenedAt: string | null; seenThrough: string | null; now: Date }): {
  seenThrough: string | null;
  newVisit: boolean;
} {
  const last = input.lastOpenedAt ? Date.parse(input.lastOpenedAt) : Number.NaN;
  return !Number.isFinite(last) || input.now.getTime() - last > VISIT_GAP_MS
    ? { seenThrough: input.lastOpenedAt, newVisit: true }
    : { seenThrough: input.seenThrough, newVisit: false };
}

export type BriefCandidate = {
  kind: NovaSignalKind;
  relevance: NovaRelevance;
  observedAt: string;
  subjectId?: string | null;
  subjectRef?: string | null;
  evidence?: Record<string, unknown>;
};

export type AssembledBrief<T extends BriefCandidate> = {
  worthAttention: T[];
  /** Everything Nova looked at and decided against, kept so that "4 ignored as
   *  noise" is a claim someone can open rather than a number on a screen. */
  noise: T[];
  /** Relevant, and over the cap.
   *
   *  These were going nowhere. `noise` is what relevance rejected, so a finding
   *  that lost only the cap was neither shown nor held back -- it was absent,
   *  and "Things watched: 34" was a number nobody could open. Twenty-two paid
   *  endpoints were being watched and five could be seen, which is the right
   *  brief and the wrong product: the cap is there so a daily read stays a
   *  daily read, not so the market becomes unreachable. */
  overflow: T[];
  /** The same rows again, grouped by why they were held.
   *
   *  `noise` here is the bucket above, `duplicate` is listed nowhere else, and
   *  every other bucket together is `overflow`. They are separated because a
   *  single "held back" number hides which filter did the work: the
   *  goal-significance gate now decides most of a brief, and while only
   *  relevance was counted, a day that filtered twenty-one things could report
   *  zero. A duplicate is counted once, here, and not listed a second time:
   *  the same card twice in the watchlist is the defect the bucket names. */
  withheld: Record<NovaWithholdReason, T[]>;
};

export function assembleBrief<T extends BriefCandidate>(
  signals: T[],
  limits: { attention?: number; findings?: number; goal?: string | null } = {},
): AssembledBrief<T> {
  const attentionLimit = limits.attention ?? BRIEF_LIMITS.attention;
  const findingLimit = limits.findings ?? BRIEF_LIMITS.findings;

  const withheld = Object.fromEntries(
    NOVA_WITHHOLD_REASONS.map((reason) => [reason, [] as T[]]),
  ) as Record<NovaWithholdReason, T[]>;
  /* One listing per endpoint, before anything else sorts them: a repeat of a
     listing is a duplicate whatever its relevance, and ordering keeps the
     strongest and newest of each. */
  const listed = new Set<string>();
  const ordered = orderByRelevance(signals).filter((signal) => {
    if (signal.kind !== "capability_available") return true;
    const endpoint = endpointOf(signal);
    if (!endpoint) return true;
    if (listed.has(endpoint)) { withheld.duplicate.push(signal); return false; }
    listed.add(endpoint);
    return true;
  });
  const noise = ordered.filter((signal) => signal.relevance === "noise");
  const eligible = ordered.filter((signal) => signal.relevance !== "noise");
  withheld.noise = noise;
  const seen = new Set<string>();
  const qualified = eligible.filter(signal => {
    if (isBackgroundKind(signal.kind)) { withheld.background.push(signal); return false; }
    if (signal.kind === "official_publication" || signal.kind === "repository_release") {
      const assessment = assessmentOf({ evidence: signal.evidence ?? {} });
      /* No assessment for the goal in force is not the same statement as an
         assessment that found nothing. The first says Nova has not read it
         yet -- the analysis budget ran out, the model was unavailable, or the
         goal changed after the reading -- and that is a gap in coverage the
         owner should see rather than a verdict about the material. */
      if (!assessment || assessment.goal !== limits.goal) { withheld.not_analyzed.push(signal); return false; }
      if (!assessment.significant) { withheld.not_significant.push(signal); return false; }
    }
    const subject = signal.subjectRef ?? signal.subjectId;
    if (!subject) return true;
    const key = `${subject}:${signal.kind}`;
    if (seen.has(key)) { withheld.duplicate.push(signal); return false; }
    seen.add(key); return true;
  });

  /* Changes first, all of them, in relevance order. A change is the thing Nova
     exists to catch and it is never dropped to make room for a finding. */
  const changes = qualified.filter((signal) => !isFinding(signal.kind));
  const findings = qualified.filter((signal) => isFinding(signal.kind));

  const worthAttention: T[] = [];
  for (const change of changes) {
    if (worthAttention.length >= attentionLimit) break;
    worthAttention.push(change);
  }

  let findingsTaken = 0;
  for (const finding of findings) {
    if (worthAttention.length >= attentionLimit) break;
    if (findingsTaken >= findingLimit) break;
    findingsTaken += 1;
    worthAttention.push(finding);
  }

  const shown = new Set(worthAttention);
  const duplicates = new Set(withheld.duplicate);
  const overflow = eligible.filter((signal) => !shown.has(signal) && !duplicates.has(signal));
  withheld.over_cap = qualified.filter((signal) => !shown.has(signal));

  return { worthAttention, noise, overflow, withheld };
}

/**
 * The line at the top.
 *
 * Local to the reader, not to the server: a brief that says "Good morning" at
 * ten at night is a small thing that tells someone this was written for nobody
 * in particular.
 */
export function greeting(hourOfDay: number): string {
  if (!Number.isFinite(hourOfDay)) return "Hello";
  const hour = Math.max(0, Math.min(23, Math.trunc(hourOfDay)));
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * What a person is told about a refresh that found nothing.
 *
 * "Nothing changed" and "I could not look" are opposite facts that produce the
 * same empty screen, and a daily product that renders them identically tells a
 * small lie every quiet day until the day it matters.
 */
export function quietSummary(input: {
  subjectsChecked: number;
  sourcesUnavailable: string[];
}): string {
  if (input.sourcesUnavailable.length > 0) {
    const names = input.sourcesUnavailable.join(" and ");
    return `Nova could not reach ${names} this time, so this is not a quiet day -- it is an incomplete one.`;
  }
  if (input.subjectsChecked === 0) {
    return "Nova is not watching anything yet.";
  }
  return `No source-supported finding was selected from the ${input.subjectsChecked} things checked.`;
}
