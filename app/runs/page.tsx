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
import { connection } from "next/server";
import { Suspense } from "react";
import {
  BadgeCheck,
  Bot,
  ReceiptText,
  Sparkles,
  Store,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchRecentAgentRuns, type PublicAgentRun } from "@/lib/agent/runs-public";
import { RunsListClient } from "./runs-client";

export const metadata = {
  title: "Workflow Activity",
  description: "Public hosted and operator buyer-agent activity timelines.",
};

async function RunsList() {
  await connection();

  let runs: PublicAgentRun[] = [];
  let error: string | null = null;

  try {
    runs = await fetchRecentAgentRuns(50);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return <RunsListClient initialRuns={runs} error={error} />;
}

function RunsFallback() {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
      <Card className="rounded-2xl border border-white/10 bg-[#090c13]/80 p-6 text-sm text-muted-foreground backdrop-blur-xl">
        Loading agent runs...
      </Card>
    </section>
  );
}

export default function RunsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-b border-white/5 bg-gradient-to-b from-[#0a0d15] via-[#080a0f] to-[#07090e] py-12 sm:py-16">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-primary text-xs font-semibold">
                Buyer Agent Activity
              </Badge>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-xs text-muted-foreground">
                Public Purchase Timeline
              </Badge>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl gradient-text">
              Activity Archive
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Inspect how hosted and advanced operator workflows plan, select and purchase services through x402/Gateway, publish receipts, and record post-settlement Arc proofs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm" className="rounded-xl border-white/10 bg-white/5 hover:bg-white/10">
              <Link href="/demo">
                <Sparkles className="size-4 mr-1 text-cyan-400" />
                Demo
              </Link>
            </Button>
            <Button asChild size="sm" className="rounded-xl bg-primary hover:bg-blue-600 font-semibold">
              <Link href="/agent-runner">
                <Bot className="size-4 mr-1" />
                Run Workflow
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="rounded-xl border-white/10 bg-white/5 hover:bg-white/10">
              <Link href="/results">
                <Store className="size-4 mr-1" />
                Reports
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <Suspense fallback={<RunsFallback />}>
        <RunsList />
      </Suspense>
    </main>
  );
}
