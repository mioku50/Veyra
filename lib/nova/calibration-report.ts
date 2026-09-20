/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */

/** Reporting only: no signer, scheduler, model or payment dependencies. */
export type CalibrationRow = {
  signal_id: string;
  mandate_hash: string;
  verdict: "WOULD_ALLOW" | "WOULD_DENY";
  would_spend_usdc: number | string;
  failed_codes: string[];
  owner_feedback: "useful" | "not_worth_it" | null;
  budget_period_start: string;
  decided_at: string;
};

export type CalibrationTerms = {
  canonical_hash: string;
  mode: string;
  network: string;
  budget_timezone: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  max_per_transaction_usdc: number | string;
  max_per_day_usdc: number | string;
  max_total_usdc: number | string;
  max_autonomous_attempts_per_day: number;
};

function micros(value: string | number): bigint {
  const text = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error("Invalid six-decimal USDC amount");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}

function usdc(value: bigint): string {
  return `${value / BigInt(1_000_000)}.${String(value % BigInt(1_000_000)).padStart(6, "0")}`;
}

function instant(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("Invalid calibration timestamp");
  return result;
}

export function calibrationReport(
  rows: readonly CalibrationRow[], terms: CalibrationTerms, asOf: Date,
) {
  const cutoff = instant(asOf.toISOString());
  const issued = instant(terms.issued_at);
  const expires = instant(terms.expires_at);
  if (expires <= issued) throw new Error("Invalid mandate validity window");
  const visible = rows.filter(row => instant(row.decided_at) <= cutoff);
  const selected = visible.filter(row => row.mandate_hash === terms.canonical_hash);
  const days = new Map<string, { allowed: number; denied: number; amount: bigint }>();
  const seen = new Set<string>();
  const failures: Record<string, number> = {};
  const quotes = new Map<string, number>();
  const violations: string[] = [];
  const feedback = { useful: 0, not_worth_it: 0, missing: 0 };
  let allowed = 0;
  let total = BigInt(0);
  let duplicates = 0;
  for (const row of selected) {
    const at = instant(row.decided_at);
    if (at < issued || at >= expires) violations.push("decision_outside_mandate_window");
    if (terms.revoked_at && at >= instant(terms.revoked_at)) violations.push("decision_after_revocation");
    const period = new Date(instant(row.budget_period_start)).toISOString();
    const key = JSON.stringify([row.signal_id, period]);
    if (seen.has(key)) duplicates++;
    seen.add(key);
    const day = days.get(period) ?? { allowed: 0, denied: 0, amount: BigInt(0) };
    const amount = micros(row.would_spend_usdc);
    quotes.set(usdc(amount), (quotes.get(usdc(amount)) ?? 0) + 1);
    feedback[row.owner_feedback ?? "missing"]++;
    for (const code of new Set(row.failed_codes)) failures[code] = (failures[code] ?? 0) + 1;
    if (row.verdict === "WOULD_ALLOW") {
      allowed++; total += amount; day.allowed++; day.amount += amount;
      if (row.failed_codes.length) violations.push("allowed_with_failed_checks");
      if (amount > micros(terms.max_per_transaction_usdc)) violations.push("per_action_limit_exceeded");
    } else if (row.verdict === "WOULD_DENY") {
      day.denied++;
      if (!row.failed_codes.length) violations.push("denied_without_reason");
    } else throw new Error("Unknown calibration verdict");
    days.set(period, day);
  }
  for (const day of days.values()) {
    if (day.amount > micros(terms.max_per_day_usdc)) violations.push("daily_budget_exceeded");
    if (day.allowed > terms.max_autonomous_attempts_per_day) violations.push("daily_attempts_exceeded");
  }
  if (total > micros(terms.max_total_usdc)) violations.push("total_budget_exceeded");
  if (duplicates) violations.push("duplicate_signal_in_budget_day");
  const dates = selected.map(row => instant(row.decided_at)).sort((a, b) => a - b);
  return {
    asOf: asOf.toISOString(),
    mandate: terms,
    window: cutoff < issued ? "not_started" : cutoff < expires ? "in_progress" : "ended",
    revoked: !!terms.revoked_at && instant(terms.revoked_at) <= cutoff,
    decisions: selected.length,
    excludedOtherMandates: visible.length - selected.length,
    excludedAfterSnapshot: rows.length - visible.length,
    allowed, denied: selected.length - allowed,
    allowedHypotheticalSpendUsdc: usdc(total),
    feedback,
    failureCounts: failures,
    quoteHistogramUsdc: Object.fromEntries([...quotes].sort(([a], [b]) => Number(a) - Number(b))),
    duplicateSignalDays: duplicates,
    integrityViolations: [...new Set(violations)],
    firstDecisionAt: dates.length ? new Date(dates[0]).toISOString() : null,
    lastDecisionAt: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([periodStart, day]) => ({
      periodStart, allowed: day.allowed, denied: day.denied, hypotheticalSpendUsdc: usdc(day.amount),
    })),
    // Shadow observations cannot prove delivery quality or wallet enforcement.
    liveAutonomyApproval: "NOT_GRANTED",
    limitations: [
      "Only recorded, priced decisions are counted; skipped/unpriced/error passes need scheduler evidence.",
      "Hypothetical spend is not a payment or delivery result.",
      "Feedback is current at extraction; this is not a historical feedback snapshot.",
      "This report does not verify mandate signatures or grant AUTOPILOT permission.",
    ],
  };
}
