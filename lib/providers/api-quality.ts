/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient } from "@supabase/supabase-js";
import { tryGetServerSupabaseConfig } from "../supabase/server-env.ts";
import type {
  ApiQualityAlert,
  ApiQualityAlertSeverity,
  ApiQualityAlertType,
  ApiQualityComparisonCategoryHighlight,
  ApiQualityComparisonItem,
  ApiQualityComparisonResult,
  ApiQualityDelta,
  ApiQualityMetrics,
  ApiQualityObservation,
  ApiQualityObservationInput,
  ApiQualityObservationRow,
  ApiQualityProbeConfig,
  ApiQualityProbeResult,
  ApiQualityScore,
  ConfidenceLevel,
  ProbeEngineOptions,
  ProbeRunStatus,
  ProbeRunSummary,
  ProbeType,
  QualityStatus,
  ServiceQualityInput,
} from "./api-quality-types.ts";

import { getServiceById, getServiceBySlug } from "../services/registry.ts";
import {
  getDynamicStoreServiceRowById,
  getDynamicStoreServiceRowBySlug,
} from "../services/store-service-persistence.ts";

const inMemoryObservations: ApiQualityObservation[] = [];
const inMemoryAlerts: ApiQualityAlert[] = [];

export class ApiQualityStoreUnavailableError extends Error {
  readonly status = 503;
  readonly code = "api_quality_observation_store_unavailable";
  readonly unavailable = true;

  constructor(message = "api_quality_observation_store_unavailable") {
    super(message);
    this.name = "ApiQualityStoreUnavailableError";
  }
}

export class ApiQualityServiceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "api_quality_service_not_found";

  constructor(
    message = "The requested service could not be found or evaluated.",
  ) {
    super(message);
    this.name = "ApiQualityServiceNotFoundError";
  }
}

export const API_QUALITY_SERVICE_NOT_FOUND_RESPONSE = {
  error: {
    code: "api_quality_service_not_found",
    message: "The requested service could not be found or evaluated.",
  },
} as const;

/**
 * Validates that a requested service exists, is public, live, and NOT private, draft, disabled, or internalOnly.
 * If service is missing, private, draft, disabled, or internalOnly, returns null (or throws ApiQualityServiceNotFoundError).
 */
export async function validatePublicServiceForQualityEvaluation(
  serviceId: string,
  options: { throwOnError?: boolean } = {},
): Promise<{ id: string; name: string; slug: string; status: string } | null> {
  if (!serviceId || typeof serviceId !== "string" || !serviceId.trim()) {
    if (options.throwOnError) {
      throw new ApiQualityServiceNotFoundError();
    }
    return null;
  }

  const idToLookup = serviceId.trim();

  // 1. Check static service registry
  const staticService =
    getServiceById(idToLookup) || getServiceBySlug(idToLookup);

  if (staticService) {
    const isLive = staticService.status === "live";
    const isInternal = Boolean(staticService.internalOnly);
    const isPrivate = Boolean(
      (staticService as any).isPrivate || (staticService as any).private,
    );

    if (isLive && !isInternal && !isPrivate) {
      return {
        id: staticService.id,
        name: staticService.name,
        slug: staticService.slug,
        status: staticService.status,
      };
    }
  } else {
    // 2. Check dynamic store services
    try {
      const dynamicRow =
        (await getDynamicStoreServiceRowById(idToLookup)) ||
        (await getDynamicStoreServiceRowBySlug(idToLookup));

      if (dynamicRow) {
        const isLive = dynamicRow.status === "live";
        const isInternal = Boolean(
          (dynamicRow as any).internalOnly || dynamicRow.raw?.internalOnly,
        );
        const isPrivate = Boolean(
          (dynamicRow as any).isPrivate ||
            (dynamicRow as any).private ||
            dynamicRow.raw?.isPrivate ||
            dynamicRow.raw?.private,
        );

        if (isLive && !isInternal && !isPrivate) {
          return {
            id: dynamicRow.id,
            name: dynamicRow.name,
            slug: dynamicRow.slug,
            status: dynamicRow.status,
          };
        }
      }
    } catch {
      // Ignore DB errors during validation lookup
    }
  }

  if (options.throwOnError) {
    throw new ApiQualityServiceNotFoundError();
  }

  return null;
}

/**
 * Returns true if in-memory store fallback is allowed (test environment or explicit env override).
 */
export function isMemoryFallbackAllowed(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.API_QUALITY_ALLOW_MEMORY_STORE === "true"
  );
}

/**
 * Converts a database row to the canonical ApiQualityObservation object.
 */
export function rowToObservation(
  row: ApiQualityObservationRow,
): ApiQualityObservation {
  return {
    observationId: row.observation_id,
    serviceId: row.service_id,
    sellerPublicId: row.seller_public_id ?? null,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    quotedPriceUsdc:
      row.quoted_price_usdc !== null && row.quoted_price_usdc !== undefined
        ? typeof row.quoted_price_usdc === "number"
          ? row.quoted_price_usdc
          : parseFloat(String(row.quoted_price_usdc))
        : null,
    paidAmountUsdc:
      row.paid_amount_usdc !== null && row.paid_amount_usdc !== undefined
        ? typeof row.paid_amount_usdc === "number"
          ? row.paid_amount_usdc
          : parseFloat(String(row.paid_amount_usdc))
        : null,
    latencyMs:
      row.latency_ms !== null && row.latency_ms !== undefined
        ? typeof row.latency_ms === "number"
          ? row.latency_ms
          : parseInt(String(row.latency_ms), 10)
        : null,
    httpStatusClass: row.http_status_class,
    endpointReached: Boolean(row.endpoint_reached),
    responseSchemaValid:
      row.response_schema_valid !== null && row.response_schema_valid !== undefined
        ? Boolean(row.response_schema_valid)
        : null,
    responseWithinSizeLimit:
      row.response_within_size_limit !== null && row.response_within_size_limit !== undefined
        ? Boolean(row.response_within_size_limit)
        : null,
    paymentRequired: Boolean(row.payment_required),
    paymentAuthorized:
      row.payment_authorized !== null && row.payment_authorized !== undefined
        ? Boolean(row.payment_authorized)
        : null,
    paymentSettled:
      row.payment_settled !== null && row.payment_settled !== undefined
        ? Boolean(row.payment_settled)
        : null,
    executionCompleted: Boolean(row.execution_completed),
    arcProofVerified: Boolean(row.arc_proof_verified),
    errorCategory: row.error_category,
    source: row.source,
    createdAt: row.created_at,
  };
}

