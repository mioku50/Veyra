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

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, CircleDollarSign } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  serviceRegistry,
  type ApiService,
  type ServiceSourceType,
  type ServiceStatus,
} from "@/lib/services/registry";
import { getStoreServiceBySlug } from "@/lib/services/store-service-persistence";

export const dynamic = "force-dynamic";

type ServiceDetailPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

const statusLabels: Record<ServiceStatus, string> = {
  draft: "Draft",
  verifying: "Verifying",
  live: "Live",
  mock: "Mock",
  "coming-soon": "Coming soon",
  disabled: "Disabled",
};

const sourceLabels: Record<ServiceSourceType, string> = {
  static: "Internal deterministic",
  provider_backed: "Live Provider",
  seller_mock: "Seller-created mock",
  external_placeholder: "Seller-created placeholder",
  external_seller: "External Seller API",
};

function getPublicBaseUrl() {
  const configuredUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL;

  if (configuredUrl) return configuredUrl.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;

  return "https://YOUR_DOMAIN";
}

function buildCurlExample(service: ApiService) {
  const url = `${getPublicBaseUrl()}${service.endpoint}`;

  if (service.method === "POST") {
    const request = service.exampleRequest as { body?: unknown };
    const body = JSON.stringify(request.body ?? {}, null, 2);

    return `curl -i -X POST ${url} \\
  -H 'Content-Type: application/json' \\
  -d '${body}'`;
  }

  return `curl -i ${url}`;
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="text-sm font-semibold uppercase text-muted-foreground">
        {title}
      </h2>
      <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs leading-5">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}

export function generateStaticParams() {
  return serviceRegistry.map((service) => ({ slug: service.slug }));
}

export async function generateMetadata({
  params,
}: ServiceDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const service = await getStoreServiceBySlug(slug);

  if (!service) {
    return {
      title: "API Service",
    };
  }

  return {
    title: `${service.name} | API Store`,
    description: service.shortDescription,
  };
}

export default async function ServiceDetailPage({
  params,
}: ServiceDetailPageProps) {
  const { slug } = await params;
  const service = await getStoreServiceBySlug(slug);

  if (!service) notFound();

  const curlExample = buildCurlExample(service);
  const isLive = service.status === "live";
  const isSellerMock = service.sourceType === "seller_mock";
  const isExternalPlaceholder = service.sourceType === "external_placeholder";
  const isCallable = isLive && !isExternalPlaceholder;

  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
          <Button asChild variant="ghost" className="mb-8 px-0">
            <Link href="/store">
              <ArrowLeft />
              Back to API Store
            </Link>
          </Button>

          <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
            <div>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{service.category}</Badge>
                <Badge variant={isLive ? "default" : "outline"}>
                  {statusLabels[service.status]}
                </Badge>
                <Badge variant={service.isPaid ? "secondary" : "outline"}>
                  {service.isPaid ? "Paid API" : "Free"}
                </Badge>
                <Badge variant={service.sourceType === "static" ? "outline" : "secondary"}>
                  {sourceLabels[service.sourceType]}
                </Badge>
              </div>
              <h1 className="text-4xl font-bold tracking-normal text-foreground sm:text-5xl">
                {service.name}
              </h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-muted-foreground">
                {service.longDescription}
              </p>
            </div>

            <aside className="rounded-lg border bg-background p-5">
              <div className="flex items-center gap-2 font-semibold">
                <CircleDollarSign className="size-5 text-primary" />
                Service terms
              </div>
              <dl className="mt-5 grid gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Price</dt>
                  <dd className="font-mono">{service.priceLabel}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Method</dt>
                  <dd className="font-mono">{service.method}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Endpoint</dt>
                  <dd className="break-all font-mono">{service.endpoint}</dd>
                </div>
              </dl>
              <div className="mt-5 flex flex-col gap-2">
                <CopyButton value={service.endpoint} label="Copy endpoint" />
                {isCallable ? (
                  <Button asChild variant="outline">
                    <Link href={service.endpoint}>
                      Open endpoint
                      <ArrowUpRight />
                    </Link>
                  </Button>
                ) : (
                  <Button disabled variant="outline">
                    {isExternalPlaceholder ? "External fulfillment disabled" : "Planned service"}
                  </Button>
                )}
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6 lg:grid-cols-[1fr_1fr]">
        <section className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground">
            Example use case
          </h2>
          <p className="mt-3 leading-7">{service.exampleUseCase}</p>
        </section>

        <section className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground">
            Agent reasoning hint
          </h2>
          <p className="mt-3 leading-7">{service.agentReasoningHint}</p>
        </section>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-8 sm:px-6">
        <section className="rounded-lg border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase text-muted-foreground">
                cURL example
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {isCallable
                  ? "Unpaid direct requests to live paid services return HTTP 402 until an agent satisfies the x402 payment requirement."
                  : "This service is visible for discovery, but paid fulfillment is not enabled."}
              </p>
            </div>
            <CopyButton value={curlExample} label="Copy cURL" />
          </div>
          {isCallable ? (
            <pre className="mt-4 overflow-auto rounded-md bg-muted p-4 text-xs leading-5">
              {curlExample}
            </pre>
          ) : isExternalPlaceholder ? (
            <p className="mt-4 rounded-md bg-muted p-4 text-sm text-muted-foreground">
              External fulfillment is not enabled in this MVP. The listing is
              discoverable, but the app does not proxy arbitrary external APIs.
            </p>
          ) : (
            <p className="mt-4 rounded-md bg-muted p-4 text-sm text-muted-foreground">
              This service is planned for a future phase.
            </p>
          )}
        </section>
      </section>

      {isSellerMock ? (
        <section className="mx-auto w-full max-w-6xl px-4 pb-8 sm:px-6">
          <section className="rounded-lg border bg-card p-5">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">
              Seller-created demo service
            </h2>
            <p className="mt-3 leading-7 text-muted-foreground">
              This service uses legacy protected mock fulfillment. The paid
              response is served from stored seller metadata, so no arbitrary
              external API proxying is involved.
            </p>
          </section>
        </section>
      ) : null}

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 pb-16 sm:px-6 lg:grid-cols-2">
        <JsonPanel title="Input schema" value={service.inputSchema} />
        <JsonPanel title="Output schema" value={service.outputSchema} />
        <JsonPanel title="Example request" value={service.exampleRequest} />
        <JsonPanel title="Example response" value={service.exampleResponse} />
      </section>
    </main>
  );
}
