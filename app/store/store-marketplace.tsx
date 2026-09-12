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

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  ClipboardCheck,
  Database,
  FileJson,
  Fuel,
  PlusCircle,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyButton } from "@/components/copy-button";
import { BRAND } from "@/lib/brand";
import type {
  ApiService,
  ServiceMethod,
  ServiceSourceType,
  ServiceStatus,
} from "@/lib/services/registry";

const statusLabels: Record<ServiceStatus, string> = {
  draft: "Draft",
  verifying: "Verifying",
  live: "Live",
  mock: "Mock",
  "coming-soon": "Coming soon",
  disabled: "Disabled",
};

const methodLabels: Record<ServiceMethod, string> = {
  GET: "GET",
  POST: "POST",
};

const sourceLabels: Record<ServiceSourceType, string> = {
  static: "Internal deterministic",
  provider_backed: "Live Provider",
  seller_mock: "Seller-created mock",
  external_placeholder: "Seller-created placeholder",
  external_seller: "External Seller API",
};

const howItWorks = [
  "Agent discovers service",
  "Endpoint returns HTTP 402 payment requirement",
  "Agent pays with USDC on Arc through x402",
  "API returns the protected response",
];

type StoreMarketplaceProps = {
  services: readonly ApiService[];
  categories: readonly string[];
  warning?: string | null;
};

