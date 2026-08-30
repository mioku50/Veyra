/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

export type HttpStatusClass =
  | "2xx"
  | "4xx"
  | "5xx"
  | "timeout"
  | "network_error";

export type ErrorCategory =
  | "none"
  | "timeout"
  | "network"
  | "invalid_response"
  | "payment_failed"
  | "settlement_failed"
  | "execution_failed"
  | "verification_failed";

export type ObservationSource =
  | "real_paid_execution"
  | "scheduled_probe"
  | "historical_execution"
  // Free x402 challenge probe against an externally discovered endpoint. It is
  // a real network observation (unlike the retired synthetic `scheduled_probe`),
  // but it never involves a payment, so it must never be persisted into the
  // seller quality store - `recordApiQualityObservation` rejects it.
  | "x402_discovery_probe";

export type ConfidenceLevel = "high" | "medium" | "low";

export type QualityStatus =
  | "Excellent"
  | "Reliable"
  | "Mixed signals"
  | "High attention"
  | "Insufficient data";

export interface ApiQualityObservation {
  observationId: string;
  serviceId: string;
  sellerPublicId?: string | null;
  startedAt: string;
  completedAt: string | null;
  quotedPriceUsdc: number | null;
  paidAmountUsdc: number | null;
  latencyMs: number | null;
  httpStatusClass: HttpStatusClass;
  endpointReached: boolean;
  responseSchemaValid: boolean | null;
  responseWithinSizeLimit: boolean | null;
  paymentRequired: boolean;
  paymentAuthorized: boolean | null;
  paymentSettled: boolean | null;
  executionCompleted: boolean;
  arcProofVerified: boolean;
  errorCategory: ErrorCategory;
  source: ObservationSource;
  createdAt: string;
}

export type ApiQualityObservationRow = {
  observation_id: string;
  service_id: string;
  seller_public_id: string | null;
  started_at: string;
  completed_at: string | null;
  quoted_price_usdc: string | number | null;
  paid_amount_usdc: string | number | null;
  latency_ms: number | null;
  http_status_class: HttpStatusClass;
  endpoint_reached: boolean;
  response_schema_valid: boolean | null;
  response_within_size_limit: boolean | null;
  payment_required: boolean;
  payment_authorized: boolean | null;
  payment_settled: boolean | null;
  execution_completed: boolean;
  arc_proof_verified: boolean;
  error_category: ErrorCategory;
  source: ObservationSource;
  created_at: string;
};

export type ApiQualityObservationInput = Omit<
  ApiQualityObservation,
  "observationId" | "createdAt"
> & {
  observationId?: string;
  createdAt?: string;
};

export interface ApiQualityMetrics {
  totalObservations: number;
  uptimePercent: number | null;
  executionSuccessPercent: number | null;
  paymentSuccessPercent: number | null;
  settlementSuccessPercent: number | null;
  validResponsePercent: number | null;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
  quotedPriceMinUsdc: number;
  quotedPriceMedianUsdc: number;
  quotedPriceMaxUsdc: number;
  costPerSuccessfulResultUsdc: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

export interface ApiQualityScore {
  overallScore: number | null;
  qualityScore?: number | null;
  availabilityScore: number | null;
  executionReliabilityScore: number | null;
  responseValidityScore: number | null;
  paymentSuccessScore: number | null;
  settlementSuccessScore: number | null;
  latencyConsistencyScore: number | null;
  status: QualityStatus;
  qualityStatus?: QualityStatus;
  confidenceLevel: ConfidenceLevel;
  hasSufficientData: boolean;
}

export interface ServiceQualityInput {
  serviceId: string;
  serviceName?: string;
  sellerPublicId?: string | null;
  observations: ApiQualityObservation[];
}

export interface ApiQualityComparisonItem {
  serviceId: string;
  serviceName?: string;
  sellerPublicId?: string | null;
  metrics: ApiQualityMetrics;
  score: ApiQualityScore;
  rank: number;
}

export interface ApiQualityComparisonCategoryHighlight {
  category: "uptime" | "latency" | "execution" | "cost" | "overall";
  title: string;
  winnerServiceId: string;
  winnerServiceName?: string;
  value: string;
  description: string;
}

export interface ApiQualityComparisonResult {
  services: ApiQualityComparisonItem[];
  highlights: ApiQualityComparisonCategoryHighlight[];
  overallWinnerServiceId: string | null;
  observationWindowDays?: number;
}

export type ProbeType = "availability" | "paid_execution";

export type ProbeRunStatus =
  | "success"
  | "degraded"
  | "failed"
  | "budget_exceeded"
  | "cooldown_skipped"
  | "inactive_skipped";

export type ApiQualityAlertType =
  | "quality_degradation"
  | "uptime_drop"
  | "latency_spike"
  | "score_drop"
  | "execution_failure_spike";

export type ApiQualityAlertSeverity = "critical" | "warning" | "info";

export interface ApiQualityProbeConfig {
  serviceId: string;
  probeType?: ProbeType;
  maxPriceUsdc?: number;
  cooldownSeconds?: number;
  maxDailyProbeBudgetUsdc?: number;
  timeoutMs?: number;
}

export interface ApiQualityDelta {
  serviceId: string;
  previousScore: number | null;
  newScore: number | null;
  scoreDelta: number | null;
  previousUptimePercent: number | null;
  newUptimePercent: number | null;
  uptimeDelta: number | null;
  previousLatencyP95Ms: number;
  newLatencyP95Ms: number;
  latencyDeltaMs: number;
}

export interface ApiQualityAlert {
  alertId: string;
  serviceId: string;
  alertType: ApiQualityAlertType;
  severity: ApiQualityAlertSeverity;
  message: string;
  details: {
    previousValue?: number;
    newValue?: number;
    delta?: number;
    threshold?: number;
    [key: string]: unknown;
  };
  createdAt: string;
}

export interface ApiQualityProbeResult {
  probeId: string;
  serviceId: string;
  probeType: ProbeType;
  status: ProbeRunStatus;
  observation?: ApiQualityObservation;
  skippedReason?: string;
  metricsDelta?: ApiQualityDelta;
  alertsTriggered: ApiQualityAlert[];
  executedAt: string;
}

export interface ProbeEngineOptions {
  serviceIds?: string[];
  probeType?: ProbeType | "auto";
  maxDailyProbeBudgetUsdc?: number;
  cooldownSeconds?: number;
  emitAlerts?: boolean;
}

export interface ProbeRunSummary {
  totalProbes: number;
  executed: number;
  skipped: number;
  totalCostUsdc: number;
  results: ApiQualityProbeResult[];
  alerts: ApiQualityAlert[];
  executedAt: string;
}


