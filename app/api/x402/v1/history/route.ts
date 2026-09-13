/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { readJsonBody, trustApiError, TRUST_API_HEADERS } from "@/lib/x402/trust-api/http";
import {
  loadEndpointObservations,
  summariseEndpointHistory,
} from "@/lib/x402/trust-api/observations";
import { TRUST_API_PRICING } from "@/lib/x402/trust-api/pricing";
import {
  normalizeResourceUrl,
  parseProbeMethod,
  resourceKeyFor,
} from "@/lib/x402/trust-api/resource";
import { withTrustApiPayment } from "@/lib/x402/trust-api/seller";

export const dynamic = "force-dynamic";

/**
 * Paid. Everything Veyra has ever observed about one endpoint.
 *
 * This is the archive, not a probe: it answers what this endpoint has been
 * like, not what it is doing this second. That is the half no caller can
 * reconstruct for themselves — anyone can measure an endpoint once, but only
 * something that has been watching has a distribution and a list of the days
 * its payee changed.
 */
export const POST = withTrustApiPayment(async (request: NextRequest) => {
  try {
    const body = await readJsonBody(request);
    const resource = normalizeResourceUrl(body.resource);
    const method = parseProbeMethod(body.method);
    const resourceKey = resourceKeyFor(method, resource);

    const rows = await loadEndpointObservations(resourceKey);
    const history = summariseEndpointHistory(resourceKey, rows);

    return NextResponse.json({
      resource,
      resourceKey,
      method,
      observations: history.observations,
      firstObservedAt: history.firstObservedAt,
      lastObservedAt: history.lastObservedAt,
      // Stated rather than implied: below ten observations the quality engine
      // refuses to score, and so does this response.
      statisticalEvidenceAvailable: history.statisticalEvidenceAvailable,
      availability: {
        uptimePercent: history.metrics.uptimePercent,
        validResponsePercent: history.metrics.validResponsePercent,
      },
      latencyMs: {
        p50: history.metrics.latencyP50Ms,
        p95: history.metrics.latencyP95Ms,
        max: history.metrics.latencyMaxMs,
      },
      priceUsdc: {
        min: history.metrics.quotedPriceMinUsdc,
        median: history.metrics.quotedPriceMedianUsdc,
        max: history.metrics.quotedPriceMaxUsdc,
      },
      quality: {
        status: history.quality.status,
        confidenceLevel: history.quality.confidenceLevel,
        overallScore: history.quality.overallScore,
      },
      payee: {
        current: history.payToNow,
        stableSince: history.payToStableSince,
        distinctSeen: history.distinctPayTos,
      },
      changes: history.changes,
      note: history.observations === 0
        ? "Veyra has no observations of this endpoint yet. Ask for a verdict first - that probe is free and it is what starts the record."
        : undefined,
    }, { headers: TRUST_API_HEADERS });
  } catch (error) {
    return trustApiError(error);
  }
}, {
  endpoint: TRUST_API_PRICING.history.path,
  priceUsdc: TRUST_API_PRICING.history.priceUsdc,
  description: TRUST_API_PRICING.history.description,
});
