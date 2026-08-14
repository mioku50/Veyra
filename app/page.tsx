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
    color: "from-cyan-500/20 via-cyan-500/5 to-transparent border-cyan-500/30 text-cyan-400 hover:border-cyan-500/60",
    badge: "Trust Gate",
  },
  {
    title: "Explore Evaluator",
    tagline: "Independent Verification",
    desc: "Verify ERC-8183 deliverables on Arc before funds settle.",
    href: "/evaluators",
    icon: BadgeCheck,
    color: "from-emerald-500/20 via-emerald-500/5 to-transparent border-emerald-500/30 text-emerald-400 hover:border-emerald-500/60",
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
    gradient: "from-blue-500/20 via-blue-500/5 to-transparent border-blue-500/30 hover:border-blue-500/60 shadow-[0_0_25px_rgba(61,126,255,0.15)]",
    icon: Github,
  },
  {
    type: "paid_api_quality",
    description:
      "Evaluate and compare paid APIs using observed pricing, latency, availability, response validity, payment execution, and settlement history.",
    benefits: ["Quality Score (0–100)", "Uptime & P95 Latency", "Side-by-side benchmarking"],
    gradient: "from-cyan-500/20 via-cyan-500/5 to-transparent border-cyan-500/30 hover:border-cyan-500/60 shadow-[0_0_25px_rgba(6,182,212,0.15)]",
    icon: Activity,
  },
  {
    type: "market_context",
    description:
      "Receive a current market snapshot using live provider-backed asset data.",
    benefits: ["Current asset data", "Market context", "Structured evidence"],
    gradient: "from-emerald-500/20 via-emerald-500/5 to-transparent border-emerald-500/30 hover:border-emerald-500/60 shadow-[0_0_25px_rgba(16,185,129,0.15)]",
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
        <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-primary/20 via-cyan-500/10 to-purple-500/10 blur-[120px] opacity-70" />

        <div className="mx-auto flex w-full max-w-7xl flex-col items-center px-4 text-center sm:px-6">
          <div className="mb-6">
            <PublicBetaBadge showDisclaimer />
          </div>

          <h1 className="text-xl font-extrabold uppercase tracking-[0.24em] text-white">
            {BRAND.name}
          </h1>
          <p className="mt-2 text-sm font-semibold text-cyan-300">{BRAND.tagline}</p>

          <h2 className="mt-5 max-w-4xl text-3xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl leading-[1.15]">
            <span className="text-white">Trust Infrastructure for</span>{" "}
            <span className="gradient-text">Agentic Commerce</span>
          </h2>

          <p className="mt-5 max-w-3xl text-base font-normal leading-relaxed text-muted-foreground sm:text-lg">
            Verify agents. Select trusted counterparties. Enforce transaction policy. Evaluate work. Build verifiable reputation on Arc.
          </p>

          <div className="mt-8 flex flex-col gap-3.5 sm:flex-row sm:items-center">
            <Button
              asChild
              size="lg"
              className="rounded-xl bg-gradient-to-r from-primary via-blue-600 to-cyan-500 font-semibold text-white shadow-[0_0_25px_rgba(61,126,255,0.35)] transition-all duration-300 hover:scale-105 hover:shadow-[0_0_35px_rgba(61,126,255,0.5)]"
            >
              <Link href="/trust">
                <ShieldCheck className="size-5 mr-2" />
                Explore Agent Trust
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
      <section className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
          <div>
            <Badge variant="outline" className="border-primary/30 text-primary bg-primary/5 text-xs">
              Trust Stack
            </Badge>
            <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl text-foreground">
              Core Trust Primitives
            </h2>
          </div>
          <Button asChild variant="ghost" size="sm" className="w-fit text-cyan-400 hover:text-cyan-300 p-0 text-xs">
            <Link href="/trust">
              View full trust overview <ArrowRight className="size-3.5 ml-1" />
            </Link>
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {quickTrustActions.map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.title}
                href={action.href}
                className={`group relative flex flex-col justify-between rounded-2xl border bg-gradient-to-b p-5 backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 ${action.color}`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex size-9 items-center justify-center rounded-xl bg-white/10 border border-white/10 text-foreground group-hover:scale-110 transition-transform">
                      <Icon className="size-4.5" />
                    </div>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {action.badge}
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-foreground group-hover:text-primary transition-colors">
                    {action.title}
                  </h3>
                  <p className="text-[11px] font-medium text-cyan-300/80 mb-2">
                    {action.tagline}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {action.desc}
                  </p>
                </div>
                <div className="mt-4 flex items-center text-xs font-semibold text-primary pt-2 border-t border-white/5">
                  Launch <ArrowRight className="size-3.5 ml-1 group-hover:translate-x-1 transition-transform" />
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* 3. Try Veyra in 30 Seconds: GitHub Due Diligence */}
      <section className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
        <div className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-[#0c101a] via-[#090c13] to-[#07090e] p-1 shadow-[0_0_40px_rgba(61,126,255,0.1)] transition-all duration-300 hover:border-primary/50 hover:shadow-[0_0_50px_rgba(61,126,255,0.18)]">
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
            <div className="p-6 sm:p-8 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-primary font-semibold">
                    Try Veyra in 30 Seconds
                  </Badge>
                  <span className="text-xs text-muted-foreground">x402 Verified</span>
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
                <Button type="submit" size="lg" className="rounded-xl bg-primary hover:bg-blue-600 font-semibold shadow-[0_0_20px_rgba(61,126,255,0.3)]">
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
                      <Badge variant={report.completedWithWarnings ? "outline" : "default"} className={report.completedWithWarnings ? "border-amber-500/30 bg-amber-500/10 text-amber-300 text-[11px]" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 text-[11px]"}>
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
