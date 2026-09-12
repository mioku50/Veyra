/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Code2,
  FlaskConical,
  Fuel,
  Radio,
  Store,
  TerminalSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BRAND } from "@/lib/brand";
import { getPythProviderDiagnostic } from "@/lib/providers/pyth";

export const metadata = {
  title: "Developer Tools",
  description:
    `Advanced ${BRAND.agentApi}, API Store, planner, wallet launch, and local CLI tools for ${BRAND.name} operators.`,
};

const tools = [
  {
    title: `${BRAND.agentApi} v1`,
    href: "/console/agent-api",
    icon: Code2,
    body: `${BRAND.agentApi} v1 endpoints, OpenAPI 3.0 spec, credential scope reference, and interactive TypeScript & Python SDK quickstart snippets.`,
  },
  {
    title: "API Store",
    href: "/store",
    icon: Store,
    body: "Inspect the allowlisted paid services, schemas, x402 prices, and protected endpoints used by workflows.",
  },
  {
    title: "Agent Control",
    href: "/agent-control",
    icon: Bot,
    body: "Dry-run the shared planner and inspect service buy/skip reasoning without creating a payment.",
  },
  {
    title: "Fund Local CLI Agent",
    href: "/agent-launch",
    icon: Fuel,
    body: "Open the explicit funding flow for an operator-owned Arc Testnet buyer wallet used by the advanced local CLI.",
  },
  {
    title: "Agent Setup",
    href: "/agent-setup",
    icon: FlaskConical,
    body: "Configure and run the local CLI with your own buyer-agent wallet and server-side secrets.",
  },
];

export default function DeveloperToolsPage() {
  const provider = getPythProviderDiagnostic();
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/20">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
          <Badge className="mb-4">Advanced / operator flow</Badge>
          <h1 className="text-4xl font-bold tracking-normal sm:text-5xl">Developer Tools</h1>
          <p className="mt-4 max-w-3xl leading-7 text-muted-foreground">
            The browser-hosted workflow is the primary product. These tools keep
            the underlying service registry, planner inspection, wallet funding,
            and local CLI available for developers who need direct control.
          </p>
        </div>
      </section>
      <section className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-8 sm:px-6 md:grid-cols-2">
        {tools.map(({ title, href, icon: Icon, body }) => (
          <Card key={href} className="command-card rounded-lg">
            <CardHeader>
              <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                <Icon className="size-5" />
              </div>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5">
              <p className="text-sm leading-6 text-muted-foreground">{body}</p>
              <Button asChild variant="outline">
                <Link href={href}>
                  Open {title}
                  <ArrowRight />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
        <Card className="rounded-lg border-primary/25 md:col-span-2">
          <CardHeader>
            <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary"><Radio className="size-5" /></div>
            <div className="flex flex-wrap items-center gap-2"><CardTitle>Pyth provider details</CardTitle><Badge>{provider.configured ? "Server adapter configured" : "Server adapter unavailable"}</Badge><Badge variant="secondary">Live Provider</Badge></div>
          </CardHeader>
          <CardContent className="grid gap-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-muted-foreground">Provider</dt><dd className="font-medium">{provider.provider}</dd></div>
              <div><dt className="text-muted-foreground">Symbols</dt><dd>{provider.supportedSymbols.join(", ")}</dd></div>
              <div><dt className="text-muted-foreground">Agent access price</dt><dd className="font-mono">{provider.priceUsdc} USDC</dd></div>
              <div><dt className="text-muted-foreground">Freshness threshold</dt><dd>{provider.maxPriceAgeSeconds} seconds</dd></div>
            </dl>
            <p className="text-sm leading-6 text-muted-foreground">{BRAND.name} charges the buyer-agent through x402, then obtains and normalizes Pyth Network data. The agent does not pay Pyth directly. Feed IDs and the upstream host are fixed server-side; arbitrary provider proxying is disabled.</p>
            <p className="rounded-md bg-secondary/30 p-3 text-xs text-muted-foreground">{provider.dataBoundary}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg border-primary/25 md:col-span-2">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-3 text-sm text-muted-foreground">
              <TerminalSquare className="size-5 shrink-0 text-primary" />
              Local CLI is an advanced own-wallet/operator path. Hosted workflows
              never ask for a user private key.
            </p>
            <Button asChild>
              <Link href="/agent-runner">Return to Run Workflow</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
