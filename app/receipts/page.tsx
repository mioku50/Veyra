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
  FileSearch,
  ListChecks,
  ReceiptText,
  Sparkles,
  Store,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { USDCAmount } from "@/components/wallet/USDCAmount";
import { WalletAddress } from "@/components/wallet/WalletAddress";
import {
  fetchRecentReceipts,
  type CommerceReceipt,
} from "@/lib/commerce/receipts";
import { shortenHash } from "@/lib/utils";

export const metadata = {
  title: "Commerce Receipts",
  description: "Public audit trail for paid x402 API purchases.",
};

type ReceiptsPageProps = {
  searchParams?: Promise<{
    wallet?: string;
    serviceSlug?: string;
  }>;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function onchainStatusLabel(receipt: CommerceReceipt) {
  if (receipt.onchainProof?.status === "verified") return "Verified on Arc";
  if (receipt.onchainProof?.status === "pending") return "Onchain proof pending";
  if (receipt.onchainProof?.status === "failed") return "Proof failed";
  return "Onchain unavailable";
}

function ReceiptCard({ receipt }: { receipt: CommerceReceipt }) {
  return (
    <Card className="rounded-2xl border border-white/10 bg-[#090c13]/90 backdrop-blur-xl p-1 transition-all duration-300 hover:border-primary/40 hover:shadow-[0_0_30px_rgba(52,227,155,0.12)]">
      <CardContent className="grid gap-4 p-5">
        <div className="grid min-w-0 gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StatusBadge status="paid" />
              <Badge
                variant={
                  receipt.serviceSourceType === "seller_mock" ? "secondary" : "outline"
                }
                className="border-white/10 bg-white/5 text-xs"
              >
                {receipt.sourceLabel}
              </Badge>
              <Badge variant={receipt.paymentEvent ? "default" : "outline"} className="border-white/10 text-xs">
                {receipt.paymentEventStatusLabel}
              </Badge>
              <Badge
                variant={
                  receipt.onchainProof?.status === "verified"
                    ? "default"
                    : receipt.onchainProof?.status === "failed"
                      ? "destructive"
                      : "outline"
                }
                className={receipt.onchainProof?.status === "verified" ? "bg-sky-500/10 border-sky-500/30 text-sky-300 text-xs" : "text-xs"}
              >
                {onchainStatusLabel(receipt)}
              </Badge>
            </div>

            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-xl font-bold tracking-tight text-foreground">{receipt.serviceName}</h2>
              {receipt.serviceSlug && (
                <span className="font-mono text-xs text-muted-foreground">
                  ({receipt.serviceSlug})
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground border-t border-white/5 pt-3">
              {receipt.buyerWallet && (
                <div>
                  Payer: <WalletAddress address={receipt.buyerWallet} />
                </div>
              )}
              <div>Timestamp: {formatDate(receipt.createdAt)}</div>
              {receipt.requestId && (
                <div className="font-mono">Req ID: {shortenHash(receipt.requestId, 6)}</div>
              )}
            </div>
          </div>

          <div className="flex flex-col items-start gap-3 border-t border-white/5 pt-4 lg:items-end lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <USDCAmount value={receipt.amountUsdc} size="lg" />
            <Button asChild size="sm" className="rounded-xl bg-primary hover:bg-blue-600 font-semibold text-white">
              <Link href={receipt.links.receipt}>
                Inspect Receipt
                <ArrowRight className="size-4 ml-1" />
              </Link>
            </Button>
          </div>
        </div>

        {receipt.onchainProof?.transactionHash ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/5 p-3 text-xs">
            <div className="flex items-center gap-2">
              <BadgeCheck className="size-4 text-sky-400" />
              <span className="font-mono text-muted-foreground">
                Tx: {shortenHash(receipt.onchainProof.transactionHash)}
              </span>
            </div>
            {receipt.onchainProof.transactionExplorerUrl ? (
              <a
                href={receipt.onchainProof.transactionExplorerUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-cyan-400 hover:underline"
              >
                View on Arc Explorer →
              </a>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

async function ReceiptsContent({
  searchParams,
}: {
  searchParams?: Promise<{ wallet?: string; serviceSlug?: string }>;
}) {
  await connection();
  const params = await searchParams;
  const walletFilter = params?.wallet;
  const serviceSlugFilter = params?.serviceSlug;

  let receipts: CommerceReceipt[] = [];
  let error: string | null = null;

  try {
    receipts = await fetchRecentReceipts({
      limit: 50,
      wallet: walletFilter,
      serviceSlug: serviceSlugFilter,
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  if (error) {
    return (
      <section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <Card className="rounded-2xl border border-destructive/30 bg-destructive/10 p-6 text-sm text-destructive backdrop-blur-xl">
          Unable to load receipts: {error}
        </Card>
      </section>
    );
  }

  if (receipts.length === 0) {
    return (
      <section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <EmptyState
          icon={ReceiptText}
          title="No receipts found"
          description={
            walletFilter || serviceSlugFilter
              ? "No receipts match the specified filter criteria."
              : "No x402 payments have been completed yet."
          }
          action={
            walletFilter || serviceSlugFilter
              ? { label: "Clear filters", href: "/receipts" }
              : { label: "Run Workflow", href: "/agent-runner" }
          }
        />
      </section>
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
      {receipts.map((receipt) => (
        <ReceiptCard key={receipt.id} receipt={receipt} />
      ))}
    </section>
  );
}

function ReceiptsFallback() {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
      <Card className="rounded-2xl border border-white/10 bg-[#090c13]/80 p-6 text-sm text-muted-foreground backdrop-blur-xl">
        Loading receipts...
      </Card>
    </section>
  );
}

export default function ReceiptsPage({ searchParams }: ReceiptsPageProps) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-b border-white/5 bg-gradient-to-b from-[#0a0d15] via-[#080a0f] to-[#07090e] py-12 sm:py-16">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-primary text-xs font-semibold">
                Audit Trail
              </Badge>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-xs text-muted-foreground">
                x402 Micropayment Log
              </Badge>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl gradient-text">
              Commerce Receipts
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Public audit trail and cryptographic evidence log for paid x402 service calls and Arc settlement receipts.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" className="rounded-xl bg-primary hover:bg-blue-600 font-semibold">
              <Link href="/agent-runner">
                <Bot className="size-4 mr-1" />
                Run Workflow
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="rounded-xl border-white/10 bg-white/5 hover:bg-white/10">
              <Link href="/runs">
                <ListChecks className="size-4 mr-1" />
                Runs
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <Suspense fallback={<ReceiptsFallback />}>
        <ReceiptsContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
