import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Bot, Fuel, ListChecks, ShieldCheck, Sparkles, Store } from "lucide-react";
import { AgentControlClient } from "@/app/agent-control/agent-control-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  categoriesForServices,
  listPublicStoreServices,
} from "@/lib/services/store-service-persistence";

export const metadata = {
  title: "Buyer Agent Control Center",
  description:
    "Plan buyer-agent tasks, budgets, and service-selection policy without moving funds.",
};

async function AgentControlData() {
  await connection();
  const { services } = await listPublicStoreServices();

  return <AgentControlClient categories={categoriesForServices(services)} />;
}

function AgentControlFallback() {
  return (
    <Card className="rounded-lg">
      <CardContent className="p-6 text-sm text-muted-foreground">
        Loading buyer-agent control center...
      </CardContent>
    </Card>
  );
}

export default function AgentControlPage() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/30">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-12 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Buyer Agent</Badge>
              <Badge variant="outline">Control Center</Badge>
            </div>
            <h1 className="text-4xl font-bold tracking-normal text-foreground sm:text-5xl">
              Plan what the buyer-agent should buy
            </h1>
            <p className="mt-4 max-w-3xl leading-7 text-muted-foreground">
              Configure task, budget, and purchase policy before running the
              local CLI agent. This page performs dry-run planning only; paid
              x402 requests still happen locally.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild variant="outline">
              <Link href="/agent-runner?workflow=github">
                <Sparkles />
                Guided Demo
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/console/developer-tools">
                <Fuel />
                Developer Tools
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/agent-setup">
                <ShieldCheck />
                Setup Guide
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/runs">
                <ListChecks />
                Agent Runs
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/store">
                <Store />
                API Store
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        <div className="mb-5 grid gap-4 md:grid-cols-3">
          {[
            ["Dry-run", "No payment signatures, deposits, or private keys are handled in the browser."],
            ["Policy", "Filter by category, source, max price, and budget before buying."],
            ["Command", "Generate a local `npm run agent` command for the selected task and limit."],
          ].map(([title, body]) => (
            <Card key={title} className="rounded-lg">
              <CardContent className="p-5">
                <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                  <Bot size={20} />
                </div>
                <p className="font-semibold">{title}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Suspense fallback={<AgentControlFallback />}>
          <AgentControlData />
        </Suspense>
      </section>
    </main>
  );
}
