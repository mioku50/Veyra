/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { NovaSignal } from "./types.ts";

export type PublicMaterial = {
  id: string;
  title: string;
  url: string;
  text: string;
  publishedAt: string | null;
  fetchedAt: string;
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
