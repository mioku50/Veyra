/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { READING_RULES } from "./value.ts";

/**
 * What the pipeline did over a window, from what it wrote down.
 *
 * Roadmap item 3 asks for eight measurements. Six are here, and a seventh --
 * missed events -- only as far as the owner reported them. What is not
 * measured is named rather than approximated, because a coverage report that
 * quietly drops the awkward half of its own brief is the thing it exists to
 * prevent.
 *
 * Every number is read from a row the scheduler wrote at the time. Nothing is
 * inferred from logs and nothing is recomputed by re-reading a source, so the
 * report says what happened rather than what would happen now.
 */
export type CoverageReport = {
  source: string;
  window: { from: string; to: string };
  passes: { total: number; byTrigger: Record<string, number> };
  coverage: {
    subjectsChecked: number;
    signalsFound: number;
    signalsKept: number;
    signalsAsNoise: number;
    /** Found but not kept: duplicates, over-cap and below the score floor. */
    notKept: number;
  };
  /** Hosts that did not answer, by name and by how many passes hit it. */
  unavailable: Record<string, number>;
  /** Fetched and not parseable, by feed. Not an availability problem. */
  unreadable: Record<string, number>;
  reading: {
    attempted: number;
    failed: number;
    /** The model invalid-output rate, by named cause. */
    byCause: Record<string, number>;
    failureRate: string;
  };
  durationMs: { median: number; p90: number; max: number };
  ticks: {
    recorded: number;
    stoppedEarly: number;
    shadowDecided: number;
    shadowWouldAllow: number;
    shadowBlocked: Record<string, number>;
    /** The figure the D0 capture could not answer. */
    shadowUnpriced: Record<string, number>;
  };
  cards: { stored: number; underCurrentRules: number; stale: number; neverRead: number };
  /** Events the owner said Nova should have shown, by what Nova had. */
  misses: {
    reported: number;
    /** observed: a ranking miss. covered: a reading miss. not_covered: a coverage gap. */
    byFinding: Record<string, number>;
    /** Where the coverage gaps are. The input to extending sources. */
    notCoveredHosts: Record<string, number>;
  };
  limitations: string[];
};

const bump = (into: Record<string, number>, key: string, by = 1) => { into[key] = (into[key] ?? 0) + by; };

/** Reading failures are recorded in `sources_unavailable` too, for the owner.
 *  Counting them again here would report one failure as two. */
const READING_NOTE = /^Nova public-source analysis/;

