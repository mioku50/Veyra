import {
  arcUsdcBlocklistHardExclusion,
  COUNTERPARTY_SELECTION_POLICY,
  freshnessFromAge,
} from "./policy.ts";
import { BRAND } from "../brand.ts";
import type {
  CandidateRankingInput,
  EligibilityStatus,
  EvidenceFreshness,
  RankedCandidate,
  RankingDimension,
} from "./types.ts";

function bounded(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function rounded(value: number) {
  return Math.round(bounded(value));
}

function worstFreshness(states: EvidenceFreshness[]): EvidenceFreshness {
  const order: EvidenceFreshness[] = ["missing", "stale", "aging", "fresh"];
  return states.reduce((worst, item) =>
    order.indexOf(item) < order.indexOf(worst) ? item : worst, "fresh");
}

function eligibilityFor(input: CandidateRankingInput): {
  status: EligibilityStatus;
  reason?: string;
} {
  const hard = arcUsdcBlocklistHardExclusion(
    input.arcUsdcBlocklistStatus ?? "unknown",
  ) ?? input.hardExclusions?.[0];
  if (hard) return { status: "INELIGIBLE", reason: hard };
  if (input.requireExactCapability && input.capabilityMatch !== "exact") {
    return { status: "INELIGIBLE", reason: "unsupported_capability" };
  }
  if (input.capabilityMatch === "none") {
    return { status: "INELIGIBLE", reason: "unsupported_capability" };
  }
  if (
    input.advertisedPriceUsdc !== undefined
    && input.advertisedPriceUsdc > input.requestedBudgetUsdc
  ) {
    return { status: "INELIGIBLE", reason: "budget_exceeded" };
  }
  switch (input.trustDecision.decision) {
    case "ALLOW": return { status: "ELIGIBLE" };
    case "ALLOW_WITH_LIMITS": return { status: "ELIGIBLE_WITH_LIMITS" };
    case "REQUIRE_EVALUATOR": return { status: "REQUIRES_EVALUATOR" };
    case "REVIEW_REQUIRED": return { status: "REVIEW_REQUIRED", reason: "review_required" };
    default: return { status: "INELIGIBLE", reason: input.trustDecision.reasons[0]?.toLowerCase() || "policy_denied" };
  }
}

export function rankCounterpartyCandidate(input: CandidateRankingInput): RankedCandidate {
  const policy = COUNTERPARTY_SELECTION_POLICY;
  const sources = input.evidence.sources;
  const source = (name: string) => sources.find((item) => item.source === name);
  const overallFreshness = worstFreshness(sources.map((item) => item.freshness));
  const freshnessScore = policy.freshness.scores[overallFreshness];
  const freshnessCoverageScore = rounded(
    freshnessScore * 0.5 + input.evidence.snapshotCoverage * 100 * 0.5,
  );
  const weightedConfidence = rounded(
    input.evidence.snapshotConfidence * policy.confidenceInputs.snapshotConfidenceWeight
      + input.evidence.snapshotCoverage * 100 * policy.confidenceInputs.coverageWeight,
  );
  const confidence = input.evidence.evidenceCounts.total === 0
    ? 0
    : rounded(Math.min(weightedConfidence, input.evidence.snapshotCoverage * 100));

  const dimensionInputs: Array<{
    name: RankingDimension["name"];
    score: number;
    evidenceCount: number;
    freshness: EvidenceFreshness;
    explanation: string;
  }> = [
    {
      name: "reputationQuality",
      score: input.evidence.dimensions.reputationQuality,
      evidenceCount: input.evidence.evidenceCounts.total,
      freshness: source("reputation")?.freshness ?? "missing",
      explanation: "Latest evidence-weighted Veyra reputation quality.",
    },
    {
      name: "executionReliability",
      score: input.evidence.dimensions.executionReliability,
      evidenceCount: input.evidence.evidenceCounts.execution,
      freshness: source("execution")?.freshness ?? "missing",
      explanation: "Verified ERC-8183 completion and rejection history.",
    },
    {
      name: "evaluatorSuccess",
      score: input.evidence.dimensions.evaluatorSuccess,
      evidenceCount: input.evidence.evidenceCounts.evaluator,
      freshness: source("evaluator")?.freshness ?? "missing",
      explanation: `${BRAND.name} evaluator verdict history.`,
    },
    {
      name: "economicReliability",
      score: input.evidence.dimensions.economicReliability,
      evidenceCount: input.evidence.evidenceCounts.economic,
      freshness: source("economic")?.freshness ?? "missing",
      explanation: "Verified settlement and economic evidence.",
    },
    {
      name: "serviceQuality",
      score: input.evidence.dimensions.serviceQuality,
      evidenceCount: input.evidence.evidenceCounts.serviceQuality,
      freshness: source("service_quality")?.freshness ?? "missing",
      explanation: "Observed API availability and service-quality evidence.",
    },
    {
      name: "evidenceFreshnessCoverage",
      score: freshnessCoverageScore,
      evidenceCount: input.evidence.evidenceCounts.total,
      freshness: overallFreshness,
      explanation: "Freshness and coverage of the evidence used for selection.",
    },
  ];

  const dimensions = dimensionInputs.map((dimension) => ({
    ...dimension,
    score: rounded(dimension.evidenceCount === 0 ? 0 : dimension.score),
    weight: policy.weights[dimension.name],
    confidence: dimension.evidenceCount === 0 ? 0 : confidence,
  }));
  const rawQuality = dimensions.reduce(
    (sum, dimension) => sum + dimension.score * dimension.weight,
    0,
  );
  const relevanceMultiplier = policy.capabilityMultipliers[input.capabilityMatch];
  const baseQualityScore = rounded(rawQuality * relevanceMultiplier);
  const confidenceMultiplier =
    policy.confidenceMultiplier.floor
    + (confidence / 100) * policy.confidenceMultiplier.variable;
  const rankingScore = rounded(baseQualityScore * confidenceMultiplier);
  const eligibility = eligibilityFor(input);
  const requested = input.requestedBudgetUsdc;
  const policyMax = Math.max(0, input.trustDecision.policy.maxValueUsdc);
  const executable = ["ELIGIBLE", "ELIGIBLE_WITH_LIMITS", "REQUIRES_EVALUATOR"].includes(eligibility.status);
  const recommendedMaxExposureUsdc = executable ? Math.min(requested, policyMax) : 0;
  const staleSources = sources.filter((item) => item.freshness === "stale" || item.freshness === "missing");

  const topReasons = [
    ...input.evidence.positiveSignals,
    `${input.capabilityMatch} capability match`,
    `${input.evidence.evidenceCounts.total} canonical evidence records`,
  ].slice(0, 4);
  const tradeoffs = [
    ...(confidence < 70 ? [`Evidence confidence is ${confidence}%.`] : []),
    ...(input.capabilityMatch !== "exact" ? [`Capability match is ${input.capabilityMatch}.`] : []),
    ...(staleSources.length > 0 ? [`${staleSources.length} evidence sources are stale or missing.`] : []),
  ];

  return {
    identity: input.identity,
    serviceId: input.evidence.selectedService?.serviceId,
    capabilityMatch: input.capabilityMatch,
    eligibility: eligibility.status,
    trustDecision: input.trustDecision.decision,
    trustDecisionId: input.trustDecision.decisionId,
    trustDecisionHash: input.trustDecision.canonicalHash as `0x${string}`,
    trustScore: rounded(input.evidence.trustScore),
    baseQualityScore,
    rankingScore,
    confidence,
    requestedAmountUsdc: requested,
    policyMaxExposureUsdc: policyMax,
    recommendedMaxExposureUsdc,
    advertisedPriceUsdc: input.advertisedPriceUsdc,
    priceKind: input.priceKind,
    evidenceHash: input.evidence.evidenceHash,
    evidenceCoverage: rounded(input.evidence.snapshotCoverage * 100),
    evidenceCount: input.evidence.evidenceCounts.total,
    evidenceSources: input.evidence.sources,
    refreshSuggested: staleSources.length > 0,
    refreshableModules: staleSources.length > 0
      ? [
          { module: "agent_trust_report", estimatedCostUsdc: policy.refreshCostsUsdc.agent_trust_report },
          { module: "paid_api_quality", estimatedCostUsdc: policy.refreshCostsUsdc.paid_api_quality },
        ]
      : [],
    dimensions,
    topReasons,
    riskSignals: Array.from(new Set([
      ...input.evidence.riskSignals,
      ...input.trustDecision.riskSignals,
      ...(input.arcUsdcBlocklistStatus === "blocklisted"
        ? ["arc_usdc_blocklisted"]
        : input.arcUsdcBlocklistStatus === "unknown"
          ? ["arc_usdc_blocklist_unknown"]
          : []),
    ])),
    tradeoffs,
    rejectionReason: eligibility.reason,
    arcUsdcBlocklistStatus: input.arcUsdcBlocklistStatus ?? "unknown",
    rank: 0,
  };
}

export function rankCounterparties(inputs: CandidateRankingInput[]) {
  const ranked = inputs.map(rankCounterpartyCandidate).sort((left, right) => {
    const leftExecutable = ["ELIGIBLE", "ELIGIBLE_WITH_LIMITS", "REQUIRES_EVALUATOR"].includes(left.eligibility);
    const rightExecutable = ["ELIGIBLE", "ELIGIBLE_WITH_LIMITS", "REQUIRES_EVALUATOR"].includes(right.eligibility);
    if (leftExecutable !== rightExecutable) return rightExecutable ? 1 : -1;
    if (right.rankingScore !== left.rankingScore) return right.rankingScore - left.rankingScore;
    if (right.trustScore !== left.trustScore) return right.trustScore - left.trustScore;
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return left.identity.agentId.localeCompare(right.identity.agentId);
  });
  ranked.forEach((candidate, index) => { candidate.rank = index + 1; });
  const winner = ranked.find((candidate) =>
    ["ELIGIBLE", "ELIGIBLE_WITH_LIMITS", "REQUIRES_EVALUATOR"].includes(candidate.eligibility));
  return { ranked, winner: winner ?? null };
}
