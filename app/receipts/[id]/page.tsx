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
import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import {
  ArrowLeft,
  BadgeCheck,
  ExternalLink,
  ListChecks,
  ReceiptText,
  ShieldCheck,
  Store,
} from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fetchReceiptById,
  type CommerceReceipt,
} from "@/lib/commerce/receipts";
import { shortenHash } from "@/lib/utils";
import { ProviderResponseDetails } from "@/components/services/provider-response-details";

type ReceiptDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export const metadata = {
  title: "Commerce Receipt",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function JsonPreview({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <p className="mt-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">
        No safe response preview was recorded for this receipt.
      </p>
    );
  }

  return (
    <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-muted p-4 text-xs leading-5">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function onchainStatusLabel(receipt: CommerceReceipt) {
  if (receipt.onchainProof?.status === "verified") return "Verified on Arc";
  if (receipt.onchainProof?.status === "pending") return "Onchain proof pending";
  if (receipt.onchainProof?.status === "failed") return "Proof failed";
  return "Onchain unavailable";
}

async function getReceiptUrl(id: string) {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "http";

  return host ? `${proto}://${host}/receipts/${id}` : `/receipts/${id}`;
}

function ReceiptSummary({
  receipt,
  receiptUrl,
}: {
  receipt: CommerceReceipt;
  receiptUrl: string;
}) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant="default">x402 paid</Badge>
          <Badge
            variant={
              receipt.serviceSourceType === "seller_mock" ? "secondary" : "outline"
            }
          >
            {receipt.sourceLabel}
          </Badge>
          <Badge variant={receipt.paymentEvent ? "default" : "outline"}>
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
          >
            {onchainStatusLabel(receipt)}
          </Badge>
        </div>
        <CardTitle className="flex items-center gap-2 text-3xl">
          <ReceiptText className="size-7 text-primary" />
          Commerce Receipt
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {formatDate(receipt.createdAt)}
        </p>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="font-mono text-lg">{receipt.amountUsdc} USDC</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Service</dt>
            <dd className="font-medium">{receipt.serviceName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Method</dt>
            <dd className="font-mono">{receipt.method ?? "n/a"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Run status</dt>
            <dd>{receipt.runStatus ?? "n/a"}</dd>
          </div>
        </dl>

        <div>
          <p className="text-sm text-muted-foreground">Receipt URL</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-md bg-muted px-2 py-1 text-xs">
              {receiptUrl}
            </code>
            <CopyButton value={receiptUrl} label="Copy URL" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ReceiptLinks({ receipt }: { receipt: CommerceReceipt }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <ShieldCheck className="size-5" />
          Audit links
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Button asChild variant="outline">
          <Link href={receipt.links.run}>
            <ListChecks />
            Open run timeline
          </Link>
        </Button>
        {receipt.links.agent ? (
          <Button asChild variant="outline">
            <Link href={receipt.links.agent}>
              <BadgeCheck />
              Agent Passport
            </Link>
          </Button>
        ) : null}
        {receipt.links.service ? (
          <Button asChild variant="outline">
            <Link href={receipt.links.service}>
              <Store />
              Service detail
            </Link>
          </Button>
        ) : null}
        {receipt.paymentEvent ? (
          <Button asChild variant="outline">
            <Link href="/dashboard">
              <ExternalLink />
              Seller Dashboard
            </Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MetadataCard({ receipt }: { receipt: CommerceReceipt }) {
  const paymentEventId =
    receipt.paymentEventId ?? receipt.matchedPaymentEventId ?? null;

  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl">Purchase metadata</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Buyer wallet</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono">
              {receipt.buyerWallet ? (
                <>
                  <Link
                    href={`/agents/${receipt.buyerWallet}`}
                    className="break-all text-primary hover:underline"
                  >
                    {receipt.buyerWallet}
                  </Link>
                  <CopyButton
                    value={receipt.buyerWallet}
                    label="Copy wallet"
                    size="sm"
                  />
                </>
              ) : (
                "n/a"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Request ID</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono">
              {receipt.requestId ? (
                <>
                  <span className="break-all">{receipt.requestId}</span>
                  <CopyButton
                    value={receipt.requestId}
                    label="Copy request"
                    size="sm"
                  />
                </>
              ) : (
                "n/a"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Endpoint</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono">
              {receipt.endpoint ? (
                <>
                  <span className="break-all">{receipt.endpoint}</span>
                  <CopyButton
                    value={receipt.endpoint}
                    label="Copy endpoint"
                    size="sm"
                  />
                </>
              ) : (
                "n/a"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Payment event</dt>
            <dd className="mt-1 font-mono">
              {paymentEventId ? shortenHash(paymentEventId, 8) : "n/a"}
            </dd>
          </div>
        </dl>

        {receipt.paymentEvent ? (
          <div className="rounded-lg border p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="default">Payment event matched</Badge>
              <Badge variant="outline">{receipt.paymentEvent.network}</Badge>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Event ID</dt>
                <dd className="break-all font-mono">{receipt.paymentEvent.id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-mono">
                  {receipt.paymentEvent.amountUsdc} USDC
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Gateway tx</dt>
                <dd className="break-all font-mono">
                  {receipt.paymentEvent.gatewayTx ?? "n/a"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Timestamp</dt>
                <dd>{formatDate(receipt.paymentEvent.createdAt)}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
            Payment event unavailable. The purchase step is paid, but no
            matching payment event could be safely linked by endpoint, buyer
            wallet, amount, and timestamp.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ResponseCard({ receipt }: { receipt: CommerceReceipt }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-xl">Safe response preview</CardTitle>
          {receipt.responsePreview ? (
            <CopyButton
              value={JSON.stringify(receipt.responsePreview, null, 2)}
              label="Copy preview"
            />
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-5"><ProviderResponseDetails value={receipt.responsePreview} /></div>
        <JsonPreview value={receipt.responsePreview} />
        {receipt.reasoning ? (
          <div className="mt-5 border-t pt-5">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">
              Agent reasoning
            </h2>
            <p className="mt-2 leading-7">{receipt.reasoning}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OnchainProofCard({ receipt }: { receipt: CommerceReceipt }) {
  const proof = receipt.onchainProof;

  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-xl">
            <ShieldCheck className="size-5" />
            Onchain proof
          </CardTitle>
          <Badge
            variant={
              proof?.status === "verified"
                ? "default"
                : proof?.status === "failed"
                  ? "destructive"
                  : "outline"
            }
          >
            {onchainStatusLabel(receipt)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {!proof ? (
          <p className="text-sm leading-6 text-muted-foreground">
            This legacy receipt does not have onchain proof metadata.
          </p>
        ) : (
          <>
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Chain ID</dt>
                <dd className="font-mono">{proof.chainId ?? "n/a"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Receipt hash</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono">
                  <span className="break-all">{proof.receiptHash ?? "n/a"}</span>
                  {proof.receiptHash ? (
                    <CopyButton
                      value={proof.receiptHash}
                      label="Copy receipt hash"
                      size="sm"
                    />
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Proof ID</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono">
                  <span className="break-all">{proof.proofId ?? "n/a"}</span>
                  {proof.proofId ? (
                    <CopyButton value={proof.proofId} label="Copy proof ID" size="sm" />
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Block number</dt>
                <dd className="font-mono">{proof.blockNumber ?? "n/a"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Attester</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono">
                  <span className="break-all">{proof.attester ?? "n/a"}</span>
                  {proof.attester ? (
                    <CopyButton value={proof.attester} label="Copy attester" size="sm" />
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Verified at</dt>
                <dd>{proof.verifiedAt ? formatDate(proof.verifiedAt) : "n/a"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Attempts</dt>
                <dd className="font-mono">{proof.attemptCount}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Contract address</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono">
                  {proof.contractExplorerUrl && proof.contractAddress ? (
                    <a
                      href={proof.contractExplorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-primary hover:underline"
                    >
                      {proof.contractAddress}
                    </a>
                  ) : (
                    "n/a"
                  )}
                  {proof.contractAddress ? (
                    <CopyButton
                      value={proof.contractAddress}
                      label="Copy contract"
                      size="sm"
                    />
                  ) : null}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Transaction hash</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono">
                  {proof.transactionExplorerUrl && proof.transactionHash ? (
                    <a
                      href={proof.transactionExplorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-primary hover:underline"
                    >
                      {proof.transactionHash}
                    </a>
                  ) : (
                    "n/a"
                  )}
                  {proof.transactionHash ? (
                    <CopyButton
                      value={proof.transactionHash}
                      label="Copy transaction"
                      size="sm"
                    />
                  ) : null}
                </dd>
              </div>
            </dl>

            {proof.transactionExplorerUrl ? (
              <Button asChild variant="outline" className="w-fit">
                <a
                  href={proof.transactionExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink />
                  View on Arcscan
                </a>
              </Button>
            ) : null}
            {proof.status === "failed" && proof.error ? (
              <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {proof.error}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

async function ReceiptDetail({ params }: ReceiptDetailPageProps) {
  await connection();
  const { id } = await params;
  const [receipt, receiptUrl] = await Promise.all([
    fetchReceiptById(id).catch(() => null),
    getReceiptUrl(id),
  ]);

  if (!receipt) notFound();

  return (
    <>
      <section className="border-b bg-secondary/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <Button asChild variant="ghost" className="mb-6 px-0">
            <Link href="/receipts">
              <ArrowLeft />
              Back to Receipts
            </Link>
          </Button>
          <ReceiptSummary receipt={receipt} receiptUrl={receiptUrl} />
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6 lg:grid-cols-[1fr_320px]">
        <div className="grid gap-4">
          <MetadataCard receipt={receipt} />
          <OnchainProofCard receipt={receipt} />
          <ResponseCard receipt={receipt} />
        </div>
        <ReceiptLinks receipt={receipt} />
      </section>
    </>
  );
}

function ReceiptDetailFallback() {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6">
      <Card className="rounded-lg">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading commerce receipt...
        </CardContent>
      </Card>
    </section>
  );
}

export default function ReceiptDetailPage({ params }: ReceiptDetailPageProps) {
  return (
    <main className="min-h-screen bg-background">
      <Suspense fallback={<ReceiptDetailFallback />}>
        <ReceiptDetail params={params} />
      </Suspense>
    </main>
  );
}
