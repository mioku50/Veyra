/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import { getAddress, isAddress, zeroAddress, type Hex } from "viem";
import { BRAND } from "../../brand.ts";
import { hashCanonical } from "../../counterparty-selection/canonical.ts";
import {
  buildMarketplaceTrustDecision,
  marketplaceEvidenceCoverage,
  MARKETPLACE_EVIDENCE_DIMENSIONS,
} from "../../counterparty-selection/marketplace.ts";
import type { MarketplaceCandidate } from "../../counterparty-selection/marketplace-source.ts";
import {
  buildX402ProbeEvidence,
  probeX402Resource,
  X402_PROBE_VERSION,
} from "../../providers/x402-probe.ts";
import type { TrustDecision } from "../../trust-gate/types.ts";
import { TRUST_DECISION_EXPIRY_SECONDS, TRUST_POLICY_VERSION } from "../../trust-gate/types.ts";
import {
  buildEvidenceWithHistory,
  loadEndpointObservations,
  recordEndpointObservation,
  summariseEndpointHistory,
  type EndpointChangeEvent,
} from "./observations.ts";
import {
  expectationFromAccept,
  normalizeResourceUrl,
  parseProbeMethod,
  readAccept,
  readX402Challenge,
  resourceKeyFor,
  selectBaselineAccept,
  TrustApiError,
  type ExpectationBaseline,
  type ObservedAccept,
  type ProbeMethod,
} from "./resource.ts";

export const TRUST_API_VERDICT_VERSION = "veyra-trust-api-verdict-v1" as const;
export const TRUST_API_VERDICT_TTL_SECONDS = 300;

/** The same ceiling the browser purchase path enforces. A verdict is advice
 *  about a payment; advice about a life-changing payment is a different
 *  product with different duties. */
export const TRUST_API_MAX_BUDGET_USDC = 5;

export type TrustApiAlert = {
  code:
    | "pay_to_changed"
    | "price_changed"
    | "catalog_drift"
    | "first_sighting"
    | "endpoint_unreachable"
    | "no_challenge";
  severity: "critical" | "warning" | "info";
  detail: string;
};

export type TrustApiVerdict = {
  verdictVersion: typeof TRUST_API_VERDICT_VERSION;
  probeVersion: typeof X402_PROBE_VERSION;
  policyVersion: string;
  resource: string;
  resourceKey: string;
  method: ProbeMethod;
  baseline: ExpectationBaseline;
  decision: TrustDecision["decision"];
  /** Whether Veyra would let this payment proceed at the requested budget. */
  granted: boolean;
  payTo: string | null;
  network: string | null;
  priceUsdc: number | null;
  maxExposureUsdc: number;
  postCallVerificationRequired: boolean;
  probe: {
    reachable: boolean;
    respondedWith402: boolean;
    challengeParseable: boolean;
    httpStatus: number | null;
    latencyMs: number | null;
    integrityScore: number;
    catalogDrift: string[];
    criticalFailure: string | null;
    failedChecks: string[];
  };
  evidence: {
    coverage: number;
    observedDimensions: string[];
    missingDimensions: string[];
    statisticalEvidenceAvailable: boolean;
    observations: number;
  };
  alerts: TrustApiAlert[];
  reasons: string[];
  explanation: string;
  evidenceHash: Hex;
  issuedAt: string;
  expiresAt: string;
  /** Not serialised to callers: the input a clearance would be signed over. */
  trustDecision: TrustDecision;
};

/** A candidate shaped from what the endpoint itself published, for the paths
 *  where the caller names a resource instead of picking one out of a catalog. */