export function StoreMarketplace({
  services,
  categories,
  warning,
}: StoreMarketplaceProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [method, setMethod] = useState("all");
  const [source, setSource] = useState("all");

  const filteredServices = useMemo(() => {
    const query = search.trim().toLowerCase();

    return services.filter((service) => {
      const matchesSearch =
        query.length === 0 ||
        service.name.toLowerCase().includes(query) ||
        service.shortDescription.toLowerCase().includes(query) ||
        service.longDescription.toLowerCase().includes(query) ||
        service.endpoint.toLowerCase().includes(query) ||
        service.category.toLowerCase().includes(query);

      return (
        matchesSearch &&
        (category === "all" || service.category === category) &&
        (status === "all" || service.status === status) &&
        (method === "all" || service.method === method) &&
        (source === "all" ||
          (source === "official" && service.sourceType === "static") ||
          (source === "provider" && service.sourceType === "provider_backed") ||
          (source === "seller" && (service.sourceType === "seller_mock" || service.sourceType === "external_placeholder")))
      );
    });
  }, [category, method, search, services, source, status]);

  const discoveryPreview = {
    services: services.slice(0, 3).map((service) => ({
      slug: service.slug,
      method: service.method,
      endpoint: service.endpoint,
      price: service.priceLabel,
      status: service.status,
      sourceType: service.sourceType,
    })),
  };

  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/30">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6 lg:py-16">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{BRAND.name}</Badge>
            <Badge variant="outline">Developer service catalog</Badge>
          </div>
          <div className="grid gap-6 lg:grid-cols-[1fr_320px] lg:items-end">
            <div>
              <h1 className="text-4xl font-bold tracking-normal text-foreground sm:text-5xl">
                API Store · Developer Tool
              </h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-muted-foreground">
                Inspect the allowlisted x402-powered APIs used by hosted
                workflows, plus safe seller-created service listings.
              </p>
              <p className="mt-4 max-w-3xl leading-7 text-muted-foreground">
                Each live service returns HTTP 402 until an agent pays the
                required USDC amount through x402 and Circle Gateway.
              </p>
            </div>
            <div className="grid gap-4">
              <div className="rounded-lg border bg-background p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="size-4 text-primary" />
                  Workflow service layer
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Services</dt>
                    <dd className="font-mono text-lg">{services.length}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Seller-created</dt>
                    <dd className="font-mono text-lg">
                      {services.filter((service) => service.sourceType === "seller_mock" || service.sourceType === "external_placeholder").length}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-col gap-2">
                  <Button asChild size="sm">
                    <Link href="/review">
                      <ClipboardCheck />
                      Review Pack
                    </Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href="/demo">
                      <Sparkles />
                      Start guided demo
                    </Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href="/launch">
                      <Rocket />
                      Launch Pack
                    </Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href="/developer-tools">
                      <Fuel />
                      Developer Tools
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/seller">
                      <PlusCircle />
                      Become a seller
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        {warning ? (
          <p className="mb-4 rounded-lg border bg-card p-3 text-sm text-muted-foreground">
            {warning}
          </p>
        ) : null}
        <div className="grid gap-3 rounded-lg border bg-card p-4 lg:grid-cols-[1fr_170px_150px_140px_160px]">
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search services, endpoints, or categories"
              className="pl-9"
            />
          </label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="live">Live</SelectItem>
              <SelectItem value="mock">Mock</SelectItem>
              <SelectItem value="coming-soon">Coming soon</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Method" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All methods</SelectItem>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="official">Internal deterministic</SelectItem>
              <SelectItem value="provider">Live Provider</SelectItem>
              <SelectItem value="seller">Seller-created</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 pb-10 sm:px-6 lg:grid-cols-2">
        {filteredServices.map((service) => (
          <Card key={service.id} className="flex flex-col rounded-lg shadow-sm">
            <CardHeader>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{service.category}</Badge>
                <Badge variant={service.status === "live" ? "default" : "outline"}>
                  {statusLabels[service.status]}
                </Badge>
                <Badge variant={service.status === "coming-soon" ? "outline" : "secondary"}>
                  {service.status === "coming-soon" ? "Coming soon" : "Paid API"}
                </Badge>
                <Badge variant={service.sourceType === "static" ? "outline" : "secondary"}>
                  {sourceLabels[service.sourceType]}
                </Badge>
              </div>
              <CardTitle className="text-xl">{service.name}</CardTitle>
              <p className="text-sm leading-6 text-muted-foreground">
                {service.shortDescription}
              </p>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-5">
              <dl className="grid gap-3 text-sm">
                <div className="grid gap-1 sm:grid-cols-[90px_1fr]">
                  <dt className="font-semibold text-muted-foreground">Method</dt>
                  <dd className="font-mono">{methodLabels[service.method]}</dd>
                </div>
                <div className="grid gap-1 sm:grid-cols-[90px_1fr]">
                  <dt className="font-semibold text-muted-foreground">Endpoint</dt>
                  <dd className="break-all font-mono">{service.endpoint}</dd>
                </div>
                <div className="grid gap-1 sm:grid-cols-[90px_1fr]">
                  <dt className="font-semibold text-muted-foreground">Price</dt>
                  <dd className="font-mono">{service.priceLabel}</dd>
                </div>
              </dl>
              <div className="mt-auto flex flex-col gap-2 border-t pt-4 sm:flex-row">
                <Button asChild className="flex-1">
                  <Link href={`/store/${service.slug}`}>
                    View details
                    <ArrowRight />
                  </Link>
                </Button>
                <CopyButton
                  value={service.endpoint}
                  label="Copy endpoint"
                  className="sm:w-auto"
                />
              </div>
            </CardContent>
          </Card>
        ))}
        {filteredServices.length === 0 ? (
          <Card className="rounded-lg lg:col-span-2">
            <CardContent className="p-6 text-sm text-muted-foreground">
              No services match the current filters.
            </CardContent>
          </Card>
        ) : null}
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 pb-16 sm:px-6 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-2">
            <Database className="size-5 text-primary" />
            <h2 className="text-xl font-semibold">How It Works</h2>
          </div>
          <ol className="mt-6 grid gap-3">
            {howItWorks.map((step, index) => (
              <li key={step} className="flex gap-3 text-sm leading-6">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs text-secondary-foreground">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="rounded-lg border bg-card p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileJson className="size-5 text-primary" />
                <h2 className="text-xl font-semibold">
                  Machine-readable service discovery
                </h2>
              </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/review">
                  <ClipboardCheck />
                  Review pack
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/demo">
                  <Sparkles />
                  Guided demo
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/runs">See agent purchase timelines</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/agents">
                  <BadgeCheck />
                  Agent Passports
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/developer-tools">
                  <Fuel />
                  Developer Tools
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/seller">Create service</Link>
              </Button>
              <CopyButton value="/api/store/services" label="Copy URL" />
            </div>
            </div>
          <p className="mt-4 font-mono text-sm text-primary">
            GET /api/store/services
          </p>
          <pre className="mt-4 max-h-72 overflow-auto rounded-md bg-muted p-4 text-xs leading-5">
            {JSON.stringify(discoveryPreview, null, 2)}
          </pre>
        </div>
      </section>
    </main>
  );
}
