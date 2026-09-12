"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { Eyebrow, Money, Pill, Stat, verdictFromDecision, VERDICT_TONE } from "./primitives";

export type RunDecision = {
  granted: boolean;
  decision: string | null;
  reason: string;
  explanation: string;
  resource: string | null;
  payTo: string | null;
  priceUsdc: number | null;
  maxExposureUsdc: number;
  postCallVerificationRequired: boolean;
  winnerTitle: string | null;
  reasons: string[];
  clearance: {
    digest: string;
    attester: string;
    expiresAt: string;
    onchainVerified: boolean;
    chainId: number;
  } | null;
  expiresAt: string;
};

function short(hex: string, lead = 10, tail = 6) {
  if (!hex || hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

function secondsLeft(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.round(ms / 1000));
}

export function DecisionPanel({ decision, busy, onAuthorize }: {
  decision: RunDecision;
  busy: boolean;
  onAuthorize: () => void;
}) {
  const verdict = verdictFromDecision(decision.decision);
  const tone = VERDICT_TONE[verdict];
  const denied = !decision.granted;
  const ttl = secondsLeft(decision.expiresAt);

  return (
    <section
      className={`run-panel-raised ${denied ? "run-verdict-deny" : "run-verdict-allow"} overflow-hidden`}
      aria-live="polite"
    >
      <div className="px-6 pt-6 pb-5">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <Eyebrow>Veyra decision</Eyebrow>
            <div
              className="run-display mt-2 text-[34px] font-semibold"
              style={{ color: tone.color }}
            >
              {tone.label}
            </div>
            {decision.winnerTitle ? (
              <div className="mt-2 truncate text-[15px] text-[var(--run-text)]">
                {decision.winnerTitle}
              </div>
            ) : null}
            {decision.resource ? (
              <div className="mt-1 truncate font-mono text-[12px] text-[var(--run-text-faint)]">
                {decision.resource}
              </div>
            ) : null}
          </div>

          <div className="shrink-0 text-right">
            <Eyebrow>Max exposure</Eyebrow>
            <div className="run-display mt-2 text-[30px] font-semibold">
              <Money value={decision.maxExposureUsdc} />
            </div>
            {decision.priceUsdc !== null && decision.priceUsdc !== decision.maxExposureUsdc ? (
              <div className="mt-1 text-[12px] text-[var(--run-text-faint)]">
                quoted <Money value={decision.priceUsdc} unit="" />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Why. The reasons are the product: a verdict without them is an opinion. */}
      <div className="border-t border-[var(--run-line)] px-6 py-5">
        <Eyebrow>Why</Eyebrow>
        <p className="mt-2.5 text-[13px] leading-relaxed text-[var(--run-text-muted)]">
          {decision.explanation || decision.reason}
        </p>
        {decision.reasons.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {decision.reasons.map((r) => (
              <li key={r} className="flex gap-2.5 text-[13px] text-[var(--run-text-muted)]">
                <span aria-hidden style={{ color: tone.color }}>+</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {decision.postCallVerificationRequired ? (
          <div className="mt-4">
            <Pill tone="warn">Response is not independently verified after the call</Pill>
          </div>
        ) : null}
      </div>

      {/* The signed authorization, stated as something bound rather than issued. */}
      {decision.clearance ? (
        <div className="border-t border-[var(--run-line)] bg-[var(--run-canvas-raised)] px-6 py-5">
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Stat label="Clearance">
              <span className="font-mono text-[13px]">{short(decision.clearance.digest)}</span>
            </Stat>
            <Stat label="Attester">
              <span className="font-mono text-[13px]">{short(decision.clearance.attester, 8, 4)}</span>
            </Stat>
            <Stat label="Onchain">
              {decision.clearance.onchainVerified
                ? <Pill tone="good">Verified</Pill>
                : <Pill tone="neutral">Not verified</Pill>}
            </Stat>
            <Stat label="Valid for">
              <span className="run-num">{ttl}s</span>
            </Stat>
          </div>
          <p className="mt-4 text-[12px] leading-relaxed text-[var(--run-text-faint)]">
            The clearance is bound to this endpoint, capability and amount. It cannot be
            replayed against a different purchase, and it expires rather than lingering.
          </p>
        </div>
      ) : null}

      <div className="border-t border-[var(--run-line)] px-6 py-5">
        {denied ? (
          <div className="text-[13px] text-[var(--run-text-muted)]">
            Nothing is authorized. Veyra will not sign for a counterparty it cannot
            justify from evidence — change the budget or priority and decide again.
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onAuthorize}
              disabled={busy || ttl === 0}
              className="run-focus inline-flex h-11 items-center gap-2 rounded-[var(--run-radius-sm)] px-5 text-[14px] font-semibold text-[#04130c] transition-opacity disabled:opacity-40"
              style={{ background: "var(--run-mint)" }}
            >
              {busy ? "Authorizing…" : ttl === 0 ? "Decision expired" : "Authorize & pay"}
            </button>
            <span className="text-[12px] text-[var(--run-text-faint)]">
              Veyra decides. Circle pays — settlement leaves your agent wallet, capped at{" "}
              <Money value={decision.maxExposureUsdc} className="text-[var(--run-text-muted)]" />.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
