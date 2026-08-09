/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Calculator,
  Check,
  CreditCard,
  LoaderCircle,
  Wallet,
  ShieldCheck,
  Zap,
  Github,
  Activity,
  BarChart3,
  MessageSquareText,
  Rocket,
  ArrowRight,
  Info,
  Sparkles,
  Layers,
  AlertCircle,
  FileCheck2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import { shortenHash } from "@/lib/utils";
import { humanizeError } from "@/lib/errors/humanize-error";
import {
  HOSTED_REQUESTER_IDENTITY_LABEL,
  HOSTED_REQUESTER_NOT_CHARGED_COPY,
  HOSTED_REQUESTER_PAYMENT_COPY,
  hostedInputPreviewHelper,
} from "@/lib/agent/hosted-ui";
import {
  getHostedWorkflowTemplate,
  curatedHostedWorkflowTemplates,
} from "@/lib/agent/workflow-templates";
import { parseGitHubRepositoryInput } from "@/lib/providers/github-repository-ref";
import type {
  HostedPlannerSnapshot,
  HostedWorkflowQuote,
  PythMarketSymbol,
  HostedRunnerDiagnostic,
  HostedWorkflowType,
  RecentHostedJob,
} from "./types";

const workflowIcons: Record<HostedWorkflowType, typeof Bot> = {
  agent_trust_report: ShieldCheck,
  treasury_health: Zap,
  github_due_diligence: Github,
  paid_api_quality: Activity,
  market_context: BarChart3,
  sentiment_tone: MessageSquareText,
  builder_update: Rocket,
  custom_task: Bot,
  project_360: Layers,
};

const runnerWorkflowTemplates = curatedHostedWorkflowTemplates.filter(
  (workflow) => workflow.value !== "project_360",
);

