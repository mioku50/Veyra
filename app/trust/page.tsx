/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata } from "next";
import Link from "next/link";
import {
  ShieldCheck,
  Bot,
  SlidersHorizontal,
  BadgeCheck,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  FileCode2,
  Activity,
  Layers,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PublicBetaBadge } from "@/components/ui/public-beta-badge";
import { BRAND, brandPageTitle } from "@/lib/brand";

export const metadata: Metadata = {
  title: brandPageTitle("Trust Infrastructure"),
  description:
    "Verify agents, evaluate transaction policy, select optimal counterparties, and verify ERC-8183 deliverables on Arc.",
};

const trustGateOutcomes = [
  {
    code: "ALLOW",
    label: "Allow",
    desc: "Unrestricted execution within standard policy",
    color: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  {
    code: "ALLOW_WITH_LIMITS",
    label: "Allow with Limits",
    desc: "Approved with budget or rate caps enforced",
    color: "border-blue-500/30 bg-blue-500/10 text-cyan-300",
  },
  {
    code: "REQUIRE_EVALUATOR",
    label: "Require Evaluator",
    desc: "Mandatory ERC-8183 evaluator verification before settlement",
    color: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  },
  {
    code: "REVIEW_REQUIRED",
    label: "Review Required",
    desc: "Manual review required due to risk signals",
    color: "border-purple-500/30 bg-purple-500/10 text-purple-300",
  },
  {
    code: "DENY",
    label: "Deny",
    desc: "Transaction rejected; policy violation or excessive risk",
    color: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  },
] as const;

const pipelineSteps = [
  { step: "1", title: "ERC-8004 Identity", desc: "Onchain registration & metadata" },
  { step: "2", title: "Reputation", desc: "Evidence-weighted scores" },
  { step: "3", title: "Counterparty Selection", desc: "Ranked evaluation & constraints" },
  { step: "4", title: "Trust Gate", desc: "Pre-transaction policy check" },
  { step: "5", title: "Signed Clearance", desc: "EIP-712 cryptographic ticket" },
  { step: "6", title: "ERC-8183 / x402", desc: "Job execution or payment" },
  { step: "7", title: "Evaluation", desc: "Independent deliverable verification" },
  { step: "8", title: "Settlement", desc: "Arc payment authorization" },
  { step: "9", title: "New Evidence", desc: "Continuous feedback loop" },
] as const;

export default function TrustHubPage() {
  return (
    <main className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-white/5 bg-gradient-to-b from-[#0a0d15] via-[#080a0f] to-[#07090e] py-16 sm:py-20">
        <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-primary/20 via-cyan-500/10 to-purple-500/10 blur-[120px] opacity-70" />

        <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 text-center sm:px-6">
          <PublicBetaBadge showDisclaimer className="mb-6" />

          <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl">
            Veyra <span className="text-primary">Trust Stack</span>
          </h1>

          <p className="mt-4 max-w-3xl text-base font-normal leading-relaxed text-muted-foreground sm:text-lg">
            Verify agents, select trusted counterparties, enforce preflight policy decisions,
            and evaluate ERC-8183 deliverables with verifiable onchain evidence on Arc.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg" className="rounded-xl bg-primary hover:bg-blue-600 font-semibold shadow-[0_0_20px_rgba(61,126,255,0.3)]">
              <Link href="/trust/select">
                <SlidersHorizontal className="size-4 mr-2" />
                Select Counterparty
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="rounded-xl border-white/10 bg-white/5 hover:bg-white/10">
              <Link href="/trust-gate">
                <ShieldCheck className="size-4 mr-2 text-cyan-400" />
                Evaluate Transaction
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* 4 Core Pillars Grid */}
      <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
        <div className="mb-10 text-center sm:text-left">
          <Badge variant="outline" className="border-primary/30 text-primary bg-primary/5">
            Core Capabilities
          </Badge>
          <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
            Four pillars of agentic trust
          </h2>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* A. Verify an Agent */}
          <Card className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#0c101a] via-[#090c13] to-[#07090e] p-2 backdrop-blur-xl shadow-lg transition-all hover:border-primary/40">
            <CardHeader className="p-6 pb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex size-10 items-center justify-center rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
                  <Bot className="size-5" />
                </div>
                <Badge variant="secondary" className="border-purple-500/30 bg-purple-500/10 text-purple-300 text-xs">
                  ERC-8004 + Reputation
                </Badge>
              </div>
              <CardTitle className="mt-4 text-xl font-bold">A. Verify an Agent</CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6 pt-0 space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Understand identity, evidence quality, reputation, execution history, and risk before interacting with an agent.
              </p>
              <div className="flex flex-wrap gap-2 pt-2">
                <Button asChild size="sm" variant="outline" className="rounded-lg border-white/10 bg-white/5 hover:bg-white/10 text-xs">
                  <Link href="/reputation">
                    <Activity className="size-3.5 mr-1 text-purple-400" />
                    Agent Reputation
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline" className="rounded-lg border-white/10 bg-white/5 hover:bg-white/10 text-xs">
                  <Link href="/agent-runner?workflow=agent_trust_report">
                    <ShieldCheck className="size-3.5 mr-1 text-cyan-400" />
                    Trust Report
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* B. Evaluate a Transaction */}
          <Card className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#0c101a] via-[#090c13] to-[#07090e] p-2 backdrop-blur-xl shadow-lg transition-all hover:border-cyan-500/40">
            <CardHeader className="p-6 pb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex size-10 items-center justify-center rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
                  <ShieldCheck className="size-5" />
                </div>
                <Badge variant="secondary" className="border-cyan-500/30 bg-cyan-500/10 text-cyan-300 text-xs">
                  Policy Preflight
                </Badge>
              </div>
              <CardTitle className="mt-4 text-xl font-bold">B. Evaluate a Transaction</CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6 pt-0 space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Run a policy decision before an ERC-8183 job, x402 payment, or service purchase.
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {trustGateOutcomes.map((outcome) => (
                  <span
                    key={outcome.code}
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold ${outcome.color}`}
                  >
                    {outcome.code}
                  </span>
                ))}
              </div>
              <div className="pt-2">
                <Button asChild size="sm" className="rounded-lg bg-cyan-500 hover:bg-cyan-600 font-semibold text-slate-950 text-xs">
                  <Link href="/trust-gate">
                    Open Trust Gate <ArrowRight className="size-3.5 ml-1" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* C. Choose a Counterparty */}
          <Card className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#0c101a] via-[#090c13] to-[#07090e] p-2 backdrop-blur-xl shadow-lg transition-all hover:border-blue-500/40">
            <CardHeader className="p-6 pb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex size-10 items-center justify-center rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
                  <SlidersHorizontal className="size-5" />
                </div>
                <Badge variant="secondary" className="border-blue-500/30 bg-blue-500/10 text-blue-300 text-xs">
                  Multi-Criteria Ranking
                </Badge>
              </div>
              <CardTitle className="mt-4 text-xl font-bold">C. Choose a Counterparty</CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6 pt-0 space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Compare eligible agents using identity, reputation, execution evidence, economic reliability, and budget constraints.
              </p>
              <div className="pt-2">
                <Button asChild size="sm" variant="outline" className="rounded-lg border-white/10 bg-white/5 hover:bg-white/10 text-xs font-semibold">
                  <Link href="/trust/select">
                    Counterparty Selection Matrix <ArrowRight className="size-3.5 ml-1" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* D. Verify Work */}
          <Card className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#0c101a] via-[#090c13] to-[#07090e] p-2 backdrop-blur-xl shadow-lg transition-all hover:border-emerald-500/40">
            <CardHeader className="p-6 pb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  <BadgeCheck className="size-5" />
                </div>
                <Badge variant="secondary" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs">
                  ERC-8183 Settlement
                </Badge>
              </div>
              <CardTitle className="mt-4 text-xl font-bold">D. Verify Work</CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6 pt-0 space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Use Veyra&apos;s independent ERC-8183 evaluator to verify submitted work before settlement.
              </p>
              <div className="pt-2">
                <Button asChild size="sm" variant="outline" className="rounded-lg border-white/10 bg-white/5 hover:bg-white/10 text-xs font-semibold">
                  <Link href="/evaluators">
                    Explore ERC-8183 Evaluator <ArrowRight className="size-3.5 ml-1" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Trust Pipeline Lifecycle Visualization */}
      <section className="border-t border-white/5 bg-[#06080d]/80 py-16">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <div className="max-w-3xl">
            <Badge variant="outline" className="border-cyan-500/30 text-cyan-400 bg-cyan-500/5">
              Protocol Lifecycle
            </Badge>
            <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
              End-to-end trust pipeline
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              From identity onboarding to execution, independent evaluation, and proof settlement on Arc.
            </p>
          </div>

          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pipelineSteps.map((item) => (
              <div
                key={item.step}
                className="relative flex items-start gap-3.5 rounded-xl border border-white/10 bg-gradient-to-b from-white/5 to-transparent p-4 backdrop-blur-md transition-all hover:border-primary/30"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-xs font-bold text-primary">
                  {item.step}
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-10 rounded-xl border border-white/10 bg-white/[0.02] p-5 text-center sm:flex sm:items-center sm:justify-between sm:text-left">
            <div>
              <p className="text-sm font-bold text-foreground">Build with the Veyra Agent API</p>
              <p className="text-xs text-muted-foreground">
                Integrate programmatic trust decisions, reputation lookups, and evaluations into autonomous agents.
              </p>
            </div>
            <Button asChild size="sm" className="mt-4 sm:mt-0 rounded-xl bg-primary hover:bg-blue-600 font-semibold text-xs">
              <Link href="/console/agent-api">
                <FileCode2 className="size-3.5 mr-1.5" />
                View API Specs
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
