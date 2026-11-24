"use client";

/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import type { TrustApiVerdict } from "@/lib/x402/trust-api/verdict";

const EXAMPLE_URL = "https://api.aisa.one/apis/v2/apollo/labels";

const DECISION_LABELS = {
  ALLOW: "Allow",
  ALLOW_WITH_LIMITS: "Allow with limits",
  REQUIRE_EVALUATOR: "Requires an evaluator",
  REVIEW_REQUIRED: "Review required",
  DENY: "Do not proceed",
} satisfies Record<TrustApiVerdict["decision"], string>;

type PublicVerdictPayload = Pick<
  TrustApiVerdict,
  | "resource"
  | "method"
  | "decision"
  | "granted"
  | "payTo"
  | "network"
  | "priceUsdc"
  | "postCallVerificationRequired"
  | "probe"
  | "alerts"
  | "reasons"
  | "explanation"
>;

type VerdictCheckResult = {
  verdict: PublicVerdictPayload;
  budgetUsdc: number;
};

function friendlyVerdictError(code: string | undefined, serverMessage: string | undefined, maxBudget: number): string {
  switch (code) {
    case "resource_required":
    case "resource_not_a_url":
      return `Enter a valid absolute HTTPS URL (for example, ${EXAMPLE_URL}).`;
    case "resource_scheme_unsupported":
      return "Only public HTTPS URLs are supported. Plain HTTP, localhost, and private network addresses cannot be checked.";
    case "arc_mainnet_not_offered":
      return "This endpoint responded with HTTP 402, but did not offer a supported Arc Mainnet USDC payment option.";
    case "no_payable_challenge":
      return "This endpoint answered without a readable HTTP 402 payment challenge for the selected method. Try choosing GET or POST explicitly.";
    case "endpoint_unreachable":
      return "The target endpoint did not answer or timed out during verification.";
    case "arc_quote_unavailable":
      return "The live Arc Mainnet USDC offer could not be confirmed from this endpoint right now.";
    case "budget_invalid":
      return `Enter an optional budget greater than 0 and at most ${maxBudget} USDC.`;
    case "rate_limited":
      return serverMessage || "Too many free checks from this address. Wait a moment and try again.";
    default:
      return serverMessage || "The live check is unavailable right now. Try again shortly.";
  }
}

function hostFromUrl(resource: string): string | null {
  try {
    return new URL(resource).hostname;
  } catch {
    return null;
  }
}

export function EndpointChecker({ maxBudget }: { maxBudget: number }) {
  const urlId = useId();
  const methodId = useId();
  const budgetId = useId();

  const [resource, setResource] = useState("");
  const [method, setMethod] = useState<"" | "GET" | "POST">("");
  const [budget, setBudget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerdictCheckResult | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const trimmed = resource.trim();
    setError(null);
    setResult(null);

    if (!trimmed) {
      setError(`Enter a valid absolute HTTPS URL (for example, ${EXAMPLE_URL}).`);
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      setError(`Enter a valid absolute HTTPS URL (for example, ${EXAMPLE_URL}).`);
      return;
    }

    if (parsedUrl.protocol !== "https:") {
      setError(
        "Only public HTTPS URLs are supported. Plain HTTP, localhost, and private network addresses cannot be checked.",
      );
      return;
    }

    let budgetUsdc: number | undefined;
    if (budget.trim()) {
      const parsedBudget = Number(budget);
      if (!Number.isFinite(parsedBudget) || parsedBudget <= 0 || parsedBudget > maxBudget) {
        setError(`Enter an optional budget greater than 0 and at most ${maxBudget} USDC.`);
        return;
      }
      budgetUsdc = parsedBudget;
    }

    const requestBody: { resource: string; method?: "GET" | "POST"; budgetUsdc?: number } = {
      resource: trimmed,
    };
    if (method) requestBody.method = method;
    if (budgetUsdc !== undefined) requestBody.budgetUsdc = budgetUsdc;

    setPending(true);
    try {
      const response = await fetch("/api/x402/v1/verdict", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Veyra-Source": "web",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(friendlyVerdictError(body?.error?.code, body?.error?.message, maxBudget));
        return;
      }
      if (
        !Object.hasOwn(DECISION_LABELS, body?.decision) ||
        body.signed !== false ||
        typeof body.granted !== "boolean" ||
        !Array.isArray(body.reasons) ||
        !Array.isArray(body.alerts)
      ) {
        throw new Error("Invalid verdict response");
      }
      setResult({
        verdict: body as PublicVerdictPayload,
        budgetUsdc: budgetUsdc ?? 1,
      });
    } catch {
      setError("The live check is unavailable right now. Try again shortly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label="Live endpoint verification"
      className="space-y-4 rounded-2xl border border-white/10 bg-[#0b0f19]/80 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Live Arc Mainnet check</h2>
          <p className="text-sm text-muted-foreground">
            One unpaid probe against the target URL — returns price, payee, and payment verdict without spending USDC.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setResource(EXAMPLE_URL);
            setMethod("");
            setError(null);
          }}
          disabled={pending}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-white/10 disabled:opacity-50"
        >
          Try example: api.aisa.one
        </button>
      </div>

      <form onSubmit={onSubmit} noValidate className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={urlId} className="block text-sm font-medium text-foreground">
            Paste an x402 URL
          </label>
          <input
            id={urlId}
            type="url"
            value={resource}
            onChange={(event) => setResource(event.target.value)}
            placeholder={EXAMPLE_URL}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            className="block w-full min-w-0 rounded-lg border border-white/15 bg-background px-3.5 py-2.5 font-mono text-sm text-foreground outline-none focus:border-primary"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <label htmlFor={methodId} className="block text-sm font-medium text-foreground">
              Method
            </label>
            <select
              id={methodId}
              value={method}
              onChange={(event) => setMethod(event.target.value as "" | "GET" | "POST")}
              disabled={pending}
              className="block w-full rounded-lg border border-white/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value="">Auto-detect</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={budgetId} className="block text-sm font-medium text-foreground">
              Budget (USDC, optional)
            </label>
            <input
              id={budgetId}
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              max={maxBudget}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder={`1 (max ${maxBudget})`}
              disabled={pending}
              className="block w-full rounded-lg border border-white/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
            />
          </div>

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60 sm:w-auto"
          >
            {pending ? "Checking…" : "Check endpoint"}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}

      <div aria-live="polite" aria-busy={pending}>
        {result && <EndpointVerdictCard result={result} />}
      </div>
    </section>
  );
}

