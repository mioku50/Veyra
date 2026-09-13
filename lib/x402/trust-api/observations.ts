/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { getByoaClient } from "../../byoa/service.ts";
import {
  calculateQualityScore,
  computeApiQualityMetrics,
  getConfidenceLevel,
} from "../../providers/api-quality.ts";
import type {
  ApiQualityMetrics,
  ApiQualityObservation,
  ApiQualityScore,
  ErrorCategory,
  HttpStatusClass,
} from "../../providers/api-quality-types.ts";
import type { X402ProbeEvidence, X402ProbeResult } from "../../providers/x402-probe.ts";
import type { ProbeMethod } from "./resource.ts";

const OBSERVATION_TABLE = "x402_endpoint_observations";

/** Enough to characterise an endpoint without unbounded reads. */
export const ENDPOINT_HISTORY_LIMIT = 200;

export type EndpointObservationRow = {
  observation_id: string;
  resource_key: string;
  resource_url: string;
  method: ProbeMethod;
  network: string;
  candidate_id: string | null;
  observed_pay_to: string | null;
  observed_price_usdc: string | number | null;
  observed_asset: string | null;
  reachable: boolean;
  responded_with_402: boolean;
  challenge_parseable: boolean;
  challenge_transport: string;
  http_status: number | null;
  http_status_class: HttpStatusClass;
  latency_ms: number | null;
  integrity_score: number;
  catalog_drift: string[] | null;
  critical_failure: string | null;
  error_category: ErrorCategory;
  probe_version: string;
  probed_at: string;
};

