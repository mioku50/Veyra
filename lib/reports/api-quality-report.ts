/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ApiQualityComparisonResult,
  ApiQualityMetrics,
  ApiQualityObservation,
  ApiQualityScore,
  ConfidenceLevel,
  ErrorCategory,
  QualityStatus,
} from "../providers/api-quality-types.ts";
import {
  calculateQualityScore,
  compareApiQuality,
  computeApiQualityMetrics,
} from "../providers/api-quality.ts";
import { BRAND } from "../brand.ts";

export interface NumericMetric {
  value: number | null;
  isLowerBound?: boolean;
  confidence: ConfidenceLevel;
}

export interface HostedWorkflowArcProofItem {
  receiptId?: string;
  txHash: string | null;
  status: string;
  explorerUrl: string | null;
  blockNumber?: number | null;
  contractAddress?: string | null;
}

export interface HostedWorkflowReceiptItem {
  receiptId: string;
  serviceSlug: string;
  serviceName: string;
  priceUsdc: string;
  status: string;
}

export interface ApiQualityReportServiceSummary {
  serviceId: string;
  serviceName: string;
  sellerPublicId: string | null;
  observationCount: NumericMetric;
  rank?: number;
  qualityScore?: number | null;
  status?: QualityStatus;
}

export interface ApiQualityReportRiskItem {
  code: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  impact: string;
}

export interface ApiQualityReportObservedFailureItem {
  category: ErrorCategory;
  count: number;
  percentage: number;
  description: string;
}

export interface ApiQualityPublicReport {
  reportId: string;
  workflow: string;
  workflowType?: string;
  status: string;
  mode: "single" | "comparison";
  targetServices: string[];
  overallStatus: QualityStatus;
  overallScore: number | null;
  confidence: ConfidenceLevel;
  executiveSummary: string;
  generatedAt: string;
  observationWindowDays: number;

  // 15 Structured Report Sections:
  // Section 1: Executive Summary (available at top-level executiveSummary as well)
  // Section 2: Services Overview & Comparison
  servicesCompared: ApiQualityReportServiceSummary[];

  // Section 3: Price and Cost Efficiency
  priceAndCostEfficiency: {
    quotedPriceMinUsdc: NumericMetric;
    quotedPriceMedianUsdc: NumericMetric;
    quotedPriceMaxUsdc: NumericMetric;
    costPerSuccessfulResultUsdc: NumericMetric;
    summary: string;
  };

  // Section 4: Availability
  availability: {
    uptimePercent: NumericMetric;
    totalObservations: NumericMetric;
    summary: string;
  };

  // Section 5: Latency Distribution
  latencyDistribution: {
    latencyP50Ms: NumericMetric;
    latencyP95Ms: NumericMetric;
    latencyMaxMs: NumericMetric;
    summary: string;
  };

  // Section 6: Response Quality
  responseQuality: {
    validResponsePercent: NumericMetric;
    schemaValidationPercent: NumericMetric;
    withinSizeLimitPercent: NumericMetric;
    summary: string;
  };

  // Section 7: Payment and Settlement Reliability
  paymentAndSettlementReliability: {
    paymentSuccessPercent: NumericMetric;
    settlementSuccessPercent: NumericMetric;
    summary: string;
  };

  // Section 8: Observed Failures
  observedFailures: ApiQualityReportObservedFailureItem[];

  // Section 9: Quality Score and Confidence
  qualityScoreAndConfidence: {
    overallScore: number | null;
    status: QualityStatus;
    confidenceLevel: ConfidenceLevel;
    hasSufficientData: boolean;
    breakdown: {
      availabilityScore: number | null;
      executionReliabilityScore: number | null;
      responseValidityScore: number | null;
      paymentSuccessScore: number | null;
      settlementSuccessScore: number | null;
      latencyConsistencyScore: number | null;
    };
    summary: string;
  };

  // Section 10: Evidence-Backed Strengths
  strengths: string[];

  // Section 11: Risks and Review Items
  risksAndReviewItems: ApiQualityReportRiskItem[];

  // Section 12: Questions Before Integration
  questionsBeforeIntegration: string[];

  // Section 13: Evidence and Observation Window
  evidenceAndObservationWindow: {
    windowDays: number;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    totalObservationsCount: NumericMetric;
    realPaidExecutionCount: NumericMetric;
    scheduledProbeCount: NumericMetric;
    historicalExecutionCount: NumericMetric;
    summary: string;
  };

  // Section 14: Limitations
  limitations: {
    disclaimer: string;
    analyzedAt: string;
  };

  // Section 15: Payment & Arc Verification Details
  verification: {
    status: string;
    network: string;
    proofs: HostedWorkflowArcProofItem[];
    receipts: HostedWorkflowReceiptItem[];
    verifiedSteps: number;
    requiredSteps: number;
  };

