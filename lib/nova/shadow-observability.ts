/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { ShadowPass } from "./shadow-run.ts";

/** Aggregate counts only: safe for the public scheduler log. */
export function emptyShadowMetrics() {
  return {
    shadowPasses: 0,
    shadowFailed: 0,
    shadowSkippedForTime: 0,
    shadowBlocked: {} as Record<string, number>,
    shadowConsidered: 0,
    shadowSkipped: 0,
    shadowDeadlineHits: 0,
    shadowDecided: 0,
    shadowWouldAllow: 0,
    shadowWouldSpendUsdc: 0,
    shadowUnpriced: {} as Record<string, number>,
  };
}

export type ShadowMetrics = ReturnType<typeof emptyShadowMetrics>;

/** Preserve a successful brief even if rehearsal fails, but retain the failure count. */
export async function observeShadowPass(
  metrics: ShadowMetrics,
  hasTime: boolean,
  run: () => Promise<ShadowPass>,
): Promise<void> {
  if (!hasTime) {
    metrics.shadowSkippedForTime++;
    return;
  }
  metrics.shadowPasses++;
  let pass: ShadowPass;
  try {
    pass = await run();
  } catch {
    // Exception text may contain a private question, endpoint or credentials.
    metrics.shadowFailed++;
    return;
  }
  if (pass.blocked) metrics.shadowBlocked[pass.blocked] = (metrics.shadowBlocked[pass.blocked] ?? 0) + 1;
  metrics.shadowConsidered += pass.considered;
  metrics.shadowSkipped += pass.skipped;
  if (pass.ranOutOfTime) metrics.shadowDeadlineHits++;
  metrics.shadowDecided += pass.decided;
  metrics.shadowWouldAllow += pass.wouldAllow;
  metrics.shadowWouldSpendUsdc += pass.wouldSpendUsdc;
  for (const [reason, count] of Object.entries(pass.unpricedReasons)) {
    metrics.shadowUnpriced[reason] = (metrics.shadowUnpriced[reason] ?? 0) + count;
  }
}
