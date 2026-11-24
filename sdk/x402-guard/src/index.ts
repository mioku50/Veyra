/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */

export const DEFAULT_VEYRA_VERDICT_URL = "https://agent-commerce-six.vercel.app/api/x402/v1/verdict";

export type PreflightSignal = {
  code: string;
  detail: string;
  meta?: Record<string, string | number | null>;
};

export type VerdictPreflight = {
  result: "block" | "pass";
  blocking: PreflightSignal[];
  notes: PreflightSignal[];
};

export type VeyraVerdictResponse = {
  decision?: string;
  granted?: boolean;
  payTo?: string | null;
  network?: string | null;
  priceUsdc?: number | null;
  postCallVerificationRequired?: boolean;
  preflight?: VerdictPreflight;
  [key: string]: unknown;
};

export type GuardedFetchOptions = {
  budgetUsdc: number;
  verdictUrl?: string;
  onVeyraUnavailable?: "block" | "allow";
  method?: "GET" | "POST";
  verdictHeaders?: Record<string, string>;
  verdictTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class VeyraBlockedError extends Error {
  readonly resource: string;
  readonly method: string;
  readonly blocking: PreflightSignal[];
  readonly notes: PreflightSignal[];
  readonly unavailable: boolean;
  readonly verdict?: VeyraVerdictResponse;

  constructor(input: {
    message: string;
    resource: string;
    method: string;
    blocking: PreflightSignal[];
    notes?: PreflightSignal[];
    unavailable?: boolean;
    verdict?: VeyraVerdictResponse;
  }) {
    super(input.message);
    this.name = "VeyraBlockedError";
    this.resource = input.resource;
    this.method = input.method;
    this.blocking = input.blocking;
    this.notes = input.notes ?? [];
    this.unavailable = input.unavailable ?? false;
    this.verdict = input.verdict;
  }
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined, override?: "GET" | "POST"): "GET" | "POST" {
  if (override) return override;
  const raw = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return raw === "POST" ? "POST" : "GET";
}

function unavailableSignal(detail: string): PreflightSignal[] {
  return [{ code: "veyra_unavailable", detail }];
}

export async function guardedFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: GuardedFetchOptions,
): Promise<Response> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const upstream = await fetchFn(input, init);
  if (upstream.status !== 402) return upstream;

  const resource = input instanceof Request ? input.url : String(input);
  const method = requestMethod(input, init, options.method);
  const verdictUrl = options.verdictUrl ?? DEFAULT_VEYRA_VERDICT_URL;
  const failMode = options.onVeyraUnavailable ?? "block";

  let verdict: VeyraVerdictResponse;
  try {
    const res = await fetchFn(verdictUrl, {
      method: "POST",
      headers: {
        ...options.verdictHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resource, method, budgetUsdc: options.budgetUsdc }),
      signal: AbortSignal.timeout(options.verdictTimeoutMs ?? 15_000),
    });
    if (!res.ok) {
      throw new Error(`verdict_http_${res.status}`);
    }
    const body = (await res.json()) as VeyraVerdictResponse | null;
    if (!body?.preflight || (body.preflight.result !== "pass" && body.preflight.result !== "block")) {
      throw new Error("verdict_malformed");
    }
    verdict = body;
  } catch (error) {
    if (failMode === "allow") return upstream;
    const reason = error instanceof Error ? error.message : "unknown_error";
    throw new VeyraBlockedError({
      message: `Veyra preflight unavailable (${reason}); failing closed before payment.`,
      resource,
      method,
      blocking: unavailableSignal(`Veyra verdict unavailable: ${reason}.`),
      unavailable: true,
    });
  }

  if (verdict.preflight?.result === "block") {
    const details = verdict.preflight.blocking.map((signal) => signal.code).join(", ") || "blocked";
    throw new VeyraBlockedError({
      message: `Veyra preflight blocked payment to ${resource}: ${details}.`,
      resource,
      method,
      blocking: verdict.preflight.blocking,
      notes: verdict.preflight.notes ?? [],
      verdict,
    });
  }

  return upstream;
}

export function createGuardedFetch(options: GuardedFetchOptions): typeof fetch {
  return (input, init) => guardedFetch(input, init, options);
}
