/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from "react";

/** Shared vocabulary for the Run surface. Semantics first: a colour here always
 *  means the same thing, so a reader learns the screen once. */

export type Verdict = "allow" | "limited" | "review" | "deny" | "unknown";

export const VERDICT_TONE: Record<Verdict, { label: string; color: string; wash: string }> = {
  allow: { label: "Allow", color: "var(--run-azure)", wash: "var(--run-azure-wash)" },
  limited: { label: "Allow with limits", color: "var(--run-azure)", wash: "var(--run-azure-wash)" },
  review: { label: "Needs evaluator", color: "var(--run-amber)", wash: "var(--run-amber-wash)" },
  deny: { label: "Deny", color: "var(--run-red)", wash: "var(--run-red-wash)" },
  unknown: { label: "Undecided", color: "var(--run-text-faint)", wash: "transparent" },
};

export function verdictFromDecision(decision: string | null | undefined): Verdict {
  switch (decision) {
    case "ALLOW": return "allow";
    case "ALLOW_WITH_LIMITS": return "limited";
    case "REQUIRE_EVALUATOR":
    case "REVIEW_REQUIRED": return "review";
    case "DENY": return "deny";
    default: return "unknown";
  }
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="run-eyebrow">{children}</div>;
}

/** Money is never a plain string: it carries its unit and aligns with its column. */
export function Money({ value, unit = "USDC", className = "" }: {
  value: number | null | undefined;
  unit?: string;
  className?: string;
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className={`run-num text-[var(--run-text-faint)] ${className}`}>—</span>;
  }
  // Sub-cent prices are the normal case here, so significant digits matter more
  // than a fixed two-decimal convention.
  const text = value < 0.01 ? value.toFixed(4) : value.toFixed(2);
  return (
    <span className={`run-num ${className}`}>
      ${text}
      <span className="ml-1 text-[0.75em] text-[var(--run-text-faint)]">{unit}</span>
    </span>
  );
}

/** A hairline bar filled to a 0-100 score. Colour tracks the band, so a weak
 *  score is visibly weak without needing a label. */
export function Meter({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const color =
    clamped >= 75 ? "var(--run-azure)" : clamped >= 45 ? "var(--run-amber)" : "var(--run-red)";
  return (
    <div className="run-meter" role="presentation">
      <span style={{ width: `${clamped}%`, background: color }} />
    </div>
  );
}

export function Stat({ label, children, hint }: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="run-eyebrow mb-1.5">{label}</div>
      <div className="text-[15px] leading-none text-[var(--run-text)]">{children}</div>
      {hint ? <div className="mt-1.5 text-[12px] text-[var(--run-text-faint)]">{hint}</div> : null}
    </div>
  );
}

export function Pill({ tone = "neutral", children }: {
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
  children: ReactNode;
}) {
  const tones = {
    neutral: "border-[var(--run-line-strong)] text-[var(--run-text-muted)]",
    good: "border-[rgba(77,208,255,0.28)] text-[var(--run-azure)] bg-[var(--run-azure-wash)]",
    warn: "border-[rgba(255,179,64,0.3)] text-[var(--run-amber)] bg-[var(--run-amber-wash)]",
    bad: "border-[rgba(255,92,122,0.32)] text-[var(--run-red)] bg-[var(--run-red-wash)]",
    info: "border-[rgba(179,168,255,0.32)] text-[var(--run-lavender)]",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Evidence lines read as claims that were checked, not as marketing bullets.
 *  A failed check is shown with the same weight as a passing one. */
export function CheckLine({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  const mark = ok === null ? "–" : ok ? "✓" : "!";
  const color = ok === null
    ? "var(--run-text-faint)"
    : ok ? "var(--run-azure)" : "var(--run-amber)";
  return (
    <li className="flex items-start gap-2.5 text-[13px] leading-relaxed">
      <span aria-hidden className="run-num mt-px w-3 shrink-0 text-center" style={{ color }}>{mark}</span>
      <span className={ok === false ? "text-[var(--run-text)]" : "text-[var(--run-text-muted)]"}>{children}</span>
    </li>
  );
}

export function Panel({ raised = false, className = "", children }: {
  raised?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`${raised ? "run-panel-raised" : "run-panel"} ${className}`}>{children}</div>
  );
}
