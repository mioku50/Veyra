"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState } from "react";
import { CandidateCard, type RunCandidate } from "@/components/run/candidate-card";
import { DecisionPanel, type RunDecision } from "@/components/run/decision-panel";
import { Eyebrow, Money, Panel, Pill } from "@/components/run/primitives";

type Rail = "api" | "job";
type Priority = "trust" | "cost" | "speed";
type Phase = "idle" | "discovering" | "verifying" | "decided" | "authorizing" | "authorized" | "error";

const STEPS = ["Intent", "Discover", "Verify", "Decide", "Execute", "Learn"] as const;

const PHASE_STEP: Record<Phase, number> = {
  idle: 0, discovering: 1, verifying: 2, decided: 3,
  authorizing: 4, authorized: 5, error: 3,
};

const CAPABILITIES = [
  "market_research", "web_search", "news", "crypto_market_data",
  "weather", "sports_stats", "github_due_diligence", "agent_reputation",
];

const PRIORITY_NOTE: Record<Priority, string> = {
  trust: "Strongest evidence first.",
  cost: "Cheapest first, within budget.",
  speed: "Lowest observed latency first.",
};

function hostOf(resource: string | null | undefined) {
  if (!resource) return null;
  try { return new URL(resource).host; } catch { return resource; }
}

