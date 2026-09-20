/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { calibrationReport, type CalibrationRow, type CalibrationTerms } from "../lib/nova/calibration-report.ts";

const terms: CalibrationTerms = {
  canonical_hash: "epoch", mode: "PREVIEW", network: "eip155:8453", budget_timezone: "Europe/Berlin",
  issued_at: "2026-09-15T00:00:00Z", expires_at: "2026-09-22T00:00:00Z", revoked_at: null,
  max_per_transaction_usdc: "0.01", max_per_day_usdc: "0.03", max_total_usdc: "0.15",
  max_autonomous_attempts_per_day: 3,
};
const base: CalibrationRow = {
  signal_id: "one", mandate_hash: "epoch", verdict: "WOULD_ALLOW", would_spend_usdc: "0.01",
  failed_codes: [], owner_feedback: null, budget_period_start: "2026-09-14T22:00:00Z",
  decided_at: "2026-09-15T12:00:00Z",
};
const now = new Date("2026-09-20T12:00:00Z");
const r = calibrationReport([
  base, { ...base, signal_id: "two", would_spend_usdc: "0.006", owner_feedback: "useful" },
  { ...base, signal_id: "three", verdict: "WOULD_DENY", would_spend_usdc: "0.04", failed_codes: ["price", "daily"] },
  { ...base, mandate_hash: "development", would_spend_usdc: "100" },
  { ...base, decided_at: "2026-09-21T00:00:00Z" },
], terms, now);
assert.equal(r.decisions, 3);
assert.equal(r.excludedOtherMandates, 1);
assert.equal(r.excludedAfterSnapshot, 1);
assert.equal(r.allowedHypotheticalSpendUsdc, "0.016000");
assert.deepEqual(r.feedback, { useful: 1, not_worth_it: 0, missing: 2 });
assert.deepEqual(r.failureCounts, { price: 1, daily: 1 });
assert.deepEqual(r.integrityViolations, []);
assert.equal(r.liveAutonomyApproval, "NOT_GRANTED");
assert.equal(r.window, "in_progress");
const dup = calibrationReport([base, { ...base, budget_period_start: "2026-09-15T00:00:00+02:00" }], terms, now);
assert.equal(dup.duplicateSignalDays, 1);
assert(dup.integrityViolations.includes("duplicate_signal_in_budget_day"));
const breached = calibrationReport(Array.from({ length: 4 }, (_, i) => ({ ...base, signal_id: String(i) })), terms, now);
assert(breached.integrityViolations.includes("daily_budget_exceeded"));
assert(breached.integrityViolations.includes("daily_attempts_exceeded"));
const revoked = calibrationReport([base], { ...terms, revoked_at: "2026-09-15T01:00:00Z" }, now);
assert(revoked.integrityViolations.includes("decision_after_revocation"));
assert.throws(() => calibrationReport([{ ...base, would_spend_usdc: "0.0000001" }], terms, now));
assert.throws(() => calibrationReport([{ ...base, decided_at: "bad" }], terms, now));
const empty = calibrationReport([], terms, new Date("2026-09-22T00:00:00Z"));
assert.equal(empty.window, "ended");
assert.equal(empty.firstDecisionAt, null);
assert.equal(empty.liveAutonomyApproval, "NOT_GRANTED");
console.log("PASS: calibration isolation, exact amounts, feedback, cutoff, duplicates, budget limits, revocation and empty evidence");