function candidateFromAccept(input: {
  resource: string;
  method: ProbeMethod;
  accept: ObservedAccept;
  capability: string;
}): MarketplaceCandidate {
  const origin = new URL(input.resource).origin;
  const catalogHash = hashCanonical({
    resource: input.resource,
    method: input.method,
    accepts: [{
      network: input.accept.network,
      asset: input.accept.asset.toLowerCase(),
      payTo: input.accept.payTo.toLowerCase(),
      amountAtomic: input.accept.amountAtomic,
      scheme: input.accept.scheme,
    }],
    siwx: false,
  });
  return {
    candidateId: `direct:${resourceKeyFor(input.method, input.resource).slice(0, 16)}`,
    resource: input.resource,
    origin,
    method: input.method,
    provider: { name: origin, docsUrl: null, contact: null },
    description: null,
    mimeType: null,
    declaresInputSchema: false,
    declaresOutputSchema: false,
    outputSchema: null,
    siwx: false,
    supportsVanillaX402: !input.accept.gatewayBatched,
    supportsCircleGateway: input.accept.gatewayBatched,
    accepts: [{ ...input.accept, priceUsdc: input.accept.priceUsdc ?? 0 }],
    selectedAccept: { ...input.accept, priceUsdc: input.accept.priceUsdc ?? 0 },
    priceUsdc: input.accept.priceUsdc ?? 0,
    lastUpdated: null,
    capabilities: [input.capability],
    capabilityMatch: "exact",
    catalogHash,
  } as unknown as MarketplaceCandidate;
}

function alertsFrom(input: {
  baseline: ExpectationBaseline;
  reachable: boolean;
  challengeParseable: boolean;
  drift: string[];
  changes: EndpointChangeEvent[];
  liveAccept: ObservedAccept | null;
  lastPayTo: string | null;
}): TrustApiAlert[] {
  const alerts: TrustApiAlert[] = [];

  if (!input.reachable) {
    alerts.push({
      code: "endpoint_unreachable",
      severity: "critical",
      detail: "The endpoint did not answer at all. Nothing can be verified about it right now.",
    });
    return alerts;
  }
  if (!input.challengeParseable) {
    alerts.push({
      code: "no_challenge",
      severity: "critical",
      detail: "The endpoint answered but published no readable x402 payment challenge.",
    });
  }

  // The alert the whole evidence base exists to make possible: this endpoint is
  // asking to be paid somewhere other than where it used to.
  const livePayTo = input.liveAccept?.payTo?.toLowerCase() ?? null;
  if (input.lastPayTo && livePayTo && livePayTo !== input.lastPayTo) {
    alerts.push({
      code: "pay_to_changed",
      severity: "critical",
      detail: `The payee changed since Veyra last observed this endpoint: ${input.lastPayTo} → ${livePayTo}.`,
    });
  }

  const priceChange = input.changes.find((change) => change.field === "price_usdc");
  if (priceChange) {
    alerts.push({
      code: "price_changed",
      severity: "warning",
      detail: `Price moved from ${priceChange.from} to ${priceChange.to} USDC on ${priceChange.observedAt}.`,
    });
  }

  for (const drift of input.drift) {
    alerts.push({
      code: "catalog_drift",
      severity: "warning",
      detail: `Live challenge disagrees with its baseline: ${drift.replace(/_/g, " ")}.`,
    });
  }

  if (input.baseline === "first_sighting") {
    alerts.push({
      code: "first_sighting",
      severity: "info",
      detail: `${BRAND.name} has never observed this endpoint before. There is no history to compare against, and this verdict says so rather than implying safety.`,
    });
  }
  return alerts;
}

/**
 * The verdict itself, identical whether it was paid for or not.
 *
 * Selling a *different* answer to paying callers would make the free one a
 * demo, and a trust product whose free verdict is a demo is not trustworthy.
 * What money buys is the signature underneath it, which is the only part
 * nobody else can produce.
 */