function EndpointVerdictCard({ result: { verdict, budgetUsdc } }: { result: VerdictCheckResult }) {
  const priceUnknown = verdict.alerts.some((alert) => alert.code === "price_not_quoted");
  const quotedPrice = priceUnknown ? null : verdict.priceUsdc;
  const overBudget = quotedPrice !== null && quotedPrice > budgetUsdc;
  const decisionLabel = DECISION_LABELS[verdict.decision];
  const conditionsFailed =
    !verdict.granted && verdict.decision !== "DENY" && verdict.decision !== "REVIEW_REQUIRED";

  let heading = decisionLabel;
  if (conditionsFailed) heading = "Payment conditions not met";
  if (overBudget) heading = "Over budget";

  const host = hostFromUrl(verdict.resource);

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-background/80 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2.5">
        <h3 className="text-base font-semibold text-foreground">{heading}</h3>
        <span className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-xs text-muted-foreground">
          {verdict.method} · {verdict.network ?? "Arc Mainnet"}
        </span>
      </div>

      <p className="text-muted-foreground">{verdict.explanation}</p>

      <dl className="grid gap-3 sm:grid-cols-2">
        {heading !== decisionLabel && (
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Policy verdict</dt>
            <dd className="font-medium text-foreground">{decisionLabel}</dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Live price</dt>
          <dd className="font-mono text-foreground">
            {quotedPrice === null ? "Quoted per request (0 on empty probe)" : `${quotedPrice} USDC`}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Budget checked</dt>
          <dd className="font-mono text-foreground">{budgetUsdc} USDC</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Payee</dt>
          <dd className="break-all font-mono text-foreground">{verdict.payTo ?? "Unavailable"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Probe status</dt>
          <dd className="font-mono text-foreground">
            HTTP {verdict.probe.httpStatus ?? "—"}
            {verdict.probe.latencyMs !== null ? ` · ${verdict.probe.latencyMs} ms` : ""}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Endpoint</dt>
          <dd className="break-all font-mono text-xs text-muted-foreground">{verdict.resource}</dd>
        </div>
      </dl>

      {verdict.alerts.length > 0 && (
        <ul className="space-y-1.5 border-t border-white/10 pt-2.5 text-xs text-muted-foreground">
          {verdict.alerts.map((alert) => (
            <li key={`${alert.code}:${alert.detail}`} className="break-words">
              <span className="font-semibold uppercase text-foreground">{alert.severity}:</span> {alert.detail}
            </li>
          ))}
        </ul>
      )}

      {verdict.reasons.length > 0 && (
        <ul className="list-inside list-disc text-xs text-muted-foreground">
          {verdict.reasons.map((reason) => (
            <li key={reason}>{reason.replaceAll("_", " ").toLowerCase()}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2.5 text-xs text-muted-foreground">
        <span>
          Unsigned verdict from {BRAND.name}. No payment sent.
        </span>
        {host && (
          <Link
            href={`/check?q=${encodeURIComponent(host)}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            View host in Arc index
          </Link>
        )}
      </div>
    </div>
  );
}
