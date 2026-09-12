/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { redirect } from "next/navigation";
import { HostedAgentRunner } from "./hosted-agent-runner";
import { getHostedRunnerDiagnostic } from "@/lib/agent/hosted-policy";
import { listRecentHostedAgentJobs } from "@/lib/agent/hosted-jobs";
import { parseHostedRunnerQuery } from "@/lib/agent/workflow-links";
import { getHostedWorkflowCheckoutDiagnostic } from "@/lib/agent/workflow-pricing";

export const metadata = {
  title: "Real-Input Hosted Agent Workflows",
  description: "Submit real text to allowlisted multi-service x402 workflows with privacy-safe dynamic reports and verified Arc proofs.",
};

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{
    job?: string | string[];
    workflow?: string | string[];
    symbol?: string | string[];
    repository?: string | string[];
  }>;
};

function recentHistoryWithTimeout() {
  return Promise.race([
    listRecentHostedAgentJobs(8),
    new Promise<Awaited<ReturnType<typeof listRecentHostedAgentJobs>>>((resolve) => {
      setTimeout(() => resolve([]), 3_000);
    }),
  ]).catch(() => []);
}

export default async function AgentRunnerPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const job = Array.isArray(params.job) ? params.job[0] : params.job;
  if (job && /^[0-9a-f-]{36}$/i.test(job)) redirect(`/agent-runner/${job}`);
  const initialSelection = parseHostedRunnerQuery(params);
  const repositoryParam = Array.isArray(params.repository) ? params.repository[0] : params.repository;
  const [diagnostic, history] = await Promise.all([
    Promise.resolve({
      ...getHostedRunnerDiagnostic(),
      checkout: getHostedWorkflowCheckoutDiagnostic(),
    }),
    recentHistoryWithTimeout(),
  ]);
  return (
    <HostedAgentRunner
      diagnostic={diagnostic}
      initialHistory={history}
      initialWorkflowType={initialSelection.workflowType}
      initialMarketSymbol={initialSelection.marketSymbol}
      initialRepository={repositoryParam}
    />
  );
}
