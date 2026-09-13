"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { BRAND } from "@/lib/brand";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import { ConnectChip } from "@/components/wallet/connect-chip";
import { buildPaymentTypedData } from "@/lib/x402/browser-payment";
import { buildRequestBody } from "@/lib/x402/request-body";
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

/** One ERC-8183 transaction, encoded by Veyra and signed by the buyer. */
type JobStep = {
  step: "create_job" | "approve_usdc" | "fund_escrow";
  to: string;
  data: string;
  value: string;
  chainId: number;
  title: string;
  detail: string;
};

/**
 * What an agent asked to look into, handed over in the URL.
 *
 * Nova finds something worth investigating and links here with the question
 * already written. Read once, at mount: a person who then edits the intent must
 * not have their edit overwritten by the address bar.
 */
function seededFromUrl(): { intent: string; capability: string } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const intent = params.get("intent")?.trim() ?? "";
  if (!intent) return null;
  const asked = params.get("capability")?.trim() ?? "";
  return {
    intent: intent.slice(0, 400),
    capability: CAPABILITIES.includes(asked) ? asked : CAPABILITIES[0],
  };
}

export function RunClient() {
  const seed = useMemo(seededFromUrl, []);
  const [rail, setRail] = useState<Rail>("api");
  const [intent, setIntent] = useState(seed?.intent ?? "");
  const [capability, setCapability] = useState(seed?.capability ?? CAPABILITIES[0]);
  const [budget, setBudget] = useState("0.10");
  const [priority, setPriority] = useState<Priority>("trust");

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<RunCandidate[]>([]);
  const [decision, setDecision] = useState<RunDecision | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<{ catalogTotal: number; discovered: number; probed: number } | null>(null);

  /* The exact bytes that will be posted to the seller, shown before the wallet
     opens and editable, because for a provider that publishes no input schema
     the only party who can know the right shape is the person reading. */
  const [requestBodyText, setRequestBodyText] = useState("");
  const [bodyTouched, setBodyTouched] = useState(false);

  /* The purchase itself, paid from the visitor's own wallet. `onAuthorize` used
     to flip a UI state and print a CLI command, so nothing was ever bought from
     the browser. Veyra signs the verdict; the user signs the money. */
  const [payment, setPayment] = useState<{
    stage: "quoting" | "signing" | "settling" | "preparing" | "prepared" | "funding" | "done" | "failed";
    quotedUsdc?: number;
    paidUsdc?: number;
    payTo?: string;
    transaction?: string | null;
    result?: unknown;
    message?: string;
    /* Where the money actually leaves from. Circle's batched scheme debits a
       Gateway deposit, not the wallet balance, so a user holding USDC can still
       be refused — and needs to be told where to put it. */
    funding?: "wallet" | "gateway_deposit";
    /* Exactly what the wallet is about to show, shown here first. A reader who
       cannot compare the two has no way to tell a bounded authorization from
       an unlimited approval — which is the whole promise of the product. */
    signing?: {
      chainId: number;
      network: string;
      primaryType: string;
      amountUsdc: number;
      recipient: string;
      nonce: string;
      validBefore: number;
      domainName: string;
      verifyingContract: string;
      gatewayBatched: boolean;
    };
    /* Whether a Gateway endpoint can actually be paid, asked before the wallet
       opens rather than discovered from a refusal afterwards. */
    gateway?: {
      supported: boolean;
      sufficient: boolean | null;
      gatewayAvailableAtomic: string | null;
      gatewayPendingAtomic: string | null;
      walletUsdcAtomic: string | null;
      depositAtomic: string;
      canDeposit: boolean;
      chainId: number;
      message: string;
      steps: Array<{ kind: string; to: string; data: string; value: string; chainId: number; title: string; detail: string }>;
    } | null;
    /* Which deposit step is in the wallet right now. */
    gatewayBusy?: string | null;
    gatewayDone?: string[];
    /* The verification the trust tier demanded, as it actually came back. */
    verification?: {
      verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
      required: boolean;
      summary: string;
      responseHash: string;
      checks: Array<{ id: string; passed: boolean | null; severity: string; detail: string }>;
    } | null;
    /* The endpoint re-quoted a different price than the catalog advertised.
       That is catalog drift arriving at the worst possible moment, and the
       reader has to see it. */
    quoteDrift?: { advertisedUsdc: number; quotedUsdc: number } | null;
    /* The decision-log entry this purchase or job belongs to. */
    executionId?: string | null;
    executionState?: string | null;
    /* ERC-8183 steps the buyer's own wallet must send. Veyra encodes them and
       signs none of them: the escrow is funded from the buyer's USDC. */
    jobSteps?: JobStep[];
    jobPhase?: string | null;
    jobId?: string | null;
    jobBudgetUsdc?: number | null;
    jobNote?: string | null;
    stepBusy?: string | null;
  } | null>(null);

  /* Veyra signs its verdicts to a wallet, so a decision needs a verified owner
     session. The screen used to call the API without one and print the raw
     `credential_missing` back at the visitor, which made the product's main
     screen look broken to anyone who had not been through the owner flow on
     some other page. The flow now lives here, where it is needed. */
  const wallet = useArcWallet();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);

  const checkSession = useCallback(async () => {
    try {
      const response = await fetch("/api/byoa/management/session", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      setAuthenticated(payload?.authenticated === true);
    } catch {
      setAuthenticated(false);
    }
  }, []);

  useEffect(() => { void checkSession(); }, [checkSession]);

  /* Two steps on purpose. `connect()` resolves before React has the address, so
     signing in the same handler would sign with a stale one; and a visitor who
     has not connected yet should be asked for that first, not for a signature. */
  async function verifyOwner() {
    setVerifying(true);
    setError(null);
    try {
      if (!wallet.providerAvailable) {
        throw new Error("No browser wallet was detected. Install one, or call the Agent API with a machine credential.");
      }
      const address = wallet.address;
      if (!address) throw new Error("Connect a wallet to continue.");
      if (!wallet.isArcTestnet) await wallet.switchToArc();

      const created = await post("/api/byoa/management/challenges", { wallet: address });
      if (!created.response.ok) throw new Error(failureText(created.payload, created.response.status));
      const challenge = created.payload?.challenge as { id: string; message: string };
      const signature = await wallet.signMessage(challenge.message);

      const opened = await post("/api/byoa/management/session", {
        challengeId: challenge.id,
        message: challenge.message,
        signature,
      });
      if (!opened.response.ok) throw new Error(failureText(opened.payload, opened.response.status));
      setAuthenticated(true);
      setPhase("idle");
    } catch (caught: any) {
      setError(caught?.message || "Wallet verification failed.");
      setPhase("error");
    } finally {
      setVerifying(false);
    }
  }

  const bodyPlan = useMemo(
    () => buildRequestBody({
      intent,
      capability,
      inputSchema: (decision?.inputSchema ?? null) as Record<string, unknown> | null,
    }),
    [intent, capability, decision?.inputSchema],
  );

  // Follows the plan until the reader edits it, then stays out of their way.
  useEffect(() => {
    if (bodyTouched) return;
    setRequestBodyText(JSON.stringify(bodyPlan.body, null, 2));
  }, [bodyPlan, bodyTouched]);

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

  /* Server strings are written for operators reading logs, not for the person
     looking at the screen. "BYOA request origin is not allowed." told a visitor
     nothing they could act on and exposed an internal subsystem's name; the
     original still goes to the console for whoever is debugging. */
  const HUMANISED: Record<string, string> = {
    origin_denied: `${BRAND.name} cannot open a wallet session on this address yet. The deployment has to list this domain before it will sign anything here.`,
    credential_missing: "Verify your wallet first — a decision is signed to an owner, so Veyra needs to know whose it is.",
    rate_limited: "Too many requests just now. Give it a moment and try again.",
    marketplace_discovery_unavailable: "The service catalog did not answer. Nothing was decided, and nothing was spent.",
    counterparty_no_eligible_candidate: "No counterparty cleared the policy at this budget. Raising the budget or relaxing the priority may find one.",
    clearance_unavailable: `${BRAND.name} cannot sign clearances right now, so it refused rather than authorise something it cannot attest to.`,
  };

  function failureText(payload: any, status: number) {
    const reason = payload?.reason || payload?.error?.code || payload?.code;
    const raw = payload?.error?.message || payload?.error || payload?.message;
    if (typeof raw === "string" && raw) console.warn("[run] request failed", { status, reason, raw });
    if (typeof reason === "string" && HUMANISED[reason]) return HUMANISED[reason];
    // A sentence naming an internal subsystem is still an internal string, even
    // when it reads like prose.
    const internal = /\bBYOA\b|supabase|postgres|permission denied|relation "/i;
    if (typeof raw === "string" && raw && !/^[a-z0-9_]+$/i.test(raw) && !internal.test(raw)) return raw;
    return `Request failed (${status})`;
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
      if (err?.status === 401 || /credential|session/i.test(String(err?.message ?? ""))) {
        setAuthenticated(false);
        setError("This session is no longer verified. Verify your wallet again to decide.");
      } else {
        setError(err?.message || "Something went wrong.");
      }
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
          + `${BRAND.name} will not authorise a job it cannot justify from evidence.`,
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
      // The persisted selection is what the ERC-8183 rail executes against.
      // Without it the job rail had nothing to hand the execution pipeline and
      // fell through to the x402 path, which cannot run an agent job.
      selectionId: selection.selectionId,
      capability,
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
      funding: c.marketplace.funding,
      payableNow: c.marketplace.payableNow ?? null,
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
      funding: rec.funding ?? null,
      payableNow: rec.payableNow ?? null,
      routingNote: rec.routingNote ?? null,
      inputSchema: (selection.candidates ?? []).find(
        (c: any) => c.marketplace?.candidateId === rec.candidateId,
      )?.marketplace?.inputSchema ?? null,
      outputSchema: (selection.candidates ?? []).find(
        (c: any) => c.marketplace?.candidateId === rec.candidateId,
      )?.marketplace?.outputSchema ?? null,
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
      selectionId: selection.selectionId,
      selectionHash: selection.canonicalHash,
      candidateId: rec.candidateId,
      capability,
    });
  }

  /**
   * One button, two rails, and they are not the same transaction.
   *
   * `onAuthorize` used to call the x402 purchase path no matter which rail the
   * decision came from. For an agent job that meant posting an ERC-8004 service
   * id to a route that expects an x402 endpoint URL: the button could not work,
   * and the rail the project's strongest onchain proof belongs to was the one
   * the product could not run.
   */
  async function authorize() {
    if (rail === "job") return prepareAgentJob();
    return payAndRun();
  }

  /**
   * The agent-job rail, on the rail it actually settles on.
   *
   * Preparation is deliberately where this stops by default. Advancing an
   * ERC-8183 job means creating it onchain and funding escrow, and the adapter
   * that does so signs with keys Veyra holds — which is the right shape for the
   * operator's own demo and the wrong shape for a stranger's money. So the job
   * is prepared, recorded, and the screen says plainly who must sign next.
   */
  async function prepareAgentJob() {
    if (!decision?.selectionId) {
      setPayment({ stage: "failed", message: "This decision has no persisted selection to execute against." });
      return;
    }
    setPhase("authorizing");
    setPayment({ stage: "preparing" });
    try {
      const prepared = await post("/api/execution/v1/prepare", {
        selectionId: decision.selectionId,
        requestedAmountUsdc: decision.maxExposureUsdc,
        mode: "PREPARE",
        ...(wallet.address ? { executorWallet: wallet.address } : {}),
      });
      if (!prepared.response.ok) {
        throw new Error(failureText(prepared.payload?.error ?? prepared.payload, prepared.response.status));
      }
      const attempt = prepared.payload?.execution ?? prepared.payload;
      const executionId = attempt?.executionId ?? null;
      setPayment({
        stage: "prepared",
        quotedUsdc: decision.priceUsdc ?? undefined,
        payTo: decision.payTo ?? undefined,
        executionId,
        executionState: attempt?.state ?? "PREPARED",
        message:
          "Authorized and recorded. ERC-8183 escrow is funded from your own wallet — "
          + `${BRAND.name} encodes each step and verifies it on Arc, and holds no key `
          + "that could spend for you.",
      });
      setPhase("authorized");
      if (executionId) await loadJobSteps(executionId, null);
    } catch (caught: any) {
      setPayment({ stage: "failed", message: caught?.shortMessage || caught?.message || "The job could not be prepared." });
      setPhase("decided");
    }
  }

  /** Asks Veyra what the wallet must send next. Nothing here is signed server-side. */
  async function loadJobSteps(executionId: string, jobId: string | null) {
    if (!wallet.address) {
      setPayment((prev) => prev && { ...prev, jobNote: "Connect a wallet to fund this job yourself." });
      return;
    }
    const steps = await post("/api/run/v1/job/steps", {
      executionId,
      buyerWallet: wallet.address,
      ...(jobId ? { jobId } : {}),
    });
    if (!steps.response.ok) {
      setPayment((prev) => prev && {
        ...prev,
        jobNote: failureText(steps.payload?.error ?? steps.payload, steps.response.status),
      });
      return;
    }
    setPayment((prev) => prev && {
      ...prev,
      jobSteps: steps.payload.steps ?? [],
      jobPhase: steps.payload.phase ?? null,
      jobId: steps.payload.job?.id ?? jobId ?? null,
      jobBudgetUsdc: steps.payload.budgetUsdc ?? null,
      jobNote: steps.payload.note ?? null,
    });
  }

  /** One step, sent by the user's wallet, then confirmed by Veyra against Arc. */
  /**
   * Funds Circle Gateway from the buyer's own wallet.
   *
   * Two transactions, exactly as Circle's buyer quickstart does them: approve
   * the exact deposit, then `deposit()`. The approval is never unlimited, and
   * it is skipped entirely when the existing allowance already covers it.
   *
   * A plain transfer to the Gateway wallet is NOT credited to the unified
   * balance, which is why this goes through the contract call and not a send.
   */
  async function fundGateway(step: { kind: string; to: string; data: string; chainId: number }) {
    setPayment((prev) => prev && { ...prev, gatewayBusy: step.kind, message: undefined });
    try {
      if (wallet.chainId !== step.chainId) {
        const switched = await wallet.switchToChain(step.chainId);
        if (!switched) throw new Error(`Switch your wallet to chain ${step.chainId} to fund Gateway.`);
      }
      await wallet.sendTransaction({
        to: step.to as `0x${string}`,
        data: step.data as `0x${string}`,
      });

      /* Re-read rather than assume. A deposit is credited to the unified
         balance a moment after the transaction lands, so the honest report is
         what Circle says now — not what the amount implies it ought to be. */
      const done = [...(payment?.gatewayDone ?? []), step.kind];
      const refreshed = await post("/api/run/v1/gateway", {
        chainId: step.chainId,
        wallet: wallet.address,
        requiredAtomic: payment?.gateway
          ? String(Math.round((payment.quotedUsdc ?? 0) * 1e6))
          : "0",
      });
      setPayment((prev) => prev && {
        ...prev,
        gatewayBusy: null,
        gatewayDone: done,
        gateway: refreshed.response.ok ? refreshed.payload : prev.gateway,
      });
    } catch (caught: any) {
      setPayment((prev) => prev && {
        ...prev,
        gatewayBusy: null,
        message: caught?.shortMessage || caught?.message || "That step was not completed.",
      });
    }
  }

  async function sendJobStep(step: JobStep) {
    const executionId = payment?.executionId;
    if (!executionId) return;
    setPayment((prev) => prev && { ...prev, stepBusy: step.step, jobNote: null });
    try {
      if (wallet.chainId !== step.chainId) {
        const switched = await wallet.switchToChain(step.chainId);
        if (!switched) throw new Error("Switch your wallet to Arc Testnet to sign this step.");
      }
      const txHash = await wallet.sendTransaction({
        to: step.to as `0x${string}`,
        data: step.data as `0x${string}`,
      });
      // Veyra reads the receipt from Arc rather than believing the browser.
      const advanced = await post("/api/run/v1/job/advance", {
        executionId,
        step: step.step,
        txHash,
      });
      const result = advanced.payload ?? {};
      if (!advanced.response.ok || result.confirmed === false) {
        setPayment((prev) => prev && {
          ...prev,
          stepBusy: null,
          jobNote: result.message || "That step did not confirm on Arc.",
        });
        return;
      }
      const jobId = result.jobId ?? payment?.jobId ?? null;
      setPayment((prev) => prev && {
        ...prev,
        stepBusy: null,
        jobId,
        executionState: result.state ?? prev.executionState,
      });
      await loadJobSteps(executionId, jobId);
    } catch (caught: any) {
      setPayment((prev) => prev && {
        ...prev,
        stepBusy: null,
        jobNote: caught?.shortMessage || caught?.message || "The wallet did not send that step.",
      });
    }
  }

  async function payAndRun() {
    if (!decision?.resource) return;
    setPhase("authorizing");
    setPayment({ stage: "quoting" });
    try {
      if (!wallet.address) throw new Error("Connect a wallet before paying.");

      /* 1. Quote. x402 prices per call, so the challenge is raised by the same
            body that will be sent — a different body is a different price.
            The body is whatever the reader approved above, not a guess made
            here: posting an invented shape is what turned a live purchase into
            a paid HTTP 400. */
      let requestBody: unknown;
      try {
        requestBody = JSON.parse(requestBodyText);
      } catch {
        throw new Error("The request body is not valid JSON. Fix it before paying.");
      }
      const quoted = await post("/api/run/v1/quote", {
        resource: decision.resource,
        method: "POST",
        requestBody,
        maxAmountUsdc: decision.maxExposureUsdc,
        chainId: wallet.chainId,
        // Sent so the server can refuse the quote outright when the provider's
        // own schema rejects the body, rather than letting it be paid for.
        inputSchema: decision.inputSchema ?? undefined,
      });
      /* The endpoint publishes its request schema inside the 402 challenge,
         which the quote route reads and the catalog may not carry at all. When
         that schema refuses the body, the repaired shape goes back on screen in
         the provider's own field names instead of leaving the reader to guess
         a second time — the refusal already cost nothing, and a fixed body is
         one click rather than one more rejected call. */
      const publishedSchema = quoted.payload?.error?.inputSchema as Record<string, unknown> | undefined;
      if (quoted.response.status === 422 && publishedSchema) {
        const repaired = buildRequestBody({ intent, capability, inputSchema: publishedSchema });
        setRequestBodyText(JSON.stringify(repaired.body, null, 2));
        setBodyTouched(true);
        throw new Error(
          `${quoted.payload.error.message} Veyra rebuilt the request from the schema the endpoint publishes — check it above and try again.`,
        );
      }
      if (!quoted.response.ok) throw new Error(failureText(quoted.payload?.error ?? quoted.payload, quoted.response.status));
      if (quoted.payload?.paymentRequired === false) {
        setPayment({ stage: "done", paidUsdc: 0, result: quoted.payload.body, message: "The endpoint answered without asking for payment." });
        setPhase("authorized");
        return;
      }

      const { accept, nonce, quotedUsdc, resourceDescriptor } = quoted.payload as { accept: any; nonce: string; quotedUsdc: number; resourceDescriptor: unknown };

      // 2. Be on the chain the endpoint is paid on. The clearance is issued on
      //    Arc; most of the x402 catalog settles on Base, so the wallet moves
      //    for one signature and the user is told why.
      if (wallet.chainId !== accept.chainId) {
        setPayment({ stage: "signing", quotedUsdc, payTo: accept.payTo, message: `Switch your wallet to chain ${accept.chainId} to pay this endpoint.` });
        const switched = await wallet.switchToChain(accept.chainId);
        if (!switched) throw new Error(`This endpoint settles on chain ${accept.chainId}. Switch your wallet there and try again.`);
      }

      // 3. Sign. The wallet shows the same recipient and amount as the panel,
      //    and the signature is what caps the spend — not this page.
      const funding: "wallet" | "gateway_deposit" = accept.gatewayBatched ? "gateway_deposit" : "wallet";
      const quoteDrift = decision.priceUsdc !== null
        && Math.abs(quotedUsdc - decision.priceUsdc) > 1e-9
        ? { advertisedUsdc: decision.priceUsdc, quotedUsdc }
        : null;
      /* Ask before the wallet opens, not after the refusal. A batched accept
         spends a Gateway deposit rather than the wallet balance, so a wallet
         holding plenty of USDC is still refused — and the refusal arrives
         after the reader has approved a signature for nothing. */
      if (accept.gatewayBatched) {
        const preflight = await post("/api/run/v1/gateway", {
          chainId: accept.chainId,
          wallet: wallet.address,
          requiredAtomic: accept.amountAtomic,
        });
        const gateway = preflight.response.ok ? preflight.payload : null;
        if (gateway && gateway.supported && gateway.sufficient !== true) {
          setPayment({
            stage: "funding",
            quotedUsdc,
            payTo: accept.payTo,
            funding,
            quoteDrift,
            gateway,
            gatewayDone: [],
            gatewayBusy: null,
          });
          setPhase("decided");
          return;
        }
      }

      const { authorization, typedData } = buildPaymentTypedData({
        accept,
        from: wallet.address as `0x${string}`,
        nonce: nonce as `0x${string}`,
      });
      /* Published before the wallet is asked, so the two can be compared field
         by field. The authorization names one recipient, one amount and one
         nonce, and expires; it is not an allowance the seller can draw again. */
      setPayment({
        stage: "signing",
        quotedUsdc,
        payTo: accept.payTo,
        funding,
        quoteDrift,
        signing: {
          chainId: accept.chainId,
          network: accept.network,
          primaryType: typedData.primaryType as string,
          amountUsdc: Number(authorization.value) / 1e6,
          recipient: authorization.to,
          nonce: authorization.nonce,
          validBefore: Number(authorization.validBefore),
          domainName: accept.assetName,
          verifyingContract: accept.verifyingContract,
          gatewayBatched: Boolean(accept.gatewayBatched),
        },
      });
      const signature = await wallet.signTypedData(typedData as any);

      // 4. Relay. Veyra carries the signed authorization to the seller and
      //    returns what came back.
      setPayment({ stage: "settling", quotedUsdc, payTo: accept.payTo, funding, quoteDrift });
      const settled = await post("/api/run/v1/settle", {
        resource: decision.resource,
        method: "POST",
        requestBody,
        accept,
        authorization,
        signature,
        resourceDescriptor,
        // The tier asked for verification; this is what makes it happen rather
        // than merely be announced.
        verificationRequired: decision.postCallVerificationRequired,
        declaredOutputSchema: decision.outputSchema ?? undefined,
        // Files this purchase against the decision that authorized it, instead
        // of leaving the decision log blank while money moves.
        selectionId: decision.selectionId ?? undefined,
        selectionHash: decision.selectionHash ?? undefined,
        clearanceDigest: decision.clearance?.digest ?? undefined,
        counterpartyAgentId: decision.candidateId ?? undefined,
        capability: decision.capability ?? undefined,
      });
      if (!settled.response.ok) throw new Error(failureText(settled.payload?.error ?? settled.payload, settled.response.status));
      const result = settled.payload as any;
      if (result.settled === false) {
        setPayment({
          stage: "failed",
          executionId: result.executionId ?? null,
          quotedUsdc,
          funding,
          quoteDrift,
          paidUsdc: result.paid ? result.paidUsdc : undefined,
          payTo: result.paid ? result.payTo : undefined,
          transaction: result.transaction ?? null,
          verification: result.verification ?? null,
          result: result.paid ? (result.result ?? result.body) : undefined,
          message: result.message
            || result.verification?.summary
            || "The endpoint rejected the payment.",
        });
        setPhase("decided");
        return;
      }
      setPayment({
        stage: "done",
        executionId: result.executionId ?? null,
        quotedUsdc,
        paidUsdc: result.paidUsdc,
        payTo: result.payTo,
        transaction: result.transaction ?? null,
        result: result.result ?? result.body,
        verification: result.verification ?? null,
        funding,
        quoteDrift,
      });
      setPhase("authorized");
    } catch (caught: any) {
      setPayment({ stage: "failed", message: caught?.shortMessage || caught?.message || "The purchase did not complete." });
      setPhase("decided");
    }
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
                className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-[11px] font-bold text-white"
                style={{ background: "linear-gradient(180deg,var(--run-accent),var(--run-accent-deep))" }}
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
                  className="run-focus hidden rounded-[6px] px-2.5 py-1.5 text-[12px] text-[var(--run-text-muted)] transition-colors hover:bg-[var(--run-surface)] hover:text-[var(--run-text)] sm:block"
                >
                  {text}
                </Link>
              ),
            )}
            <span aria-hidden className="mx-1.5 hidden h-4 w-px bg-[var(--run-line-strong)] sm:block" />
            <ConnectChip verified={authenticated} onVerify={() => void verifyOwner()} verifying={verifying} />
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-5 pb-20 pt-7 sm:px-7 sm:pt-9">

        {/* Product first. The pitch gets the height it earns and no more: the
            point of this screen is to be used, not read. */}
        <section className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            {/* Two deliberate lines. Left to wrap on its own the lockup broke
                after "Circle", which is the worst of the three options. */}
            <h1 className="run-display text-[30px] sm:text-[38px]">
              Veyra decides.<br />
              <span style={{ color: "var(--run-accent)" }}>Circle pays.</span>
            </h1>
            <p className="mt-3 max-w-[38ch] text-[14px] leading-[1.5] text-[var(--run-text-muted)]">
              Veyra checks who you are about to pay, and what it will cost, before you sign.
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {["ERC-8004", "ERC-8183", "x402", "Gateway", "USDC", "Arc"].map((s) => (
                <span key={s} className="run-chip run-num">{s}</span>
              ))}
            </div>
          </div>

          {/* Not another bordered card: a lit plate, so the one piece of hard
              evidence on the page does not look like a form field. */}
          <aside className="run-proof px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <span className="run-eyebrow">Live proof</span>
              <a
                href="https://testnet.arcscan.app/tx/0xd1d958d5014a3584a21c7e67444091af25c64940aa4759c928fa2962d0995a22"
                target="_blank"
                rel="noreferrer"
                className="run-focus run-num text-[11px] text-[var(--run-azure)] hover:underline"
              >
                Job #186207 ↗
              </a>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
              {[
                ["Escrow paid", "0.05 USDC"],
                ["Policy checks", "11 / 11"],
                ["Gas", "0.0118 USDC"],
                ["Create → payout", "19 s"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--run-text-faint)]">{k}</dt>
                  <dd className="run-num mt-0.5 text-[13px] text-[var(--run-text)]">{v}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </section>

        {/* A row of six headings reports nothing. Nodes on filling connectors
            report where the run actually is, and the line underneath says what
            it is doing right now. No box: this is not a panel, it is status. */}
        <section className="mt-7 border-t border-[var(--run-line)] pt-4" aria-label="Progress">
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            {STEPS.map((s, i) => {
              const state = i < step ? "done" : i === step && phase !== "idle" ? "active" : "idle";
              return (
                <Fragment key={s}>
                  {i > 0 ? (
                    <span className="run-link min-w-[14px]">
                      <span style={{ width: i <= step ? "100%" : "0%" }} />
                    </span>
                  ) : null}
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="run-node" data-state={state} />
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${state === "active" ? "run-pulse" : ""}`}
                      style={{
                        color: state === "done" ? "var(--run-azure)"
                          : state === "active" ? "var(--run-text)"
                          : "var(--run-text-faint)",
                      }}
                    >
                      {s}
                    </span>
                  </span>
                </Fragment>
              );
            })}
          </div>
          <div className="run-num mt-2 h-4 text-[11px] text-[var(--run-text-faint)]">
            {busy
              ? rail === "api"
                ? "probing live endpoints…"
                : "reading ERC-8004 identity and settlement history…"
              : stats
                ? `${stats.catalogTotal} in catalog · ${stats.discovered} matched · ${stats.probed} probed`
                : ""}
          </div>
        </section>

        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
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
              {authenticated === false ? (
                <>
                  <button
                    type="button"
                    onClick={() => (wallet.address ? void verifyOwner() : void wallet.connect())}
                    disabled={verifying || wallet.connecting}
                    className="run-cta run-focus inline-flex h-10 items-center rounded-[var(--run-radius-sm)] px-4.5 text-[13.5px] font-semibold"
                  >
                    {wallet.connecting
                      ? "Opening wallet…"
                      : verifying
                        ? "Waiting for signature…"
                        : wallet.address
                          ? "Verify wallet to decide"
                          : "Connect wallet"}
                  </button>
                  <span className="max-w-[44ch] text-[11px] leading-relaxed text-[var(--run-text-faint)]">
                    A verdict is signed to a wallet, so Veyra needs to know whose it is.
                    One signature, no transaction, nothing spent.
                  </span>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={decide}
                    disabled={busy || authenticated === null}
                    className="run-cta run-focus inline-flex h-10 items-center rounded-[var(--run-radius-sm)] px-4.5 text-[13.5px] font-semibold"
                  >
                    {busy ? "Probing endpoints…" : "Find best route"}
                  </button>
                  <span className="text-[11px] text-[var(--run-text-faint)]">
                    Free — every candidate is probed before a cent moves.
                  </span>
                </>
              )}
            </div>
          </Panel>

          <aside className="run-aside flex flex-col">
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
              counterparty nobody has paid yet cannot reach <span className="text-[var(--run-azure)]">Allow</span> —
              not because it is bad, but because the evidence does not exist.
            </p>
          </aside>
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
              onAuthorize={() => void authorize()}
            />

            {/* Shown before the wallet opens, never after. x402 prices per call
                and the seller charges for what it received, so a request the
                provider rejects still costs the call — which is exactly how a
                live purchase became a paid HTTP 400. */}
            {rail === "api" && decision.granted ? (
              <section className="run-panel mt-3 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
                  <span className="run-eyebrow">Request sent to the provider</span>
                  {bodyPlan.guessed ? (
                    <span className="text-[11px] font-medium text-[var(--run-amber)]">
                      Shape not published — guessed
                    </span>
                  ) : (
                    <span className="text-[11px] text-[var(--run-azure)]">
                      Built from the provider&apos;s published schema
                    </span>
                  )}
                </div>
                <div className="px-5 pb-4 pt-3">
                  <textarea
                    value={requestBodyText}
                    onChange={(event) => { setBodyTouched(true); setRequestBodyText(event.target.value); }}
                    spellCheck={false}
                    rows={Math.min(10, Math.max(3, requestBodyText.split("\n").length))}
                    aria-label="Request body sent to the provider"
                    className="run-field run-num w-full resize-y rounded-[var(--run-radius-sm)] p-3 text-[12px] leading-relaxed"
                  />
                  {bodyPlan.note ? (
                    <p className="mt-2.5 max-w-[68ch] text-[11.5px] leading-relaxed text-[var(--run-text-muted)]">
                      {bodyPlan.note}
                    </p>
                  ) : null}
                  {bodyTouched ? (
                    <button
                      type="button"
                      onClick={() => setBodyTouched(false)}
                      className="run-focus mt-2.5 text-[11.5px] text-[var(--run-text-faint)] underline-offset-4 hover:underline"
                    >
                      Reset to what Veyra proposed
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {/* What the user actually bought. The screen used to stop at a CLI
            command, which meant the product ended one step before the thing the
            user came for. */}
        {payment ? (
          <section className="run-decision mt-4" data-verdict="allow">
            <div className="run-signature" />
            <div className="px-6 py-5">
              <div className="flex flex-wrap items-baseline justify-between gap-4">
                <span className="run-eyebrow">
                  {payment.stage === "preparing"
                    ? "Preparing the job"
                    : payment.stage === "prepared"
                      ? "Job authorized"
                      : payment.stage === "done"
                    ? payment.verification?.verdict === "INCONCLUSIVE" ? "Result · unverified" : "Result · verified"
                    : payment.stage === "failed"
                      ? payment.paidUsdc !== undefined ? "Paid · failed verification" : "Not purchased"
                      : payment.stage === "funding"
                        ? "Gateway balance required"
                        : "Purchasing"}
                </span>
                {payment.paidUsdc !== undefined ? (
                  <span className="run-num text-[13px] text-[var(--run-text-muted)]">
                    paid <Money value={payment.paidUsdc} className="text-[var(--run-text)]" />
                    {payment.payTo ? <> to <span className="text-[var(--run-text-faint)]">{payment.payTo.slice(0, 8)}…{payment.payTo.slice(-4)}</span></> : null}
                  </span>
                ) : payment.quotedUsdc !== undefined ? (
                  <span className="run-num text-[13px] text-[var(--run-text-muted)]">
                    quoted <Money value={payment.quotedUsdc} className="text-[var(--run-text)]" />
                  </span>
                ) : null}
              </div>

              {payment.stage !== "done" && payment.stage !== "failed"
                && payment.stage !== "preparing" && payment.stage !== "prepared"
                /* Funding is not a step of the purchase — it is what has to be
                   true before the purchase can start. Showing it inside the
                   three-step run would claim progress that has not happened. */
                && payment.stage !== "funding" ? (
                <ol className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {(["quoting", "signing", "settling"] as const).map((step, i) => {
                    const order = { quoting: 0, signing: 1, settling: 2 } as const;
                    const at = order[payment.stage as keyof typeof order] ?? 0;
                    const label = step === "quoting"
                      ? "Reading the price"
                      : step === "signing"
                        ? "Waiting for your signature"
                        : "Delivering the payment";
                    return (
                      <li key={step} className="flex items-center gap-2">
                        {i > 0 ? <span aria-hidden className="text-[10px] text-[var(--run-line-strong)]">→</span> : null}
                        <span className="run-node" data-state={i < at ? "done" : i === at ? "active" : "idle"} />
                        <span
                          className={`text-[11.5px] ${i === at ? "run-pulse" : ""}`}
                          style={{ color: i <= at ? "var(--run-text)" : "var(--run-text-faint)" }}
                        >
                          {label}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              ) : null}

              {payment.quoteDrift ? (
                <p
                  className="mt-3.5 max-w-[62ch] rounded-[var(--run-radius-sm)] border px-3 py-2 text-[12px] leading-relaxed"
                  style={{ borderColor: "var(--run-amber)", color: "var(--run-amber)" }}
                >
                  This endpoint now asks <Money value={payment.quoteDrift.quotedUsdc} /> where its
                  catalog entry advertised <Money value={payment.quoteDrift.advertisedUsdc} />. The
                  signature covers the live price, never the advertised one.
                </p>
              ) : null}

              {payment.stage === "signing" ? (
                <p className="mt-3.5 max-w-[62ch] text-[12px] leading-relaxed text-[var(--run-text-muted)]">
                  Your wallet is showing the exact recipient and amount above. That
                  signature is the ceiling — Veyra relays it and cannot change it.
                </p>
              ) : null}

              {/* The same fields the wallet is about to show, published first so
                  the two can be compared. A wallet may warn on this signature:
                  Circle's batched scheme domain-separates the authorization by
                  the Gateway contract rather than by the token, which most
                  simulators cannot evaluate. The warning is about what the
                  simulator could not read, and these are the values it could
                  not read — an authorization for one amount, to one recipient,
                  on one nonce, that expires. */}
              {payment.stage === "signing" && payment.signing ? (
                <div className="mt-4 rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas-raised)] p-4">
                  <span className="run-eyebrow">You are signing</span>
                  <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
                    {[
                      ["Network", `chain ${payment.signing.chainId}`],
                      ["Type", payment.signing.primaryType],
                      ["Amount", `${payment.signing.amountUsdc.toFixed(6)} USDC`],
                      ["Recipient", payment.signing.recipient],
                      ["Signed against", `${payment.signing.domainName} · ${payment.signing.verifyingContract}`],
                      ["Expires", new Date(payment.signing.validBefore * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z"],
                      ["Nonce", payment.signing.nonce],
                    ].map(([label, value]) => (
                      <Fragment key={label}>
                        <dt className="text-[11.5px] uppercase tracking-wide text-[var(--run-text-faint)]">{label}</dt>
                        <dd className="run-num break-all text-[12px] text-[var(--run-text)]">{value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  <p className="mt-3 max-w-[62ch] text-[12px] leading-relaxed text-[var(--run-text-muted)]">
                    This authorization can move exactly{" "}
                    {payment.signing.amountUsdc.toFixed(6)} USDC to that recipient,
                    once, before it expires. It is not an unlimited approval, and
                    nothing can be drawn again on the same nonce.
                  </p>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(payment.signing!.recipient)}
                    className="run-focus mt-3 text-[12px] text-[var(--run-azure)] hover:underline"
                  >
                    Copy recipient
                  </button>
                </div>
              ) : null}

              {/* The dead end, turned into the step that clears it. Veyra used to
                  name the Gateway deposit as the reason a funded wallet was
                  refused and then offer no way to make one. */}
              {payment.stage === "funding" && payment.gateway ? (
                <div className="mt-4 space-y-3">
                  <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
                    {[
                      ["Price", `${(payment.quotedUsdc ?? 0).toFixed(6)} USDC`],
                      ["Wallet balance", payment.gateway.walletUsdcAtomic === null
                        ? "unknown"
                        : `${(Number(payment.gateway.walletUsdcAtomic) / 1e6).toFixed(6)} USDC`],
                      ["Gateway balance", payment.gateway.gatewayAvailableAtomic === null
                        ? "unknown"
                        : `${(Number(payment.gateway.gatewayAvailableAtomic) / 1e6).toFixed(6)} USDC`],
                    ].map(([label, value]) => (
                      <Fragment key={label}>
                        <dt className="text-[11.5px] uppercase tracking-wide text-[var(--run-text-faint)]">{label}</dt>
                        <dd className="run-num text-[12.5px] text-[var(--run-text)]">{value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  <p className="max-w-[62ch] text-[12.5px] leading-relaxed text-[var(--run-text)]">
                    {payment.gateway.message}
                  </p>

                  {payment.gateway.sufficient === true ? (
                    <button
                      type="button"
                      onClick={() => void payAndRun()}
                      className="run-cta run-focus inline-flex h-10 items-center rounded-[var(--run-radius-sm)] px-5 text-[13px] font-semibold"
                    >
                      Continue purchase — {(payment.quotedUsdc ?? 0).toFixed(6)} USDC
                    </button>
                  ) : payment.gateway.steps.map((step, index) => {
                    const done = (payment.gatewayDone ?? []).includes(step.kind);
                    return (
                      <div
                        key={step.kind}
                        className="rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas-raised)] p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2.5">
                              <span className="run-num text-[11px] text-[var(--run-text-faint)]">
                                {String(index + 1).padStart(2, "0")}
                              </span>
                              <span className="text-[13.5px] font-medium">{step.title}</span>
                              {done ? (
                                <span className="text-[11px] text-[var(--run-azure)]">done</span>
                              ) : null}
                            </div>
                            <p className="mt-1.5 max-w-[58ch] text-[12px] leading-relaxed text-[var(--run-text-muted)]">
                              {step.detail}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void fundGateway(step)}
                            disabled={done || Boolean(payment.gatewayBusy)}
                            className="run-cta run-focus inline-flex h-9 shrink-0 items-center rounded-[var(--run-radius-sm)] px-4 text-[12.5px] font-semibold disabled:opacity-50"
                          >
                            {payment.gatewayBusy === step.kind ? "Waiting for your wallet…" : "Sign in wallet"}
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  <p className="max-w-[62ch] text-[12px] leading-relaxed text-[var(--run-text-faint)]">
                    A deposit stays yours and can be withdrawn from Circle Gateway.
                    It is not a payment to this endpoint — it is the balance every
                    batched endpoint on this chain draws from.
                  </p>
                </div>
              ) : null}

              {/* Two rails that look identical in the wallet and are not. A
                  vanilla accept moves USDC out of the balance the wallet shows;
                  Circle's batched accept debits a Gateway deposit, so someone
                  holding plenty of USDC can still be refused for an empty
                  deposit — with no way to guess that from the error. */}
              {payment.funding === "gateway_deposit"
                && payment.stage !== "done" ? (
                <p className="mt-3.5 max-w-[62ch] text-[12px] leading-relaxed text-[var(--run-text-faint)]">
                  This endpoint settles through Circle Gateway, which spends a
                  Gateway deposit rather than your wallet balance. Holding USDC is
                  not enough — it has to be deposited to the Gateway wallet on
                  this chain first.
                </p>
              ) : null}

              {payment.message ? (
                <p className="mt-3.5 text-[13px] leading-relaxed text-[var(--run-text)]">{payment.message}</p>
              ) : null}

              {/* The buyer's own signatures. Veyra encodes each call and reads the
                  receipt back from Arc; it never holds a key that could send
                  one, which is what keeps the escrow the buyer's money. */}
              {payment.jobSteps && payment.jobSteps.length > 0 ? (
                <div className="mt-4 space-y-2.5">
                  {payment.jobBudgetUsdc ? (
                    <div className="run-num text-[12px] text-[var(--run-text-muted)]">
                      escrow budget <Money value={payment.jobBudgetUsdc} className="text-[var(--run-text)]" />
                      {payment.jobId ? <span className="text-[var(--run-text-faint)]"> · job #{payment.jobId}</span> : null}
                    </div>
                  ) : null}
                  {payment.jobSteps.map((step, index) => (
                    <div
                      key={step.step}
                      className="rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas-raised)] p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2.5">
                            <span className="run-num text-[11px] text-[var(--run-text-faint)]">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className="text-[13.5px] font-medium">{step.title}</span>
                          </div>
                          <p className="mt-1.5 max-w-[58ch] text-[12px] leading-relaxed text-[var(--run-text-muted)]">
                            {step.detail}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void sendJobStep(step)}
                          disabled={payment.stepBusy !== null && payment.stepBusy !== undefined}
                          className="run-cta run-focus inline-flex h-9 shrink-0 items-center rounded-[var(--run-radius-sm)] px-4 text-[12.5px] font-semibold"
                        >
                          {payment.stepBusy === step.step ? "Waiting for your wallet…" : "Sign in wallet"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {payment.jobNote ? (
                <p className="mt-3.5 max-w-[62ch] text-[12px] leading-relaxed text-[var(--run-text-muted)]">
                  {payment.jobNote}
                </p>
              ) : null}

              {payment.executionId ? (
                <p className="run-num mt-3 text-[11.5px] text-[var(--run-text-faint)]">
                  recorded as{" "}
                  <Link
                    href="/executions"
                    className="run-focus text-[var(--run-azure)] hover:underline"
                  >
                    {payment.executionId}
                  </Link>
                  {payment.executionState ? ` · ${payment.executionState}` : null}
                </p>
              ) : null}

              {payment.transaction ? (
                <a
                  href={`https://basescan.org/tx/${payment.transaction}`}
                  target="_blank"
                  rel="noreferrer"
                  className="run-focus run-num mt-3 inline-block text-[11.5px] text-[var(--run-azure)] hover:underline"
                >
                  {payment.transaction.slice(0, 10)}…{payment.transaction.slice(-6)} ↗
                </a>
              ) : null}

              {payment.verification ? (
                <div className="mt-4 rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas-raised)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                    <span className="run-eyebrow">
                      {payment.verification.required ? "Required verification" : "Verification"}
                    </span>
                    <span
                      className="run-num text-[12px] font-semibold"
                      style={{
                        color: payment.verification.verdict === "PASS"
                          ? "var(--run-azure)"
                          : payment.verification.verdict === "FAIL"
                            ? "var(--run-red)"
                            : "var(--run-amber)",
                      }}
                    >
                      {payment.verification.verdict}
                    </span>
                  </div>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--run-text-muted)]">
                    {payment.verification.summary}
                  </p>
                  <ul className="mt-3 space-y-1.5">
                    {payment.verification.checks.map((check) => (
                      <li key={check.id} className="flex items-start gap-2.5 text-[12px]">
                        <span
                          aria-hidden
                          className="mt-[6px] h-[5px] w-[5px] shrink-0 rounded-full"
                          style={{
                            background: check.passed === true
                              ? "var(--run-azure)"
                              : check.passed === false
                                ? "var(--run-red)"
                                : "var(--run-text-faint)",
                          }}
                        />
                        <span className="min-w-0 text-[var(--run-text-muted)]">{check.detail}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="run-num mt-3 text-[11px] text-[var(--run-text-faint)]">
                    response {payment.verification.responseHash.slice(0, 10)}…{payment.verification.responseHash.slice(-6)}
                  </p>
                </div>
              ) : null}

              {payment.result !== undefined && payment.result !== null ? (
                <pre className="run-num mt-4 max-h-[26rem] overflow-auto rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-canvas)] p-4 text-[11.5px] leading-relaxed text-[var(--run-text-muted)]">
{typeof payment.result === "string" ? payment.result : JSON.stringify(payment.result, null, 2)}
                </pre>
              ) : null}

              {payment.stage === "failed" ? (
                <button
                  type="button"
                  onClick={() => void payAndRun()}
                  className="run-cta run-focus mt-4 inline-flex h-9 items-center rounded-[var(--run-radius-sm)] px-4 text-[13px] font-semibold"
                >
                  Try the purchase again
                </button>
              ) : null}
            </div>
          </section>
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
