"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { CandidateCard, type RunCandidate } from "@/components/run/candidate-card";
import { DecisionPanel, type RunDecision } from "@/components/run/decision-panel";
import { Eyebrow, Money, Panel } from "@/components/run/primitives";

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

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  }

  function failureText(payload: any, status: number) {
    return payload?.error || payload?.code || payload?.message || `Request failed (${status})`;
  }

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
      if (rail === "job") {
        await decideAgentJob(budgetUsdc);
      } else {
        await decideMarketplace(budgetUsdc);
      }
      setPhase("decided");
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
      setPhase("error");
    }
  }

  /* ---- ERC-8004 counterparties, settled as an ERC-8183 job ---- */

  async function decideAgentJob(budgetUsdc: number) {
    const found = await post("/api/trust/v1/counterparties/discover", {
      capability,
      maxPriceUsdc: budgetUsdc,
      limit: 6,
    });
    if (!found.response.ok) throw new Error(failureText(found.payload, found.response.status));

    const discovered: any[] = Array.isArray(found.payload?.candidates) ? found.payload.candidates : [];
    setStats({ catalogTotal: discovered.length, discovered: discovered.length, probed: 0 });
    if (discovered.length === 0) {
      throw new Error("No ERC-8004 counterparty is registered for this capability yet.");
    }

    const chosen = await post(
      "/api/trust/v1/counterparties/select",
      {
        capability,
        task: intent.trim() || undefined,
        budgetUsdc,
        candidates: discovered.map((c) => ({
          agentId: c.agentId,
          serviceId: c.services?.[0]?.serviceId,
        })),
      },
      { "Idempotency-Key": `run-${crypto.randomUUID()}` },
    );

    // A refusal arrives as 422, not as a payload with granted:false. It is a
    // decision, so it is rendered as one rather than as a broken request.
    if (chosen.response.status === 422 && chosen.payload?.error === "no_eligible_counterparty") {
      setCandidates(mapRankedCandidates(chosen.payload?.details?.candidates ?? []));
      setDecision({
        granted: false,
        decision: "DENY",
        reason: "no_eligible_counterparty",
        explanation:
          "No discovered ERC-8004 counterparty cleared the policy for this capability and budget. "
          + "Veyra will not authorise a job it cannot justify from evidence.",
        resource: null, payTo: null, priceUsdc: null,
        maxExposureUsdc: 0,
        postCallVerificationRequired: false,
        winnerTitle: null, reasons: [], clearance: null,
      });
      return;
    }
    if (!chosen.response.ok) throw new Error(failureText(chosen.payload, chosen.response.status));

    const selection = chosen.payload.selection;
    const mapped = mapRankedCandidates(selection.candidates ?? []);
    const winner = mapped.find((c) => c.id === selection.recommendedAgentId) ?? null;

    setCandidates(mapped);
    setSelectedId(selection.recommendedAgentId);

    // The clearance is issued separately for this rail, so the decision is
    // shown first and the signature attached when it arrives.
    let clearance: RunDecision["clearance"] = null;
    const signed = await post(`/api/trust/v1/selections/${selection.selectionId}/clearance`, {});
    if (signed.response.ok) {
      const record = signed.payload?.clearance ?? {};
      clearance = {
        digest: record.clearanceDigest ?? record.digest ?? "—",
        attester: record.attester ?? record.signer ?? "—",
        expiresAt: record.expiresAt ?? selection.expiresAt,
        onchainVerified: Boolean(signed.payload?.onchainVerified),
        chainId: 5042002,
      };
    }

    setDecision({
      granted: true,
      decision: selection.decision,
      reason: "cleared",
      explanation: selection.winnerExplanation,
      resource: selection.recommendedServiceId ?? null,
      payTo: selection.recommendedWallet,
      priceUsdc: winner?.priceUsdc ?? null,
      maxExposureUsdc: selection.recommendedMaxExposureUsdc,
      postCallVerificationRequired: selection.decision !== "ALLOW",
      winnerTitle: winner?.title ?? selection.recommendedAgentId,
      reasons: winner?.reasons ?? [],
      clearance,
      expiresAt: selection.expiresAt,
    });
  }

  /** ERC-8004 candidates carry settlement history instead of a live probe. */
  function mapRankedCandidates(list: any[]): RunCandidate[] {
    return list
      .filter((c) => c?.identity?.agentId)
      .map((c) => ({
        id: c.identity.agentId,
        title: c.identity.agentId,
        subtitle: c.identity.ownerAddress,
        priceUsdc: c.advertisedPriceUsdc ?? c.quotedPriceUsdc ?? null,
        trustScore: c.trustScore ?? 0,
        evidenceCoverage: c.evidenceCoverage ?? 0,
        decision: c.trustDecision ?? null,
        maxExposureUsdc: c.recommendedMaxExposureUsdc ?? 0,
        rank: c.rank ?? 0,
        probe: null,
        evidence: {
          observed: (c.evidenceSources ?? []).map((s: any) => s.source),
          missing: [],
          settledExecutions: c.evidenceCount ?? 0,
          arcProofBacked: Boolean(c.identity.verifiedOnchain),
        },
        reasons: c.topReasons ?? [],
        risks: c.riskSignals ?? [],
      }));
  }

  /* ---- Circle x402 marketplace, settled over Gateway ---- */

  async function decideMarketplace(budgetUsdc: number) {
    const { response, payload } = await post("/api/trust/v1/marketplace/select", {
      capability,
      query: intent.trim() || undefined,
      budgetUsdc,
      maxPriceUsdc: budgetUsdc,
      limit: 6,
    });
    if (!response.ok) throw new Error(failureText(payload, response.status));

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
  }

  const checklist = rail === "api"
    ? [
        ["Live endpoint", "Answers a valid x402 challenge right now"],
        ["Catalog integrity", "Live price and payee match the listing"],
        ["Observed latency", "How fast it answered, and how often"],
        ["Settlement history", "Whether anyone has actually been paid by it"],
        ["Evaluator verdicts", "Whether independent verification ever ran"],
      ]
    : [
        ["Onchain identity", "Registered in the ERC-8004 registry on Arc"],
        ["Settled executions", "ERC-8183 jobs completed and paid out"],
        ["Evaluator verdicts", "Independent verdicts on delivered work"],
        ["Economic reliability", "Refunds, rejections, disputed settlements"],
        ["Evidence freshness", "How recently any of this was observed"],
      ];

  const railPct = (step / (STEPS.length - 1)) * 100;

  return (
    <div data-surface="run" className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-[var(--run-line)] bg-[rgba(5,7,10,0.86)] backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between px-5 py-2.5 sm:px-7">
          <div className="flex items-center gap-3">
            <Link href="/" className="run-focus flex items-center gap-2.5">
              <span
                className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-[11px] font-bold text-[#04160e]"
                style={{ background: "linear-gradient(180deg,var(--run-mint),var(--run-mint-deep))" }}
              >
                V
              </span>
              <span className="text-[13.5px] font-semibold tracking-tight">Veyra</span>
            </Link>
            <span aria-hidden className="h-3.5 w-px bg-[var(--run-line-strong)]" />
            <span className="run-num hidden text-[10.5px] text-[var(--run-text-faint)] sm:inline">
              Arc Testnet · 5042002
            </span>
          </div>
          <nav className="flex items-center gap-0.5">
            {[["/executions", "Decisions"], ["/agents", "Agents"], ["/console", "Developers"]].map(
              ([href, text]) => (
                <Link
                  key={href}
                  href={href}
                  className="run-focus rounded-[6px] px-2.5 py-1.5 text-[12px] text-[var(--run-text-muted)] transition-colors hover:bg-[var(--run-surface)] hover:text-[var(--run-text)]"
                >
                  {text}
                </Link>
              ),
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-5 pb-20 pt-9 sm:px-7 sm:pt-12">

        {/* Claim on the left, evidence for it on the right. The right half used
            to be empty, which is the most expensive space on the page to waste
            and the reason the screen read as a form. */}
        <section className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_330px]">
          <div>
            {/* Two deliberate lines. Left to wrap on its own the lockup broke
                after "Circle", which is the worst of the three options. */}
            <h1 className="run-display text-[34px] sm:text-[44px]">
              Veyra decides.<br />
              <span style={{ color: "var(--run-mint)" }}>Circle pays.</span>
            </h1>
            <p className="mt-3.5 max-w-[46ch] text-[15px] leading-[1.55] text-[var(--run-text-muted)]">
              Before your agent spends USDC, Veyra weighs the evidence and decides
              whether it should pay, whom, and how much.
            </p>
            <div className="mt-5 flex flex-wrap gap-1.5">
              {["ERC-8004", "ERC-8183", "x402", "Gateway", "USDC", "Arc"].map((s) => (
                <span key={s} className="run-chip run-num">{s}</span>
              ))}
            </div>
          </div>

          <aside className="run-proof p-5">
            <div className="flex items-center justify-between">
              <span className="run-eyebrow">Proven on Arc</span>
              <span className="run-chip" data-tone="mint">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--run-mint)]" />
                Completed
              </span>
            </div>

            <div className="run-num mt-3.5 text-[19px] tracking-tight">
              Job #186207
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--run-text-faint)]">
              A full ERC-8183 lifecycle — escrow, submission, independent verdict,
              payout — between separate client, provider and evaluator keys.
            </p>

            <dl className="mt-4 space-y-2.5 border-t border-[var(--run-line)] pt-4">
              {[
                ["Escrow released", "0.05 USDC"],
                ["Total gas", "0.0118 USDC"],
                ["Create → payout", "19 s"],
                ["Onchain steps", "5"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[11.5px] text-[var(--run-text-faint)]">{k}</dt>
                  <dd className="run-num text-[12.5px] text-[var(--run-text)]">{v}</dd>
                </div>
              ))}
            </dl>

            <a
              href="https://testnet.arcscan.app/tx/0xd1d958d5014a3584a21c7e67444091af25c64940aa4759c928fa2962d0995a22"
              target="_blank"
              rel="noreferrer"
              className="run-focus mt-4 inline-flex items-center gap-1.5 text-[11.5px] text-[var(--run-mint)] hover:underline"
            >
              Verdict transaction on Arcscan
              <span aria-hidden>→</span>
            </a>
          </aside>
        </section>

        {/* Progress as a filled track. Six words on an invisible hairline read
            as scattered text; a track that fills reads as a position. */}
        <section className="run-panel mt-8 px-5 py-4" aria-label="Progress">
          <div className="mb-2.5 grid grid-cols-6 gap-2">
            {STEPS.map((s, i) => {
              const state = i < step ? "done" : i === step && phase !== "idle" ? "active" : "idle";
              return (
                <span
                  key={s}
                  className={`text-[9.5px] font-semibold uppercase tracking-[0.15em] ${
                    i === 0 ? "text-left" : i === STEPS.length - 1 ? "text-right" : "text-center"
                  } ${state === "active" ? "run-pulse" : ""}`}
                  style={{
                    color: state === "done" ? "var(--run-mint)"
                      : state === "active" ? "var(--run-text)"
                      : "var(--run-text-faint)",
                  }}
                >
                  {s}
                </span>
              );
            })}
          </div>
          <div className="run-rail-track">
            <span className="run-rail-fill" style={{ width: `${railPct}%` }} />
          </div>
        </section>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Panel raised className="p-5 sm:p-6">
            <div className="run-track mb-5 flex gap-1">
              {([["api", "API purchase", "x402 · Gateway"], ["job", "Agent job", "ERC-8004 · 8183"]] as const).map(
                ([value, text, sub]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRail(value)}
                    data-active={rail === value}
                    className="run-seg run-focus flex-1 px-3 py-2 text-left"
                    style={{ color: rail === value ? "var(--run-text)" : "var(--run-text-faint)" }}
                  >
                    <span className="block text-[12.5px] font-semibold">{text}</span>
                    <span className="run-num mt-px block text-[9.5px] text-[var(--run-text-faint)]">{sub}</span>
                  </button>
                ),
              )}
            </div>

            <label className="block">
              <Eyebrow>What does your agent need?</Eyebrow>
              <div className="run-field mt-2">
                <input
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  placeholder="Research the latest developments in Ambient"
                  className="w-full bg-transparent px-3.5 py-2.5 text-[14px] text-[var(--run-text)] outline-none placeholder:text-[var(--run-text-faint)]"
                />
              </div>
            </label>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <Eyebrow>Capability</Eyebrow>
                <div className="run-field mt-2">
                  <select
                    value={capability}
                    onChange={(e) => setCapability(e.target.value)}
                    className="h-10 w-full cursor-pointer bg-transparent px-2.5 text-[13.5px] text-[var(--run-text)] outline-none"
                  >
                    {CAPABILITIES.map((c) => (
                      <option key={c} value={c} className="bg-[var(--run-surface)]">{c.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>
              </label>

              <label className="block">
                <Eyebrow>Budget</Eyebrow>
                <div className="run-field mt-2 flex h-10 items-center px-2.5">
                  <span className="run-num text-[13px] text-[var(--run-text-faint)]">$</span>
                  <input
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    inputMode="decimal"
                    className="run-num w-full bg-transparent px-1.5 text-[14px] text-[var(--run-text)] outline-none"
                  />
                  <span className="run-num text-[9.5px] text-[var(--run-text-faint)]">USDC</span>
                </div>
              </label>
            </div>

            <div className="mt-4">
              <Eyebrow>Optimize for</Eyebrow>
              <div className="run-track mt-2 flex gap-1">
                {(["trust", "cost", "speed"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    data-active={priority === p}
                    className="run-seg run-focus flex-1 px-3 py-1.5 text-[12.5px] font-medium capitalize"
                    style={{ color: priority === p ? "var(--run-text)" : "var(--run-text-faint)" }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--run-text-faint)]">
                {PRIORITY_NOTE[priority]} Ordering only — the verdict is unchanged.
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3.5 border-t border-[var(--run-line)] pt-5">
              <button
                type="button"
                onClick={decide}
                disabled={busy}
                className="run-cta run-focus inline-flex h-10 items-center rounded-[var(--run-radius-sm)] px-4.5 text-[13.5px] font-semibold"
              >
                {busy ? "Probing endpoints…" : "Find best route"}
              </button>
              {stats ? (
                <span className="run-num text-[11px] text-[var(--run-text-faint)]">
                  {stats.catalogTotal} in catalog · {stats.discovered} matched · {stats.probed} probed
                </span>
              ) : (
                <span className="text-[11px] text-[var(--run-text-faint)]">
                  Free — every candidate is probed before a cent moves.
                </span>
              )}
            </div>
          </Panel>

          <Panel className="flex flex-col p-5 sm:p-6">
            <Eyebrow>What Veyra checks</Eyebrow>
            <ul className="mt-3.5 space-y-3">
              {checklist.map(([title, detail], i) => (
                <li key={title} className="flex gap-3">
                  <span className="run-num mt-px text-[9.5px] text-[var(--run-text-faint)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium text-[var(--run-text)]">{title}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-[1.5] text-[var(--run-text-faint)]">{detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-auto border-t border-[var(--run-line)] pt-4 text-[11.5px] leading-[1.6] text-[var(--run-text-muted)]">
              How many of these can be observed is what caps the trust tier. A
              counterparty nobody has paid yet cannot reach <span className="text-[var(--run-mint)]">Allow</span> —
              not because it is bad, but because the evidence does not exist.
            </p>
          </Panel>
        </div>

        {error ? (
          <Panel className="mt-4 border-[rgba(255,97,114,0.28)] p-5">
            <Eyebrow>Not decided</Eyebrow>
            <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--run-text)]">{error}</p>
          </Panel>
        ) : null}

        {decision ? (
          <div className="mt-4">
            <DecisionPanel
              decision={decision}
              busy={phase === "authorizing"}
              onAuthorize={() => setPhase("authorized")}
            />
          </div>
        ) : null}

        {phase === "authorized" && decision ? (
          <Panel className="mt-4 p-5">
            <Eyebrow>Hand-off</Eyebrow>
            <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--run-text-muted)]">
              Veyra has decided and signed. Settlement is Circle&apos;s — pay the cleared
              resource, capped at the authorized exposure:
            </p>
            <pre className="run-num mt-3.5 overflow-x-auto rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas)] p-3.5 text-[11.5px] leading-relaxed text-[var(--run-text-muted)]">
{`circle services pay "${decision.resource ?? ""}" \\
  --max-amount ${decision.maxExposureUsdc} \\
  --output json`}
            </pre>
            <p className="mt-2.5 text-[11.5px] text-[var(--run-text-faint)]">
              Paying a different resource on the strength of this verdict will not work:
              the clearance is bound to the one above.
            </p>
          </Panel>
        ) : null}

        {shown.length > 0 ? (
          <section className="mt-8">
            <div className="mb-3.5 flex items-baseline justify-between">
              <Eyebrow>Candidates</Eyebrow>
              <span className="run-num text-[11px] text-[var(--run-text-faint)]">
                {shown.length} probed · budget <Money value={Number(budget)} className="text-[var(--run-text-muted)]" />
              </span>
            </div>
            <div className="run-rule mb-3.5" />
            <div className="space-y-2.5">
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
      </main>
    </div>
  );
}
