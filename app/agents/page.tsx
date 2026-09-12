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
  ArrowRight,
  BadgeCheck,
  Bot,
  ListChecks,
  ReceiptText,
  Store,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { USDCAmount } from "@/components/wallet/USDCAmount";
import { WalletAddress } from "@/components/wallet/WalletAddress";
import {
  countVerifiedAgentProofs,
  listAgentProfiles,
  type PublicAgentProfile,
} from "@/lib/agent/passport-persistence";

export const metadata = {
  title: "Agent Passports",
  description: "Public buyer-agent identity and reputation passports.",
};

function formatDate(value: string | null) {
  if (!value) return "n/a";

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ProfileCard({
  profile,
  verifiedProofs,
}: {
  profile: PublicAgentProfile;
  verifiedProofs: number;
}) {
  const trustColor =
    profile.trust_score >= 67
      ? "bg-sky-400"
      : profile.trust_score >= 34
        ? "bg-amber-400"
        : "bg-red-400";

  return (
    <Card className="command-card rounded-lg shadow-sm">
      <CardHeader>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Agent Passport</Badge>
            <Badge variant={profile.trust_score >= 60 ? "default" : "outline"}>
              Trust {profile.trust_score}/100
            </Badge>
          </div>
          <div className="w-full max-w-[220px]">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full ${trustColor}`}
                style={{ width: `${Math.min(100, Math.max(0, profile.trust_score))}%` }}
              />
            </div>
          </div>
        </div>
        <CardTitle className="min-w-0 text-xl">
          <WalletAddress address={profile.wallet} chars={8} />
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Last run: {formatDate(profile.last_run_at)}
        </p>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Workflows</dt>
            <dd className="font-mono">{profile.total_runs}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Reports</dt>
            <dd className="font-mono">{profile.completed_runs}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Successful calls</dt>
            <dd className="font-mono">{profile.paid_requests}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Arc proofs</dt>
            <dd className="font-mono">{verifiedProofs}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Spent</dt>
            <dd><USDCAmount value={profile.total_usdc_spent} /></dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Success rate</dt>
            <dd className="font-mono">
              {profile.total_runs
                ? `${Math.round((profile.completed_runs / profile.total_runs) * 100)}%`
                : "0%"}
            </dd>
          </div>
        </dl>
        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Reputation is derived from public run and purchase-step history.
          </p>
          <Button asChild>
            <Link href={`/agents/${profile.wallet}`}>
              View passport
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

async function AgentsList() {
  await connection();

  let profiles: PublicAgentProfile[] = [];
  let error: string | null = null;
  let proofCounts = new Map<string, number>();

  try {
    profiles = await listAgentProfiles(30);
  } catch (caught) {
    /* The driver's message ("permission denied for table payment_events") is a
       server-side fact, not something a visitor can act on, and printing it
       leaks the schema. It belongs in the logs; the page says what the reader
       needs to know, which is that the list is unavailable, not why. */
    console.error("[agents] failed to load passports", caught);
    error = "unavailable";
  }

  /* Proof counts decorate a passport; they never gate one. Kept in its own
     try so a missing grant on the payments table cannot hide the agents. */
  if (profiles.length > 0) {
    try {
      proofCounts = await countVerifiedAgentProofs(profiles.map((profile) => profile.wallet));
    } catch (caught) {
      console.warn("[agents] proof counts unavailable", caught);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
      {error ? (
        <Card className="rounded-lg">
          <CardContent className="p-6">
            <p className="font-medium">Agent passports are temporarily unavailable.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              The passport index could not be read. Onchain identity and settlement
              records on Arc are unaffected — only this listing is.
            </p>
          </CardContent>
        </Card>
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agent passports yet."
          description="Run a hosted workflow to create the first public buyer-agent Passport."
          action={{ label: "Run Workflow", href: "/agent-runner" }}
        />
      ) : (
        profiles.map((profile) => (
          <ProfileCard
            key={profile.wallet}
            profile={profile}
            verifiedProofs={proofCounts.get(profile.wallet.toLowerCase()) ?? 0}
          />
        ))
      )}
    </section>
  );
}

function AgentsFallback() {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
      <Card className="rounded-lg">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading agent passports...
        </CardContent>
      </Card>
    </section>
  );
}

export default function AgentsPage() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/30">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Agent Identity</Badge>
              <Badge variant="outline">Reputation Passport</Badge>
            </div>
            <h1 className="text-4xl font-bold tracking-normal text-foreground sm:text-5xl">
              Agent Passports
            </h1>
            <p className="mt-4 max-w-3xl leading-7 text-muted-foreground">
              Public buyer-agent identities derived from hosted workflows,
              completed Final Reports, successful x402 calls, verified Arc
              proofs, spend, and execution success rate.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild variant="outline">
              <Link href="/agent-runner">
                <Bot />
                Run Workflow
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/runs">
                <ListChecks />
                Activity
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/receipts">
                <ReceiptText />
                Receipts
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/proofs">
                <Store />
                Arc Proofs
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 pt-8 sm:px-6 md:grid-cols-3">
        {[
          ["Trust score", "Computed deterministically from observed activity"],
          ["Workflow history", "Reports, paid calls, spend, and success rate"],
          ["Arc verification", "Registry proofs linked to successful receipts"],
        ].map(([title, body]) => (
          <Card key={title} className="rounded-lg">
            <CardHeader>
              <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                <BadgeCheck size={20} />
              </div>
              <CardTitle className="text-lg">{title}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-6 text-muted-foreground">
              {body}
            </CardContent>
          </Card>
        ))}
      </section>

      <Suspense fallback={<AgentsFallback />}>
        <AgentsList />
      </Suspense>
    </main>
  );
}
