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
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Clock,
  ListChecks,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fetchAgentPassport,
  type AgentPassportDetail,
  type AgentPassportRun,
  type PublicAgentProfile,
  type PublicAgentReputationEvent,
} from "@/lib/agent/passport-persistence";
import {
  fetchReceiptsByAgentWallet,
  type CommerceReceipt,
} from "@/lib/commerce/receipts";
import { shortenHash } from "@/lib/utils";

type AgentPassportPageProps = {
  params: Promise<{
    wallet: string;
  }>;
};

export const metadata = {
  title: "Agent Passport",
};

function statusVariant(status: string) {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "running") return "secondary";
  return "outline";
}

function formatDate(value: string | null) {
  if (!value) return "n/a";

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <Card className="rounded-lg">
      <CardContent className="p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-2 font-mono text-2xl font-semibold">{value}</p>
        {detail ? <p className="mt-2 text-xs text-muted-foreground">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}

function TrustScore({ profile }: { profile: PublicAgentProfile }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Deterministic trust score</Badge>
          <Badge variant={profile.trust_score >= 60 ? "default" : "outline"}>
            {profile.trust_score}/100
          </Badge>
        </div>
        <CardTitle className="flex items-center gap-2 text-3xl">
          <ShieldCheck className="size-7 text-primary" />
          Agent Passport
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div>
          <p className="text-sm text-muted-foreground">Wallet</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-md bg-muted px-2 py-1 text-xs">
              {profile.wallet}
            </code>
            <CopyButton value={profile.wallet} label="Copy wallet" />
          </div>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${profile.trust_score}%` }}
          />
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          The score is deterministic, not a model output: completed workflows,
          successful paid calls, and budget-respected execution raise it; failed
          calls and failed workflows reduce it.
        </p>
      </CardContent>
    </Card>
  );
}

function RunsPanel({ runs }: { runs: AgentPassportRun[] }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <ListChecks className="size-5" />
          Recent runs
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No public runs are linked to this wallet yet.
          </p>
        ) : (
          runs.map((run) => (
            <div
              key={run.id}
              className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto] sm:items-center"
            >
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(run.created_at)}
                  </span>
                </div>
                <p className="line-clamp-2 font-medium">{run.task}</p>
                <p className="mt-2 font-mono text-xs text-muted-foreground">
                  Spent {run.spent_usdc} / {run.budget_usdc} USDC
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={`/runs/${run.id}`}>
                  Timeline
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function EventsPanel({ events }: { events: PublicAgentReputationEvent[] }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <Clock className="size-5" />
          Reputation events
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reputation events have been recorded yet.
          </p>
        ) : (
          events.map((event) => (
            <div key={event.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{event.event_type}</Badge>
                  <Badge variant={event.score_delta >= 0 ? "default" : "destructive"}>
                    {event.score_delta >= 0 ? "+" : ""}
                    {event.score_delta}
                  </Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatDate(event.created_at)}
                </span>
              </div>
              <p className="mt-3 font-medium">{event.title}</p>
              {event.description ? (
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {event.description}
                </p>
              ) : null}
              {event.run_id ? (
                <Link
                  href={`/runs/${event.run_id}`}
                  className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  Open run
                  <ArrowRight size={14} />
                </Link>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ReceiptsPanel({ receipts }: { receipts: CommerceReceipt[] }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <ReceiptText className="size-5" />
          Recent receipts
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {receipts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No paid commerce receipts are linked to this wallet yet.
          </p>
        ) : (
          receipts.map((receipt) => (
            <div key={receipt.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="default">x402 paid</Badge>
                  <Badge
                    variant={
                      receipt.serviceSourceType === "seller_mock"
                        ? "secondary"
                        : "outline"
                    }
                  >
                    {receipt.sourceLabel}
                  </Badge>
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {receipt.amountUsdc} USDC
                </span>
              </div>
              <p className="mt-3 font-medium">{receipt.serviceName}</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {receipt.endpoint ?? "n/a"}
              </p>
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href={`/receipts/${receipt.id}`}>
                  Open receipt
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function PassportContent({
  detail,
  receipts,
  verifiedProofs,
}: {
  detail: AgentPassportDetail;
  receipts: CommerceReceipt[];
  verifiedProofs: number;
}) {
  const { profile } = detail;

  return (
    <>
      <section className="border-b bg-secondary/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <Button asChild variant="ghost" className="mb-6 px-0">
            <Link href="/agents">
              <ArrowLeft />
              Back to Agent Passports
            </Link>
          </Button>
          <TrustScore profile={profile} />
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Workflows" value={profile.total_runs} />
          <StatCard label="Final Reports" value={profile.completed_runs} />
          <StatCard label="Successful calls" value={profile.paid_requests} />
          <StatCard label="Verified Arc proofs" value={verifiedProofs} />
          <StatCard
            label="Spent"
            value={`${profile.total_usdc_spent} USDC`}
          />
          <StatCard
            label="Success rate"
            value={
              profile.total_runs
                ? `${Math.round((profile.completed_runs / profile.total_runs) * 100)}%`
                : "0%"
            }
          />
        </div>

        <Card className="rounded-lg">
          <CardContent className="grid gap-4 p-5 text-sm sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground">First seen</p>
              <p className="mt-1 font-medium">{formatDate(profile.first_seen_at)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Last run</p>
              <p className="mt-1 font-medium">{formatDate(profile.last_run_at)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Budget-respected runs</p>
              <p className="mt-1 font-mono font-medium">
                {profile.budget_respected_runs}
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <RunsPanel runs={detail.recentRuns} />
          <EventsPanel events={detail.recentEvents} />
        </div>
        <ReceiptsPanel receipts={receipts} />
      </section>
    </>
  );
}

async function AgentPassport({ params }: AgentPassportPageProps) {
  await connection();
  const { wallet } = await params;
  const [detail, receipts] = await Promise.all([
    fetchAgentPassport(wallet).catch(() => null),
    fetchReceiptsByAgentWallet(wallet, 100).catch(() => [] as CommerceReceipt[]),
  ]);

  if (!detail) notFound();

  return (
    <PassportContent
      detail={detail}
      receipts={receipts.slice(0, 6)}
      verifiedProofs={
        receipts.filter((receipt) => receipt.onchainProof?.status === "verified").length
      }
    />
  );
}

function AgentPassportFallback() {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
      <Card className="rounded-lg">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading agent passport...
        </CardContent>
      </Card>
    </section>
  );
}

export default function AgentPassportPage({ params }: AgentPassportPageProps) {
  return (
    <main className="min-h-screen bg-background">
      <Suspense fallback={<AgentPassportFallback />}>
        <AgentPassport params={params} />
      </Suspense>
    </main>
  );
}