function percentiles(values: number[]) {
  if (!values.length) return { median: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

export async function coverageReport(db: SupabaseClient, input: { from: string; to: string }): Promise<CoverageReport> {
  const { data: refreshRows, error: refreshError } = await db
    .from("nova_refreshes")
    .select("trigger,subjects_checked,signals_found,signals_kept,signals_as_noise,sources_unavailable,articles_unreadable,readings_attempted,reading_failures,duration_ms,started_at")
    .gte("started_at", input.from).lte("started_at", input.to).order("started_at");
  if (refreshError) throw new Error(`Could not read refreshes: ${refreshError.message}`);
  const refreshes = (refreshRows ?? []) as unknown as Array<{
    trigger: string; subjects_checked: number; signals_found: number; signals_kept: number;
    signals_as_noise: number; sources_unavailable: string[] | null;
    articles_unreadable: Record<string, number> | null; readings_attempted: number | null;
    reading_failures: Record<string, number> | null; duration_ms: number;
  }>;

  const { data: tickRows, error: tickError } = await db
    .from("nova_ticks")
    .select("stopped_early,shadow_decided,shadow_would_allow,shadow_blocked,shadow_unpriced")
    .gte("started_at", input.from).lte("started_at", input.to);
  if (tickError) throw new Error(`Could not read ticks: ${tickError.message}`);
  const ticks = (tickRows ?? []) as Array<{
    stopped_early: boolean; shadow_decided: number; shadow_would_allow: number;
    shadow_blocked: Record<string, number> | null; shadow_unpriced: Record<string, number> | null;
  }>;

  const { data: signalRows, error: signalError } = await db
    .from("nova_signals").select("rules:evidence->valueAssessment->>rules").limit(2000);
  if (signalError) throw new Error(`Could not read signals: ${signalError.message}`);
  const signals = (signalRows ?? []) as Array<{ rules: string | null }>;

  const { data: missRows, error: missError } = await db
    .from("nova_misses").select("finding,host")
    .gte("created_at", input.from).lte("created_at", input.to);
  if (missError) throw new Error(`Could not read misses: ${missError.message}`);
  const misses = (missRows ?? []) as Array<{ finding: string; host: string }>;

  const byTrigger: Record<string, number> = {};
  const unavailable: Record<string, number> = {};
  const unreadable: Record<string, number> = {};
  const byCause: Record<string, number> = {};
  const shadowBlocked: Record<string, number> = {};
  const shadowUnpriced: Record<string, number> = {};
  const coverage = { subjectsChecked: 0, signalsFound: 0, signalsKept: 0, signalsAsNoise: 0, notKept: 0 };
  let attempted = 0;

  for (const row of refreshes) {
    bump(byTrigger, row.trigger);
    coverage.subjectsChecked += row.subjects_checked ?? 0;
    coverage.signalsFound += row.signals_found ?? 0;
    coverage.signalsKept += row.signals_kept ?? 0;
    coverage.signalsAsNoise += row.signals_as_noise ?? 0;
    attempted += row.readings_attempted ?? 0;
    for (const note of row.sources_unavailable ?? []) {
      if (READING_NOTE.test(note)) continue;
      bump(unavailable, note.replace(/\s+/g, " ").trim().slice(0, 80));
    }
    for (const [label, count] of Object.entries(row.articles_unreadable ?? {})) bump(unreadable, label, count);
    for (const [cause, count] of Object.entries(row.reading_failures ?? {})) bump(byCause, cause, count);
  }
  coverage.notKept = coverage.signalsFound - coverage.signalsKept;

  for (const tick of ticks) {
    for (const [reason, count] of Object.entries(tick.shadow_blocked ?? {})) bump(shadowBlocked, reason, count);
    for (const [reason, count] of Object.entries(tick.shadow_unpriced ?? {})) bump(shadowUnpriced, reason, count);
  }

  const byFinding: Record<string, number> = {};
  const notCoveredHosts: Record<string, number> = {};
  for (const miss of misses) {
    bump(byFinding, miss.finding);
    if (miss.finding === "not_covered") bump(notCoveredHosts, miss.host);
  }

  const failed = Object.values(byCause).reduce((a, b) => a + b, 0);
  const underCurrentRules = signals.filter(s => Number(s.rules) === READING_RULES).length;
  const read = signals.filter(s => s.rules !== null && s.rules !== undefined).length;

  return {
    source: "Configured Supabase database; production identity not independently attested",
    window: { from: input.from, to: input.to },
    passes: { total: refreshes.length, byTrigger },
    coverage,
    unavailable,
    unreadable,
    reading: {
      attempted, failed, byCause,
      failureRate: attempted ? `${((failed / attempted) * 100).toFixed(1)}%` : "n/a",
    },
    durationMs: percentiles(refreshes.map(r => r.duration_ms ?? 0)),
    ticks: {
      recorded: ticks.length,
      stoppedEarly: ticks.filter(t => t.stopped_early).length,
      shadowDecided: ticks.reduce((a, t) => a + (t.shadow_decided ?? 0), 0),
      shadowWouldAllow: ticks.reduce((a, t) => a + (t.shadow_would_allow ?? 0), 0),
      shadowBlocked, shadowUnpriced,
    },
    cards: {
      stored: signals.length, underCurrentRules,
      stale: read - underCurrentRules,
      neverRead: signals.length - read,
    },
    misses: { reported: misses.length, byFinding, notCoveredHosts },
    limitations: [
      "Missed events are only those the owner reported. A miss nobody reported is still not measurable, so a small number here is not evidence of good coverage.",
      "App-side model and RPC costs are not recorded. They live in provider billing, which this report does not read.",
      "Ticks are counted only from the first tick written after nova_ticks existed. An empty ticks section over an older window means the rows predate the table, not that no tick ran.",
      "Cards are counted across the whole store, not the window: a stale card is stale now, whenever it was written.",
    ],
  };
}