export function RunClient() {
  const [rail, setRail] = useState<Rail>("api");
  const [intent, setIntent] = useState("");
  const [capability, setCapability] = useState(CAPABILITIES[0]);
  const [budget, setBudget] = useState("0.10");
  const [priority, setPriority] = useState<Priority>("trust");

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<RunCandidate[]>([]);
  const [decision, setDecision] = useState<RunDecision | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<{ catalogTotal: number; discovered: number; probed: number } | null>(null);

  const busy = phase === "discovering" || phase === "verifying" || phase === "authorizing";
  const step = PHASE_STEP[phase];

  /* Priority re-sorts what is shown. It does not reach the decision engine:
     the verdict is computed server-side from evidence and is identical
     whichever ordering the operator happens to be looking at. */
  const shown = useMemo(() => {
    const list = [...candidates];
    if (priority === "cost") {
      list.sort((a, b) => (a.priceUsdc ?? Infinity) - (b.priceUsdc ?? Infinity));
    } else if (priority === "speed") {
      list.sort((a, b) => (a.probe?.latencyMs ?? Infinity) - (b.probe?.latencyMs ?? Infinity));
    } else {
      list.sort((a, b) => a.rank - b.rank);
    }
    return list;
  }, [candidates, priority]);

  async function decide() {
    const budgetUsdc = Number(budget);
    if (!Number.isFinite(budgetUsdc) || budgetUsdc <= 0) {
      setError("Enter a budget above zero.");
      setPhase("error");
      return;
    }

    setPhase("discovering");
    setError(null);
    setCandidates([]);
    setDecision(null);
    setSelectedId(null);
    setStats(null);

    try {
      setPhase("verifying");
      const response = await fetch(
        rail === "api"
          ? "/api/trust/v1/marketplace/select"
          : "/api/trust/v1/counterparties/discover",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            rail === "api"
              ? {
                  capability,
                  query: intent.trim() || undefined,
                  budgetUsdc,
                  maxPriceUsdc: budgetUsdc,
                  limit: 6,
                }
              : { capability, limit: 6 },
          ),
        },
      );

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || payload?.code || `Request failed (${response.status})`);
      }

      if (rail === "job") {
        // The agent-job rail discovers ERC-8004 counterparties; ranking them
        // needs a second, idempotent call that this screen does not yet make.
        const found = Array.isArray(payload?.candidates) ? payload.candidates.length : 0;
        setStats({ catalogTotal: found, discovered: found, probed: 0 });
        throw new Error(
          found === 0
            ? "No ERC-8004 counterparties are registered for this capability yet."
            : `Discovered ${found} ERC-8004 counterparties. Ranking for the agent-job rail is not wired into this screen yet — use the API purchase rail for a full decision.`,
        );
      }

      const selection = payload.selection;
      const mapped: RunCandidate[] = (selection.candidates ?? []).map((c: any) => ({
        id: c.marketplace.candidateId,
        title: c.marketplace.provider?.name || hostOf(c.marketplace.resource) || c.marketplace.candidateId,
        subtitle: c.marketplace.resource,
        priceUsdc: c.marketplace.priceUsdc,
        trustScore: c.trustScore,
        evidenceCoverage: c.evidenceCoverage,
        decision: c.trustDecision,
        maxExposureUsdc: c.recommendedMaxExposureUsdc,
        rank: c.rank,
        probe: c.probe
          ? {
              reachable: c.probe.reachable,
              respondedWith402: c.probe.respondedWith402,
              latencyMs: c.probe.latencyMs,
              catalogDrift: c.probe.catalogDrift ?? [],
              statisticalEvidenceAvailable: c.probe.statisticalEvidenceAvailable,
              integrityScore: c.probe.integrityScore,
            }
          : null,
        evidence: {
          observed: c.evidenceLimits?.observedDimensions ?? [],
          missing: c.evidenceLimits?.missingDimensions ?? [],
          settledExecutions: c.evidenceLimits?.settledExecutions ?? 0,
          arcProofBacked: Boolean(c.evidenceLimits?.arcProofBacked),
        },
        reasons: c.topReasons ?? [],
        risks: c.riskSignals ?? [],
      }));

      const rec = selection.recommendation;
      const winner = mapped.find((c) => c.id === rec.candidateId) ?? null;

      setCandidates(mapped);
      setSelectedId(rec.candidateId);
      setStats({
        catalogTotal: selection.catalogTotal ?? 0,
        discovered: selection.discovered ?? mapped.length,
        probed: selection.probed ?? 0,
      });
      setDecision({
        granted: rec.granted,
        decision: rec.decision,
        reason: rec.reason,
        explanation: rec.explanation,
        resource: rec.resource,
        payTo: rec.payTo,
        priceUsdc: rec.priceUsdc,
        maxExposureUsdc: rec.maxExposureUsdc,
        postCallVerificationRequired: rec.postCallVerificationRequired,
        winnerTitle: winner?.title ?? null,
        reasons: winner?.reasons ?? [],
        clearance: selection.clearance
          ? {
              digest: selection.clearance.clearanceDigest,
              attester: selection.clearance.attester,
              expiresAt: selection.clearance.expiresAt,
              onchainVerified: selection.clearance.onchainVerified,
              chainId: selection.clearance.chainId,
            }
          : null,
        expiresAt: selection.expiresAt,
      });
      setPhase("decided");
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
      setPhase("error");
    }
  }

  return (
    <div data-surface="run" className="min-h-screen">
      <div className="mx-auto w-full max-w-[1120px] px-5 py-10 sm:px-8 sm:py-14">

        <header className="mb-10">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <div>
              <h1 className="run-display text-[40px] font-semibold sm:text-[52px]">
                Veyra decides. <span className="text-[var(--run-mint)]">Circle pays.</span>
              </h1>
              <p className="mt-3 max-w-[46ch] text-[15px] leading-relaxed text-[var(--run-text-muted)]">
                Before your agent spends USDC, Veyra decides whether it should pay,
                whom, and how much.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Pill tone="info">Arc Testnet</Pill>
              <Pill tone="neutral">Read-only preflight</Pill>
            </div>
          </div>
        </header>

        {/* Flow rail: the whole product in six words, and a live position marker. */}
        <ol className="mb-8 flex flex-wrap items-center gap-x-2 gap-y-3">
          {STEPS.map((s, i) => {
            const done = i < step;
            const active = i === step && phase !== "idle";
            return (
              <li key={s} className="flex items-center gap-2">
                <span
                  className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${active ? "run-pulse" : ""}`}
                  style={{
                    color: done ? "var(--run-mint)" : active ? "var(--run-text)" : "var(--run-text-faint)",
                  }}
                >
                  {s}
                </span>
                {i < STEPS.length - 1 ? (
                  <span aria-hidden className="h-px w-6" style={{ background: done ? "var(--run-mint-dim)" : "var(--run-line)" }} />
                ) : null}
              </li>
            );
          })}
        </ol>

        {/* Intent */}
        <Panel raised className="mb-8 p-6">
          <div className="mb-5 flex gap-1 rounded-[var(--run-radius-sm)] border border-[var(--run-line)] p-1">
            {([["api", "API purchase"], ["job", "Agent job"]] as const).map(([value, text]) => (
              <button
                key={value}
                type="button"
                onClick={() => setRail(value)}
                className="run-focus flex-1 rounded-[7px] px-3 py-2 text-[13px] font-medium transition-colors"
                style={{
                  background: rail === value ? "var(--run-surface-active)" : "transparent",
                  color: rail === value ? "var(--run-text)" : "var(--run-text-faint)",
                }}
              >
                {text}
                <span className="ml-2 text-[11px] text-[var(--run-text-faint)]">
                  {value === "api" ? "x402 · Gateway" : "ERC-8004 · ERC-8183"}
                </span>
              </button>
            ))}
          </div>

          <label className="block">
            <Eyebrow>What does your agent need?</Eyebrow>
            <input
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Research the latest developments in Ambient"
              className="run-focus mt-2.5 w-full rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas)] px-4 py-3.5 text-[16px] text-[var(--run-text)] placeholder:text-[var(--run-text-faint)]"
            />
          </label>

          <div className="mt-5 grid gap-5 sm:grid-cols-[1fr_1fr_1.4fr]">
            <label className="block">
              <Eyebrow>Capability</Eyebrow>
              <select
                value={capability}
                onChange={(e) => setCapability(e.target.value)}
                className="run-focus mt-2.5 h-11 w-full rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas)] px-3 text-[14px] text-[var(--run-text)]"
              >
                {CAPABILITIES.map((c) => (
                  <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <Eyebrow>Budget</Eyebrow>
              <div className="run-focus mt-2.5 flex h-11 items-center rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas)] px-3">
                <span className="text-[var(--run-text-faint)]">$</span>
                <input
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  inputMode="decimal"
                  className="run-num w-full bg-transparent px-1.5 text-[14px] text-[var(--run-text)] outline-none"
                />
                <span className="text-[11px] text-[var(--run-text-faint)]">USDC</span>
              </div>
            </label>

            <div>
              <Eyebrow>Optimize for</Eyebrow>
              <div className="mt-2.5 flex gap-1 rounded-[var(--run-radius-sm)] border border-[var(--run-line)] p-1">
                {(["trust", "cost", "speed"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className="run-focus flex-1 rounded-[7px] px-3 py-1.5 text-[13px] font-medium capitalize transition-colors"
                    style={{
                      background: priority === p ? "var(--run-surface-active)" : "transparent",
                      color: priority === p ? "var(--run-text)" : "var(--run-text-faint)",
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[11px] text-[var(--run-text-faint)]">
                {PRIORITY_NOTE[priority]} Ordering only — the verdict is unchanged.
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={decide}
              disabled={busy}
              className="run-focus inline-flex h-11 items-center rounded-[var(--run-radius-sm)] px-5 text-[14px] font-semibold text-[#04130c] transition-opacity disabled:opacity-40"
              style={{ background: "var(--run-mint)" }}
            >
              {busy ? "Probing endpoints…" : "Find best route"}
            </button>
            {stats ? (
              <span className="run-num text-[12px] text-[var(--run-text-faint)]">
                {stats.catalogTotal} in catalog · {stats.discovered} matched · {stats.probed} probed live
              </span>
            ) : (
              <span className="text-[12px] text-[var(--run-text-faint)]">
                Free: every candidate is probed before a cent moves.
              </span>
            )}
          </div>
        </Panel>

        {error ? (
          <Panel className="mb-8 border-[rgba(255,92,108,0.28)] p-5">
            <Eyebrow>Not decided</Eyebrow>
            <p className="mt-2 text-[14px] leading-relaxed text-[var(--run-text)]">{error}</p>
          </Panel>
        ) : null}

        {decision ? (
          <div className="mb-8">
            <DecisionPanel
              decision={decision}
              busy={phase === "authorizing"}
              onAuthorize={() => setPhase("authorized")}
            />
          </div>
        ) : null}

        {phase === "authorized" && decision ? (
          <Panel className="mb-8 p-6">
            <Eyebrow>Hand-off</Eyebrow>
            <p className="mt-2.5 text-[13px] leading-relaxed text-[var(--run-text-muted)]">
              Veyra has decided and signed. Settlement is Circle&apos;s — pay the cleared
              resource, capped at the authorized exposure:
            </p>
            <pre className="mt-4 overflow-x-auto rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas)] p-4 font-mono text-[12px] leading-relaxed text-[var(--run-text-muted)]">
{`circle services pay "${decision.resource ?? ""}" \\
  --max-amount ${decision.maxExposureUsdc} \\
  --output json`}
            </pre>
            <p className="mt-3 text-[12px] text-[var(--run-text-faint)]">
              Paying a different resource on the strength of this verdict will not work:
              the clearance is bound to the one above.
            </p>
          </Panel>
        ) : null}

        {shown.length > 0 ? (
          <section>
            <div className="mb-4 flex items-baseline justify-between">
              <Eyebrow>Candidates</Eyebrow>
              <span className="run-num text-[12px] text-[var(--run-text-faint)]">
                {shown.length} probed · budget <Money value={Number(budget)} className="text-[var(--run-text-muted)]" />
              </span>
            </div>
            <div className="space-y-3">
              {shown.map((c, i) => (
                <CandidateCard
                  key={c.id}
                  candidate={c}
                  index={i}
                  selected={c.id === selectedId}
                  onSelect={() => setSelectedId(c.id)}
                />
              ))}
            </div>
          </section>
        ) : null}

        {phase === "idle" ? (
          <Panel className="p-6">
            <Eyebrow>What happens when you press it</Eyebrow>
            <ol className="mt-3 space-y-2 text-[13px] leading-relaxed text-[var(--run-text-muted)]">
              <li>1. Veyra asks Circle&apos;s catalog which endpoints claim this capability.</li>
              <li>2. Each one is probed live and for free, and its answer compared against what the catalog advertises.</li>
              <li>3. Survivors are ranked on evidence — not on what they say about themselves.</li>
              <li>4. Policy sets a ceiling. A first-contact endpoint never reaches Allow.</li>
              <li>5. You get a signed authorization bound to one endpoint and one amount, or a refusal with its reason.</li>
            </ol>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
