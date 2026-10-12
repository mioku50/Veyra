import type { ReputationEvidence } from "../reputation/types.ts";
import { TRUST_DECISION_EXPIRY_SECONDS, TRUST_POLICY_VERSION } from "../trust-gate/types.ts";

// Monad-only policy revision. The shared Arc scoring engine and tiers are unchanged.
export const METROPOLIS_TRUST_VERSION = `${TRUST_POLICY_VERSION}:metropolis-evidence-v2`;
export const MONAD_SECURITY_STATE_TTL_SECONDS = TRUST_DECISION_EXPIRY_SECONDS;
export const MONAD_HISTORY_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;

export type MonadHistoryEvidence = ReputationEvidence & {
  /** Original payment time for payment-bound assessments; null means event age is unknown. */
  historyAnchorAt: string | null;
};
export type MonadHistorySummary = {
  lookbackSeconds: number;
  verifiedEvidenceCount: number;
  scoredEvidenceCount: number;
  retainedNegativeCount: number;
  oldestEventAgeSeconds: number | null;
  excludedPositiveEvidence: readonly { evidenceId: string; reason: "OUTSIDE_LOOKBACK" | "UNKNOWN_EVENT_TIME" }[];
};

/** Preserve source timestamps. Reverification and a later assessment cannot rejuvenate a payment. */
export function selectMonadHistory(evidence: readonly MonadHistoryEvidence[], now: Date) {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new Error("Invalid history evaluation time");
  const scored: MonadHistoryEvidence[] = [];
  const excluded: { evidenceId: string; reason: "OUTSIDE_LOOKBACK" | "UNKNOWN_EVENT_TIME" }[] = [];
  const ages: number[] = [];
  let retainedNegativeCount = 0;
  for (const item of evidence) {
    const eventTime = item.historyAnchorAt === null ? null : new Date(item.historyAnchorAt).getTime();
    if (eventTime !== null && (!Number.isFinite(eventTime) || eventTime > time)) {
      throw new Error("Invalid original history timestamp");
    }
    if (eventTime !== null) ages.push(Math.floor((time - eventTime) / 1000));
    // Old failures stay visible and cannot disappear when their positive history ages out.
    if (!item.positive) { scored.push(item); retainedNegativeCount++; continue; }
    if (eventTime === null) excluded.push({ evidenceId: item.evidenceId, reason: "UNKNOWN_EVENT_TIME" });
    else if (time - eventTime > MONAD_HISTORY_LOOKBACK_SECONDS * 1000) {
      excluded.push({ evidenceId: item.evidenceId, reason: "OUTSIDE_LOOKBACK" });
    } else scored.push(item);
  }
  const summary: MonadHistorySummary = {
    lookbackSeconds: MONAD_HISTORY_LOOKBACK_SECONDS, verifiedEvidenceCount: evidence.length,
    scoredEvidenceCount: scored.length, retainedNegativeCount,
    oldestEventAgeSeconds: ages.length ? Math.max(...ages) : null, excludedPositiveEvidence: excluded,
  };
  return { evidence: scored, summary };
}