export async function computeTrustApiVerdict(input: {
  resource: unknown;
  method?: unknown;
  budgetUsdc: number;
  capability?: string;
  requesterWallet?: string;
  now?: Date;
  probeFetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<TrustApiVerdict> {
  const resource = normalizeResourceUrl(input.resource);
  const method = parseProbeMethod(input.method);
  const capability = typeof input.capability === "string" && input.capability.trim()
    ? input.capability.trim().slice(0, 64)
    : "unspecified";

  if (!Number.isFinite(input.budgetUsdc) || input.budgetUsdc <= 0
    || input.budgetUsdc > TRUST_API_MAX_BUDGET_USDC) {
    throw new TrustApiError("budget_invalid", 400,
      `budgetUsdc must be between 0 and ${TRUST_API_MAX_BUDGET_USDC}.`);
  }

  const now = input.now ?? new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TRUST_API_VERDICT_TTL_SECONDS * 1000).toISOString();
  const resourceKey = resourceKeyFor(method, resource);

  const history = await loadEndpointObservations(resourceKey);
  const lastObservation = history[0] ?? null;

  /* The yardstick. With history, drift means "changed since Veyra last looked",
     which is the question an agent actually has. Without it, Veyra reads the
     challenge once to learn what this endpoint claims, and reports that it had
     nothing to compare against. */
  let baseline: ExpectationBaseline;
  let baselineAccept: ObservedAccept | null = null;
  if (lastObservation?.observed_pay_to && lastObservation.observed_price_usdc !== null) {
    baseline = "veyra_history";
    baselineAccept = {
      scheme: "exact",
      network: lastObservation.network,
      asset: lastObservation.observed_asset ?? "",
      payTo: lastObservation.observed_pay_to,
      amountAtomic: String(Math.round(Number(lastObservation.observed_price_usdc) * 1e6)),
      priceUsdc: Number(lastObservation.observed_price_usdc),
      maxTimeoutSeconds: null,
      gatewayBatched: false,
    };
  } else {
    baseline = "first_sighting";
    const bootstrap = await readX402Challenge(resource, method, input.probeFetchImpl);
    baselineAccept = selectBaselineAccept(bootstrap.accepts);
  }

  if (!baselineAccept || !isAddress(baselineAccept.payTo)) {
    // Nothing payable was published, so there is nothing to have an opinion
    // about. This is a refusal, not a low score.
    const probe = await probeX402Resource(
      expectationFromAccept({
        candidateId: `direct:${resourceKey.slice(0, 16)}`,
        resource,
        method,
        accept: baselineAccept ?? {
          scheme: "exact", network: "", asset: "", payTo: zeroAddress,
          amountAtomic: "0", priceUsdc: 0, maxTimeoutSeconds: null, gatewayBatched: false,
        },
      }),
      { fetchImpl: input.probeFetchImpl, now },
    );
    void recordEndpointObservation({
      resourceKey, resourceUrl: resource, method,
      network: baselineAccept?.network ?? "", probe,
      asset: baselineAccept?.asset ?? null,
    });
    throw new TrustApiError(
      probe.reachable ? "no_payable_challenge" : "endpoint_unreachable",
      probe.reachable ? 422 : 502,
      probe.reachable
        ? "The endpoint published no payment option Veyra can evaluate."
        : "The endpoint did not answer.",
    );
  }

  const expectation = expectationFromAccept({
    candidateId: `direct:${resourceKey.slice(0, 16)}`,
    resource,
    method,
    accept: baselineAccept,
  });
  const probe = await probeX402Resource(expectation, { fetchImpl: input.probeFetchImpl, now });

  void recordEndpointObservation({
    resourceKey,
    resourceUrl: resource,
    method,
    network: baselineAccept.network,
    probe,
    asset: baselineAccept.asset,
  });

  const evidence = history.length > 0
    ? buildEvidenceWithHistory(probe, history)
    : buildX402ProbeEvidence([probe]);
  const coverage = marketplaceEvidenceCoverage(evidence);
  const confidenceLevel = evidence.qualityScore.confidenceLevel;
  const confidence = confidenceLevel === "high" ? 0.9 : confidenceLevel === "medium" ? 0.6 : 0.3;

  const summary = summariseEndpointHistory(resourceKey, history, probe.observation);

  const liveAccept: ObservedAccept = {
    ...baselineAccept,
    payTo: probe.observedPayTo ?? baselineAccept.payTo,
    priceUsdc: probe.observedPriceUsdc ?? baselineAccept.priceUsdc,
    amountAtomic: probe.observedPriceUsdc !== null
      ? String(Math.round(probe.observedPriceUsdc * 1e6))
      : baselineAccept.amountAtomic,
  };

  const requestedValueUsdc = liveAccept.priceUsdc ?? 0;
  const evidenceHash = hashCanonical({
    schema: "veyra.trust-api-verdict.v1",
    resourceKey,
    probeVersion: X402_PROBE_VERSION,
    integrityScore: probe.integrityScore,
    observations: summary.observations,
    coverage: coverage.coverage.toFixed(6),
    payTo: liveAccept.payTo.toLowerCase(),
    priceUsdc: requestedValueUsdc.toFixed(6),
    probedAt: probe.probedAt,
  });

  const candidate = candidateFromAccept({ resource, method, accept: liveAccept, capability });
  const trustDecision = buildMarketplaceTrustDecision({
    requesterWallet: input.requesterWallet && isAddress(input.requesterWallet)
      ? getAddress(input.requesterWallet)
      : zeroAddress,
    payTo: getAddress(liveAccept.payTo),
    candidate,
    integrityScore: probe.integrityScore,
    coverage: coverage.coverage,
    confidence,
    evidenceHash,
    capability,
    requestedValueUsdc,
    issuedAt,
    expiresAt: new Date(now.getTime() + TRUST_DECISION_EXPIRY_SECONDS * 1000).toISOString(),
    // A payee that moved since Veyra last looked is exactly the condition the
    // policy must treat as hostile rather than merely note.
    riskSignals: summary.payToNow
      && probe.observedPayTo
      && summary.payToNow !== probe.observedPayTo.toLowerCase()
      ? ["COUNTERPARTY_FARMING"]
      : [],
  });

  const alerts = alertsFrom({
    baseline,
    reachable: probe.reachable,
    challengeParseable: probe.challengeParseable,
    drift: probe.catalogDrift,
    changes: summary.changes,
    liveAccept,
    lastPayTo: lastObservation?.observed_pay_to?.toLowerCase() ?? null,
  });

  const maxExposureUsdc = Math.min(
    input.budgetUsdc,
    trustDecision.policy.maxValueUsdc,
    requestedValueUsdc > 0 ? requestedValueUsdc : input.budgetUsdc,
  );
  const granted = trustDecision.decision !== "DENY"
    && trustDecision.decision !== "REVIEW_REQUIRED"
    && requestedValueUsdc <= input.budgetUsdc
    && alerts.every((alert) => alert.severity !== "critical");

  const explanation = granted
    ? `${candidate.origin} answers a conformant challenge at integrity ${probe.integrityScore}/100, `
      + `with ${summary.observations} observation(s) on record and ${Math.round(coverage.coverage * 100)}% evidence coverage. `
      + `${BRAND.name} would pay up to ${maxExposureUsdc.toFixed(6)} USDC here.`
    : alerts.find((alert) => alert.severity === "critical")?.detail
      ?? (requestedValueUsdc > input.budgetUsdc
        ? `The endpoint asks ${requestedValueUsdc.toFixed(6)} USDC, above the ${input.budgetUsdc.toFixed(6)} USDC budget.`
        : `Evidence does not support paying this counterparty: ${trustDecision.reasons.join(", ")}.`);

  return {
    verdictVersion: TRUST_API_VERDICT_VERSION,
    probeVersion: X402_PROBE_VERSION,
    policyVersion: TRUST_POLICY_VERSION,
    resource,
    resourceKey,
    method,
    baseline,
    decision: trustDecision.decision,
    granted,
    payTo: liveAccept.payTo,
    network: liveAccept.network,
    priceUsdc: requestedValueUsdc,
    maxExposureUsdc,
    postCallVerificationRequired: trustDecision.policy.evaluatorRequired,
    probe: {
      reachable: probe.reachable,
      respondedWith402: probe.respondedWith402,
      challengeParseable: probe.challengeParseable,
      httpStatus: probe.httpStatus,
      latencyMs: probe.latencyMs,
      integrityScore: probe.integrityScore,
      catalogDrift: probe.catalogDrift,
      criticalFailure: probe.criticalFailure,
      failedChecks: probe.checks.filter((check) => !check.passed).map((check) => check.id),
    },
    evidence: {
      coverage: Math.round(coverage.coverage * 100),
      observedDimensions: coverage.observed,
      missingDimensions: MARKETPLACE_EVIDENCE_DIMENSIONS.filter(
        (dimension) => !coverage.observed.includes(dimension),
      ),
      statisticalEvidenceAvailable: evidence.statisticalEvidenceAvailable,
      observations: summary.observations,
    },
    alerts,
    reasons: trustDecision.reasons,
    explanation,
    evidenceHash,
    issuedAt,
    expiresAt,
    trustDecision,
  };
}

/** A stable id for a verdict, so a caller can reference one in an outcome. */
export function newVerdictId() {
  return `vvd_${randomBytes(8).toString("hex")}`;
}
