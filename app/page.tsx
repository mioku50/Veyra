/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Code2,
  FileText,
  Sparkles,
  ShieldCheck,
  Github,
  Activity,
  BarChart3,
  MessageSquareText,
  Rocket,
  Zap,
  SlidersHorizontal,
  BadgeCheck,
  Layers,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PublicBetaBadge } from "@/components/ui/public-beta-badge";
import {
  listHostedFinalReports,
  type HostedFinalReportSummary,
} from "@/lib/agent/hosted-jobs";
import {
  getHostedWorkflowTemplate,
  type HostedWorkflowType,
} from "@/lib/agent/workflow-templates";
import { hostedWorkflowHref } from "@/lib/agent/workflow-links";
import {
  publicReportSubject,
  sanitizePublicReportText,
} from "@/lib/agent/public-report-copy";
import { BRAND, BRAND_TITLE } from "@/lib/brand";
import { API_QUALITY_FINALIZER_PRICE_USDC } from "@/lib/services/constants";

export const metadata: Metadata = {
  title: { absolute: BRAND_TITLE },
  description: BRAND.description,
  openGraph: {
    title: BRAND_TITLE,
    description: BRAND.description,
  },
  twitter: {
    title: BRAND_TITLE,
    description: BRAND.description,
  },
};

const featuredBenefits = [
  "Live GitHub data",
  "Activity & maintainer analysis",
  "Engineering quality signals",
  "Adoption risk detection",
  "Shareable Arc-verified report",
] as const;

const quickTrustActions = [
  {
    title: "Verify Agent",
    tagline: "Reputation & Evidence",
    desc: "Inspect identity, verified track record, and risk profiles before interaction.",
    href: "/reputation",
    icon: Bot,
    color: "from-purple-500/20 via-purple-500/5 to-transparent border-purple-500/30 text-purple-400 hover:border-purple-500/60",
    badge: "ERC-8004",
  },
  {
    title: "Select Counterparty",
    tagline: "Constraint-Based Ranking",
    desc: "Compare candidates across performance, reputation, and pricing budgets.",
    href: "/trust/select",
    icon: SlidersHorizontal,
    color: "from-blue-500/20 via-blue-500/5 to-transparent border-blue-500/30 text-blue-400 hover:border-blue-500/60",
    badge: "Selection Engine",
  },
  {
    title: "Trust Preflight",
    tagline: "Policy Decision Gate",
    desc: "Preflight transactions with fail-closed rules and signed clearance tickets.",
    href: "/trust-gate",
    icon: ShieldCheck,
    color: "from-cyan-500/20 via-sky-500/5 to-transparent border-cyan-500/30 text-cyan-400 hover:border-cyan-500/60",
    badge: "Trust Gate",
  },
  {
    title: "Authorize & Execute",
    tagline: "Trust-Routed Execution",
    desc: "Execute selected actions within signed spending and trust limits.",
    href: "/trust/mandates",
    icon: Zap,
    color: "from-amber-500/20 via-amber-500/5 to-transparent border-amber-500/30 text-amber-400 hover:border-amber-500/60",
    badge: "Mandates",
  },
  {
    title: "Explore Evaluator",
    tagline: "Independent Verification",
    desc: "Verify ERC-8183 deliverables on Arc before funds settle.",
    href: "/evaluators",
    icon: BadgeCheck,
    color: "from-sky-500/20 via-sky-500/5 to-transparent border-sky-500/30 text-sky-400 hover:border-sky-500/60",
    badge: "ERC-8183",
  },
] as const;

