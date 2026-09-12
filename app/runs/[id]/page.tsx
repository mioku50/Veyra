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
import { ArrowLeft, BadgeCheck, ExternalLink, ReceiptText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/copy-button";
import {
  fetchAgentRunDetail,
  type PublicAgentRun,
  type PublicAgentStep,
} from "@/lib/agent/runs-public";
import { shortenHash } from "@/lib/utils";
import { ARC_TESTNET_EXPLORER_URL } from "@/lib/commerce/onchain-proof";
import { ProviderResponseDetails } from "@/components/services/provider-response-details";

type RunDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export const metadata = {
  title: "Agent Run",
};

function statusVariant(status: string) {
  if (status === "completed" || status === "paid") return "default";
  if (status === "failed") return "destructive";
  if (status === "running" || status === "selected" || status === "payment_required") {
    return "secondary";
  }
  return "outline";
}

function sourceLabel(sourceType: string | null) {
  if (sourceType === "static") return "Internal deterministic";
  if (sourceType === "provider_backed") return "Live Provider";
  if (sourceType === "seller_mock") return "Seller-created mock";
  if (sourceType === "external_seller") return "External Seller API";
  if (sourceType === "external_placeholder") return "Seller-created placeholder";
  return null;
}

function proofStatusLabel(status: string | undefined) {
  if (status === "verified") return "Verified on Arc";
  if (status === "pending") return "Onchain proof pending";
  if (status === "failed") return "Proof failed";
  return null;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function JsonPreview({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;

  return (
    <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs leading-5">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function RunSummary({ run }: { run: PublicAgentRun }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          <Badge variant="secondary">{run.mode}</Badge>
        </div>
        <CardTitle className="text-3xl">{run.task}</CardTitle>
        <p className="text-sm text-muted-foreground">{formatDate(run.created_at)}</p>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <dt className="text-muted-foreground">Budget</dt>
            <dd className="font-mono">{run.budget_usdc} USDC</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Spent</dt>
            <dd className="font-mono">{run.spent_usdc} USDC</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Paid</dt>
            <dd className="font-mono">{run.paid_count ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Skipped</dt>
            <dd className="font-mono">{run.skipped_count ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Wallet</dt>
            <dd className="font-mono">
              {run.agent_wallet ? (
                <Link
                  href={`/agents/${run.agent_wallet}`}
                  className="text-primary hover:underline"
                >
                  {shortenHash(run.agent_wallet, 5)}
                </Link>
              ) : (
                "n/a"
              )}
            </dd>
          </div>
        </dl>
        {run.summary ? (
          <p className="rounded-md bg-secondary p-3 text-sm text-secondary-foreground">
            {run.summary}
          </p>
        ) : null}
        {run.error ? (
          <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {run.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TimelineStep({ step }: { step: PublicAgentStep }) {
  const paymentEventId = step.payment_event_id ?? step.matched_payment_event_id ?? null;
  const proofLabel = proofStatusLabel(step.onchain_proof?.status);
  const explorerBase = (
    process.env.NEXT_PUBLIC_ARC_EXPLORER_URL ?? ARC_TESTNET_EXPLORER_URL
  ).replace(/\/$/, "");

  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Step {step.step_index}</Badge>
          <Badge variant={statusVariant(step.status)}>{step.status}</Badge>
          {step.method ? <Badge variant="outline">{step.method}</Badge> : null}
          {sourceLabel(step.service_source_type) ? (
            <Badge
              variant={
                step.service_source_type === "static" ? "outline" : "secondary"
              }
            >
              {sourceLabel(step.service_source_type)}
            </Badge>
          ) : null}
          {proofLabel ? (
            <Badge
              variant={
                step.onchain_proof?.status === "verified"
                  ? "default"
                  : step.onchain_proof?.status === "failed"
                    ? "destructive"
                    : "outline"
              }
            >
              {proofLabel}
            </Badge>
          ) : null}
        </div>
        <CardTitle className="text-xl">
          {step.service_name ?? step.service_slug ?? "Unknown service"}
        </CardTitle>
        {step.endpoint ? (
          <p className="break-all font-mono text-xs text-muted-foreground">
            {step.endpoint}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Price</dt>
            <dd className="font-mono">{step.price_usdc ?? "0"} USDC</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Request ID</dt>
            <dd className="font-mono">
              {step.request_id ? shortenHash(step.request_id, 6) : "n/a"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Payment event</dt>
            <dd>
              {paymentEventId ? (
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {shortenHash(paymentEventId, 6)}
                  <ExternalLink size={12} />
                </Link>
              ) : (
                <span className="text-muted-foreground">n/a</span>
              )}
              {!step.payment_event_id && step.matched_payment_event_id ? (
                <span className="ml-2 text-xs text-muted-foreground">matched</span>
              ) : null}
            </dd>
          </div>
        </dl>

        {step.reasoning ? (
          <div>
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">
              Reasoning
            </h2>
            <p className="mt-2 leading-7">{step.reasoning}</p>
          </div>
        ) : null}

        {step.error ? (
          <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {step.error}
          </p>
        ) : null}

        <ProviderResponseDetails value={step.response_preview} />

        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">
              Response preview
            </h2>
            {step.response_preview ? (
              <CopyButton
                value={JSON.stringify(step.response_preview, null, 2)}
                label="Copy preview"
              />
            ) : null}
          </div>
          <JsonPreview value={step.response_preview} />
        </div>

        {step.status === "paid" ? (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button asChild variant="outline">
              <Link href={`/receipts/${step.id}`}>
                <ReceiptText />
                Public receipt
              </Link>
            </Button>
            {step.onchain_proof?.transactionHash ? (
              <Button asChild variant="outline">
                <a
                  href={`${explorerBase}/tx/${step.onchain_proof.transactionHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink />
                  Arc proof transaction
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

async function RunDetail({ params }: RunDetailPageProps) {
  await connection();
  const { id } = await params;
  const result = await fetchAgentRunDetail(id).catch(() => null);

  if (!result) notFound();

  return (
    <>
      <section className="border-b bg-secondary/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <Button asChild variant="ghost" className="mb-6 px-0">
            <Link href="/runs">
              <ArrowLeft />
              Back to Activity
            </Link>
          </Button>
          {result.run.agent_wallet ? (
            <Button asChild variant="outline" className="mb-6 ml-4">
              <Link href={`/agents/${result.run.agent_wallet}`}>
                <BadgeCheck />
                Agent Passport
              </Link>
            </Button>
          ) : null}
          <RunSummary run={result.run} />
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
        {result.steps.length === 0 ? (
          <Card className="rounded-lg">
            <CardContent className="p-6 text-sm text-muted-foreground">
              No timeline steps have been recorded for this run yet.
            </CardContent>
          </Card>
        ) : (
          result.steps.map((step) => (
            <TimelineStep key={step.id} step={step} />
          ))
        )}
      </section>
    </>
  );
}

function RunDetailFallback() {
  return (
    <>
      <section className="border-b bg-secondary/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <Button asChild variant="ghost" className="mb-6 px-0">
            <Link href="/runs">
              <ArrowLeft />
              Back to Activity
            </Link>
          </Button>
          <Card className="rounded-lg">
            <CardContent className="p-6 text-sm text-muted-foreground">
              Loading agent run...
            </CardContent>
          </Card>
        </div>
      </section>
    </>
  );
}

export default function RunDetailPage({ params }: RunDetailPageProps) {
  return (
    <main className="min-h-screen bg-background">
      <Suspense fallback={<RunDetailFallback />}>
        <RunDetail params={params} />
      </Suspense>
    </main>
  );
}
