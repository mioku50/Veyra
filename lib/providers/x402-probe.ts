/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAddress } from "viem";
import {
  computeApiQualityMetrics,
  calculateQualityScore,
  getConfidenceLevel,
} from "./api-quality.ts";
import type {
  ApiQualityMetrics,
  ApiQualityObservation,
  ApiQualityScore,
  ErrorCategory,
  HttpStatusClass,
} from "./api-quality-types.ts";
import { fetchWithSsrfProtection } from "../seller/ssrf.ts";

/**
 * Free x402 challenge probe for externally discovered endpoints.
 *
 * A marketplace seller has no Veyra reputation and no Arc proof history, so a
 * statistical score is unavailable on first contact. What *is* available on
 * first contact is deterministic protocol evidence: does the endpoint answer,
 * does it speak x402, and does the challenge it serves match what the catalog
 * advertises. Those are single-observation facts, and they are what this module
 * measures.
 *
 * Statistical reliability (uptime, latency distribution) is delegated to the
 * existing api-quality engine, which honestly reports "Insufficient data" until
 * enough observations accumulate. This module never fabricates that history.
 *
 * The probe NEVER sends a payment header and never settles anything.
 */

export const X402_PROBE_VERSION = "veyra-x402-probe-v1" as const;

export const X402_PROBE_LIMITS = {
  timeoutMs: 8_000,
  maxResponseBytes: 256 * 1024,
  latencyBudgetMs: 2_500,
  latencyFailMs: 8_000,
  maxSaneTimeoutSeconds: 3_600,
  // Circle Gateway batches settlement, so its accepts legitimately publish a
  // week-long authorization window (the same 604900s constant the Veyra x402
  // seller uses). Judging those against the vanilla ceiling would flag every
  // conformant Gateway seller.
  maxSaneGatewayTimeoutSeconds: 604_900,
} as const;

export type X402ProbeSeverity = "critical" | "major" | "minor";

export type X402ProbeCheck = {
  id: string;
  passed: boolean;
  severity: X402ProbeSeverity;
  weight: number;
  detail: string;
};

/** Non-critical weights sum to 100. Critical checks gate the whole score. */
const CHECK_WEIGHTS = {
  payto_address_valid: 15,
  price_matches_catalog: 20,
  settlement_surface_automatable: 15,
  challenge_latency_ok: 15,
  declares_input_schema: 10,
  declares_output_schema: 10,
  timeout_window_sane: 10,
  provider_documented: 5,
} as const;

export type X402ProbeExpectation = {
  candidateId: string;
  resource: string;
  method: "GET" | "POST";
  network: string;
  payTo: string;
  asset: string;
  amountAtomic: string;
  priceUsdc: number;
  maxTimeoutSeconds: number | null;
  siwx: boolean;
  supportsVanillaX402: boolean;
  supportsCircleGateway: boolean;
  gatewayBatched: boolean;
  declaresInputSchema: boolean;
  declaresOutputSchema: boolean;
  docsUrl: string | null;
};

export type ChallengeTransport = "payment_required_header" | "response_body" | "none";

export type X402ProbeResult = {
  probeVersion: typeof X402_PROBE_VERSION;
  candidateId: string;
  resource: string;
  probedAt: string;
  challengeTransport: ChallengeTransport;
  reachable: boolean;
  httpStatus: number | null;
  httpStatusClass: HttpStatusClass;
  respondedWith402: boolean;
  challengeParseable: boolean;
  observedPriceUsdc: number | null;
  observedPayTo: string | null;
  catalogDrift: string[];
  latencyMs: number | null;
  checks: X402ProbeCheck[];
  criticalFailure: string | null;
  integrityScore: number;
  errorCategory: ErrorCategory;
  observation: ApiQualityObservation;
};

export type X402ProbeEvidence = {
  probes: X402ProbeResult[];
  integrityScore: number;
  metrics: ApiQualityMetrics;
  qualityScore: ApiQualityScore;
  statisticalEvidenceAvailable: boolean;
};

function statusClass(status: number | null): HttpStatusClass {
  if (status === null) return "network_error";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "network_error";
}

function atomicToUsdc(amount: unknown): number | null {
  const raw = String(amount ?? "").trim();
  if (!/^\d{1,30}$/.test(raw)) return null;
  return Number(BigInt(raw)) / 1_000_000;
}

