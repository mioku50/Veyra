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

function relativeTime(value: string | null) {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/* A passport, not three cards.
 *
 * The name promised an object — an identity you can hold and check — and the
 * page delivered a grid of equal tiles that could have described anything. This
 * is one surface: who the agent is, the score, what it has actually done, and
 * the record each claim rests on. Nothing here is estimated; every number is
 * read from observed activity or from Arc. */
function Passport({
  profile,
  verifiedProofs,
}: {
  profile: PublicAgentProfile;
  verifiedProofs: number;
}) {
  const score = Math.max(0, Math.min(100, Math.round(profile.trust_score)));
  const successRate = profile.total_runs
    ? Math.round((profile.completed_runs / profile.total_runs) * 100)
    : 0;
  const band =
    score >= 75 ? "var(--run-azure)" : score >= 45 ? "var(--run-amber)" : "var(--run-red)";

  const figures: Array<[string, string, string]> = [
    ["Executions", String(profile.total_runs), `${profile.completed_runs} completed`],
    ["Successful", `${successRate}%`, `${profile.failed_runs} failed`],
    ["Settled", `${profile.total_usdc_spent} USDC`, `${profile.paid_requests} paid calls`],
    ["Arc proofs", String(verifiedProofs), verifiedProofs > 0 ? "verified onchain" : "none yet"],
  ];

  const ledger: Array<[string, React.ReactNode]> = [
    ["Identity", <span key="i" className="font-mono text-[12px]">{profile.wallet}</span>],
    ["History", `${profile.total_runs} runs observed since ${formatDate(profile.first_seen_at)}`],
    ["Evidence", `${verifiedProofs} settlement${verifiedProofs === 1 ? "" : "s"} carry a verified Arc proof`],
    ["Budget", `${profile.budget_respected_runs} of ${profile.total_runs} runs stayed inside the ceiling`],
  ];

  return (
    <section className="run-panel-raised overflow-hidden">
      <div className="run-signature" />

      <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-5">
        <div className="min-w-0">
          <span className="run-eyebrow">Agent passport</span>
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            <code className="run-num break-all text-[15px] text-[var(--run-text)]">
              {profile.wallet}
            </code>
            <CopyButton value={profile.wallet} label="Copy wallet" />
          </div>
        </div>
        <span className="run-chip" data-tone="verified">
          <ShieldCheck className="size-3" />
          Arc Testnet
        </span>
      </div>

      <div className="grid gap-7 px-6 pb-6 pt-6 sm:grid-cols-[200px_minmax(0,1fr)]">
        <div>
          {/* Not "Trust". The number is computed from observed activity —
              completed runs, paid calls, budgets respected — and saturates at
              100 on volume alone, with no cryptographic evidence required. A
              passport reading "Trust 100/100" beside "Arc proofs 0" invites
              exactly the conclusion the evidence does not support. */}
          <span className="run-eyebrow">Observed activity</span>
          <div className="run-display run-num mt-1.5 text-[52px] leading-none" style={{ color: band }}>
            {score}
            <span className="text-[18px] text-[var(--run-text-faint)]">/100</span>
          </div>
          <div className="run-meter mt-3">
            <span style={{ width: `${score}%`, background: band }} />
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--run-text-faint)]">
            Deterministic, not a model output: completed workflows, successful paid
            calls and budget-respected execution raise it, failures reduce it. It
            measures behaviour Veyra has watched, not cryptographic proof — so it
            is an input to a decision, never authority for a large spend on its own.
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 self-start">
          {figures.map(([label, value, detail]) => (
            <div key={label}>
              <dt className="run-eyebrow">{label}</dt>
              <dd className="run-num mt-1.5 text-[21px] leading-none text-[var(--run-text)]">{value}</dd>
              <dd className="mt-1.5 text-[11px] text-[var(--run-text-faint)]">{detail}</dd>
            </div>
          ))}
        </dl>
      </div>

      <dl className="border-t border-[var(--run-line)] bg-[var(--run-canvas-raised)] px-6 py-5">
        {ledger.map(([label, value], i) => (
          <div
            key={label}
            className={`flex flex-wrap items-baseline gap-x-5 gap-y-1 py-2 ${i > 0 ? "border-t border-[var(--run-line)]" : ""}`}
          >
            <dt className="run-eyebrow w-[74px] shrink-0">{label}</dt>
            <dd className="min-w-0 flex-1 text-[12.5px] text-[var(--run-text-muted)]">{value}</dd>
          </div>
        ))}
        <p className="mt-3 text-[11px] text-[var(--run-text-faint)]">
          Last active {relativeTime(profile.last_run_at)} · first seen{" "}
          {formatDate(profile.first_seen_at)}
        </p>
      </dl>
    </section>
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
      <section className="mx-auto w-full max-w-5xl px-4 pt-8 sm:px-6">
        <Button asChild variant="ghost" className="mb-5 px-0">
          <Link href="/agents">
            <ArrowLeft />
            Back to Agent Passports
          </Link>
        </Button>
        <Passport profile={profile} verifiedProofs={verifiedProofs} />
      </section>

      <section className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-6">
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
