/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { orderByRelevance } from "./relevance.ts";
import type { NovaRelevance, NovaSignalKind } from "./types.ts";

/**
 * Turning everything Nova found into the few lines a person will actually read.
 *
 * The first live run produced thirteen items, which is a list, not a brief. A
 * person who opens thirteen items every morning stops opening them, and then
 * the one that mattered -- the changed payee -- is the one they miss.
 *
 * So this caps hard, and the cap is not arbitrary. Findings ("this exists and
 * costs this") are what a first look produces and there can be dozens; changes
 * ("this moved") are rare and are the reason to come back. Changes therefore
 * always outrank findings regardless of score, and findings are limited to a
 * handful so they can never crowd out a change.
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

export type BriefCandidate = {
  kind: NovaSignalKind;
  relevance: NovaRelevance;
  observedAt: string;
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
};

export function assembleBrief<T extends BriefCandidate>(
  signals: T[],
  limits: { attention?: number; findings?: number } = {},
): AssembledBrief<T> {
  const attentionLimit = limits.attention ?? BRIEF_LIMITS.attention;
  const findingLimit = limits.findings ?? BRIEF_LIMITS.findings;

  const ordered = orderByRelevance(signals);
  const noise = ordered.filter((signal) => signal.relevance === "noise");
  const eligible = ordered.filter((signal) => signal.relevance !== "noise");

  /* Changes first, all of them, in relevance order. A change is the thing Nova
     exists to catch and it is never dropped to make room for a finding. */
  const changes = eligible.filter((signal) => !isFinding(signal.kind));
  const findings = eligible.filter((signal) => isFinding(signal.kind));

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
  const overflow = eligible.filter((signal) => !shown.has(signal));

  return { worthAttention, noise, overflow };
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
  return `Nothing moved across the ${input.subjectsChecked} things Nova watches for you.`;
}
