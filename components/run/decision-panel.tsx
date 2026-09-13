"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatUsdc, Money, Pill, verdictFromDecision, VERDICT_TONE } from "./primitives";

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
  /** Absent on a refusal: nothing was authorised, so nothing expires. */
  expiresAt?: string;
  /** The winner's published response shape, when it publishes one. Carried so
   *  the post-call check can hold the response to the provider's own promise. */
  outputSchema?: Record<string, unknown> | null;
};

function short(hex: string, lead = 10, tail = 6) {
  if (!hex || hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

function secondsLeft(iso?: string) {
  if (!iso) return 0;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.round(ms / 1000));
}

/** A readable handle for one decision, derived from the thing that actually
 *  identifies it. Two decisions never share a digest, so they never share an
 *  ID, and the ID can be checked against the clearance rather than trusted. */
function decisionId(digest: string | undefined) {
  if (!digest) return null;
  return `D-${digest.replace(/^0x/, "").slice(-4).toUpperCase()}`;
}

/** Bar heights read straight out of the digest. Same clearance, same glyph;
 *  a different decision is visibly a different object. Nothing is random. */
function fingerprintBars(digest: string | undefined, count = 22) {
  const hex = (digest ?? "").replace(/^0x/, "");
  if (hex.length < count) return [];
  return Array.from({ length: count }, (_, i) => {
    const nibble = parseInt(hex[i % hex.length], 16);
    return 5 + Math.round((Number.isNaN(nibble) ? 0 : nibble) / 15 * 13);
  });
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
  const id = decisionId(decision.clearance?.digest);
  const bars = fingerprintBars(decision.clearance?.digest);
  const mode = denied ? "deny" : "allow";

  return (
    <section className="run-decision" data-verdict={mode} aria-live="polite">
      <div className="run-signature" data-verdict={mode} />

      <div className="flex items-center justify-between gap-4 px-6 pt-4">
        <span className="run-eyebrow">Veyra decision</span>
        {id ? (
          <span className="run-num text-[11px] tracking-[0.08em] text-[var(--run-text-faint)]">
            #{id}
          </span>
        ) : null}
      </div>

      {/* The verdict is the largest thing on the screen, because it is the one
          output of the product. Everything beside it is its justification. */}
      <div className="grid gap-6 px-6 pb-6 pt-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="run-verdict-word run-display" style={{ color: tone.color }}>
            {tone.label}
          </div>
          {decision.winnerTitle ? (
            <div className="mt-3 truncate text-[15px] font-medium text-[var(--run-text)]">
              {decision.winnerTitle}
            </div>
          ) : null}
          {decision.resource ? (
            <div className="run-num mt-1 truncate text-[11.5px] text-[var(--run-text-faint)]">
              {decision.resource}
            </div>
          ) : null}
        </div>

        {/* The headline figure is the money that is about to leave, not the
            policy ceiling. The wallet will ask for the price; showing the
            ceiling this large invited the reader to think they were approving
            it. The ceiling still matters - it is what the clearance authorizes
            - so it stays, one step down. */}
        <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-1 sm:text-right">
          <div>
            <dt className="run-eyebrow">You pay</dt>
            <dd className="run-display run-num mt-1.5 text-[26px] font-semibold">
              <Money value={decision.priceUsdc ?? decision.maxExposureUsdc} />
            </dd>
          </div>
          <div>
            <dt className="run-eyebrow">Policy ceiling</dt>
            <dd className="run-num mt-1.5 text-[14px] text-[var(--run-text-muted)]">
              <Money value={decision.maxExposureUsdc} unit="" />
            </dd>
          </div>
        </dl>
      </div>

      {/* Why. The reasons are the product: a verdict without them is an opinion. */}
      <div className="border-t border-[var(--run-line)] px-6 py-5">
        <span className="run-eyebrow">Trust evidence</span>
        <p className="mt-2.5 text-[13px] leading-relaxed text-[var(--run-text-muted)]">
          {decision.explanation || decision.reason}
        </p>
        {decision.reasons.length > 0 ? (
          <ul className="mt-3.5 grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {decision.reasons.map((r) => (
              <li key={r} className="flex items-start gap-2.5 text-[12.5px] text-[var(--run-text-muted)]">
                <span
                  aria-hidden
                  className="mt-[6px] h-[5px] w-[5px] shrink-0 rounded-full"
                  style={{ background: tone.color }}
                />
                <span className="min-w-0">{r}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {decision.postCallVerificationRequired ? (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Pill tone="warn">Verification runs after the call</Pill>
            <span className="text-[11.5px] text-[var(--run-text-faint)]">
              Evidence is thin enough that Veyra will not call this purchase
              successful until it has checked what arrives.
            </span>
          </div>
        ) : null}
      </div>

      {/* The signature strip: what was signed, by whom, and the glyph that
          identifies it. This is the line people screenshot. */}
      {decision.clearance ? (
        <div className="border-t border-[var(--run-line)] bg-[var(--run-canvas-raised)] px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="run-num text-[11.5px] text-[var(--run-text-muted)]">
                <span className="text-[var(--run-text-faint)]">signed on Arc </span>
                {short(decision.clearance.digest)}
              </span>
              <span className="run-num text-[11.5px] text-[var(--run-text-muted)]">
                <span className="text-[var(--run-text-faint)]">attester </span>
                {short(decision.clearance.attester, 8, 4)}
              </span>
              {decision.clearance.onchainVerified ? (
                <Pill tone="good">Verified onchain</Pill>
              ) : (
                <Pill tone="neutral">Not verified onchain</Pill>
              )}
              {ttl > 0 ? (
                <span className="run-num text-[11.5px] text-[var(--run-text-faint)]">
                  valid {ttl}s
                </span>
              ) : null}
            </div>
            {bars.length > 0 ? (
              <div
                className="run-fingerprint"
                data-verdict={mode}
                aria-label={`Clearance fingerprint ${short(decision.clearance.digest, 8, 4)}`}
              >
                {bars.map((h, i) => (
                  <i key={i} style={{ height: `${h}px` }} />
                ))}
              </div>
            ) : null}
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--run-text-faint)]">
            Bound to this endpoint, capability and amount. It cannot be replayed against
            a different purchase, and it expires rather than lingering.
          </p>
        </div>
      ) : null}

      <div className="border-t border-[var(--run-line)] px-6 py-5">
        {denied ? (
          <div className="text-[13px] leading-relaxed text-[var(--run-text-muted)]">
            Nothing is authorized. Veyra will not sign for a counterparty it cannot
            justify from evidence — change the budget or priority and decide again.
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onAuthorize}
              disabled={busy || ttl === 0}
              className="run-cta run-focus inline-flex h-10 items-center gap-2 rounded-[var(--run-radius-sm)] px-5 text-[13.5px] font-semibold"
            >
              {busy
                ? "Authorizing…"
                : ttl === 0
                  ? "Decision expired"
                  : decision.priceUsdc !== null
                    ? `Authorize ${formatUsdc(decision.priceUsdc)} & pay`
                    : "Authorize & pay"}
            </button>
            <span className="max-w-[46ch] text-[11.5px] leading-relaxed text-[var(--run-text-faint)]">
              Veyra decides; you sign. The price is re-read from the endpoint
              immediately before your wallet is asked, so what you sign is what
              it asks for now — never more than the ceiling above.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
