/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { notFound } from "next/navigation";
import { HostedJobResult } from "../hosted-job-result";
import { getHostedAgentJobView, redactPublicSellerAccounting } from "@/lib/agent/hosted-jobs";
import { isByoaHostedJob } from "@/lib/byoa/service";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ jobId: string }> };

export default async function HostedJobResultPage({ params }: PageProps) {
  const { jobId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) notFound();
  if (await isByoaHostedJob(jobId).catch(() => true)) notFound();
  const view = await getHostedAgentJobView(jobId).catch(() => null);
  if (!view) notFound();
  return <HostedJobResult initialView={redactPublicSellerAccounting(view)} />;
}