const evidenceWorkflows: Array<{
  type: HostedWorkflowType;
  description: string;
  benefits: readonly string[];
  gradient: string;
  icon: typeof Bot;
}> = [
  {
    type: "agent_trust_report",
    description:
      "Verify an AI agent before you use, pay, or integrate it. Review identity, code health, execution history, services, payments, contract signals, and Arc verification in one evidence-backed report.",
    benefits: ["Deterministic Trust Score", "Evidence-backed review", "Arc verification status"],
    gradient: "from-purple-500/20 via-purple-500/5 to-transparent border-purple-500/30 hover:border-purple-500/60 shadow-[0_0_25px_rgba(168,85,247,0.15)]",
    icon: ShieldCheck,
  },
  {
    type: "treasury_health",
    description:
      "Analyze on-chain USDC inflows, outflows, burn rate, counterparty concentration (HHI), agent expenses, and runway for any wallet with Arc verification.",
    benefits: ["USDC Flow Analysis", "Counterparty Risk HHI", "Treasury Health Score"],
    gradient: "from-amber-500/20 via-amber-500/5 to-transparent border-amber-500/30 hover:border-amber-500/60 shadow-[0_0_25px_rgba(245,158,11,0.15)]",
    icon: Zap,
  },
  {
    type: "github_due_diligence",
    description:
      "Understand the health, activity, engineering signals, and adoption risks of a public repository.",
    benefits: ["Repository health", "Maintainer activity", "Adoption risk signals"],
    gradient: "from-blue-500/20 via-blue-500/5 to-transparent border-blue-500/30 hover:border-blue-500/60 shadow-[0_0_25px_rgba(52,227,155,0.15)]",
    icon: Github,
  },
  {
    type: "paid_api_quality",
    description:
      "Evaluate and compare paid APIs using observed pricing, latency, availability, response validity, payment execution, and settlement history.",
    benefits: ["Quality Score (0–100)", "Uptime & P95 Latency", "Side-by-side benchmarking"],
    gradient: "from-cyan-500/20 via-sky-500/5 to-transparent border-cyan-500/30 hover:border-cyan-500/60 shadow-[0_0_25px_rgba(6,182,212,0.15)]",
    icon: Activity,
  },
  {
    type: "market_context",
    description:
      "Receive a current market snapshot using live provider-backed asset data.",
    benefits: ["Current asset data", "Market context", "Structured evidence"],
    gradient: "from-sky-500/20 via-sky-500/5 to-transparent border-sky-500/30 hover:border-sky-500/60 shadow-[0_0_25px_rgba(16,185,129,0.15)]",
    icon: BarChart3,
  },
  {
    type: "sentiment_tone",
    description:
      "Analyze submitted text for sentiment, tone, and communication patterns.",
    benefits: ["Sentiment signals", "Tone patterns", "Shareable findings"],
    gradient: "from-pink-500/20 via-pink-500/5 to-transparent border-pink-500/30 hover:border-pink-500/60 shadow-[0_0_25px_rgba(236,72,153,0.15)]",
    icon: MessageSquareText,
  },
  {
    type: "builder_update",
    description:
      "Turn a changelog, shipping update, or project note into a concise structured report.",
    benefits: ["Progress summary", "Delivery signals", "Clear next steps"],
    gradient: "from-indigo-500/20 via-indigo-500/5 to-transparent border-indigo-500/30 hover:border-indigo-500/60 shadow-[0_0_25px_rgba(99,102,241,0.15)]",
    icon: Rocket,
  },
];

const reportWorkflowOrder: HostedWorkflowType[] = [
  "treasury_health",
  "github_due_diligence",
  "agent_trust_report",
  "paid_api_quality",
  "market_context",
  "sentiment_tone",
  "builder_update",
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
}