export function HostedAgentRunner({
  diagnostic,
  initialHistory: _initialHistory,
  initialWorkflowType,
  initialMarketSymbol,
  initialRepository,
}: {
  diagnostic: HostedRunnerDiagnostic;
  initialHistory?: RecentHostedJob[];
  initialWorkflowType: HostedWorkflowType;
  initialMarketSymbol: PythMarketSymbol;
  initialRepository?: string;
}) {
  const router = useRouter();
  const wallet = useArcWallet();
  const initial =
    runnerWorkflowTemplates.find(
      (workflow) => workflow.value === initialWorkflowType,
    ) ?? runnerWorkflowTemplates[0];
  const [workflowType, setWorkflowType] = useState<HostedWorkflowType>(initial.value);
  const [task, setTask] = useState(initial.task);
  const [inputText, setInputText] = useState(initialRepository ?? "");
  const [agentId, setAgentId] = useState("");
  const [agentWallet, setAgentWallet] = useState("");
  const [treasuryWalletAddress, setTreasuryWalletAddress] = useState("");
  const [agentRepositoryUrl, setAgentRepositoryUrl] = useState(
    initialWorkflowType === "agent_trust_report" ? initialRepository ?? "" : "",
  );
  const [contractAddress, setContractAddress] = useState("");
  const [serviceEndpoint, setServiceEndpoint] = useState("");
  const [marketSymbol, setMarketSymbol] = useState<PythMarketSymbol>(initialMarketSymbol);
  const budget = "0.005";
  const [plan, setPlan] = useState<HostedPlannerSnapshot | null>(null);
  const [quote, setQuote] = useState<HostedWorkflowQuote | null>(null);
  const [sponsoredAuthorizationMessage, setSponsoredAuthorizationMessage] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const paymentTransactionHash = useRef<string | null>(null);
  const sponsoredSignature = useRef<string | null>(null);

  const [selectedQualityServices, setSelectedQualityServices] = useState<string[]>([
    "pyth-market-price",
    "github-repository-intelligence",
  ]);
  const [observationWindowDays, setObservationWindowDays] = useState<7 | 30 | 90>(30);
  const [serviceSearchQuery, setServiceSearchQuery] = useState("");
  const [observationCountPreview, setObservationCountPreview] = useState<{
    totalObservations: number;
    observationsByService: Record<string, number>;
  } | null>(null);
  const [loadingObservations, setLoadingObservations] = useState(false);

  let repositoryRef: ReturnType<typeof parseGitHubRepositoryInput> | null = null;
  if (workflowType === "github_due_diligence" && inputText.trim()) {
    try {
      repositoryRef = parseGitHubRepositoryInput(inputText);
    } catch {
      repositoryRef = null;
    }
  }

  let agentRepositoryRef: ReturnType<typeof parseGitHubRepositoryInput> | null = null;
  if (workflowType === "agent_trust_report" && agentRepositoryUrl.trim()) {
    try {
      agentRepositoryRef = parseGitHubRepositoryInput(agentRepositoryUrl);
    } catch {
      agentRepositoryRef = null;
    }
  }
  const agentIdValid = !agentId.trim() || /^agt_[a-z0-9]{20}$/.test(agentId.trim());
  const agentWalletValid =
    !agentWallet.trim() || /^0x[0-9a-fA-F]{40}$/.test(agentWallet.trim());
  const treasuryWalletValid =
    !treasuryWalletAddress.trim() || /^0x[0-9a-fA-F]{40}$/.test(treasuryWalletAddress.trim());
  const contractAddressValid =
    !contractAddress.trim() || /^0x[0-9a-fA-F]{40}$/.test(contractAddress.trim());
  const serviceEndpointValid = (() => {
    if (!serviceEndpoint.trim()) return true;
    try {
      const url = new URL(serviceEndpoint.trim());
      return url.protocol === "https:" && !/^(?:localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(url.hostname);
    } catch {
      return false;
    }
  })();
  const hasAgentTrustPrimaryInput =
    Boolean(agentId.trim()) ||
    Boolean(agentWallet.trim()) ||
    Boolean(agentRepositoryUrl.trim());
  const isInputValid =
    workflowType === "github_due_diligence"
      ? Boolean(repositoryRef)
      : workflowType === "agent_trust_report"
        ? hasAgentTrustPrimaryInput &&
          agentIdValid &&
          agentWalletValid &&
          contractAddressValid &&
          serviceEndpointValid &&
          (!agentRepositoryUrl.trim() || Boolean(agentRepositoryRef))
        : workflowType === "paid_api_quality"
          ? selectedQualityServices.length >= 1 && selectedQualityServices.length <= 5
          : workflowType === "treasury_health"
            ? Boolean(treasuryWalletAddress.trim()) && treasuryWalletValid
            : inputText.trim().length >= 20;

  const inputHelper = workflowType === "github_due_diligence"
    ? repositoryRef
      ? "Repository valid. Ready to request a quote."
      : "Enter a public GitHub repository URL (e.g. github.com/owner/repository)."
    : workflowType === "agent_trust_report"
      ? !hasAgentTrustPrimaryInput
      ? "Provide at least one Agent ID, agent wallet, or public GitHub repository."
      : !agentIdValid
        ? "Check the public Agent ID. Use the agt_ identifier shown in Veyra."
        : !agentWalletValid
          ? "Check the agent wallet format. Use a public 0x EVM address."
          : !contractAddressValid
            ? "Check the optional Arc contract address. Use a public 0x EVM address."
            : !serviceEndpointValid
              ? "Check the optional service endpoint. Use a public HTTPS URL."
              : !agentRepositoryUrl.trim() || Boolean(agentRepositoryRef)
                ? "Input valid. Ready to request a quote."
                : "Check the optional GitHub URL format. Use https://github.com/owner/repository."
      : workflowType === "paid_api_quality"
      ? selectedQualityServices.length === 0
        ? "Select at least 1 public service to evaluate."
        : selectedQualityServices.length > 5
          ? "Maximum 5 services can be compared in a single report."
          : `Selected ${selectedQualityServices.length} service(s). Ready to request a quote.`
      : workflowType === "treasury_health"
        ? !treasuryWalletAddress.trim()
          ? "Provide a public EVM wallet address to analyze."
          : !treasuryWalletValid
            ? "Check the wallet address format. Use a valid 0x EVM address."
            : "Input valid. Ready to request a quote."
        : hostedInputPreviewHelper(inputText);

  function invalidatePlan() {
    setPlan(null);
    setQuote(null);
    setSponsoredAuthorizationMessage(null);
    setError(null);
    idempotencyKey.current = null;
    paymentTransactionHash.current = null;
    sponsoredSignature.current = null;
  }

  function selectWorkflow(nextType: HostedWorkflowType) {
    const template = getHostedWorkflowTemplate(nextType);
    setWorkflowType(nextType);
    setTask(template?.task ?? "");
    if (nextType !== "github_due_diligence" && nextType !== "agent_trust_report") {
      setInputText("");
    }
    if (nextType !== "agent_trust_report") {
      setAgentId("");
      setAgentWallet("");
      setAgentRepositoryUrl("");
      setContractAddress("");
      setServiceEndpoint("");
    }
    if (nextType !== "treasury_health") {
      setTreasuryWalletAddress("");
    }
    invalidatePlan();
  }

  function toggleQualityService(serviceId: string) {
    setSelectedQualityServices((prev) => {
      if (prev.includes(serviceId)) {
        if (prev.length <= 1) return prev;
        return prev.filter((id) => id !== serviceId);
      }
      if (prev.length >= 5) return prev;
      return [...prev, serviceId];
    });
    invalidatePlan();
  }

  function changeObservationWindow(days: 7 | 30 | 90) {
    setObservationWindowDays(days);
    invalidatePlan();
  }

  useEffect(() => {
    if (workflowType !== "paid_api_quality" || selectedQualityServices.length === 0) {
      setObservationCountPreview(null);
      return;
    }

    let cancelled = false;
    setLoadingObservations(true);

    const serviceParams = selectedQualityServices
      .map((s) => `services=${encodeURIComponent(s)}`)
      .join("&");

    fetch(
      `/api/store/observations?${serviceParams}&windowDays=${observationWindowDays}&countOnly=true`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.totalObservations === "number") {
          setObservationCountPreview({
            totalObservations: data.totalObservations,
            observationsByService: data.observationsByService || {},
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingObservations(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workflowType, selectedQualityServices, observationWindowDays]);

  function requestBody() {
    return {
      workflowType,
      task,
      inputText:
        workflowType === "github_due_diligence"
          ? (repositoryRef?.canonicalUrl ?? inputText)
          : workflowType === "market_context"
            ? marketSymbol
            : workflowType === "agent_trust_report"
              ? JSON.stringify({
                  agentId: agentId.trim() || undefined,
                  agentWallet: agentWallet.trim() || undefined,
                  repositoryUrl: agentRepositoryUrl.trim() || undefined,
                  contractAddress: contractAddress.trim() || undefined,
                  serviceEndpoint: serviceEndpoint.trim() || undefined,
                })
              : workflowType === "paid_api_quality"
                ? JSON.stringify({
                    services: selectedQualityServices,
                    windowDays: observationWindowDays,
                  })
                : workflowType === "treasury_health"
                  ? JSON.stringify({ walletAddress: treasuryWalletAddress.trim() })
                  : inputText,
      budgetUsdc: budget,
    };
  }

  async function preview() {
    if (!isInputValid || !wallet.address) return;
    setPreviewing(true);
    setError(null);
    try {
      if (!idempotencyKey.current) {
        idempotencyKey.current = crypto.randomUUID();
      }
      const response = await fetch("/api/hosted-agent/quotes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({ ...requestBody(), requesterWallet: wallet.address }),
      });
      const data = (await response.json()) as {
        quote?: HostedWorkflowQuote;
        sponsoredAuthorizationMessage?: string | null;
        error?: string;
        retryAfterSeconds?: number;
      };
      if (!response.ok || !data.quote) {
        const retry = data.retryAfterSeconds ? ` Retry in about ${data.retryAfterSeconds}s.` : "";
        throw new Error(`${data.error ?? "Unable to create workflow quote."}${retry}`);
      }
      setPlan(data.quote.plan);
      setQuote(data.quote);
      setSponsoredAuthorizationMessage(data.sponsoredAuthorizationMessage ?? null);
      return data.quote.plan;
    } catch (caught) {
      setPlan(null);
      setQuote(null);
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setPreviewing(false);
    }
  }

  async function launch() {
    if (!plan || !quote || !wallet.address || !idempotencyKey.current) return;
    setLaunching(true);
    setError(null);
    try {
      if (Date.parse(quote.expiresAt) <= Date.now()) {
        throw new Error("The workflow quote expired. Refresh the exact price before paying.");
      }
      if (wallet.address.toLowerCase() !== quote.requesterWallet.toLowerCase()) {
        throw new Error("The connected wallet differs from the wallet bound to this quote.");
      }

      if (quote.paymentMode === "paid" && !paymentTransactionHash.current) {
        if (!wallet.isArcTestnet) await wallet.switchToArc();
        paymentTransactionHash.current = await wallet.sendWorkflowPayment({
          treasuryAddress: quote.treasuryAddress,
          amountUsdc: quote.pricing.amountDueUsdc,
          payment: quote.payment,
        });
      }
      if (quote.paymentMode === "sponsored" && !sponsoredSignature.current) {
        if (!sponsoredAuthorizationMessage) {
          throw new Error("Sponsored workflow authorization is unavailable.");
        }
        sponsoredSignature.current = await wallet.signMessage(
          sponsoredAuthorizationMessage,
        );
      }

      const response = await fetch(`/api/hosted-agent/quotes/${quote.id}/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          ...requestBody(),
          transactionHash: paymentTransactionHash.current,
          signature: sponsoredSignature.current,
        }),
      });
      const data = (await response.json()) as {
        jobId?: string | null;
        error?: string;
        retryAfterSeconds?: number;
        creditIssued?: boolean;
      };
      if (data.creditIssued) {
        throw new Error(data.error ?? "The payment was converted to a workflow credit.");
      }
      if (!response.ok || !data.jobId) {
        const retry = data.retryAfterSeconds ? ` Retry in about ${data.retryAfterSeconds}s.` : "";
        throw new Error(`${data.error ?? "Unable to launch hosted workflow."}${retry}`);
      }
      router.push(`/agent-runner/${data.jobId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLaunching(false);
    }
  }

  const humanized = error ? humanizeError(error) : null;

  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Header Banner */}
      <section className="border-b border-white/5 bg-gradient-to-b from-[#0a0d15] to-[#07090e] py-10 sm:py-14">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <Badge className="mb-4 rounded-full border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1 text-xs font-semibold text-emerald-300">
            <span className="mr-2 inline-block size-2 rounded-full bg-emerald-400 animate-pulse" />
            Arc Testnet Hosted Runner
          </Badge>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl gradient-text">
            New Verified Report
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base leading-relaxed">
            Select a workflow template, provide your target parameters, obtain an immutable price quote, and launch an Arc-verified execution.
          </p>

          {/* Stepper Wizard Indicator */}
          <div className="mt-8 flex items-center gap-2 overflow-x-auto pb-2 text-xs font-semibold text-muted-foreground border-t border-white/5 pt-6">
            <div className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${!quote ? "bg-primary/15 text-primary border border-primary/30" : "bg-white/5 text-foreground"}`}>
              <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] text-white">1</span>
              Configure Input
            </div>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/40" />
            <div className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${quote ? "bg-primary/15 text-primary border border-primary/30" : "bg-white/5"}`}>
              <span className="flex size-5 items-center justify-center rounded-full bg-primary/20 text-[11px] text-muted-foreground">2</span>
              Review Quote
            </div>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/40" />
            <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 bg-white/5">
              <span className="flex size-5 items-center justify-center rounded-full bg-primary/20 text-[11px] text-muted-foreground">3</span>
              Generate Report
            </div>
          </div>
        </div>
      </section>

      {/* Main Form Section */}
      <section className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[1.1fr_0.9fr]">
        {/* Left Column: Input Form */}
        <div className="grid gap-6">
          <Card className="rounded-2xl border border-white/10 bg-[#090c13]/90 backdrop-blur-xl shadow-xl p-1">
            <CardHeader className="p-6 pb-4">
              <CardTitle className="text-xl font-bold flex items-center gap-2.5">
                <Layers className="size-5 text-primary" />
                Select Workflow Template
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 pt-0 grid gap-6">
              {/* Visual Workflow Selector Cards */}
              <div className="grid gap-3 sm:grid-cols-2">
                {runnerWorkflowTemplates.map((workflow) => {
                  const isSelected = workflowType === workflow.value;
                  const Icon = workflowIcons[workflow.value as HostedWorkflowType] ?? Bot;
                  return (
                    <button
                      key={workflow.value}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => selectWorkflow(workflow.value as HostedWorkflowType)}
                      className={`group flex min-h-[44px] items-start gap-3.5 rounded-xl border p-4 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                        isSelected
                          ? "border-primary bg-primary/10 shadow-[0_0_20px_rgba(61,126,255,0.2)]"
                          : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10"
                      }`}
                    >
                      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${isSelected ? "bg-primary text-white" : "bg-white/10 text-muted-foreground group-hover:text-foreground"}`}>
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <p className={`text-xs font-bold ${isSelected ? "text-primary" : "text-foreground"}`}>
                            {workflow.label}
                          </p>
                          {isSelected && <Check className="size-3.5 text-primary shrink-0" />}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground/90 sm:line-clamp-none">
                          {getHostedWorkflowTemplate(workflow.value as HostedWorkflowType)?.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Input Form Fields */}
              <div className="border-t border-white/5 pt-6 grid gap-5">
                {workflowType === "agent_trust_report" ? (
                  <div className="grid gap-4">
                    <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 text-xs">
                      <p className="font-semibold text-purple-300">Verify an AI Agent</p>
                      <p className="mt-1 text-muted-foreground leading-relaxed">
                        Provide at least one primary identifier (Agent ID, wallet, or GitHub repo).
                      </p>
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="agent-trust-agent-id" className="text-xs font-semibold">Agent ID</Label>
                      <input
                        id="agent-trust-agent-id"
                        value={agentId}
                        onChange={(event) => { setAgentId(event.target.value); invalidatePlan(); }}
                        placeholder="agt_…"
                        className="h-11 w-full rounded-xl border border-white/10 bg-[#06080d] px-3.5 text-xs font-mono placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="agent-trust-wallet" className="text-xs font-semibold">Agent Wallet</Label>
                      <input
                        id="agent-trust-wallet"
                        value={agentWallet}
                        onChange={(event) => { setAgentWallet(event.target.value); invalidatePlan(); }}
                        placeholder="0x…"
                        className="h-11 w-full rounded-xl border border-white/10 bg-[#06080d] px-3.5 text-xs font-mono placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>

                    <div className="grid gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="agent-trust-repository" className="text-xs font-semibold">GitHub Repository</Label>
                        {agentRepositoryRef ? <Badge variant="secondary" className="font-mono text-[10px]">{agentRepositoryRef.fullName}</Badge> : null}
                      </div>
                      <input
                        id="agent-trust-repository"
                        value={agentRepositoryUrl}
                        onChange={(event) => { setAgentRepositoryUrl(event.target.value); invalidatePlan(); }}
                        placeholder="https://github.com/owner/repository"
                        className="h-11 w-full rounded-xl border border-white/10 bg-[#06080d] px-3.5 text-xs placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                ) : workflowType === "paid_api_quality" ? (
                  <div className="grid gap-4">
                    <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 text-xs">
                      <p className="font-semibold text-cyan-300">Evaluate Paid API Quality</p>
                      <p className="mt-1 text-muted-foreground leading-relaxed">
                        Select 1 to 5 public services to compare latency, uptime, and settlement.
                      </p>
                    </div>

                    <div className="grid gap-2">
                      <Label className="text-xs font-semibold">Observation Window</Label>
                      <div className="flex gap-2">
                        {[7, 30, 90].map((days) => (
                          <Button
                            key={days}
                            type="button"
                            variant={observationWindowDays === days ? "default" : "outline"}
                            size="sm"
                            className="rounded-lg text-xs"
                            onClick={() => changeObservationWindow(days as 7 | 30 | 90)}
                          >
                            {days} Days
                          </Button>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-2">
                      <Label className="text-xs font-semibold">Target Services ({selectedQualityServices.length}/5)</Label>
                      <div className="grid gap-2 max-h-60 overflow-y-auto pr-1">
                        {[
                          { id: "pyth-market-price", name: "Live Market Price", category: "Market Data", priceUsdc: "0.0010 USDC" },
                          { id: "github-repository-intelligence", name: "GitHub Intelligence", category: "Developer", priceUsdc: "0.0015 USDC" },
                          { id: "text-analyzer", name: "Text Analyzer", category: "Compute", priceUsdc: "0.0003 USDC" },
                          { id: "premium-quote", name: "Premium Quote", category: "Research", priceUsdc: "0.0010 USDC" },
                        ].map((s) => {
                          const isSelected = selectedQualityServices.includes(s.id);
                          return (
                            <div
                              key={s.id}
                              onClick={() => toggleQualityService(s.id)}
                              className={`flex items-center justify-between rounded-xl border p-3 cursor-pointer text-xs transition-colors ${isSelected ? "border-primary bg-primary/10" : "border-white/5 bg-white/5 hover:border-white/20"}`}
                            >
                              <div className="flex items-center gap-2.5">
                                <input type="checkbox" checked={isSelected} readOnly className="rounded border-primary text-primary" />
                                <span className="font-semibold text-foreground">{s.name}</span>
                              </div>
                              <span className="font-mono text-muted-foreground">{s.priceUsdc}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : workflowType === "treasury_health" ? (
                  <div className="grid gap-4">
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs">
                      <p className="font-semibold text-amber-300">Stablecoin Treasury Health</p>
                      <p className="mt-1 text-muted-foreground leading-relaxed">
                        Analyze on-chain USDC flows, burn rate, counterparty concentration, and runway.
                      </p>
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="treasury-wallet" className="text-xs font-semibold">Wallet Address</Label>
                      <input
                        id="treasury-wallet"
                        value={treasuryWalletAddress}
                        onChange={(event) => { setTreasuryWalletAddress(event.target.value); invalidatePlan(); }}
                        placeholder="0x…"
                        className="h-11 w-full rounded-xl border border-white/10 bg-[#06080d] px-3.5 text-xs font-mono placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                ) : workflowType === "github_due_diligence" ? (
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="github-repo" className="text-xs font-semibold">Repository URL</Label>
                      {repositoryRef && <Badge variant="secondary" className="font-mono text-[10px]">{repositoryRef.fullName}</Badge>}
                    </div>
                    <input
                      id="github-repo"
                      type="url"
                      value={inputText}
                      onChange={(event) => { setInputText(event.target.value); invalidatePlan(); }}
                      placeholder="https://github.com/owner/repository"
                      className="h-11 w-full rounded-xl border border-white/10 bg-[#06080d] px-3.5 text-xs placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="input-text" className="text-xs font-semibold">Input Content</Label>
                    <textarea
                      id="input-text"
                      rows={4}
                      value={inputText}
                      onChange={(event) => { setInputText(event.target.value); invalidatePlan(); }}
                      placeholder="Enter details..."
                      className="w-full rounded-xl border border-white/10 bg-[#06080d] p-3 text-xs placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                )}

                {/* Helper Banner */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Info className="size-4 shrink-0 text-primary" />
                  <span>{inputHelper}</span>
                </div>

                {/* Request Quote Button */}
                <Button
                  onClick={preview}
                  disabled={!isInputValid || previewing || !wallet.address}
                  className="mt-2 h-12 w-full rounded-xl bg-gradient-to-r from-primary to-blue-600 font-bold text-white shadow-[0_0_20px_rgba(61,126,255,0.3)] transition-all hover:scale-[1.01]"
                >
                  {previewing ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin mr-2" />
                      Generating Quote...
                    </>
                  ) : (
                    <>
                      <Calculator className="size-4 mr-2" />
                      Calculate Quote & Build Plan
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Quote & Payment Panel */}
        <div className="grid gap-6">
          <Card className="rounded-2xl border border-white/10 bg-[#090c13]/90 backdrop-blur-xl shadow-xl p-1 lg:sticky lg:top-20">
            <CardHeader className="p-6 pb-4">
              <CardTitle className="text-xl font-bold flex items-center justify-between">
                <span className="flex items-center gap-2.5">
                  <FileCheck2 className="size-5 text-cyan-400" />
                  Workflow Quote
                </span>
                {quote && (
                  <Badge variant={quote.paymentMode === "sponsored" ? "secondary" : "default"} className={quote.paymentMode === "sponsored" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "bg-primary text-white"}>
                    {quote.paymentMode === "sponsored" ? "Sponsored (Free)" : "USDC Payment"}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>

            <CardContent className="p-6 pt-0 grid gap-5">
              {!quote ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 p-8 text-center text-muted-foreground">
                  <Calculator className="size-10 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-semibold text-foreground">No Quote Generated</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Provide required input on the left and click &quot;Calculate Quote&quot; to inspect exact pricing.
                  </p>
                </div>
              ) : (
                <div className="grid gap-5">
                  {/* Pricing Overview Box */}
                  <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-4">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs font-semibold text-muted-foreground">Total Quoted Price:</span>
                      <span className="text-2xl font-extrabold text-foreground tracking-tight">
                        {quote.pricing.amountDueUsdc} <span className="text-xs text-primary font-bold">USDC</span>
                      </span>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2.5 text-xs text-muted-foreground">
                      <span>Services Included:</span>
                      <span className="font-semibold text-foreground">{quote.plan.selectedServices.length} Allowlisted Services</span>
                    </div>
                  </div>

                  {/* Service Breakdown */}
                  <div className="grid gap-2">
                    <p className="text-xs font-semibold text-muted-foreground">Service Breakdown:</p>
                    <div className="grid gap-1.5 max-h-40 overflow-y-auto pr-1">
                      {quote.plan.selectedServices.map((svc) => (
                        <div key={svc.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-xs">
                          <span className="font-medium text-foreground truncate">{svc.name}</span>
                          <span className="font-mono text-muted-foreground shrink-0">{svc.priceUsdc} USDC</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Payment Button */}
                  {humanized && (
                    <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2">
                      <AlertCircle className="size-4 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold">{humanized.title}: </span>
                        <span>{humanized.message}</span>
                      </div>
                    </div>
                  )}

                  <Button
                    onClick={launch}
                    disabled={launching}
                    className="h-12 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 font-bold text-white shadow-[0_0_20px_rgba(0,208,132,0.3)] transition-all hover:scale-[1.01]"
                  >
                    {launching ? (
                      <>
                        <LoaderCircle className="size-4 animate-spin mr-2" />
                        Executing & Verifying...
                      </>
                    ) : (
                      <>
                        <CreditCard className="size-4 mr-2" />
                        {quote.paymentMode === "sponsored" ? "Authorize Sponsored Run" : `Pay ${quote.pricing.amountDueUsdc} USDC & Launch`}
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
