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

"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { USDCAmount } from "@/components/wallet/USDCAmount";
import { WalletAddress } from "@/components/wallet/WalletAddress";
import type { PublicAgentRun } from "@/lib/agent/runs-public";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function failedRunReason(run: PublicAgentRun) {
  if (run.status !== "failed") return null;
  const text = [run.error, run.summary].filter(Boolean).join(" ").toLowerCase();
  if (
    text.includes("insufficient_balance") ||
    text.includes("insufficient balance") ||
    text.includes("gateway balance")
  ) {
    return "testnet/balance failure";
  }
  return "testnet failure";
}

function RunCard({ run }: { run: PublicAgentRun }) {
  return (
    <Card className="command-card rounded-lg shadow-sm">
      <CardHeader>
        <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <StatusBadge status={run.mode} />
            {failedRunReason(run) ? (
              <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-300">
                {failedRunReason(run)}
              </span>
            ) : null}
          </div>
          <p className="shrink-0 text-xs text-muted-foreground">
            {formatDate(run.created_at)}
          </p>
        </div>
        <CardTitle className="line-clamp-2 text-xl leading-snug">{run.task}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Budget</dt>
            <dd><USDCAmount value={run.budget_usdc} /></dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Spent</dt>
            <dd><USDCAmount value={run.spent_usdc} /></dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Paid</dt>
            <dd className="font-mono">{run.paid_count ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Steps</dt>
            <dd className="font-mono">{run.step_count ?? 0}</dd>
          </div>
        </dl>
        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          {run.agent_wallet ? (
            <Link
              href={`/agents/${run.agent_wallet}`}
              className="min-w-0 text-primary hover:underline"
            >
              <WalletAddress address={run.agent_wallet} chars={6} copyable={false} />
            </Link>
          ) : (
            <p className="font-mono text-xs text-muted-foreground">No wallet</p>
          )}
          <Button asChild>
            <Link href={`/runs/${run.id}`}>
              View timeline
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function RunsListClient({ initialRuns, error }: { initialRuns: PublicAgentRun[], error: string | null }) {
  const [filter, setFilter] = useState("successful");

  const filteredRuns = filter === "successful"
    ? initialRuns.filter(r => r.status === "completed")
    : initialRuns;

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
      <div className="mb-4">
        <Tabs value={filter} onValueChange={setFilter} className="w-full max-w-sm">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="successful">Successful Proofs</TabsTrigger>
            <TabsTrigger value="all">Show All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {error ? (
        <Card className="rounded-lg">
          <CardContent className="p-6">
            <p className="font-medium">Agent runs are not available yet.</p>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      ) : filteredRuns.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={filter === "successful" ? "No successful agent runs yet." : "No agent runs yet."}
          description="Launch your first buyer-agent run from Agent Control after funding the local buyer-agent wallet."
          action={{ label: "Open Agent Control", href: "/agent-control" }}
        />
      ) : (
        filteredRuns.map((run) => <RunCard key={run.id} run={run} />)
      )}
    </section>
  );
}