function formatStartingPrice(value: number) {
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function selectDiverseReports(reports: HostedFinalReportSummary[], limit = 4) {
  const selected: HostedFinalReportSummary[] = [];
  const selectedIds = new Set<string>();

  for (const workflowType of reportWorkflowOrder) {
    const report = reports.find((candidate) => candidate.workflowType === workflowType);
    if (!report) continue;
    selected.push(report);
    selectedIds.add(report.id);
  }

  for (const report of reports) {
    if (selected.length >= limit) break;
    if (!selectedIds.has(report.id)) selected.push(report);
  }

  return selected.slice(0, limit);
}

async function recentReportsWithTimeout() {
  return Promise.race([
    listHostedFinalReports(20),
    new Promise<HostedFinalReportSummary[]>((resolve) => {
      setTimeout(() => resolve([]), 3_000);
    }),
  ]).catch(() => []);
}

export default async function Home() {
  await connection();
  const recentReports = await recentReportsWithTimeout();
  const reports = selectDiverseReports(recentReports);
  const featured = getHostedWorkflowTemplate("github_due_diligence");

  return (
    <main className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      {/* 1. Veyra Trust Platform Hero */}
      <section className="relative overflow-hidden border-b border-white/5 bg-gradient-to-b from-[#0a0d15] via-[#080a0f] to-[#07090e] py-16 sm:py-24">
        <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-primary/20 via-sky-500/10 to-purple-500/10 blur-[120px] opacity-70" />

        <div className="mx-auto flex w-full max-w-7xl flex-col items-center px-4 text-center sm:px-6">
          <div className="mb-6">
            <PublicBetaBadge showDisclaimer />
          </div>

          <h1 className="text-xl font-extrabold uppercase tracking-[0.24em] text-white">
            {BRAND.name}
          </h1>

          {/* One thesis. "Trust Infrastructure for Agentic Commerce" named a
              category rather than a product, and contradicted the decision
              screen it links to. */}
          <h2 className="run-display mt-5 max-w-4xl text-4xl sm:text-6xl lg:text-7xl">
            <span className="text-white">Veyra decides.</span>{" "}
            <span style={{ color: "var(--run-accent)" }}>Circle pays.</span>
          </h2>

          <p className="mt-5 max-w-2xl text-base font-normal leading-relaxed text-muted-foreground sm:text-lg">
            Evidence-based authorization for autonomous USDC spending. Before your
            agent pays an API or another agent, Veyra measures the evidence, ranks
            the alternatives, enforces policy, and signs an authorization bound to
            one endpoint and one amount.
          </p>

          <p className="run-num mt-5 text-[11px] tracking-wide text-muted-foreground/70">
            ERC-8004 · ERC-8183 · x402 · Gateway · USDC · Arc Testnet 5042002
          </p>

          <div className="mt-8 flex flex-col gap-3.5 sm:flex-row sm:items-center">
            <Button
              asChild
              size="lg"
              className="rounded-xl bg-gradient-to-r from-[var(--run-accent)] to-[var(--run-accent-deep)] font-semibold text-white shadow-[0_0_25px_rgba(52,227,155,0.35)] transition-all duration-300 hover:scale-105 hover:shadow-[0_0_35px_rgba(52,227,155,0.5)]"
            >
              <Link href="/run">
                <ShieldCheck className="size-5 mr-2" />
                Run a live decision
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="rounded-xl border-white/10 bg-white/5 backdrop-blur-md transition-all duration-200 hover:bg-white/10 hover:border-white/20"
            >
              <Link href="/agent-runner">
                <Sparkles className="size-5 mr-2 text-cyan-400" />
                Run a Workflow
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="ghost"
              className="rounded-xl text-muted-foreground hover:text-white hover:bg-white/5 text-xs sm:text-sm"
            >
              <Link href="/console/agent-api">
                <Code2 className="size-4 mr-1.5" />
                Developer API
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* 2. Quick Trust Actions Block */}
      {/* One flow, not five co-equal tools.
          The row of Verify / Select / Preflight / Authorize / Evaluate asked the
          visitor to understand the architecture before they could use anything,
          and none of the five was the product. These are the stages of a single
          decision, and the only call to action is to run one. */}
      <section className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="run-display text-2xl tracking-tight sm:text-3xl">
            One decision, start to finish
          </h2>
          <Link
            href="/executions"
            className="run-focus text-xs font-semibold text-[var(--run-azure)] hover:underline"
          >
            See the decisions already made →
          </Link>
        </div>

        <ol className="mt-8 grid gap-px overflow-hidden rounded-[var(--run-radius)] border border-[var(--run-line)] bg-[var(--run-line)] sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Intent", "Capability, budget, priority — structured from the request."],
            ["Discover", "ERC-8004 agents on Arc and the Circle x402 marketplace."],
            ["Verify", "Live 402 probe, catalog drift, latency, settlement history."],
            ["Decide", "Allow, bound, escalate or refuse — deterministically."],
            ["Execute", "x402 / Gateway Nanopayments, or ERC-8183 escrow on Arc."],
            ["Learn", "The observed outcome becomes reputation on Arc."],
          ].map(([title, body], i) => (
            <li key={title} className="bg-[var(--run-surface)] p-5">
              <span className="run-num text-[10px] text-[var(--run-text-faint)]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-2 text-[13.5px] font-semibold text-[var(--run-text)]">{title}</h3>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--run-text-faint)]">{body}</p>
            </li>
          ))}
        </ol>

        {/* Evidence, immediately under the claim. */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-[var(--run-radius)] border border-[var(--run-line)] bg-[var(--run-canvas-raised)] px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
            {[
              ["Proven on Arc", "Job #186207"],
              ["Escrow paid", "0.05 USDC"],
              ["Policy checks", "11 / 11"],
              ["Create → payout", "19 s"],
              ["Gas", "0.0118 USDC"],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="text-[9.5px] uppercase tracking-[0.13em] text-[var(--run-text-faint)]">{k}</div>
                <div className="run-num mt-0.5 text-[13px] text-[var(--run-text)]">{v}</div>
              </div>
            ))}
          </div>
          <a
            href="https://testnet.arcscan.app/tx/0xd1d958d5014a3584a21c7e67444091af25c64940aa4759c928fa2962d0995a22"
            target="_blank"
            rel="noreferrer"
            className="run-focus run-num text-[11.5px] text-[var(--run-azure)] hover:underline"
          >
            Verdict transaction ↗
          </a>
        </div>
      </section>

      {/* 3. Try Veyra in 30 Seconds: GitHub Due Diligence */}
      <section className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
        <div className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-[#0c101a] via-[#090c13] to-[#07090e] p-1 shadow-[0_0_40px_rgba(52,227,155,0.1)] transition-all duration-300 hover:border-primary/50 hover:shadow-[0_0_50px_rgba(52,227,155,0.18)]">
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
            <div className="p-6 sm:p-8 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-primary font-semibold">
                    Try Veyra in 30 Seconds
                  </Badge>
                  <span className="text-xs text-muted-foreground">x402 Enabled</span>
                </div>
                <h2 className="text-2xl font-bold tracking-tight sm:text-3xl text-foreground">
                  GitHub Project Due Diligence
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
                  Analyze a public GitHub repository and receive an evidence-backed report covering project purpose, development activity, maintainability, documentation, releases, contributor structure, and adoption risks.
                </p>
                <div className="mt-4 flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">Fixed Quote:</span>
                  <span className="text-lg font-bold text-primary">
                    From {formatStartingPrice(featured?.estimatedSpendUsdc ?? Number(API_QUALITY_FINALIZER_PRICE_USDC))} USDC
                  </span>
                </div>
              </div>

              <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                {featuredBenefits.map((benefit) => (
                  <div key={benefit} className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground">
                    <CheckCircle2 className="size-4 shrink-0 text-cyan-400" />
                    <span>{benefit}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center border-t border-white/5 bg-white/[0.02] p-6 sm:p-8 backdrop-blur-xl lg:border-l lg:border-t-0">
              <form action="/agent-runner" method="GET" className="grid w-full gap-4">
                <input type="hidden" name="workflow" value="github_due_diligence" />
                <label htmlFor="featured-repository" className="text-sm font-semibold text-foreground">
                  Repository URL
                </label>
                <input
                  id="featured-repository"
                  type="url"
                  name="repository"
                  placeholder="https://github.com/owner/repository"
                  required
                  className="h-12 w-full rounded-xl border border-white/10 bg-[#06080d] px-4 py-2 text-sm placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
                />
                <Button type="submit" size="lg" className="rounded-xl bg-primary hover:bg-blue-600 font-semibold shadow-[0_0_20px_rgba(52,227,155,0.3)]">
                  <Bot className="size-5" />
                  Analyze Repository
                </Button>
              </form>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Evidence Workflows Grid */}
      <section className="border-t border-white/5 bg-[#06080d]/60 py-16">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
          <div className="max-w-3xl">
            <Badge variant="outline" className="border-cyan-500/30 text-cyan-400 bg-cyan-500/5">
              Evidence Workflows
            </Badge>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
              Structured Evidence Generation
            </h2>
            <p className="mt-3 text-base leading-relaxed text-muted-foreground">
              Every workflow presents an immutable quote before checkout and produces a structured, Arc-verified result that feeds into the Veyra reputation engine.
            </p>
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {evidenceWorkflows.map((workflow) => {
              const template = getHostedWorkflowTemplate(workflow.type);
              if (!template) return null;
              const Icon = workflow.icon;

              return (
                <div
                  key={workflow.type}
                  className={`group relative flex flex-col justify-between rounded-2xl border bg-gradient-to-b p-6 backdrop-blur-xl transition-all duration-300 hover:-translate-y-1.5 ${workflow.gradient}`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-4">
                      <div className="flex size-10 items-center justify-center rounded-xl bg-white/10 border border-white/10 text-foreground group-hover:scale-110 transition-transform">
                        <Icon className="size-5 text-cyan-400" />
                      </div>
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-[11px] font-medium">
                        {formatStartingPrice(template.estimatedSpendUsdc)} USDC
                      </Badge>
                    </div>

                    <h3 className="text-xl font-bold tracking-tight text-foreground group-hover:text-primary transition-colors">
                      {template.label}
                    </h3>
                    <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground/90">
                      {workflow.description}
                    </p>

                    <ul className="mt-4 grid gap-2 border-t border-white/5 pt-4 text-xs text-muted-foreground">
                      {workflow.benefits.map((benefit) => (
                        <li key={benefit} className="flex items-center gap-2">
                          <CheckCircle2 className="size-3.5 shrink-0 text-cyan-400" />
                          {benefit}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <Button asChild variant="outline" size="sm" className="mt-6 w-full rounded-xl border-white/10 bg-white/5 hover:bg-primary hover:border-primary hover:text-white transition-all font-semibold">
                    <Link href={hostedWorkflowHref(workflow.type)}>
                      Run Workflow
                      <ArrowRight className="size-4 ml-1" />
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 5. Project 360 & Continuous Monitoring Feature */}
      <section className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
        <div className="grid gap-6 md:grid-cols-2">
          <Card className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#0c101a] to-[#07090e] p-2 backdrop-blur-xl shadow-xl">
            <CardHeader className="p-6">
              <CardTitle className="flex items-center gap-3 text-xl font-bold">
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/20 text-primary">
                  <Layers className="size-5" />
                </div>
                Project 360 Analysis
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6 pt-0 grid gap-5">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Run cross-source discovery across GitHub repositories, onchain contracts, and live API endpoints with non-custodial quotes and Arc-verified reports.
              </p>
              <Button asChild className="w-fit rounded-xl bg-primary hover:bg-blue-600 font-semibold">
                <Link href="/project-360">Open Project 360</Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#0c101a] to-[#07090e] p-2 backdrop-blur-xl shadow-xl">
            <CardHeader className="p-6">
              <CardTitle className="flex items-center gap-3 text-xl font-bold">
                <div className="flex size-9 items-center justify-center rounded-lg bg-cyan-500/20 text-cyan-400">
                  <Code2 className="size-5" />
                </div>
                {BRAND.agentApi}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6 pt-0 grid gap-5">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Empower external AI agents to programmatically verify counterparties, evaluate policy decisions, select services, and settle work via machine credentials.
              </p>
              <Button asChild variant="outline" className="w-fit rounded-xl border-white/10 bg-white/5 hover:bg-white/10 font-semibold">
                <Link href="/console/agent-api">Open Developer API</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* 6. Recent Reports Section */}
      <section className="border-t border-white/5 bg-[#06080d]/60 py-16">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Badge variant="secondary" className="border-white/10 bg-white/5">
                Audit Trail
              </Badge>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
                Latest verified reports
              </h2>
            </div>
            <Button asChild variant="outline" className="rounded-xl border-white/10 bg-white/5 hover:bg-white/10">
              <Link href="/results">
                View all reports <ArrowRight className="size-4 ml-1" />
              </Link>
            </Button>
          </div>

          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {reports.length ? (
              reports.map((report) => (
                <Card key={report.id} className="rounded-2xl border border-white/10 bg-[#090c13]/80 p-1 backdrop-blur-xl hover:border-white/20 transition-all">
                  <CardContent className="grid gap-3.5 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge variant="secondary" className="border-primary/20 bg-primary/10 text-primary text-xs font-semibold">
                        {report.workflowLabel}
                      </Badge>
                      <Badge variant={report.completedWithWarnings ? "outline" : "default"} className={report.completedWithWarnings ? "border-amber-500/30 bg-amber-500/10 text-amber-300 text-[11px]" : "bg-sky-500/10 border-sky-500/30 text-sky-300 text-[11px]"}>
                        {report.completedWithWarnings ? "Completed with warnings" : "Arc Verified"}
                      </Badge>
                    </div>
                    <h3 className="line-clamp-1 font-bold text-foreground text-base">
                      {publicReportSubject(report)}
                    </h3>
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {sanitizePublicReportText(report.summary)}
                    </p>
                    <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-3.5 text-xs text-muted-foreground">
                      <span>{formatDate(report.generatedAt)}</span>
                      <Button asChild size="sm" variant="ghost" className="hover:bg-white/10 hover:text-white">
                        <Link href={report.href}>
                          <FileText className="size-4 mr-1 text-primary" /> View Report
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="rounded-2xl border border-white/10 bg-[#090c13]/60 p-8 text-center text-sm text-muted-foreground md:col-span-2">
                Completed reports will appear here after real workflows finish.
              </p>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