  // Side-by-Side Comparison Matrix (for multi-service evaluation)
  comparison: ApiQualityComparisonResult | null;
}

export interface BuildApiQualityPublicReportInput {
  jobId: string;
  workflow?: string;
  status?: string;
  targetServices: string[];
  serviceNames?: Record<string, string>;
  observationWindowDays?: number;
  observationsByService?: Record<string, ApiQualityObservation[]>;
  observations?: ApiQualityObservation[];
  proofs?: HostedWorkflowArcProofItem[];
  receipts?: HostedWorkflowReceiptItem[];
  generatedAt?: string;
}

function failureCategoryDescription(cat: ErrorCategory, count: number): string {
  switch (cat) {
    case "timeout":
      return `${count} request(s) timed out before receiving a response from the provider endpoint.`;
    case "network":
      return `${count} request(s) failed due to network connectivity or DNS resolution issues.`;
    case "invalid_response":
      return `${count} request(s) returned invalid response payloads that failed schema or size validation.`;
    case "payment_failed":
      return `${count} request(s) failed during x402 payment authorization.`;
    case "settlement_failed":
      return `${count} request(s) failed during on-chain Arc USDC payment settlement.`;
    case "execution_failed":
      return `${count} request(s) failed during provider execution.`;
    case "verification_failed":
      return `${count} request(s) failed Arc proof verification.`;
    default:
      return `${count} execution event(s) encountered category: ${cat}.`;
  }
}

/**
 * Parses target service IDs and observation window days from raw input text or job metadata.
 */
