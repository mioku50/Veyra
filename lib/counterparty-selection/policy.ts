import type { CapabilityMatch, EvidenceFreshness, RankingDimensionName } from "./types.ts";
import type { ArcUsdcBlocklistStatus } from "../wallet/arc-usdc.ts";

export const COUNTERPARTY_SELECTION_POLICY = {
  version: "veyra-counterparty-selection-v1",
  expirySeconds: 15 * 60,
  maxCandidates: 10,
  minCandidates: 1,
  maxBudgetUsdc: 100_000,
  weights: {
    reputationQuality: 0.30,
    executionReliability: 0.25,
    evaluatorSuccess: 0.15,
    economicReliability: 0.10,
    serviceQuality: 0.10,
    evidenceFreshnessCoverage: 0.10,
  } satisfies Record<RankingDimensionName, number>,
  confidenceMultiplier: {
    floor: 0.60,
    variable: 0.40,
  },
  confidenceInputs: {
    snapshotConfidenceWeight: 0.60,
    coverageWeight: 0.40,
  },
  confidenceLabels: {
    Low: 30,
    Medium: 60,
    High: 90,
    "Very High": 100,
  },
  freshness: {
    freshMaxAgeSeconds: 60 * 60,
    agingMaxAgeSeconds: 24 * 60 * 60,
    scores: { fresh: 100, aging: 70, stale: 25, missing: 0 } satisfies Record<EvidenceFreshness, number>,
  },
  capabilityMultipliers: {
    exact: 1,
    related: 0.92,
    generic: 0.80,
    none: 0,
  } satisfies Record<CapabilityMatch, number>,
  relatedCapabilities: {
    github_due_diligence: ["repository_intelligence", "project_update_intelligence", "agent_trust_report"],
    market_context: ["price_context", "market_intelligence"],
    paid_api: ["api_quality", "project_update_intelligence"],
    treasury_analysis: ["treasury_health", "wallet_analysis"],
  } satisfies Record<string, string[]>,
  refreshCostsUsdc: {
    agent_trust_report: 0.05,
    paid_api_quality: 0.03,
  },
} as const;

/**
 * Weight profile for externally discovered x402 endpoints.
 *
 * A Circle-marketplace seller has no Veyra reputation snapshot, no ERC-8183
 * job history and no evaluator verdicts - and cannot acquire them before the
 * first call. Scoring it on those dimensions would hand every candidate the
 * same near-zero number and destroy the ranking. Instead the weight sits on
 * the evidence that a free probe genuinely produces: protocol and catalog
 * integrity (mapped onto serviceQuality) plus freshness/coverage of that
 * evidence. The zeroed dimensions stay visible in the response with
 * `evidenceCount: 0`, so the absence is reported rather than hidden.
 */
export const MARKETPLACE_RANKING_WEIGHTS = {
  reputationQuality: 0,
  executionReliability: 0,
  evaluatorSuccess: 0,
  economicReliability: 0,
  serviceQuality: 0.75,
  evidenceFreshnessCoverage: 0.25,
} satisfies Record<RankingDimensionName, number>;

export function arcUsdcBlocklistHardExclusion(
  status: ArcUsdcBlocklistStatus,
) {
  return status === "blocklisted" ? "arc_usdc_blocklisted" : null;
}

export function freshnessFromAge(ageSeconds: number | null): EvidenceFreshness {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return "missing";
  if (ageSeconds <= COUNTERPARTY_SELECTION_POLICY.freshness.freshMaxAgeSeconds) return "fresh";
  if (ageSeconds <= COUNTERPARTY_SELECTION_POLICY.freshness.agingMaxAgeSeconds) return "aging";
  return "stale";
}

export function capabilityMatchFor(
  requested: string,
  offered: string[],
): CapabilityMatch {
  const normalized = requested.trim().toLowerCase();
  const values = offered.map((item) => item.trim().toLowerCase());
  if (values.includes(normalized)) return "exact";
  const related = COUNTERPARTY_SELECTION_POLICY.relatedCapabilities[
    normalized as keyof typeof COUNTERPARTY_SELECTION_POLICY.relatedCapabilities
  ] ?? [];
  if (values.some((item) => related.includes(item as never))) return "related";
  return values.length > 0 ? "generic" : "none";
}
