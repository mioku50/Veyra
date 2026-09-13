/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import { isAddress } from "viem";
import {
  decodePaymentRequiredHeader,
  parseChallengeAccepts,
  X402_PROBE_LIMITS,
  type X402ProbeExpectation,
} from "../../providers/x402-probe.ts";
import { fetchWithSsrfProtection } from "../../seller/ssrf.ts";

export type ProbeMethod = "GET" | "POST";

export class TrustApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly detail?: string,
  ) {
    super(code);
    this.name = "TrustApiError";
  }
}

/**
 * A resource identity that survives catalog churn.
 *
 * The same endpoint gets re-listed with a different catalog id, a trailing
 * slash, or a differently-cased host; all of those are the same place to send
 * money, and evidence about it must accumulate in one bucket. Query strings are
 * kept - they routinely select a different resource - but their order is not
 * meaningful, so they are sorted.
 */
export function normalizeResourceUrl(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new TrustApiError("resource_required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TrustApiError("resource_not_a_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TrustApiError("resource_scheme_unsupported");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443")
    || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  url.searchParams.sort();
  return url.toString();
}

export function resourceKeyFor(method: ProbeMethod, normalizedUrl: string): string {
  return createHash("sha256").update(`${method} ${normalizedUrl}`).digest("hex");
}

export function parseProbeMethod(raw: unknown): ProbeMethod {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "POST";
  if (value !== "GET" && value !== "POST") throw new TrustApiError("method_unsupported");
  return value;
}

function atomicToUsdc(amount: unknown): number | null {
  const raw = String(amount ?? "").trim();
  if (!/^\d{1,30}$/.test(raw)) return null;
  return Number(BigInt(raw)) / 1_000_000;
}

export type ObservedAccept = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  priceUsdc: number | null;
  maxTimeoutSeconds: number | null;
  gatewayBatched: boolean;
};

export function readAccept(raw: Record<string, unknown>): ObservedAccept {
  const scheme = String(raw.scheme ?? "");
  const amountAtomic = String(raw.amount ?? raw.maxAmountRequired ?? "");
  const timeout = Number(raw.maxTimeoutSeconds);
  const extra = (raw.extra && typeof raw.extra === "object")
    ? raw.extra as Record<string, unknown>
    : {};
  return {
    scheme,
    network: String(raw.network ?? ""),
    asset: String(raw.asset ?? ""),
    payTo: String(raw.payTo ?? ""),
    amountAtomic,
    priceUsdc: atomicToUsdc(amountAtomic),
    maxTimeoutSeconds: Number.isFinite(timeout) ? timeout : null,
    gatewayBatched: /gateway/i.test(scheme) || /gateway/i.test(String(extra.name ?? "")),
  };
}

/** Cheapest accept wins the baseline, matching how a buyer would pick. */
export function selectBaselineAccept(accepts: ObservedAccept[]): ObservedAccept | null {
  const payable = accepts.filter((accept) => accept.priceUsdc !== null && isAddress(accept.payTo));
  if (payable.length === 0) return accepts[0] ?? null;
  return payable.sort((left, right) => (left.priceUsdc ?? 0) - (right.priceUsdc ?? 0))[0];
}

/**
 * One unpaid read of the endpoint's challenge, used only to learn what an
 * endpoint advertises the very first time Veyra sees it. It never sends a
 * payment header, and its result is never recorded as an observation - the
 * scored probe that follows is what becomes evidence.
 */
export async function readX402Challenge(
  resource: string,
  method: ProbeMethod,
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<{ accepts: ObservedAccept[]; httpStatus: number | null }> {
  const doFetch = fetchImpl
    ?? ((url: string, init: RequestInit) => fetchWithSsrfProtection(url, init, {
      maxTimeoutMs: X402_PROBE_LIMITS.timeoutMs,
      maxResponseSizeBytes: X402_PROBE_LIMITS.maxResponseBytes,
      label: "x402_trust_api_bootstrap",
    }));

  const init: RequestInit = { method, headers: { accept: "application/json" } };
  if (method === "POST") {
    init.body = "{}";
    init.headers = { ...init.headers as Record<string, string>, "content-type": "application/json" };
  }

  let response: Response;
  try {
    response = await doFetch(resource, init);
  } catch {
    return { accepts: [], httpStatus: null };
  }

  const header = parseChallengeAccepts(decodePaymentRequiredHeader(
    response.headers.get("payment-required"),
  ));
  let parsed = header;
  if (!parsed) {
    try {
      parsed = parseChallengeAccepts(JSON.parse(await response.text()));
    } catch {
      parsed = null;
    }
  }
  return {
    accepts: (parsed ?? []).map(readAccept),
    httpStatus: response.status,
  };
}

export type ExpectationBaseline = "catalog" | "veyra_history" | "first_sighting";

/**
 * Builds the yardstick the probe is scored against.
 *
 * What "drift" means depends entirely on this, which is why the baseline is
 * always reported alongside the verdict: drift against Circle's catalog means
 * the seller changed since it was indexed, drift against Veyra's own history
 * means the endpoint changed since we last looked, and on a first sighting
 * there is nothing to drift from and Veyra says so rather than implying safety.
 */
export function expectationFromAccept(input: {
  candidateId: string;
  resource: string;
  method: ProbeMethod;
  accept: ObservedAccept;
  declaresInputSchema?: boolean;
  declaresOutputSchema?: boolean;
  docsUrl?: string | null;
  siwx?: boolean;
}): X402ProbeExpectation {
  const { accept } = input;
  return {
    candidateId: input.candidateId,
    resource: input.resource,
    method: input.method,
    network: accept.network,
    payTo: accept.payTo,
    asset: accept.asset,
    amountAtomic: accept.amountAtomic,
    priceUsdc: accept.priceUsdc ?? 0,
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
    siwx: input.siwx ?? false,
    supportsVanillaX402: !accept.gatewayBatched,
    supportsCircleGateway: accept.gatewayBatched,
    gatewayBatched: accept.gatewayBatched,
    declaresInputSchema: input.declaresInputSchema ?? false,
    declaresOutputSchema: input.declaresOutputSchema ?? false,
    docsUrl: input.docsUrl ?? null,
  };
}