/**
 * Converts an observation input or object to a database row insert object.
 */
export function observationToRowInput(
  obs: ApiQualityObservation,
): ApiQualityObservationRow {
  return {
    observation_id: obs.observationId,
    service_id: obs.serviceId,
    seller_public_id: obs.sellerPublicId ?? null,
    started_at: obs.startedAt,
    completed_at: obs.completedAt ?? null,
    quoted_price_usdc: obs.quotedPriceUsdc ?? null,
    paid_amount_usdc: obs.paidAmountUsdc ?? null,
    latency_ms: obs.latencyMs ?? null,
    http_status_class: obs.httpStatusClass,
    endpoint_reached: obs.endpointReached,
    response_schema_valid: obs.responseSchemaValid ?? null,
    response_within_size_limit: obs.responseWithinSizeLimit ?? null,
    payment_required: obs.paymentRequired,
    payment_authorized: obs.paymentAuthorized ?? null,
    payment_settled: obs.paymentSettled ?? null,
    execution_completed: obs.executionCompleted,
    arc_proof_verified: obs.arcProofVerified,
    error_category: obs.errorCategory,
    source: obs.source,
    created_at: obs.createdAt,
  };
}

/**
 * Records a new API quality observation into database and/or in-memory store.
 */
export async function recordApiQualityObservation(
  input: ApiQualityObservationInput,
): Promise<ApiQualityObservation> {
  // Discovery probes measure third-party endpoints that no seller owns. Writing
  // them into the seller quality store would attribute unpaid, unowned traffic
  // to a Veyra service and inflate its score. Reject at the only write path.
  if (input.source === "x402_discovery_probe") {
    throw new Error(
      "x402_discovery_probe observations are request-scoped evidence and cannot be persisted",
    );
  }
  const nowIso = new Date().toISOString();
  const observationId =
    input.observationId ||
    (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `obs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);
  const createdAt = input.createdAt || nowIso;

  const observation: ApiQualityObservation = {
    ...input,
    observationId,
    completedAt: input.completedAt ?? null,
    quotedPriceUsdc: input.quotedPriceUsdc ?? null,
    paidAmountUsdc: input.paidAmountUsdc ?? null,
    latencyMs: input.latencyMs ?? null,
    responseSchemaValid: input.responseSchemaValid ?? null,
    responseWithinSizeLimit: input.responseWithinSizeLimit ?? null,
    paymentAuthorized: input.paymentAuthorized ?? null,
    paymentSettled: input.paymentSettled ?? null,
    sellerPublicId: input.sellerPublicId ?? null,
    createdAt,
  };

  const serverConfig = tryGetServerSupabaseConfig();
  if (!serverConfig) {
    if (!isMemoryFallbackAllowed()) {
      throw new ApiQualityStoreUnavailableError(
        "api_quality_observation_store_unavailable",
      );
    }
    inMemoryObservations.push(observation);
    return observation;
  }

  try {
    const client = createClient(serverConfig.url, serverConfig.key);
    const row = observationToRowInput(observation);
    const { error } = await client
      .from("api_quality_observations")
      .insert(row);
    if (error) {
      if (!isMemoryFallbackAllowed()) {
        throw new ApiQualityStoreUnavailableError(
          `api_quality_observation_store_unavailable: ${error.message}`,
        );
      }
      console.warn(
        `[recordApiQualityObservation] Supabase insert warning: ${error.message}`,
      );
    }
  } catch (dbErr) {
    if (!isMemoryFallbackAllowed()) {
      if (dbErr instanceof ApiQualityStoreUnavailableError) throw dbErr;
      throw new ApiQualityStoreUnavailableError(
        `api_quality_observation_store_unavailable: ${
          dbErr instanceof Error ? dbErr.message : String(dbErr)
        }`,
      );
    }
    console.warn(
      `[recordApiQualityObservation] Database write failed: ${
        dbErr instanceof Error ? dbErr.message : String(dbErr)
      }`,
    );
  }

  if (isMemoryFallbackAllowed()) {
    inMemoryObservations.push(observation);
  }

  return observation;
}

/**
 * Fetches API quality observations for a single service within a window of days.
 */
export async function fetchApiQualityObservations(
  serviceId: string,
  windowDays: number = 30,
): Promise<ApiQualityObservation[]> {
  const windowMs = Math.max(1, windowDays) * 86400 * 1000;
  const cutoffIso = new Date(Date.now() - windowMs).toISOString();

  const serverConfig = tryGetServerSupabaseConfig();
  if (!serverConfig) {
    if (!isMemoryFallbackAllowed()) {
      throw new ApiQualityStoreUnavailableError(
        "api_quality_observation_store_unavailable",
      );
    }
    return inMemoryObservations
      .filter(
        (obs) => obs.serviceId === serviceId && obs.startedAt >= cutoffIso,
      )
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
  }

  try {
    const client = createClient(serverConfig.url, serverConfig.key);
    const { data, error } = await client
      .from("api_quality_observations")
      .select("*")
      .eq("service_id", serviceId)
      .gte("started_at", cutoffIso)
      .order("started_at", { ascending: false });

    if (error) {
      if (!isMemoryFallbackAllowed()) {
        throw new ApiQualityStoreUnavailableError(
          `api_quality_observation_store_unavailable: ${error.message}`,
        );
      }
      console.warn(
        `[fetchApiQualityObservations] Supabase query warning: ${error.message}`,
      );
    } else if (Array.isArray(data)) {
      return (data as ApiQualityObservationRow[]).map(rowToObservation);
    }
  } catch (dbErr) {
    if (!isMemoryFallbackAllowed()) {
      if (dbErr instanceof ApiQualityStoreUnavailableError) throw dbErr;
      throw new ApiQualityStoreUnavailableError(
        `api_quality_observation_store_unavailable: ${
          dbErr instanceof Error ? dbErr.message : String(dbErr)
        }`,
      );
    }
    console.warn(
      `[fetchApiQualityObservations] Supabase query warning: ${
        dbErr instanceof Error ? dbErr.message : String(dbErr)
      }`,
    );
  }

  if (!isMemoryFallbackAllowed()) {
    throw new ApiQualityStoreUnavailableError(
      "api_quality_observation_store_unavailable",
    );
  }

  return inMemoryObservations
    .filter(
      (obs) => obs.serviceId === serviceId && obs.startedAt >= cutoffIso,
    )
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
}

/**
 * Fetches API quality observations for multiple services within a window of days.
 */
export async function fetchApiQualityObservationsForServices(
  serviceIds: string[],
  windowDays: number = 30,
): Promise<Record<string, ApiQualityObservation[]>> {
  const results: Record<string, ApiQualityObservation[]> = {};
  const uniqueServiceIds = Array.from(new Set(serviceIds.filter(Boolean)));

  const windowMs = Math.max(1, windowDays) * 86400 * 1000;
  const cutoffIso = new Date(Date.now() - windowMs).toISOString();

  const serverConfig = tryGetServerSupabaseConfig();
  if (!serverConfig) {
    if (!isMemoryFallbackAllowed()) {
      throw new ApiQualityStoreUnavailableError(
        "api_quality_observation_store_unavailable",
      );
    }
    for (const id of uniqueServiceIds) {
      results[id] = inMemoryObservations
        .filter((obs) => obs.serviceId === id && obs.startedAt >= cutoffIso)
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );
    }
    return results;
  }

  if (uniqueServiceIds.length > 0) {
    try {
      const client = createClient(serverConfig.url, serverConfig.key);
      const { data, error } = await client
        .from("api_quality_observations")
        .select("*")
        .in("service_id", uniqueServiceIds)
        .gte("started_at", cutoffIso)
        .order("started_at", { ascending: false });

      if (error) {
        if (!isMemoryFallbackAllowed()) {
          throw new ApiQualityStoreUnavailableError(
            `api_quality_observation_store_unavailable: ${error.message}`,
          );
        }
        console.warn(
          `[fetchApiQualityObservationsForServices] Supabase query warning: ${error.message}`,
        );
      } else if (Array.isArray(data)) {
        for (const id of uniqueServiceIds) {
          results[id] = [];
        }
        for (const row of data as ApiQualityObservationRow[]) {
          const obs = rowToObservation(row);
          if (!results[obs.serviceId]) {
            results[obs.serviceId] = [];
          }
          results[obs.serviceId].push(obs);
        }
        return results;
      }
    } catch (dbErr) {
      if (!isMemoryFallbackAllowed()) {
        if (dbErr instanceof ApiQualityStoreUnavailableError) throw dbErr;
        throw new ApiQualityStoreUnavailableError(
          `api_quality_observation_store_unavailable: ${
            dbErr instanceof Error ? dbErr.message : String(dbErr)
          }`,
        );
      }
      console.warn(
        `[fetchApiQualityObservationsForServices] Supabase query warning: ${
          dbErr instanceof Error ? dbErr.message : String(dbErr)
        }`,
      );
    }
  }

  if (!isMemoryFallbackAllowed()) {
    throw new ApiQualityStoreUnavailableError(
      "api_quality_observation_store_unavailable",
    );
  }

  for (const id of uniqueServiceIds) {
    results[id] = inMemoryObservations
      .filter((obs) => obs.serviceId === id && obs.startedAt >= cutoffIso)
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
  }

  return results;
}

/**
 * Resets the in-memory observations cache (primarily for unit tests).
 */
export function clearInMemoryApiQualityObservations(): void {
  inMemoryObservations.length = 0;
}

/**
 * Returns current in-memory observations.
 */
export function getInMemoryApiQualityObservations(): ApiQualityObservation[] {
  return [...inMemoryObservations];
}

/**
 * Calculates linear percentile for a numeric array.
 */
function getPercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Computes raw statistical API quality metrics from an array of observations.
 */
export function computeApiQualityMetrics(
  observations: ApiQualityObservation[],
): ApiQualityMetrics {
  // Historical `scheduled_probe` rows were produced by a synthetic prototype
  // and are not trustworthy execution evidence. Keep them out of every score
  // until the scheduler is backed by an observed provider request.
  observations = observations.filter(
    (observation) => observation.source !== "scheduled_probe",
  );
  const totalObservations = observations.length;
  if (totalObservations === 0) {
    return {
      totalObservations: 0,
      uptimePercent: null,
      executionSuccessPercent: null,
      paymentSuccessPercent: null,
      settlementSuccessPercent: null,
      validResponsePercent: null,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      latencyMaxMs: 0,
      quotedPriceMinUsdc: 0,
      quotedPriceMedianUsdc: 0,
      quotedPriceMaxUsdc: 0,
      costPerSuccessfulResultUsdc: null,
      firstObservedAt: null,
      lastObservedAt: null,
    };
  }

  // Uptime (endpoint reached without 5xx, timeout, or network error)
  const upCount = observations.filter(
    (o) =>
      o.endpointReached &&
      o.httpStatusClass !== "5xx" &&
      o.httpStatusClass !== "timeout" &&
      o.httpStatusClass !== "network_error",
  ).length;
  const uptimePercent = Math.round((upCount / totalObservations) * 10000) / 100;

  // Execution Success
  const execSuccessCount = observations.filter((o) => o.executionCompleted).length;
  const executionSuccessPercent =
    Math.round((execSuccessCount / totalObservations) * 10000) / 100;

  // Payment Success (null if 0 payment attempts)
  const paymentRequiredObs = observations.filter((o) => o.paymentRequired);
  const paymentSuccessPercent =
    paymentRequiredObs.length > 0
      ? Math.round(
          (paymentRequiredObs.filter((o) => o.paymentAuthorized).length /
            paymentRequiredObs.length) *
            10000,
        ) / 100
      : null;

  // Settlement Success (null if 0 authorized payments)
  const paymentAuthorizedObs = observations.filter((o) => o.paymentAuthorized);
  const settlementSuccessPercent =
    paymentAuthorizedObs.length > 0
      ? Math.round(
          (paymentAuthorizedObs.filter((o) => o.paymentSettled).length /
            paymentAuthorizedObs.length) *
            10000,
        ) / 100
      : null;

  // Valid Response %
  const validResponseCount = observations.filter(
    (o) => o.responseSchemaValid && o.responseWithinSizeLimit,
  ).length;
  const validResponsePercent =
    Math.round((validResponseCount / totalObservations) * 10000) / 100;

  // Latency percentiles
  const latencies = observations
    .map((o) => o.latencyMs)
    .filter((v): v is number => typeof v === "number" && !isNaN(v));
  const latencyP50Ms = latencies.length > 0 ? Math.round(getPercentile(latencies, 50)) : 0;
  const latencyP95Ms = latencies.length > 0 ? Math.round(getPercentile(latencies, 95)) : 0;
  const latencyMaxMs = latencies.length > 0 ? Math.round(Math.max(...latencies)) : 0;

  // Quoted Prices
  const prices = observations
    .map((o) => o.quotedPriceUsdc)
    .filter((v): v is number => typeof v === "number" && !isNaN(v));
  const sortedPrices = [...prices].sort((a, b) => a - b);
  const quotedPriceMinUsdc =
    sortedPrices.length > 0 ? Math.round(sortedPrices[0] * 1e6) / 1e6 : 0;
  const quotedPriceMedianUsdc =
    sortedPrices.length > 0
      ? Math.round(getPercentile(sortedPrices, 50) * 1e6) / 1e6
      : 0;
  const quotedPriceMaxUsdc =
    sortedPrices.length > 0
      ? Math.round(sortedPrices[sortedPrices.length - 1] * 1e6) / 1e6
      : 0;

  // Cost per successful result
  const successfulExecutions = observations.filter(
    (o) => o.executionCompleted && o.responseSchemaValid,
  );
  let costPerSuccessfulResultUsdc: number | null = null;
  if (successfulExecutions.length > 0) {
    const totalPaidUsdc = observations.reduce(
      (sum, o) => sum + (o.paidAmountUsdc || 0),
      0,
    );
    costPerSuccessfulResultUsdc =
      Math.round((totalPaidUsdc / successfulExecutions.length) * 1e6) / 1e6;
  }

  // Timestamps
  const sortedTimestamps = observations
    .map((o) => o.startedAt)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  return {
    totalObservations,
    uptimePercent,
    executionSuccessPercent,
    paymentSuccessPercent,
    settlementSuccessPercent,
    validResponsePercent,
    latencyP50Ms,
    latencyP95Ms,
    latencyMaxMs,
    quotedPriceMinUsdc,
    quotedPriceMedianUsdc,
    quotedPriceMaxUsdc,
    costPerSuccessfulResultUsdc,
    firstObservedAt: sortedTimestamps[0] || null,
    lastObservedAt: sortedTimestamps[sortedTimestamps.length - 1] || null,
  };
}

/**
 * Determines confidence level (high/medium/low) based on observation count, data age, and real execution ratio.
 */
export function getConfidenceLevel(
  observations: ApiQualityObservation[],
): ConfidenceLevel {
  observations = observations.filter(
    (observation) => observation.source !== "scheduled_probe",
  );
  const count = observations.length;
  if (count < 5) return "low";

  let score = 0;

  // Observation count component
  if (count >= 20) {
    score += 3;
  } else if (count >= 10) {
    score += 2;
  } else {
    score += 1;
  }

  // Data recency component
  const nowMs = Date.now();
  const latestTimestamp = observations.reduce((latest, obs) => {
    const ms = new Date(obs.startedAt).getTime();
    return ms > latest ? ms : latest;
  }, 0);

  if (latestTimestamp > 0) {
    const ageDays = (nowMs - latestTimestamp) / (86400 * 1000);
    if (ageDays <= 1) {
      score += 1;
    } else if (ageDays > 7) {
      score -= 1;
    }
  }

  // Real execution ratio component
  const realCount = observations.filter(
    (o) => o.source === "real_paid_execution",
  ).length;
  const realRatio = realCount / count;
  if (realRatio >= 0.5) {
    score += 1;
  } else if (realRatio < 0.2) {
    score -= 1;
  }

  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/**
 * Calculates the 0-100 Quality Score across Availability (25), Execution (20), Response Validity (15),
 * Payment (15), Settlement (15), and Latency (10).
 */
export function calculateQualityScore(
  metrics: ApiQualityMetrics,
  observations?: ApiQualityObservation[],
): ApiQualityScore {
  const hasSufficientData = metrics.totalObservations >= 10;

  if (!hasSufficientData) {
    return {
      overallScore: null,
      qualityScore: null,
      availabilityScore: null,
      executionReliabilityScore: null,
      responseValidityScore: null,
      paymentSuccessScore: null,
      settlementSuccessScore: null,
      latencyConsistencyScore: null,
      status: "Insufficient data",
      qualityStatus: "Insufficient data",
      confidenceLevel: observations ? getConfidenceLevel(observations) : "low",
      hasSufficientData: false,
    };
  }

  // 1. Availability Score (0 - 25)
  const availabilityScore =
    metrics.uptimePercent !== null
      ? Math.round(((metrics.uptimePercent / 100) * 25) * 10) / 10
      : 0;

  // 2. Execution Reliability Score (0 - 20)
  const executionReliabilityScore =
    metrics.executionSuccessPercent !== null
      ? Math.round(((metrics.executionSuccessPercent / 100) * 20) * 10) / 10
      : 0;

  // 3. Response Validity Score (0 - 15)
  const responseValidityScore =
    metrics.validResponsePercent !== null
      ? Math.round(((metrics.validResponsePercent / 100) * 15) * 10) / 10
      : 0;

  // 4. Payment Success Score (0 - 15)
  const paymentSuccessScore =
    metrics.paymentSuccessPercent !== null
      ? Math.round(((metrics.paymentSuccessPercent / 100) * 15) * 10) / 10
      : 15;

  // 5. Settlement Success Score (0 - 15)
  const settlementSuccessScore =
    metrics.settlementSuccessPercent !== null
      ? Math.round(((metrics.settlementSuccessPercent / 100) * 15) * 10) / 10
      : 15;

  // 6. Latency Consistency Score (0 - 10)
  let latencyConsistencyScore = 0;
  if (metrics.totalObservations > 0 && metrics.latencyP95Ms > 0) {
    // Component based on P95 magnitude (0 to 7)
    let p95Pts = 1;
    if (metrics.latencyP95Ms <= 200) p95Pts = 7;
    else if (metrics.latencyP95Ms <= 500) p95Pts = 6;
    else if (metrics.latencyP95Ms <= 1000) p95Pts = 5;
    else if (metrics.latencyP95Ms <= 2000) p95Pts = 4;
    else if (metrics.latencyP95Ms <= 5000) p95Pts = 3;
    else if (metrics.latencyP95Ms <= 10000) p95Pts = 2;

    // Component based on jitter ratio (P95 / P50) (0 to 3)
    const p50 = Math.max(1, metrics.latencyP50Ms);
    const ratio = metrics.latencyP95Ms / p50;
    let jitterPts = 0;
    if (ratio <= 1.5) jitterPts = 3;
    else if (ratio <= 2.5) jitterPts = 2;
    else if (ratio <= 4.0) jitterPts = 1;

    latencyConsistencyScore = Math.min(10, p95Pts + jitterPts);
  }

  // Overall Score (sum rounded to integer 0 - 100)
  const rawSum =
    availabilityScore +
    executionReliabilityScore +
    responseValidityScore +
    paymentSuccessScore +
    settlementSuccessScore +
    latencyConsistencyScore;

  const overallScore = Math.min(100, Math.max(0, Math.round(rawSum)));

  // Quality Status
  let status: QualityStatus;
  if (overallScore >= 90) {
    status = "Excellent";
  } else if (overallScore >= 75) {
    status = "Reliable";
  } else if (overallScore >= 55) {
    status = "Mixed signals";
  } else {
    status = "High attention";
  }

  // Confidence Level
  const confidenceLevel: ConfidenceLevel = observations
    ? getConfidenceLevel(observations)
    : metrics.totalObservations >= 20
    ? "high"
    : metrics.totalObservations >= 10
    ? "medium"
    : "low";

  return {
    overallScore,
    qualityScore: overallScore,
    availabilityScore,
    executionReliabilityScore,
    responseValidityScore,
    paymentSuccessScore,
    settlementSuccessScore,
    latencyConsistencyScore,
    status,
    qualityStatus: status,
    confidenceLevel,
    hasSufficientData: true,
  };
}

/**
 * Compares quality metrics across multiple services and generates side-by-side comparison matrix and highlights.
 */
export function compareApiQuality(
  servicesData: ServiceQualityInput[] | Record<string, ApiQualityObservation[]>,
  observationWindowDays: number = 30,
): ApiQualityComparisonResult {
  // Normalize input
  const inputs: ServiceQualityInput[] = Array.isArray(servicesData)
    ? servicesData
    : Object.entries(servicesData).map(([serviceId, observations]) => ({
        serviceId,
        observations,
      }));

  if (inputs.length === 0) {
    return {
      services: [],
      highlights: [],
      overallWinnerServiceId: null,
      observationWindowDays,
    };
  }

  // Compute metrics and score for each service
  const items: ApiQualityComparisonItem[] = inputs.map((input) => {
    const metrics = computeApiQualityMetrics(input.observations);
    const score = calculateQualityScore(metrics, input.observations);
    const sellerPublicId =
      input.sellerPublicId ||
      input.observations.find((o) => o.sellerPublicId)?.sellerPublicId ||
      null;

    return {
      serviceId: input.serviceId,
      serviceName: input.serviceName || input.serviceId,
      sellerPublicId,
      metrics,
      score,
      rank: 1, // Will be set after sorting
    };
  });

  // Sort by sufficient data first, then overallScore descending, then uptime, then execution success
  items.sort((a, b) => {
    if (a.score.hasSufficientData !== b.score.hasSufficientData) {
      return a.score.hasSufficientData ? -1 : 1;
    }
    const aScore = a.score.overallScore ?? -1;
    const bScore = b.score.overallScore ?? -1;
    if (bScore !== aScore) {
      return bScore - aScore;
    }
    const aUptime = a.metrics.uptimePercent ?? -1;
    const bUptime = b.metrics.uptimePercent ?? -1;
    if (bUptime !== aUptime) {
      return bUptime - aUptime;
    }
    const aExec = a.metrics.executionSuccessPercent ?? -1;
    const bExec = b.metrics.executionSuccessPercent ?? -1;
    return bExec - aExec;
  });

  // Assign ranks
  items.forEach((item, index) => {
    item.rank = index + 1;
  });

  const overallWinnerServiceId = items[0]?.serviceId || null;

  // Build Highlights
  const highlights: ApiQualityComparisonCategoryHighlight[] = [];

  // Overall winner highlight
  if (items.length > 0 && items[0]) {
    const winner = items[0];
    const scoreVal = winner.score.overallScore !== null ? `${winner.score.overallScore}/100` : "N/A";
    highlights.push({
      category: "overall",
      title: "Top Overall Performer",
      winnerServiceId: winner.serviceId,
      winnerServiceName: winner.serviceName,
      value: scoreVal,
      description: winner.score.overallScore !== null
        ? `Highest quality score with ${winner.score.status.toLowerCase()} status across ${winner.metrics.totalObservations} observations.`
        : `Primary service registered ${winner.metrics.totalObservations} observation(s) (insufficient data to score).`,
    });
  }

  // Uptime highlight
  const uptimeWinner = [...items].sort(
    (a, b) => (b.metrics.uptimePercent ?? -1) - (a.metrics.uptimePercent ?? -1),
  )[0];
  if (uptimeWinner && uptimeWinner.metrics.totalObservations > 0 && uptimeWinner.metrics.uptimePercent !== null) {
    highlights.push({
      category: "uptime",
      title: "Best Uptime",
      winnerServiceId: uptimeWinner.serviceId,
      winnerServiceName: uptimeWinner.serviceName,
      value: `${uptimeWinner.metrics.uptimePercent}%`,
      description: `Highest endpoint availability in the ${observationWindowDays}-day window.`,
    });
  }

  // Latency highlight
  const latencyWinner = [...items]
    .filter((item) => item.metrics.totalObservations > 0 && item.metrics.latencyP50Ms > 0)
    .sort((a, b) => a.metrics.latencyP50Ms - b.metrics.latencyP50Ms)[0];
  if (latencyWinner) {
    highlights.push({
      category: "latency",
      title: "Fastest Response (P50)",
      winnerServiceId: latencyWinner.serviceId,
      winnerServiceName: latencyWinner.serviceName,
      value: `${latencyWinner.metrics.latencyP50Ms}ms`,
      description: `Lowest median response time across recorded requests.`,
    });
  }

  // Execution reliability highlight
  const executionWinner = [...items].sort(
    (a, b) => (b.metrics.executionSuccessPercent ?? -1) - (a.metrics.executionSuccessPercent ?? -1),
  )[0];
  if (executionWinner && executionWinner.metrics.totalObservations > 0 && executionWinner.metrics.executionSuccessPercent !== null) {
    highlights.push({
      category: "execution",
      title: "Most Reliable Execution",
      winnerServiceId: executionWinner.serviceId,
      winnerServiceName: executionWinner.serviceName,
      value: `${executionWinner.metrics.executionSuccessPercent}%`,
      description: `Highest end-to-end execution success rate.`,
    });
  }

  // Cost efficiency highlight
  const costWinner = [...items]
    .filter(
      (item) =>
        item.metrics.totalObservations > 0 &&
        item.metrics.costPerSuccessfulResultUsdc !== null &&
        item.metrics.costPerSuccessfulResultUsdc > 0,
    )
    .sort(
      (a, b) =>
        (a.metrics.costPerSuccessfulResultUsdc ?? 0) -
        (b.metrics.costPerSuccessfulResultUsdc ?? 0),
    )[0];
  if (costWinner) {
    highlights.push({
      category: "cost",
      title: "Best Cost Efficiency",
      winnerServiceId: costWinner.serviceId,
      winnerServiceName: costWinner.serviceName,
      value: `${costWinner.metrics.costPerSuccessfulResultUsdc} USDC`,
      description: `Lowest cost per successful result delivered.`,
    });
  }

  return {
    services: items,
    highlights,
    overallWinnerServiceId,
    observationWindowDays,
  };
}

/**
 * Returns in-memory quality alerts, optionally filtered by serviceId.
 */
export function getInMemoryApiQualityAlerts(serviceId?: string): ApiQualityAlert[] {
  if (serviceId) {
    return inMemoryAlerts.filter((a) => a.serviceId === serviceId);
  }
  return [...inMemoryAlerts];
}

/**
 * Clears in-memory quality alerts (for testing).
 */
export function clearInMemoryApiQualityAlerts(): void {
  inMemoryAlerts.length = 0;
}

/**
 * Evaluates metric deltas between previous and new observation snapshots to detect quality degradation alerts.
 */
export function detectQualityDegradationAlerts(
  serviceId: string,
  prevScore: ApiQualityScore,
  newScore: ApiQualityScore,
  prevMetrics: ApiQualityMetrics,
  newMetrics: ApiQualityMetrics,
): ApiQualityAlert[] {
  const alerts: ApiQualityAlert[] = [];
  const nowIso = new Date().toISOString();

  // 1. Overall Score Degradation
  if (
    prevScore.hasSufficientData &&
    newScore.hasSufficientData &&
    prevScore.overallScore !== null &&
    newScore.overallScore !== null &&
    prevScore.overallScore - newScore.overallScore >= 15
  ) {
    const delta = newScore.overallScore - prevScore.overallScore;
    alerts.push({
      alertId: `alert_score_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      serviceId,
      alertType: "score_drop",
      severity: "critical",
      message: `API Quality score for service '${serviceId}' dropped by ${Math.abs(delta)} points (from ${prevScore.overallScore} to ${newScore.overallScore}).`,
      details: {
        previousValue: prevScore.overallScore,
        newValue: newScore.overallScore,
        delta,
        threshold: 15,
      },
      createdAt: nowIso,
    });
  }

  // 2. Uptime / Availability Drop
  if (
    prevMetrics.totalObservations > 0 &&
    prevMetrics.uptimePercent !== null &&
    newMetrics.uptimePercent !== null &&
    (prevMetrics.uptimePercent - newMetrics.uptimePercent >= 10 || newMetrics.uptimePercent < 90)
  ) {
    const delta = Math.round((newMetrics.uptimePercent - prevMetrics.uptimePercent) * 100) / 100;
    const severity: ApiQualityAlertSeverity = newMetrics.uptimePercent < 80 ? "critical" : "warning";
    alerts.push({
      alertId: `alert_uptime_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      serviceId,
      alertType: "uptime_drop",
      severity,
      message: `Availability for service '${serviceId}' dropped to ${newMetrics.uptimePercent}% (previously ${prevMetrics.uptimePercent}%).`,
      details: {
        previousValue: prevMetrics.uptimePercent,
        newValue: newMetrics.uptimePercent,
        delta,
        threshold: 90,
      },
      createdAt: nowIso,
    });
  }

  // 3. Latency Surge
  if (
    prevMetrics.totalObservations > 0 &&
    prevMetrics.latencyP95Ms > 0 &&
    (newMetrics.latencyP95Ms >= prevMetrics.latencyP95Ms * 1.5 || newMetrics.latencyP95Ms > 5000)
  ) {
    const delta = newMetrics.latencyP95Ms - prevMetrics.latencyP95Ms;
    alerts.push({
      alertId: `alert_latency_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      serviceId,
      alertType: "latency_spike",
      severity: "warning",
      message: `Latency P95 for service '${serviceId}' spiked to ${newMetrics.latencyP95Ms}ms (previously ${prevMetrics.latencyP95Ms}ms).`,
      details: {
        previousValue: prevMetrics.latencyP95Ms,
        newValue: newMetrics.latencyP95Ms,
        delta,
        threshold: prevMetrics.latencyP95Ms * 1.5,
      },
      createdAt: nowIso,
    });
  }

  // 4. Execution Failure Spike
  if (
    prevMetrics.totalObservations > 0 &&
    newMetrics.executionSuccessPercent !== null &&
    prevMetrics.executionSuccessPercent !== null &&
    newMetrics.executionSuccessPercent < 80 &&
    prevMetrics.executionSuccessPercent >= 80
  ) {
    const delta = Math.round((newMetrics.executionSuccessPercent - prevMetrics.executionSuccessPercent) * 100) / 100;
    alerts.push({
      alertId: `alert_exec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      serviceId,
      alertType: "execution_failure_spike",
      severity: "critical",
      message: `Execution success rate for service '${serviceId}' fell to ${newMetrics.executionSuccessPercent}%.`,
      details: {
        previousValue: prevMetrics.executionSuccessPercent,
        newValue: newMetrics.executionSuccessPercent,
        delta,
        threshold: 80,
      },
      createdAt: nowIso,
    });
  }

  return alerts;
}

/**
 * Helper to fetch public service metadata directly without pulling node:dns server dependencies into client chunks.
 */
async function fetchPublicServiceMetadata(
  serviceId: string,
): Promise<{ name: string; sellerPublicId?: string; priceUsdc: number; active: boolean } | null> {
  const serverConfig = tryGetServerSupabaseConfig();
  if (!serverConfig) return null;
  try {
    const client = createClient(serverConfig.url, serverConfig.key);
    let query = client
      .from("store_services")
      .select("public_id, name, price_usdc, status, review_status, seller_id, slug")
      .is("archived_at", null);
    if (/^svc_[a-f0-9]{20}$/.test(serviceId)) {
      query = query.eq("public_id", serviceId);
    } else if (serviceId.startsWith("seller_")) {
      const slug = serviceId.slice(7).replace(/_/g, "-");
      query = query.eq("slug", slug);
    } else {
      query = query.eq("public_id", serviceId);
    }
    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;
    const active = data.status === "active" && data.review_status === "approved";
    const priceUsdc =
      typeof data.price_usdc === "number"
        ? data.price_usdc
        : parseFloat(String(data.price_usdc || "0.10"));
    return {
      name: data.name || serviceId,
      priceUsdc: isNaN(priceUsdc) ? 0.10 : priceUsdc,
      active,
    };
  } catch {
    return null;
  }
}

async function fetchActivePublicServiceIds(): Promise<string[]> {
  const serverConfig = tryGetServerSupabaseConfig();
  if (!serverConfig) return [];
  try {
    const client = createClient(serverConfig.url, serverConfig.key);
    const { data, error } = await client
      .from("store_services")
      .select("public_id")
      .eq("source_type", "external_seller")
      .eq("status", "active")
      .eq("review_status", "approved")
      .is("archived_at", null);
    if (error || !Array.isArray(data)) return [];
    return data.map((row) => row.public_id).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Checks safety, active status, cooldown, and budget guards before executing a monitoring probe.
 */
export async function checkProbeSafetyAndBudget(
  serviceId: string,
  probeType: ProbeType,
  options?: {
    maxDailyProbeBudgetUsdc?: number;
    cooldownSeconds?: number;
    maxPriceUsdc?: number;
  },
): Promise<{
  allowed: boolean;
  status?: ProbeRunStatus;
  reason?: string;
  serviceName?: string;
  sellerPublicId?: string;
  estimatedCostUsdc: number;
}> {
  const cooldownSeconds = Math.max(
    60,
    Math.min(options?.cooldownSeconds ?? 300, 86_400),
  );
  const maxDailyBudget = Math.max(
    0,
    Math.min(options?.maxDailyProbeBudgetUsdc ?? 5.0, 5.0),
  );
  const maxPrice = Math.max(
    0,
    Math.min(options?.maxPriceUsdc ?? 1.0, 1.0),
  );

  // 1. Active service check
  let serviceName = serviceId;
  let sellerPublicId: string | undefined = undefined;
  let priceUsdc = 0.10;

  try {
    const publicWorkflow = await fetchPublicServiceMetadata(serviceId);
    if (publicWorkflow?.active) {
      serviceName = publicWorkflow.name || serviceId;
      sellerPublicId = publicWorkflow.sellerPublicId;
      priceUsdc = publicWorkflow.priceUsdc || 0.10;
    } else {
      return {
        allowed: false,
        status: "inactive_skipped",
        reason: "Probe skipped: the service is not an active approved public seller service.",
        serviceName,
        sellerPublicId,
        estimatedCostUsdc: 0,
      };
    }
  } catch {
    // Fallback if DB is unavailable or service not found
  }

  // 2. Cooldown check: verify time since last scheduled_probe for this service
  const recentObservations = await fetchApiQualityObservations(serviceId, 1);
  const latestProbe = recentObservations.find((o) => o.source === "scheduled_probe");
  if (latestProbe) {
    const elapsedSeconds = (Date.now() - new Date(latestProbe.startedAt).getTime()) / 1000;
    if (elapsedSeconds < cooldownSeconds) {
      return {
        allowed: false,
        status: "cooldown_skipped",
        reason: `Probe skipped: cooldown of ${cooldownSeconds}s in effect (last probe ${Math.round(elapsedSeconds)}s ago).`,
        serviceName,
        sellerPublicId,
        estimatedCostUsdc: 0,
      };
    }
  }

  // 3. Budget & Price limit checks for paid execution probes
  if (probeType === "paid_execution") {
    if (priceUsdc > maxPrice) {
      return {
        allowed: false,
        status: "budget_exceeded",
        reason: `Service price (${priceUsdc} USDC) exceeds max allowed per-probe price (${maxPrice} USDC).`,
        serviceName,
        sellerPublicId,
        estimatedCostUsdc: priceUsdc,
      };
    }

    // Calculate total spend on scheduled probes in past 24 hours
    const cutoff24h = new Date(Date.now() - 86400 * 1000).toISOString();
    const allRecent = inMemoryObservations.filter(
      (o) => o.source === "scheduled_probe" && o.startedAt >= cutoff24h,
    );
    const totalSpentToday = allRecent.reduce((sum, o) => sum + (o.paidAmountUsdc || 0), 0);

    if (totalSpentToday + priceUsdc > maxDailyBudget) {
      return {
        allowed: false,
        status: "budget_exceeded",
        reason: `Daily probe budget of ${maxDailyBudget} USDC would be exceeded (already spent today: ${totalSpentToday.toFixed(4)} USDC).`,
        serviceName,
        sellerPublicId,
        estimatedCostUsdc: priceUsdc,
      };
    }
  }

  return {
    allowed: true,
    serviceName,
    sellerPublicId,
    estimatedCostUsdc: probeType === "paid_execution" ? priceUsdc : 0,
  };
}

/**
 * Executes a single scheduled monitoring probe (availability or paid execution).
 */
export async function executeScheduledProbe(
  config: ApiQualityProbeConfig,
): Promise<ApiQualityProbeResult> {
  const probeType: ProbeType = config.probeType || "availability";
  const executedAt = new Date().toISOString();
  const probeId = `probe_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // Safety & budget guards
  const safety = await checkProbeSafetyAndBudget(config.serviceId, probeType, config);
  if (!safety.allowed) {
    return {
      probeId,
      serviceId: config.serviceId,
      probeType,
      status: safety.status || "inactive_skipped",
      skippedReason: safety.reason,
      alertsTriggered: [],
      executedAt,
    };
  }

  // Fail closed. The previous prototype wrote constant latency, HTTP success,
  // settlement, and Arc verification values without issuing a provider call.
  // Availability is already monitored by the seller lifecycle; paid quality
  // evidence must come from real hosted executions and persisted receipts.
  return {
    probeId,
    serviceId: config.serviceId,
    probeType,
    status: "inactive_skipped",
    skippedReason: "Scheduled API quality evidence is disabled until a real provider execution is observed.",
    alertsTriggered: [],
    executedAt,
  };
}

/**
 * Runs a batch of scheduled monitoring probes across configured or active services.
 */
export async function runScheduledApiQualityProbes(
  options?: ProbeEngineOptions,
): Promise<ProbeRunSummary> {
  const executedAt = new Date().toISOString();
  let targetServiceIds = options?.serviceIds;

  if (!targetServiceIds || targetServiceIds.length === 0) {
    try {
      const publicServiceIds = await fetchActivePublicServiceIds();
      if (Array.isArray(publicServiceIds) && publicServiceIds.length > 0) {
        targetServiceIds = publicServiceIds;
      }
    } catch {
      // Fallback to distinct serviceIds in memory
    }
  }

  if (!targetServiceIds || targetServiceIds.length === 0) {
    const memoryObservations = getInMemoryApiQualityObservations();
    const memoryServiceIds = Array.from(new Set(memoryObservations.map((o) => o.serviceId)));
    targetServiceIds = memoryServiceIds;
  }

  const results: ApiQualityProbeResult[] = [];
  const alerts: ApiQualityAlert[] = [];
  let executed = 0;
  let skipped = 0;
  let totalCostUsdc = 0;

  const probeType = options?.probeType === "auto" ? "availability" : options?.probeType || "availability";

  for (const serviceId of targetServiceIds) {
    const res = await executeScheduledProbe({
      serviceId,
      probeType,
      maxDailyProbeBudgetUsdc: options?.maxDailyProbeBudgetUsdc,
      cooldownSeconds: options?.cooldownSeconds,
    });

    results.push(res);
    if (res.status === "success") {
      executed++;
    } else {
      skipped++;
    }

    if (res.observation) {
      totalCostUsdc += res.observation.paidAmountUsdc || 0;
    }

    if (res.alertsTriggered.length > 0) {
      alerts.push(...res.alertsTriggered);
    }
  }

  return {
    totalProbes: targetServiceIds.length,
    executed,
    skipped,
    totalCostUsdc: Math.round(totalCostUsdc * 1e6) / 1e6,
    results,
    alerts,
    executedAt,
  };
}

