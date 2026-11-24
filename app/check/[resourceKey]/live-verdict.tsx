"use client";

/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { useId, useState, type FormEvent } from "react";
import type { TrustApiVerdict } from "@/lib/x402/trust-api/verdict";

const labels = {
  ALLOW: "Allow",
  ALLOW_WITH_LIMITS: "Allow with limits",
  REQUIRE_EVALUATOR: "Requires an evaluator",
  REVIEW_REQUIRED: "Review required",
  DENY: "Do not proceed",
} satisfies Record<TrustApiVerdict["decision"], string>;

type LiveVerdict = Pick<
  TrustApiVerdict,
  "decision" | "granted" | "payTo" | "priceUsdc" | "postCallVerificationRequired" | "reasons" | "alerts" | "explanation"
>;

type CheckResult = { verdict: LiveVerdict; budgetUsdc: number };

type Props = {
  resource: string;
  method: "GET" | "POST";
  listedPrice: string;
  maxBudget: number;
};

export function LiveVerdictForm({ resource, method, listedPrice, maxBudget }: Props) {
  const budgetId = useId();
  const listedAmount = Number(listedPrice);
  const [budget, setBudget] = useState(
    listedAmount > maxBudget ? String(maxBudget) : listedAmount > 0 ? listedPrice : "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const budgetUsdc = Number(budget);
    setError(null);
    setResult(null);
    if (!budget.trim() || !Number.isFinite(budgetUsdc) || budgetUsdc <= 0 || budgetUsdc > maxBudget) {
      setError(`Enter a budget greater than 0 and at most ${maxBudget} USDC.`);
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/x402/v1/verdict", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Veyra-Source": "web",
        },
        body: JSON.stringify({ resource, method, budgetUsdc }),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(typeof body?.error?.message === "string" ? body.error.message : "The live check is unavailable.");
        return;
      }
      if (!Object.hasOwn(labels, body?.decision) || body.signed !== false || typeof body.granted !== "boolean"
        || !Array.isArray(body.reasons) || !Array.isArray(body.alerts)) {
        throw new Error("Invalid live verdict response");
      }
      setResult({ verdict: body as LiveVerdict, budgetUsdc });
    } catch {
      setError("The live check is unavailable. Try again shortly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="font-semibold">Free live verdict</h2>
      <p className="text-sm text-muted-foreground">Check the current Arc USDC offer against your budget.</p>
      <form onSubmit={check} noValidate className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-40 space-y-1 text-sm">
          <label htmlFor={budgetId}>Budget (USDC)</label>
          <input
            id={budgetId}
            type="number"
            inputMode="decimal"
            step="any"
            min={0}
            max={maxBudget}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            disabled={pending}
            required
            className="block w-full rounded-md border bg-background px-3 py-2"
          />
        </div>
        <button type="submit" disabled={pending} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-60">
          {pending ? "Checking…" : "Check live offer"}
        </button>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div aria-live="polite" aria-busy={pending}>
        {result && <VerdictResult result={result} />}
      </div>
    </section>
  );
}

function VerdictResult({ result: { verdict, budgetUsdc } }: { result: CheckResult }) {
  const priceUnknown = verdict.alerts.some((alert) => alert.code === "price_not_quoted");
  const quotedPrice = priceUnknown ? null : verdict.priceUsdc;
  const overBudget = quotedPrice !== null && quotedPrice > budgetUsdc;
  const verdictLabel = labels[verdict.decision];
  const conditionsFailed = !verdict.granted && verdict.decision !== "DENY" && verdict.decision !== "REVIEW_REQUIRED";
  let heading = verdictLabel;
  if (conditionsFailed) heading = "Payment conditions not met";
  if (overBudget) heading = "Over budget";

  return (
    <div className="space-y-2 border-t pt-3 text-sm">
      <h3 className="font-semibold">{heading}</h3>
      {!verdict.granted && <p className="text-muted-foreground">{verdict.explanation}</p>}
      <dl className="space-y-1">
        {heading !== verdictLabel && <div><dt>Evidence verdict</dt><dd>{verdictLabel}</dd></div>}
        <div><dt>Live price</dt><dd>{quotedPrice === null ? "Unavailable for the probe request" : `${quotedPrice} USDC`}</dd></div>
        <div><dt>Payee</dt><dd className="break-all font-mono">{verdict.payTo ?? "Unavailable"}</dd></div>
        <div><dt>Budget checked</dt><dd>{budgetUsdc} USDC</dd></div>
      </dl>
      {verdict.reasons.length > 0 && (
        <ul className="list-inside list-disc text-muted-foreground">
          {verdict.reasons.map((reason) => <li key={reason}>{reason.replaceAll("_", " ").toLowerCase()}</li>)}
        </ul>
      )}
      {verdict.postCallVerificationRequired && <p>Post-call verification required.</p>}
      <p className="text-muted-foreground">Unsigned verdict. No payment sent.</p>
    </div>
  );
}
