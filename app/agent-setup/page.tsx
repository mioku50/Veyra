/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import Link from "next/link";
import { Bot, Fuel, ShieldCheck, Store } from "lucide-react";
import { LocalAgentSetupGuide } from "@/components/agent/local-agent-setup-guide";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";

export const metadata = {
  title: "Local Agent Setup",
  description:
    `Reviewer and developer guide for running the ${BRAND.name} buyer-agent locally.`,
};

export default function AgentSetupPage() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/20">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-12 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">CLI onboarding</Badge>
              <Badge variant="outline">Reviewer quick path</Badge>
            </div>
            <h1 className="text-4xl font-bold tracking-normal text-foreground sm:text-5xl">
              Run the buyer-agent locally
            </h1>
            <p className="mt-4 max-w-3xl leading-7 text-muted-foreground">
              Clone the repository, keep secrets in `.env.local`, fund the
              buyer-agent wallet from the browser, then run the existing local
              CLI agent to create timelines, receipts, and Agent Passport proof.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button asChild variant="outline">
              <Link href="/agent-launch">
                <Fuel />
                Fund Local CLI Agent
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/agent-control">
                <Bot />
                Plan first
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

      <section className="mx-auto grid w-full max-w-7xl gap-5 px-4 py-8 sm:px-6">
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm leading-6 text-muted-foreground">
          <div className="mb-2 flex items-center gap-2 font-semibold text-foreground">
            <ShieldCheck className="size-4 text-primary" />
            Public user limitation
          </div>
          This is a reviewer/operator flow today. The public browser app can
          fund and plan, but the local CLI still needs private local env values
          for persistence and x402 signing.
        </div>
        <LocalAgentSetupGuide />
      </section>
    </main>
  );
}