function latencyScore(latencyMs: number | null): number {
  if (latencyMs === null) return 0;
  if (latencyMs <= X402_PROBE_LIMITS.latencyBudgetMs) return 1;
  if (latencyMs >= X402_PROBE_LIMITS.latencyFailMs) return 0;
  const span = X402_PROBE_LIMITS.latencyFailMs - X402_PROBE_LIMITS.latencyBudgetMs;
  return Math.max(0, 1 - (latencyMs - X402_PROBE_LIMITS.latencyBudgetMs) / span);
}

/**
 * Decodes the `payment-required` response header.
 *
 * This is where real x402 v2 servers put the challenge: base64-encoded JSON in
 * the header, with an empty `{}` body. A probe that only reads the body sees a
 * conformant seller as unparseable, so the header is tried first.
 */
export function decodePaymentRequiredHeader(value: string | null): unknown {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  for (const candidate of [trimmed, trimmed.replace(/-/g, "+").replace(/_/g, "/")]) {
    try {
      const decoded = Buffer.from(candidate, "base64").toString("utf8");
      if (!decoded.trim().startsWith("{")) continue;
      return JSON.parse(decoded);
    } catch {
      // fall through to the next decoding attempt
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Extracts the accepts array from a 402 challenge body, tolerating both the
 * bare `{accepts: []}` form and the wrapped `{x402Version, accepts: []}` form.
 */
export function parseChallengeAccepts(body: unknown): Array<Record<string, unknown>> | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const accepts = Array.isArray(value.accepts)
    ? value.accepts
    : Array.isArray((value.paymentRequirements as unknown))
      ? value.paymentRequirements as unknown[]
      : null;
  if (!accepts) return null;
  return accepts.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object");
}

/**
 * Compares a live challenge against the catalog entry. Any mismatch on money
 * fields is catalog drift - the seller changed price or payee since indexing,
 * which is exactly the condition an agent must not pay through blindly.
 */
export function compareChallengeToCatalog(
  accepts: Array<Record<string, unknown>>,
  expected: X402ProbeExpectation,
): { matched: Record<string, unknown> | null; drift: string[] } {
  const sameNetwork = accepts.filter((accept) =>
    String(accept.network || "").toLowerCase() === expected.network.toLowerCase());
  if (sameNetwork.length === 0) {
    return { matched: null, drift: ["network_absent_from_challenge"] };
  }
  const byPayTo = sameNetwork.find((accept) =>
    String(accept.payTo || "").toLowerCase() === expected.payTo.toLowerCase());
  const drift: string[] = [];
  const candidate = byPayTo ?? sameNetwork[0];
  if (!byPayTo) drift.push("payto_changed");
  if (String(candidate.asset || "").toLowerCase() !== expected.asset.toLowerCase()) {
    drift.push("asset_changed");
  }
  const amount = String(candidate.amount ?? candidate.maxAmountRequired ?? "");
  if (amount !== expected.amountAtomic) drift.push("price_changed");
  return { matched: candidate, drift };
}

export async function probeX402Resource(
  expected: X402ProbeExpectation,
  options: {
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    now?: Date;
    timeoutMs?: number;
  } = {},
): Promise<X402ProbeResult> {
  const startedAtDate = options.now ?? new Date();
  const startedAt = startedAtDate.toISOString();
  const startMs = Date.now();
  // Wall-clock time can step backwards (NTP correction, VM clock sync), which
  // would yield a negative latency and a meaningless score. Measure elapsed
  // time on the monotonic clock instead.
  const startTick = performance.now();
  const elapsedMs = () => Math.max(0, Math.round(performance.now() - startTick));

  let status: number | null = null;
  let latencyMs: number | null = null;
  let bodyText: string | null = null;
  let paymentRequiredHeader: string | null = null;
  let errorCategory: ErrorCategory = "none";

  const doFetch = options.fetchImpl
    ?? ((url: string, init: RequestInit) => fetchWithSsrfProtection(url, init, {
      maxTimeoutMs: options.timeoutMs ?? X402_PROBE_LIMITS.timeoutMs,
      maxResponseSizeBytes: X402_PROBE_LIMITS.maxResponseBytes,
      label: "x402_discovery_probe",
    }));

  try {
    const init: RequestInit = {
      method: expected.method,
      headers: {
        accept: "application/json",
        // No X-PAYMENT header: this probe reads the challenge and stops there.
      },
    };
    if (expected.method === "POST") {
      init.body = "{}";
      init.headers = { ...init.headers as Record<string, string>, "content-type": "application/json" };
    }
    const response = await doFetch(expected.resource, init);
    latencyMs = elapsedMs();
    status = response.status;
    paymentRequiredHeader = response.headers.get("payment-required");
    bodyText = await response.text();
  } catch (error) {
    latencyMs = elapsedMs();
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    errorCategory = message.includes("timed out") || message.includes("timeout")
      ? "timeout"
      : "network";
  }

  const reachable = status !== null;
  const respondedWith402 = status === 402;
  let parsedBody: unknown = null;
  if (bodyText) {
    try { parsedBody = JSON.parse(bodyText); } catch { parsedBody = null; }
  }
  // Header first: that is where conformant x402 v2 servers put the challenge.
  const headerChallenge = respondedWith402
    ? parseChallengeAccepts(decodePaymentRequiredHeader(paymentRequiredHeader))
    : null;
  const bodyChallenge = respondedWith402 && !headerChallenge
    ? parseChallengeAccepts(parsedBody)
    : null;
  const accepts = headerChallenge ?? bodyChallenge;
  const challengeTransport: ChallengeTransport = headerChallenge
    ? "payment_required_header"
    : bodyChallenge
      ? "response_body"
      : "none";
  const challengeParseable = Array.isArray(accepts) && accepts.length > 0;
  const comparison = challengeParseable
    ? compareChallengeToCatalog(accepts!, expected)
    : { matched: null, drift: [] as string[] };

  const observedPriceUsdc = comparison.matched
    ? atomicToUsdc(comparison.matched.amount ?? comparison.matched.maxAmountRequired)
    : null;
  const observedPayTo = comparison.matched ? String(comparison.matched.payTo || "") || null : null;

  const checks: X402ProbeCheck[] = [];
  const critical = (id: string, passed: boolean, detail: string) => {
    checks.push({ id, passed, severity: "critical", weight: 0, detail });
    return passed;
  };
  const scored = (
    id: keyof typeof CHECK_WEIGHTS,
    passed: boolean,
    detail: string,
    severity: X402ProbeSeverity = "major",
  ) => {
    checks.push({ id, passed, severity, weight: CHECK_WEIGHTS[id], detail });
    return passed;
  };

  critical("endpoint_reachable", reachable, reachable
    ? `Endpoint answered with HTTP ${status}.`
    : `Endpoint did not answer (${errorCategory}).`);
  critical("x402_challenge_returned", respondedWith402, respondedWith402
    ? "Endpoint returned an HTTP 402 payment challenge."
    : `Expected HTTP 402, observed ${status ?? "no response"}.`);
  critical("challenge_parseable", challengeParseable, challengeParseable
    ? `Challenge published ${accepts!.length} payment option(s).`
    : "Challenge body could not be parsed into an accepts[] array.");
  critical("accepts_matches_catalog", challengeParseable && comparison.drift.length === 0,
    comparison.drift.length === 0
      ? "Live challenge matches the catalog network, asset, payee and price."
      : `Catalog drift detected: ${comparison.drift.join(", ")}.`);
  critical("automatable_without_siwx", !expected.siwx, expected.siwx
    ? "Endpoint requires Sign-in-With-X browser auth and cannot be paid programmatically."
    : "No interactive sign-in required.");

  scored("payto_address_valid", isAddress(expected.payTo),
    isAddress(expected.payTo)
      ? "Payee is a well-formed EVM address."
      : "Payee address is malformed.");
  scored("price_matches_catalog",
    observedPriceUsdc !== null && Math.abs(observedPriceUsdc - expected.priceUsdc) < 1e-9,
    observedPriceUsdc === null
      ? "Live price could not be read from the challenge."
      : `Live price ${observedPriceUsdc} USDC vs catalog ${expected.priceUsdc} USDC.`);
  scored("settlement_surface_automatable",
    expected.supportsVanillaX402 || expected.supportsCircleGateway,
    `vanilla=${expected.supportsVanillaX402} gateway=${expected.supportsCircleGateway}`);
  scored("challenge_latency_ok", latencyScore(latencyMs) >= 1,
    latencyMs === null
      ? "No latency measurement available."
      : `Challenge handshake took ${latencyMs}ms (budget ${X402_PROBE_LIMITS.latencyBudgetMs}ms).`,
    "minor");
  scored("declares_input_schema", expected.declaresInputSchema,
    expected.declaresInputSchema
      ? "Provider publishes an input schema."
      : "No input schema published - request shape must be guessed.",
    "minor");
  scored("declares_output_schema", expected.declaresOutputSchema,
    expected.declaresOutputSchema
      ? "Provider publishes an output schema."
      : "No output schema published - the response cannot be validated after payment.",
    "minor");
  const timeoutCeiling = expected.gatewayBatched
    ? X402_PROBE_LIMITS.maxSaneGatewayTimeoutSeconds
    : X402_PROBE_LIMITS.maxSaneTimeoutSeconds;
  scored("timeout_window_sane",
    expected.maxTimeoutSeconds !== null
      && expected.maxTimeoutSeconds > 0
      && expected.maxTimeoutSeconds <= timeoutCeiling,
    `maxTimeoutSeconds=${expected.maxTimeoutSeconds ?? "absent"} ceiling=${timeoutCeiling}`,
    "minor");
  scored("provider_documented", Boolean(expected.docsUrl),
    expected.docsUrl ? `Docs at ${expected.docsUrl}.` : "No documentation URL published.",
    "minor");

  const criticalFailure = checks.find((check) => check.severity === "critical" && !check.passed)?.id
    ?? null;
  const earned = checks
    .filter((check) => check.severity !== "critical")
    .reduce((sum, check) => {
      if (check.id === "challenge_latency_ok") return sum + check.weight * latencyScore(latencyMs);
      return sum + (check.passed ? check.weight : 0);
    }, 0);
  const integrityScore = criticalFailure ? 0 : Math.round(earned);

  if (errorCategory === "none" && !respondedWith402) errorCategory = "invalid_response";
  if (errorCategory === "none" && !challengeParseable) errorCategory = "invalid_response";

  const observation: ApiQualityObservation = {
    observationId: `x402probe_${expected.candidateId}_${startMs}`,
    serviceId: expected.candidateId,
    sellerPublicId: null,
    startedAt,
    completedAt: new Date(startMs + (latencyMs ?? 0)).toISOString(),
    quotedPriceUsdc: observedPriceUsdc,
    paidAmountUsdc: null,
    latencyMs,
    httpStatusClass: respondedWith402 ? "4xx" : statusClass(status),
    endpointReached: reachable,
    responseSchemaValid: challengeParseable ? comparison.drift.length === 0 : false,
    responseWithinSizeLimit: true,
    paymentRequired: respondedWith402,
    paymentAuthorized: null,
    paymentSettled: null,
    executionCompleted: false,
    arcProofVerified: false,
    errorCategory,
    source: "x402_discovery_probe",
    createdAt: startedAt,
  };

  return {
    probeVersion: X402_PROBE_VERSION,
    candidateId: expected.candidateId,
    resource: expected.resource,
    probedAt: startedAt,
    challengeTransport,
    reachable,
    httpStatus: status,
    httpStatusClass: statusClass(status),
    respondedWith402,
    challengeParseable,
    observedPriceUsdc,
    observedPayTo,
    catalogDrift: comparison.drift,
    latencyMs,
    checks,
    criticalFailure,
    integrityScore,
    errorCategory,
    observation,
  };
}

/**
 * Folds one or more probes into evidence. Deterministic integrity is averaged;
 * statistical quality is delegated to api-quality, which returns
 * "Insufficient data" until it has enough observations to justify a number.
 */
export function buildX402ProbeEvidence(probes: X402ProbeResult[]): X402ProbeEvidence {
  const observations = probes.map((probe) => probe.observation);
  const metrics = computeApiQualityMetrics(observations);
  const qualityScore = calculateQualityScore(metrics, observations);
  const integrityScore = probes.length === 0
    ? 0
    : Math.round(probes.reduce((sum, probe) => sum + probe.integrityScore, 0) / probes.length);
  return {
    probes,
    integrityScore,
    metrics,
    qualityScore: { ...qualityScore, confidenceLevel: getConfidenceLevel(observations) },
    statisticalEvidenceAvailable: qualityScore.hasSufficientData,
  };
}
