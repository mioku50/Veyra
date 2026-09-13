/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import Link from "next/link";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  FileText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { curatedHostedWorkflowTemplates } from "@/lib/agent/workflow-templates";
import { hostedWorkflowHref } from "@/lib/agent/workflow-links";
import { ServicePresentation } from "@/components/services/service-presentation";

export const metadata = {
  title: "Workflow Templates",
  description:
    "Hosted agent workflow templates that purchase allowlisted x402 APIs and produce verified Arc reports.",
};

export default function WorkflowsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-b border-white/5 bg-gradient-to-b from-[#0a0d15] via-[#080a0f] to-[#07090e] py-12 sm:py-16">
        <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 sm:px-6 lg:grid-cols-[1fr_0.72fr] lg:items-end">
          <div>
            <Badge className="mb-4 rounded-full border-cyan-500/30 bg-cyan-500/10 px-3.5 py-1 text-xs font-semibold text-cyan-300">
              Curated Templates
            </Badge>
            <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl gradient-text">
              Guarded Workflow Catalog
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Submit real non-sensitive input, preview allowlisted service costs, and let the hosted agent execute x402 purchases and assemble Arc-verified reports.
            </p>
          </div>
          <Card className="rounded-2xl border border-white/10 bg-[#090c13]/90 backdrop-blur-xl p-1 shadow-xl">
            <CardContent className="grid gap-3.5 p-5 text-xs">
              <p className="flex items-center gap-2 font-bold text-foreground">
                <ShieldCheck className="size-4 text-cyan-400" />
                Arc Testnet Safety Guardrails
              </p>
              <p className="text-muted-foreground leading-relaxed">
                Project-owned payer · Allowlisted services only · Immutable quotes · Workflow-specific call and budget caps.
              </p>
              <Button asChild className="rounded-xl bg-primary hover:bg-blue-600 font-semibold text-white mt-1">
                <Link href="/agent-runner">
                  <Sparkles className="size-4 mr-1.5" />
                  Run Workflow
                  <ArrowRight className="size-4 ml-1.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-2">
        {curatedHostedWorkflowTemplates.map((template) => (
          <Card key={template.value} className="rounded-2xl border border-white/10 bg-[#090c13]/90 backdrop-blur-xl p-1 transition-all duration-300 hover:border-primary/40 hover:shadow-[0_0_30px_rgba(123,108,255,0.12)]">
            <CardHeader className="p-6 pb-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-primary text-xs font-semibold">
                  Hosted Workflow
                </Badge>
                <Badge variant="outline" className="border-white/10 font-mono text-xs text-muted-foreground">
                  ~{template.estimatedSpendUsdc.toFixed(4)} USDC
                </Badge>
              </div>
              <CardTitle className="flex items-center gap-2.5 text-xl font-bold text-foreground">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Bot className="size-4" />
                </div>
                {template.label}
              </CardTitle>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {template.description}
              </p>
            </CardHeader>

            <CardContent className="p-6 pt-0 grid gap-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80">Paid Services</p>
                <div className="mt-2.5 grid gap-2">
                  {template.services.map((service) => (
                    <div
                      key={service.slug}
                      className="grid gap-2 rounded-xl border border-white/5 bg-white/5 p-3 text-xs sm:grid-cols-[1fr_auto]"
                    >
                      <div>
                        <p className="font-semibold text-foreground">{service.name}</p>
                        <div className="mt-1.5">
                          <ServicePresentation
                            metadata={{
                              ...service.presentation,
                              assetSymbol:
                                service.presentation.providerType === "live_provider"
                                  ? "BTC/USD · ETH/USD · SOL/USD"
                                  : service.presentation.assetSymbol,
                            }}
                          />
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                          {service.purpose}
                        </p>
                      </div>
                      <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                        {service.priceUsdc.toFixed(4)} USDC
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground/80">
                  <FileText className="size-3.5 text-cyan-400" /> Expected Final Report Output
                </p>
                <div className="mt-2.5 grid gap-1.5">
                  {template.expectedResult.map((result) => (
                    <p key={result} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CheckCircle2 className="size-3.5 shrink-0 text-cyan-400" />
                      {result}
                    </p>
                  ))}
                </div>
              </div>

              <Button asChild className="rounded-xl bg-primary hover:bg-blue-600 font-semibold text-white">
                <Link href={hostedWorkflowHref(template.value)}>
                  Use This Template
                  <ArrowRight className="size-4 ml-1" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