function numeric(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Persists one probe as durable evidence.
 *
 * Best-effort by design: a verdict that Veyra computed correctly must still be
 * returned when the evidence store is down. The write is what makes the *next*
 * verdict better, so losing it degrades future answers, never this one.
 */
export async function recordEndpointObservation(input: {
  resourceKey: string;
  resourceUrl: string;
  method: ProbeMethod;
  network: string;
  candidateId?: string | null;
  probe: X402ProbeResult;
  asset?: string | null;
}): Promise<boolean> {
  try {
    const { error } = await getByoaClient().from(OBSERVATION_TABLE).insert({
      resource_key: input.resourceKey,
      resource_url: input.resourceUrl,
      method: input.method,
      network: input.network,
      candidate_id: input.candidateId ?? null,
      observed_pay_to: input.probe.observedPayTo,
      observed_price_usdc: input.probe.observedPriceUsdc,
      observed_asset: input.asset ?? null,
      reachable: input.probe.reachable,
      responded_with_402: input.probe.respondedWith402,
      challenge_parseable: input.probe.challengeParseable,
      challenge_transport: input.probe.challengeTransport,
      http_status: input.probe.httpStatus,
      http_status_class: input.probe.httpStatusClass,
      latency_ms: input.probe.latencyMs,
      integrity_score: input.probe.integrityScore,
      catalog_drift: input.probe.catalogDrift,
      critical_failure: input.probe.criticalFailure,
      error_category: input.probe.errorCategory,
      probe_version: input.probe.probeVersion,
      probed_at: input.probe.probedAt,
    });
    if (error) {
      console.warn("x402_observation_write_failed", { code: error.code });
      return false;
    }
    return true;
  } catch (error) {
    console.warn("x402_observation_store_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
    return false;
  }
}

export async function loadEndpointObservations(
  resourceKey: string,
  limit = ENDPOINT_HISTORY_LIMIT,
): Promise<EndpointObservationRow[]> {
  try {
    const { data, error } = await getByoaClient()
      .from(OBSERVATION_TABLE)
      .select("*")
      .eq("resource_key", resourceKey)
      .order("probed_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, ENDPOINT_HISTORY_LIMIT)));
    if (error) {
      console.warn("x402_observation_read_failed", { code: error.code });
      return [];
    }
    return (data ?? []) as EndpointObservationRow[];
  } catch (error) {
    console.warn("x402_observation_store_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
    return [];
  }
}

export function rowToApiQualityObservation(row: EndpointObservationRow): ApiQualityObservation {
  return {
    observationId: row.observation_id,
    serviceId: row.resource_key,
    sellerPublicId: null,
    startedAt: row.probed_at,
    completedAt: new Date(
      Date.parse(row.probed_at) + (row.latency_ms ?? 0),
    ).toISOString(),
    quotedPriceUsdc: numeric(row.observed_price_usdc),
    paidAmountUsdc: null,
    latencyMs: row.latency_ms,
    httpStatusClass: row.responded_with_402 ? "4xx" : row.http_status_class,
    endpointReached: row.reachable,
    responseSchemaValid: row.challenge_parseable
      ? (row.catalog_drift ?? []).length === 0
      : false,
    responseWithinSizeLimit: true,
    paymentRequired: row.responded_with_402,
    paymentAuthorized: null,
    paymentSettled: null,
    executionCompleted: false,
    arcProofVerified: false,
    errorCategory: row.error_category,
    source: "x402_discovery_probe",
    createdAt: row.probed_at,
  };
}

export type EndpointChangeEvent = {
  field: "pay_to" | "price_usdc";
  from: string;
  to: string;
  observedAt: string;
};

export type EndpointHistory = {
  resourceKey: string;
  observations: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  metrics: ApiQualityMetrics;
  quality: ApiQualityScore;
  statisticalEvidenceAvailable: boolean;
  payToNow: string | null;
  payToStableSince: string | null;
  distinctPayTos: number;
  changes: EndpointChangeEvent[];
};

/**
 * Folds stored observations into the distributions Veyra sells, and into the
 * one alert that matters most: this endpoint's payee is not the payee it used
 * to have. A payee change is not automatically fraud, but an agent that pays it
 * without noticing has no way to find out afterwards.
 */
export function summariseEndpointHistory(
  resourceKey: string,
  rows: EndpointObservationRow[],
  live?: ApiQualityObservation,
): EndpointHistory {
  const chronological = [...rows].sort(
    (left, right) => Date.parse(left.probed_at) - Date.parse(right.probed_at),
  );
  const observations = chronological.map(rowToApiQualityObservation);
  if (live) observations.push(live);

  const metrics = computeApiQualityMetrics(observations);
  const quality = {
    ...calculateQualityScore(metrics, observations),
    confidenceLevel: getConfidenceLevel(observations),
  };

  const changes: EndpointChangeEvent[] = [];
  let previousPayTo: string | null = null;
  let previousPrice: number | null = null;
  let payToStableSince: string | null = null;
  const payTos = new Set<string>();

  for (const row of chronological) {
    const payTo = row.observed_pay_to ? row.observed_pay_to.toLowerCase() : null;
    if (payTo) {
      payTos.add(payTo);
      if (previousPayTo === null) {
        payToStableSince = row.probed_at;
      } else if (payTo !== previousPayTo) {
        changes.push({
          field: "pay_to",
          from: previousPayTo,
          to: payTo,
          observedAt: row.probed_at,
        });
        payToStableSince = row.probed_at;
      }
      previousPayTo = payTo;
    }
    const price = numeric(row.observed_price_usdc);
    if (price !== null) {
      if (previousPrice !== null && Math.abs(price - previousPrice) > 1e-9) {
        changes.push({
          field: "price_usdc",
          from: previousPrice.toFixed(6),
          to: price.toFixed(6),
          observedAt: row.probed_at,
        });
      }
      previousPrice = price;
    }
  }

  return {
    resourceKey,
    observations: observations.length,
    firstObservedAt: chronological[0]?.probed_at ?? null,
    lastObservedAt: chronological[chronological.length - 1]?.probed_at ?? null,
    metrics,
    quality,
    statisticalEvidenceAvailable: quality.hasSufficientData,
    payToNow: previousPayTo,
    payToStableSince,
    distinctPayTos: payTos.size,
    /* Newest first, and within one observation the payee change outranks the
       price change: a caller that reads only the first entry must see the one
       that decides whether to pay at all. Relying on push order made this
       depend on the order the fields happen to be checked in. */
    changes: changes.sort((left, right) => {
      const byTime = Date.parse(right.observedAt) - Date.parse(left.observedAt);
      if (byTime !== 0) return byTime;
      if (left.field === right.field) return 0;
      return left.field === "pay_to" ? -1 : 1;
    }),
  };
}


/**
 * Evidence for one endpoint, built from everything Veyra has ever seen of it
 * plus the probe it just ran.
 *
 * `buildX402ProbeEvidence` was only ever handed a single live probe, because
 * nothing was stored: every verdict was a first impression, statistical
 * availability was never satisfiable, and coverage was permanently capped below
 * what the policy needs for ALLOW. History is what lifts that cap, honestly -
 * the quality engine still answers "Insufficient data" until it has enough.
 */
export function buildEvidenceWithHistory(
  live: X402ProbeResult,
  history: EndpointObservationRow[],
): X402ProbeEvidence {
  const observations = [
    ...history.map(rowToApiQualityObservation),
    live.observation,
  ];
  const metrics = computeApiQualityMetrics(observations);
  const quality = calculateQualityScore(metrics, observations);
  return {
    probes: [live],
    // Integrity is a property of the live challenge, not of the past: an
    // endpoint that was clean yesterday and drifted today is not 50% clean.
    integrityScore: live.integrityScore,
    metrics,
    qualityScore: { ...quality, confidenceLevel: getConfidenceLevel(observations) },
    statisticalEvidenceAvailable: quality.hasSufficientData,
  };
}
