"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import { CheckLine, Meter, Money, Pill, verdictFromDecision, VERDICT_TONE } from "./primitives";

/** The subset of a ranked marketplace candidate this card renders. Kept
 *  structural rather than importing server types, so the card also accepts an
 *  ERC-8004 candidate shaped the same way. */
export type RunCandidate = {
  id: string;
  title: string;
  subtitle?: string | null;
  priceUsdc: number | null;
  trustScore: number;
  evidenceCoverage: number;
  decision: string | null;
  maxExposureUsdc: number;
  rank: number;
  probe?: {
    reachable: boolean;
    respondedWith402: boolean;
    latencyMs: number | null;
    catalogDrift: string[];
    statisticalEvidenceAvailable: boolean;
    integrityScore: number;
  } | null;
  evidence: {
    observed: string[];
    missing: string[];
    settledExecutions: number;
    arcProofBacked: boolean;
  };
  reasons: string[];
  risks: string[];
};

const DIMENSION_LABEL: Record<string, string> = {
  protocol_integrity: "Live endpoint answers a valid 402 challenge",
  catalog_integrity: "Advertised price and payee match the live challenge",
  statistical_availability: "Repeated observations of latency and uptime",
  veyra_reputation: "Reputation records held by Veyra",
  erc8183_execution: "Settled ERC-8183 jobs on Arc",
  evaluator_verdicts: "Independent evaluator verdicts",
};

function label(dimension: string) {
  return DIMENSION_LABEL[dimension] ?? dimension.replace(/_/g, " ");
}

export function CandidateCard({ candidate, selected, index, onSelect }: {
  candidate: RunCandidate;
  selected: boolean;
  index: number;
  onSelect: () => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const verdict = verdictFromDecision(candidate.decision);
  const tone = VERDICT_TONE[verdict];
  const drift = candidate.probe?.catalogDrift ?? [];

  return (
    <div
      className="run-rise run-panel overflow-hidden transition-colors"
      style={{
        animationDelay: `${index * 60}ms`,
        borderColor: selected ? "var(--run-line-accent)" : undefined,
        background: selected ? "var(--run-surface-hover)" : undefined,
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="run-focus block w-full cursor-pointer px-5 py-4 text-left"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span className="run-num text-[11px] text-[var(--run-text-faint)]">
                {String(candidate.rank).padStart(2, "0")}
              </span>
              <span className="truncate text-[15px] font-medium">{candidate.title}</span>
              {selected ? <Pill tone="good">Selected</Pill> : null}
            </div>
            {candidate.subtitle ? (
              <div className="run-num mt-1 truncate text-[11px] text-[var(--run-text-faint)]">
                {candidate.subtitle}
              </div>
            ) : null}
          </div>
          <div className="shrink-0 text-right">
            <Money value={candidate.priceUsdc} className="text-[17px]" />
            <div className="mt-1 text-[11px] text-[var(--run-text-faint)]">per call</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-[1fr_1fr_auto] items-end gap-4">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="run-eyebrow">Trust</span>
              <span className="run-num text-[13px]">{Math.round(candidate.trustScore)}<span className="text-[var(--run-text-faint)]">/100</span></span>
            </div>
            <Meter score={candidate.trustScore} />
          </div>
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="run-eyebrow">Evidence</span>
              <span className="run-num text-[13px]">{Math.round(candidate.evidenceCoverage * 100)}%</span>
            </div>
            <Meter score={candidate.evidenceCoverage * 100} />
          </div>
          <div
            className="rounded-full border px-2.5 py-1 text-[11px] font-medium"
            style={{ color: tone.color, borderColor: tone.color, background: tone.wash }}
          >
            {tone.label}
          </div>
        </div>

        {drift.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {drift.map((d) => (
              <Pill key={d} tone="bad">Catalog drift: {d.replace(/_/g, " ")}</Pill>
            ))}
          </div>
        ) : null}
      </button>

      <div className="border-t border-[var(--run-line)]">
        <button
          type="button"
          onClick={() => setShowEvidence((v) => !v)}
          aria-expanded={showEvidence}
          className="run-focus flex w-full items-center justify-between px-5 py-2.5 text-[12px] text-[var(--run-text-muted)] transition-colors hover:bg-[var(--run-surface-hover)]"
        >
          <span>{showEvidence ? "Hide evidence" : "View evidence"}</span>
          <span aria-hidden className="text-[var(--run-text-faint)]">{showEvidence ? "−" : "+"}</span>
        </button>

        {showEvidence ? (
          <div className="border-t border-[var(--run-line)] bg-[var(--run-canvas-raised)] px-5 py-4">
            <ul className="space-y-1.5">
              {candidate.probe ? (
                <>
                  <CheckLine ok={candidate.probe.reachable}>
                    Endpoint reachable
                  </CheckLine>
                  <CheckLine ok={candidate.probe.respondedWith402}>
                    Answers a valid x402 payment challenge
                  </CheckLine>
                  <CheckLine ok={drift.length === 0}>
                    {drift.length === 0
                      ? "Advertised price and payee match the live challenge"
                      : `Live challenge disagrees with the catalog (${drift.join(", ")})`}
                  </CheckLine>
                  {candidate.probe.latencyMs !== null ? (
                    <CheckLine ok={candidate.probe.latencyMs < 2000}>
                      Probe latency <span className="run-num">{candidate.probe.latencyMs} ms</span>
                    </CheckLine>
                  ) : null}
                  <CheckLine ok={candidate.probe.statisticalEvidenceAvailable}>
                    {candidate.probe.statisticalEvidenceAvailable
                      ? "Repeated observations available"
                      : "Probed once — no statistical history yet"}
                  </CheckLine>
                </>
              ) : null}
              <CheckLine ok={candidate.evidence.settledExecutions > 0}>
                {candidate.evidence.settledExecutions > 0
                  ? <><span className="run-num">{candidate.evidence.settledExecutions}</span> settled executions on record</>
                  : "No settlement history — first contact"}
              </CheckLine>
              <CheckLine ok={candidate.evidence.arcProofBacked}>
                {candidate.evidence.arcProofBacked
                  ? "Backed by onchain Arc proofs"
                  : "Not backed by onchain Arc proofs"}
              </CheckLine>
            </ul>

            {candidate.evidence.missing.length > 0 ? (
              <div className="mt-4 rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-surface)] p-3">
                <div className="run-eyebrow mb-2">What Veyra does not know</div>
                <ul className="space-y-1">
                  {candidate.evidence.missing.map((m) => (
                    <li key={m} className="text-[12px] text-[var(--run-text-faint)]">— {label(m)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {candidate.risks.length > 0 ? (
              <div className="mt-3 space-y-1">
                {candidate.risks.map((r) => (
                  <div key={r} className="text-[12px] text-[var(--run-amber)]">⚠ {r.replace(/_/g, " ")}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