export function parseApiQualityJobInput(
  inputPreview: string,
  plannerSnapshot?: any,
  structuredResult?: any,
): {
  targetServices: string[];
  observationWindowDays: number;
} {
  let targetServices: string[] = [];
  let observationWindowDays = 30;

  // 1. Try parsing JSON input preview
  if (inputPreview && inputPreview.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(inputPreview.trim());
      if (typeof parsed.serviceId === "string" && parsed.serviceId.trim()) {
        targetServices.push(parsed.serviceId.trim());
      }
      if (Array.isArray(parsed.serviceIds)) {
        targetServices.push(
          ...parsed.serviceIds.filter(
            (id: any) => typeof id === "string" && id.trim(),
          ),
        );
      }
      if (
        typeof parsed.observationWindowDays === "number" &&
        [7, 30, 90].includes(parsed.observationWindowDays)
      ) {
        observationWindowDays = parsed.observationWindowDays;
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 2. Check structuredResult workflowData
  const wfData = structuredResult?.workflowData;
  if (wfData) {
    if (typeof wfData.serviceId === "string" && wfData.serviceId.trim()) {
      targetServices.push(wfData.serviceId.trim());
    }
    if (Array.isArray(wfData.serviceIds)) {
      targetServices.push(
        ...wfData.serviceIds.filter(
          (id: any) => typeof id === "string" && id.trim(),
        ),
      );
    }
    if (Array.isArray(wfData.targetServices)) {
      targetServices.push(
        ...wfData.targetServices.filter(
          (id: any) => typeof id === "string" && id.trim(),
        ),
      );
    }
    if (
      typeof wfData.observationWindowDays === "number" &&
      [7, 30, 90].includes(wfData.observationWindowDays)
    ) {
      observationWindowDays = wfData.observationWindowDays;
    }
  }

  // 3. Fallback to comma/space token splitting on plain string inputPreview
  if (
    targetServices.length === 0 &&
    inputPreview &&
    !inputPreview.trim().startsWith("{")
  ) {
    const rawTokens = inputPreview
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const token of rawTokens) {
      if (
        token.match(/^[a-zA-Z0-9_-]+$/) &&
        ![
          "report",
          "quality",
          "api",
          "paid",
          "eval",
          "evaluate",
          "compare",
          "days",
          "7",
          "30",
          "90",
        ].includes(token.toLowerCase())
      ) {
        targetServices.push(token);
      }
    }
  }

  // 4. Fallback to selectedServices in plannerSnapshot
  if (targetServices.length === 0 && plannerSnapshot?.selectedServices) {
    for (const s of plannerSnapshot.selectedServices) {
      if (s.slug && s.slug !== "paid-api-quality-finalizer" && s.slug !== "api-quality-finalizer") {
        targetServices.push(s.slug);
      }
    }
  }

  // Deduplicate target service IDs
  targetServices = Array.from(new Set(targetServices));

  return {
    targetServices: targetServices.length > 0 ? targetServices : ["paid-api"],
    observationWindowDays,
  };
}

/**
 * Builds the canonical 15-section Paid API Quality report view model.
 */
export function buildApiQualityPublicReport(
  input: BuildApiQualityPublicReportInput,
): ApiQualityPublicReport {
  const windowDays = input.observationWindowDays ?? 30;
  const rawTargetServices = input.targetServices?.length
    ? input.targetServices
    : input.observations?.length
    ? Array.from(new Set(input.observations.map((o) => o.serviceId)))
    : ["paid-api"];

  const uniqueServices = Array.from(
    new Set(rawTargetServices.filter(Boolean)),
  );
  const mode: "single" | "comparison" =
    uniqueServices.length > 1 ? "comparison" : "single";

  // Build observations map by service ID
  const obsMap: Record<string, ApiQualityObservation[]> = {};
  if (input.observationsByService) {
    for (const id of uniqueServices) {
      obsMap[id] = (input.observationsByService[id] || []).filter(
        (observation) => observation.source !== "scheduled_probe",
      );
    }
  } else if (input.observations) {
    for (const id of uniqueServices) {
      obsMap[id] = input.observations.filter(
        (o) => o.serviceId === id && o.source !== "scheduled_probe",
      );
    }
    // If no observations matched exact service ID and only 1 service is targeted, assign all observations
    if (
      uniqueServices.length === 1 &&
      (obsMap[uniqueServices[0]] || []).length === 0
    ) {
      obsMap[uniqueServices[0]] = input.observations.filter(
        (observation) => observation.source !== "scheduled_probe",
      );
    }
  } else {
    for (const id of uniqueServices) {
      obsMap[id] = [];
    }
  }

  // Compute comparison matrix across all target services
  const comparisonResult = compareApiQuality(
    Object.entries(obsMap).map(([serviceId, observations]) => ({
      serviceId,
      serviceName: input.serviceNames?.[serviceId] || serviceId,
      observations,
    })),
    windowDays,
  );

  const primaryServiceId =
    comparisonResult.overallWinnerServiceId || uniqueServices[0] || "paid-api";
  const primaryObs = obsMap[primaryServiceId] || [];
  const primaryMetrics = computeApiQualityMetrics(primaryObs);
  const primaryScore = calculateQualityScore(primaryMetrics, primaryObs);
  const primaryServiceName =
    input.serviceNames?.[primaryServiceId] || primaryServiceId;

  const globalConfidence = primaryScore.confidenceLevel;

  // Section 1: Executive Summary
  let executiveSummary: string;
  if (mode === "comparison") {
    const totalObsAll = Object.values(obsMap).reduce(
      (sum, list) => sum + list.length,
      0,
    );
    const topPerformer = comparisonResult.services[0];
    const topScoreStr = topPerformer?.score.overallScore !== null && topPerformer?.score.overallScore !== undefined ? `${topPerformer.score.overallScore}/100` : "N/A";
    executiveSummary = `Comparative evaluation of ${uniqueServices.length} paid API service(s) (${uniqueServices.map((id) => input.serviceNames?.[id] || id).join(", ")}) over a ${windowDays}-day observation window. Top overall performer is '${topPerformer?.serviceName || primaryServiceName}' with a Quality Score of ${topScoreStr} (${topPerformer?.score.status ?? "Insufficient data"}). Total observations analyzed across all services: ${totalObsAll}.`;
  } else {
    const primaryScoreStr = primaryScore.overallScore !== null ? `${primaryScore.overallScore}/100` : "N/A";
    const primaryUptimeStr = primaryMetrics.uptimePercent !== null ? `${primaryMetrics.uptimePercent}%` : "N/A";
    const primaryExecStr = primaryMetrics.executionSuccessPercent !== null ? `${primaryMetrics.executionSuccessPercent}%` : "N/A";
    const primaryCostStr = primaryMetrics.costPerSuccessfulResultUsdc !== null ? `${primaryMetrics.costPerSuccessfulResultUsdc} USDC` : "N/A";
    executiveSummary = `Paid API Quality evaluation for '${primaryServiceName}' across ${primaryMetrics.totalObservations} observation(s) over a ${windowDays}-day window. Quality Score: ${primaryScoreStr} (${primaryScore.status}). Overall uptime: ${primaryUptimeStr}, P50 latency: ${primaryMetrics.latencyP50Ms}ms, end-to-end execution success: ${primaryExecStr}, and cost per successful result: ${primaryCostStr}.`;
  }

  // Section 2: Services Overview & Comparison
  const servicesCompared: ApiQualityReportServiceSummary[] =
    comparisonResult.services.map((item) => ({
      serviceId: item.serviceId,
      serviceName:
        input.serviceNames?.[item.serviceId] || item.serviceName || item.serviceId,
      sellerPublicId: item.sellerPublicId ?? null,
      observationCount: {
        value: item.metrics.totalObservations,
        confidence: item.score.confidenceLevel,
      },
      rank: item.rank,
      qualityScore: item.score.overallScore,
      status: item.score.status,
    }));

  // Section 3: Price and Cost Efficiency
  const priceAndCostEfficiency = {
    quotedPriceMinUsdc: {
      value: primaryMetrics.quotedPriceMinUsdc,
      confidence: globalConfidence,
    },
    quotedPriceMedianUsdc: {
      value: primaryMetrics.quotedPriceMedianUsdc,
      confidence: globalConfidence,
    },
    quotedPriceMaxUsdc: {
      value: primaryMetrics.quotedPriceMaxUsdc,
      confidence: globalConfidence,
    },
    costPerSuccessfulResultUsdc: {
      value: primaryMetrics.costPerSuccessfulResultUsdc,
      confidence: globalConfidence,
    },
    summary:
      primaryMetrics.totalObservations > 0
        ? `Quoted pricing ranges from ${primaryMetrics.quotedPriceMinUsdc} to ${primaryMetrics.quotedPriceMaxUsdc} USDC (median: ${primaryMetrics.quotedPriceMedianUsdc} USDC). Effective cost per verified successful execution: ${primaryMetrics.costPerSuccessfulResultUsdc !== null ? `${primaryMetrics.costPerSuccessfulResultUsdc} USDC` : "N/A"}.`
        : "No pricing observations recorded within the selected window.",
  };

  // Section 4: Availability
  const availability = {
    uptimePercent: {
      value: primaryMetrics.uptimePercent,
      confidence: globalConfidence,
    },
    totalObservations: {
      value: primaryMetrics.totalObservations,
      confidence: globalConfidence,
    },
    summary:
      primaryMetrics.totalObservations > 0 && primaryMetrics.uptimePercent !== null
        ? `Endpoint reached ${primaryMetrics.uptimePercent}% uptime across ${primaryMetrics.totalObservations} total observation(s).`
        : "Insufficient data to compute uptime percentage.",
  };

  // Section 5: Latency Distribution
  const latencyDistribution = {
    latencyP50Ms: {
      value: primaryMetrics.latencyP50Ms,
      confidence: globalConfidence,
    },
    latencyP95Ms: {
      value: primaryMetrics.latencyP95Ms,
      confidence: globalConfidence,
    },
    latencyMaxMs: {
      value: primaryMetrics.latencyMaxMs,
      confidence: globalConfidence,
    },
    summary:
      primaryMetrics.totalObservations > 0
        ? `Response latency distribution — P50 (median): ${primaryMetrics.latencyP50Ms}ms, P95 (tail): ${primaryMetrics.latencyP95Ms}ms, Max: ${primaryMetrics.latencyMaxMs}ms.`
        : "No latency metrics recorded.",
  };

  // Section 6: Response Quality
  const schemaValidCount = primaryObs.filter(
    (o) => o.responseSchemaValid,
  ).length;
  const withinSizeCount = primaryObs.filter(
    (o) => o.responseWithinSizeLimit,
  ).length;
  const responseQuality = {
    validResponsePercent: {
      value: primaryMetrics.validResponsePercent,
      confidence: globalConfidence,
    },
    schemaValidationPercent: {
      value:
        primaryObs.length > 0
          ? Math.round((schemaValidCount / primaryObs.length) * 10000) / 100
          : 0,
      confidence: globalConfidence,
    },
    withinSizeLimitPercent: {
      value:
        primaryObs.length > 0
          ? Math.round((withinSizeCount / primaryObs.length) * 10000) / 100
          : 0,
      confidence: globalConfidence,
    },
    summary:
      primaryMetrics.totalObservations > 0 && primaryMetrics.validResponsePercent !== null
        ? `${primaryMetrics.validResponsePercent}% of returned payloads met schema structural and size constraints.`
        : "No response validation records available.",
  };

  // Section 7: Payment and Settlement Reliability
  const paymentAndSettlementReliability = {
    paymentSuccessPercent: {
      value: primaryMetrics.paymentSuccessPercent,
      confidence: globalConfidence,
    },
    settlementSuccessPercent: {
      value: primaryMetrics.settlementSuccessPercent,
      confidence: globalConfidence,
    },
    summary:
      primaryMetrics.totalObservations > 0
        ? `Payment authorization success rate: ${primaryMetrics.paymentSuccessPercent !== null ? `${primaryMetrics.paymentSuccessPercent}%` : "N/A (no payment required)"}. On-chain settlement success rate: ${primaryMetrics.settlementSuccessPercent !== null ? `${primaryMetrics.settlementSuccessPercent}%` : "N/A"}.`
        : "No payment or settlement events recorded.",
  };

  // Section 8: Observed Failures
  const failureCategories: ErrorCategory[] = [
    "timeout",
    "network",
    "invalid_response",
    "payment_failed",
    "settlement_failed",
    "execution_failed",
    "verification_failed",
  ];
  const allObsCombined = Object.values(obsMap).flat();
  const totalFailObsCount = allObsCombined.length;
  const observedFailures: ApiQualityReportObservedFailureItem[] =
    failureCategories
      .map((cat) => {
        const count = allObsCombined.filter(
          (o) => o.errorCategory === cat,
        ).length;
        const percentage =
          totalFailObsCount > 0
            ? Math.round((count / totalFailObsCount) * 10000) / 100
            : 0;
        return {
          category: cat,
          count,
          percentage,
          description: failureCategoryDescription(cat, count),
        };
      })
      .filter((item) => item.count > 0);

  // Section 9: Quality Score and Confidence
  const qualityScoreAndConfidence = {
    overallScore: primaryScore.overallScore,
    status: primaryScore.status,
    confidenceLevel: primaryScore.confidenceLevel,
    hasSufficientData: primaryScore.hasSufficientData,
    breakdown: {
      availabilityScore: primaryScore.availabilityScore,
      executionReliabilityScore: primaryScore.executionReliabilityScore,
      responseValidityScore: primaryScore.responseValidityScore,
      paymentSuccessScore: primaryScore.paymentSuccessScore,
      settlementSuccessScore: primaryScore.settlementSuccessScore,
      latencyConsistencyScore: primaryScore.latencyConsistencyScore,
    },
    summary: primaryScore.hasSufficientData && primaryScore.overallScore !== null
      ? `Overall Quality Score: ${primaryScore.overallScore}/100 (${primaryScore.status}). Scored across 6 weighted categories with ${primaryScore.confidenceLevel} confidence.`
      : `Overall Quality Score: Insufficient data (${primaryScore.status}). Sample size is under the 10-observation threshold required for high confidence.`,
  };

  // Section 10: Evidence-Backed Strengths
  const strengths: string[] = [];
  if (primaryMetrics.uptimePercent !== null && primaryMetrics.uptimePercent >= 99 && primaryMetrics.totalObservations > 0) {
    strengths.push(
      `High availability: Endpoint maintained ${primaryMetrics.uptimePercent}% uptime across ${primaryMetrics.totalObservations} observation(s).`,
    );
  }
  if (
    primaryMetrics.executionSuccessPercent !== null &&
    primaryMetrics.executionSuccessPercent >= 95 &&
    primaryMetrics.totalObservations > 0
  ) {
    strengths.push(
      `Reliable end-to-end execution: ${primaryMetrics.executionSuccessPercent}% execution completion rate.`,
    );
  }
  if (
    primaryMetrics.validResponsePercent === 100 &&
    primaryMetrics.totalObservations > 0
  ) {
    strengths.push(
      `Perfect response schema compliance: 100% of payloads met structural and size constraints.`,
    );
  }
  if (
    primaryMetrics.paymentSuccessPercent === 100 &&
    primaryMetrics.totalObservations > 0
  ) {
    strengths.push(
      `Flawless payment authorization: 100% of quoted USDC payments were authorized.`,
    );
  }
  if (
    primaryMetrics.settlementSuccessPercent === 100 &&
    primaryMetrics.totalObservations > 0
  ) {
    strengths.push(
      `Deterministic Arc settlement: 100% of authorized payments settled on-chain.`,
    );
  }
  if (primaryMetrics.latencyP50Ms > 0 && primaryMetrics.latencyP50Ms <= 300) {
    strengths.push(
      `Fast median response time: P50 latency of ${primaryMetrics.latencyP50Ms}ms.`,
    );
  }
  if (strengths.length === 0 && primaryMetrics.totalObservations > 0) {
    strengths.push(
      `Active observation history recorded on ${BRAND.name} platform.`,
    );
  } else if (strengths.length === 0) {
    strengths.push("Initial service registration recorded; telemetry gathering in progress.");
  }

  // Section 11: Risks and Review Items
  const risksAndReviewItems: ApiQualityReportRiskItem[] = [];
  if (primaryMetrics.totalObservations < 10) {
    risksAndReviewItems.push({
      code: "limited_sample_size",
      title: "Limited Observation History",
      severity: "medium",
      description: `Only ${primaryMetrics.totalObservations} observation(s) recorded within the ${windowDays}-day window. A minimum of 10 observations is required for high-confidence scoring.`,
      impact: "Quality metrics may be sensitive to single-event outliers.",
    });
  }
  if (
    primaryMetrics.uptimePercent !== null &&
    primaryMetrics.uptimePercent < 95 &&
    primaryMetrics.totalObservations > 0
  ) {
    risksAndReviewItems.push({
      code: "degraded_availability",
      title: "Sub-Optimal Service Availability",
      severity: primaryMetrics.uptimePercent < 80 ? "critical" : "high",
      description: `Observed uptime is ${primaryMetrics.uptimePercent}%, which is below the 95% recommended threshold.`,
      impact: "Integration workflows may encounter connection or 5xx endpoint errors.",
    });
  }
  if (
    primaryMetrics.latencyP95Ms > 2000 &&
    primaryMetrics.totalObservations > 0
  ) {
    risksAndReviewItems.push({
      code: "high_tail_latency",
      title: "Elevated P95 Tail Latency",
      severity: primaryMetrics.latencyP95Ms > 5000 ? "high" : "medium",
      description: `95th percentile latency is ${primaryMetrics.latencyP95Ms}ms compared to median P50 of ${primaryMetrics.latencyP50Ms}ms.`,
      impact: "Time-sensitive buyer agent invocations may experience completion delays.",
    });
  }
  if (
    primaryMetrics.validResponsePercent !== null &&
    primaryMetrics.validResponsePercent < 95 &&
    primaryMetrics.totalObservations > 0
  ) {
    risksAndReviewItems.push({
      code: "invalid_response_schema",
      title: "Schema Validation Failures",
      severity: "high",
      description: `${Math.round((100 - primaryMetrics.validResponsePercent) * 100) / 100}% of payloads failed schema or size validation.`,
      impact: "Downstream buyer agents may fail to parse response objects.",
    });
  }
  if (
    primaryMetrics.paymentSuccessPercent !== null &&
    primaryMetrics.paymentSuccessPercent < 95 &&
    primaryMetrics.totalObservations > 0
  ) {
    risksAndReviewItems.push({
      code: "payment_authorization_failure",
      title: "Payment Authorization Failures",
      severity: "high",
      description: `Payment authorization success rate is ${primaryMetrics.paymentSuccessPercent}%.`,
      impact: "Workflow execution may halt during x402 payment authorization.",
    });
  }
  if (
    primaryMetrics.settlementSuccessPercent !== null &&
    primaryMetrics.settlementSuccessPercent < 95 &&
    primaryMetrics.totalObservations > 0
  ) {
    risksAndReviewItems.push({
      code: "arc_settlement_failure",
      title: "Arc On-Chain Settlement Failures",
      severity: "high",
      description: `On-chain settlement success rate is ${primaryMetrics.settlementSuccessPercent}%.`,
      impact: "Receipts and Arc proof trails may fail verification.",
    });
  }

  // Section 12: Questions Before Integration
  const questionsBeforeIntegration: string[] = [
    "What SLA or redundancy guarantees are provided for peak traffic window latency spikes?",
    "How does the provider endpoint handle rate-limiting headers and retry-after guidance?",
    "Are x402 micro-payment authorization tokens cached or re-generated per request?",
  ];
  if (primaryMetrics.latencyP95Ms > 1000) {
    questionsBeforeIntegration.push(
      `Can payload compression or response filtering be requested to reduce tail latency of ${primaryMetrics.latencyP95Ms}ms?`,
    );
  }
  if (primaryMetrics.validResponsePercent !== null && primaryMetrics.validResponsePercent < 100) {
    questionsBeforeIntegration.push(
      "What breaking API schema changes occurred during the observation window?",
    );
  }

  // Section 13: Evidence and Observation Window
  const realCount = primaryObs.filter(
    (o) => o.source === "real_paid_execution",
  ).length;
  const probeCount = primaryObs.filter(
    (o) => o.source === "scheduled_probe",
  ).length;
  const historicalCount = primaryObs.filter(
    (o) => o.source === "historical_execution",
  ).length;

  const evidenceAndObservationWindow = {
    windowDays,
    firstObservedAt: primaryMetrics.firstObservedAt,
    lastObservedAt: primaryMetrics.lastObservedAt,
    totalObservationsCount: {
      value: primaryMetrics.totalObservations,
      confidence: globalConfidence,
    },
    realPaidExecutionCount: {
      value: realCount,
      confidence: globalConfidence,
    },
    scheduledProbeCount: {
      value: probeCount,
      confidence: globalConfidence,
    },
    historicalExecutionCount: {
      value: historicalCount,
      confidence: globalConfidence,
    },
    summary: `Observation window: ${windowDays} day(s) (${primaryMetrics.firstObservedAt || "N/A"} to ${primaryMetrics.lastObservedAt || "N/A"}). Telemetry breakdown: ${realCount} real paid execution(s), ${probeCount} scheduled probe(s), ${historicalCount} historical execution(s).`,
  };

  // Section 14: Limitations
  const limitations = {
    disclaimer: `This Paid API Quality Report is generated automatically by ${BRAND.name} based on empirical observation telemetry recorded on Arc testnet. Metrics reflect recorded samples within the specified observation window and do not constitute a contractual SLA or legal guarantee.`,
    analyzedAt: input.generatedAt || new Date().toISOString(),
  };

  // Section 15: Payment & Arc Verification Details
  const proofs = input.proofs || [];
  const receipts = input.receipts || [];
  const verifiedProofs = proofs.filter(
    (p) => p.status === "verified" && Boolean(p.txHash),
  );
  const hasFailedProof = proofs.some((p) => p.status === "failed");
  const requiredSteps =
    receipts.length > 0 ? receipts.length : Math.max(proofs.length, 1);
  const verifiedSteps = verifiedProofs.length;

  let verificationStatus: string;
  if (hasFailedProof || (input.status === "failed" && verifiedSteps === 0)) {
    verificationStatus = "verification_failed";
  } else if (verifiedSteps > 0 && verifiedSteps >= requiredSteps) {
    verificationStatus = "verified";
  } else if (verifiedSteps > 0 && verifiedSteps < requiredSteps) {
    verificationStatus = "partially_verified";
  } else {
    verificationStatus = "verification_pending";
  }

  const verification = {
    status: verificationStatus,
    network: "arc-testnet",
    proofs,
    receipts,
    verifiedSteps,
    requiredSteps,
  };

  return {
    reportId: input.jobId,
    workflow: input.workflow || "paid_api_quality",
    workflowType: input.workflow || "paid_api_quality",
    status: input.status || "completed",
    mode,
    targetServices: uniqueServices,
    overallStatus: primaryScore.status,
    overallScore: primaryScore.overallScore,
    confidence: globalConfidence,
    executiveSummary,
    generatedAt: input.generatedAt || new Date().toISOString(),
    observationWindowDays: windowDays,

    servicesCompared,
    priceAndCostEfficiency,
    availability,
    latencyDistribution,
    responseQuality,
    paymentAndSettlementReliability,
    observedFailures,
    qualityScoreAndConfidence,
    strengths,
    risksAndReviewItems,
    questionsBeforeIntegration,
    evidenceAndObservationWindow,
    limitations,
    verification,
    comparison: mode === "comparison" ? comparisonResult : comparisonResult,
  };
}

/**
 * Formats an ApiQualityPublicReport view model as structured markdown.
 */
export function formatApiQualityPublicReportAsMarkdown(
  report: ApiQualityPublicReport,
): string {
  const serviceHeader = report.targetServices.join(", ");

  const servicesTableHead = `| Rank | Service ID | Quality Score | Status | Obs Count | P50 Latency | Uptime | Cost/Result |
| --- | --- | --- | --- | --- | --- | --- | --- |`;
  const servicesTableRows = report.servicesCompared
    .map((s) => {
      const match = report.comparison?.services.find(
        (item) => item.serviceId === s.serviceId,
      );
      const p50 = match ? `${match.metrics.latencyP50Ms}ms` : "N/A";
      const uptime = match && match.metrics.uptimePercent !== null ? `${match.metrics.uptimePercent}%` : "N/A";
      const cost = match && match.metrics.costPerSuccessfulResultUsdc !== null ? `${match.metrics.costPerSuccessfulResultUsdc} USDC` : "N/A";
      const scoreStr = s.qualityScore !== null && s.qualityScore !== undefined ? `${s.qualityScore}/100` : "N/A";
      return `| ${s.rank ?? 1} | \`${s.serviceId}\` | **${scoreStr}** | \`${s.status ?? "N/A"}\` | ${s.observationCount.value} | ${p50} | ${uptime} | ${cost} |`;
    })
    .join("\n");

  const strengthsList =
    report.strengths.length > 0
      ? report.strengths.map((s) => `- ${s}`).join("\n")
      : "- None noted.";

  const risksList =
    report.risksAndReviewItems.length > 0
      ? report.risksAndReviewItems
          .map(
            (r) =>
              `- **[${String(r.severity).toUpperCase()}]** ${r.title} (\`${r.code}\`)\n  ${r.description}\n  *Impact:* ${r.impact}`,
          )
          .join("\n")
      : "- No significant risk factors identified.";

  const questionsList =
    report.questionsBeforeIntegration.length > 0
      ? report.questionsBeforeIntegration.map((q) => `- ${q}`).join("\n")
      : "- Standard API integration review recommended.";

  const failuresList =
    report.observedFailures.length > 0
      ? report.observedFailures
          .map((f) => `- **${f.category}**: ${f.count} event(s) (${f.percentage}%)\n  ${f.description}`)
          .join("\n")
      : "- No failure events recorded in observation history.";

  const proofsList =
    report.verification.proofs.length > 0
      ? report.verification.proofs
          .map(
            (p) =>
              `- ${p.txHash ? `\`${p.txHash}\`` : p.receiptId ? `Receipt \`${p.receiptId}\`` : "Proof record"} (${p.status})${p.explorerUrl ? ` — [View Arc Proof](${p.explorerUrl})` : ""}`,
          )
          .join("\n")
      : "- No on-chain proof metadata recorded.";

  return `# Paid API Quality Report: ${serviceHeader}

**Report ID:** \`${report.reportId}\`  
**Workflow:** \`${report.workflow}\`  
**Mode:** \`${report.mode}\`  
**Status:** \`${report.status}\`  
**Quality Status:** **${report.overallStatus}** (Score: \`${report.overallScore !== null ? `${report.overallScore}/100` : "N/A"}\`, \`${report.confidence}\` confidence)  
**Observation Window:** \`${report.observationWindowDays} days\`  
**Generated At:** ${report.generatedAt}  
**Generated by:** ${BRAND.name}  

---

## Executive Summary
${report.executiveSummary}

## Quality Score & Breakdown
- **Overall Score:** \`${report.qualityScoreAndConfidence.overallScore !== null ? `${report.qualityScoreAndConfidence.overallScore}/100` : "N/A"}\` (${report.qualityScoreAndConfidence.status})
- **Confidence Level:** \`${report.qualityScoreAndConfidence.confidenceLevel}\`
- **Availability Score:** \`${report.qualityScoreAndConfidence.breakdown.availabilityScore !== null ? `${report.qualityScoreAndConfidence.breakdown.availabilityScore}/25` : "N/A"}\`
- **Execution Reliability Score:** \`${report.qualityScoreAndConfidence.breakdown.executionReliabilityScore !== null ? `${report.qualityScoreAndConfidence.breakdown.executionReliabilityScore}/20` : "N/A"}\`
- **Response Validity Score:** \`${report.qualityScoreAndConfidence.breakdown.responseValidityScore !== null ? `${report.qualityScoreAndConfidence.breakdown.responseValidityScore}/15` : "N/A"}\`
- **Payment Success Score:** \`${report.qualityScoreAndConfidence.breakdown.paymentSuccessScore !== null ? `${report.qualityScoreAndConfidence.breakdown.paymentSuccessScore}/15` : "N/A"}\`
- **Settlement Success Score:** \`${report.qualityScoreAndConfidence.breakdown.settlementSuccessScore !== null ? `${report.qualityScoreAndConfidence.breakdown.settlementSuccessScore}/15` : "N/A"}\`
- **Latency Consistency Score:** \`${report.qualityScoreAndConfidence.breakdown.latencyConsistencyScore !== null ? `${report.qualityScoreAndConfidence.breakdown.latencyConsistencyScore}/10` : "N/A"}\`

## Services Overview & Comparison
${servicesTableHead}
${servicesTableRows}

## Price & Cost Efficiency
- **Min Quoted Price:** \`${report.priceAndCostEfficiency.quotedPriceMinUsdc.value} USDC\`
- **Median Quoted Price:** \`${report.priceAndCostEfficiency.quotedPriceMedianUsdc.value} USDC\`
- **Max Quoted Price:** \`${report.priceAndCostEfficiency.quotedPriceMaxUsdc.value} USDC\`
- **Cost per Successful Result:** \`${report.priceAndCostEfficiency.costPerSuccessfulResultUsdc.value !== null ? `${report.priceAndCostEfficiency.costPerSuccessfulResultUsdc.value} USDC` : "N/A"}\`

${report.priceAndCostEfficiency.summary}

## Availability & Uptime
- **Observed Uptime:** \`${report.availability.uptimePercent.value !== null ? `${report.availability.uptimePercent.value}%` : "N/A"}\`
- **Total Observations:** \`${report.availability.totalObservations.value}\`

${report.availability.summary}

## Latency Distribution
- **P50 Latency (Median):** \`${report.latencyDistribution.latencyP50Ms.value}ms\`
- **P95 Latency (Tail):** \`${report.latencyDistribution.latencyP95Ms.value}ms\`
- **Max Latency:** \`${report.latencyDistribution.latencyMaxMs.value}ms\`

${report.latencyDistribution.summary}

## Response Quality & Schema Validation
- **Valid Response Rate:** \`${report.responseQuality.validResponsePercent.value !== null ? `${report.responseQuality.validResponsePercent.value}%` : "N/A"}\`
- **Schema Compliance:** \`${report.responseQuality.schemaValidationPercent.value}%\`
- **Within Size Limit:** \`${report.responseQuality.withinSizeLimitPercent.value}%\`

${report.responseQuality.summary}

## Payment & Settlement Reliability
- **Payment Authorization Success:** \`${report.paymentAndSettlementReliability.paymentSuccessPercent.value !== null ? `${report.paymentAndSettlementReliability.paymentSuccessPercent.value}%` : "N/A"}\`
- **Arc Settlement Success:** \`${report.paymentAndSettlementReliability.settlementSuccessPercent.value !== null ? `${report.paymentAndSettlementReliability.settlementSuccessPercent.value}%` : "N/A"}\`

${report.paymentAndSettlementReliability.summary}

## Observed Failures
${failuresList}

## Evidence-Backed Strengths
${strengthsList}

## Identified Risks & Review Items
${risksList}

## Questions Before Integration
${questionsList}

## Evidence & Observation Window
${report.evidenceAndObservationWindow.summary}

## Limitations & Disclaimer
${report.limitations.disclaimer}

---

## Payment & Arc Verification Details
- **Verification Status:** \`${report.verification.status}\`
- **Network:** \`${report.verification.network}\`

${proofsList}
`;
}
