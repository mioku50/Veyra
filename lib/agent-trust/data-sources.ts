import type { SupabaseClient } from "@supabase/supabase-js";
import type { GitHubDueDiligenceAssessment } from "../agent/github-due-diligence.ts";
import type { GitHubRepositoryRef } from "../providers/github-repository-ref.ts";
import type { GitHubRepositorySnapshot } from "../providers/github-types.ts";
import { snapshotArcContract } from "./contract.ts";
import { snapshotEndpointAvailability } from "./endpoint.ts";
import { readArcUsdcBlocklistStatus } from "../wallet/arc-usdc.ts";
import type {
  AgentIdentitySnapshot,
  AgentServiceSignal,
  AgentTrustReportInput,
  AgentTrustSourceSnapshots,
  ExecutionHistorySnapshot,
  ServiceSignalsSnapshot,
} from "./types.ts";

type AgentRow = {
  id: string;
  public_id: string;
  display_name: string;
  owner_wallet: string;
  agent_wallet: string | null;
  agent_wallet_status: "unverified" | "verified" | "failed";
  status: "pending" | "active" | "suspended" | "revoked";
  wallet_verified_at: string | null;
  created_at: string;
};

type PolicyRow = {
  allowed_workflows: string[];
  allowed_service_types: string[];
  max_price_per_run_usdc: string;
  daily_spend_limit_usdc: string;
  max_daily_calls: number;
  status: "active" | "paused";
};

type PassportRow = {
  total_workflows: number;
  completed_reports: number;
  successful_calls: number;
  verified_proofs: number;
  workflow_spent_usdc: string;
  downstream_spent_usdc: string;
  success_rate: string;
  last_run_at: string | null;
};

type InternalAgentLookup = {
  snapshot: AgentIdentitySnapshot;
  internalId: string | null;
  ownerWallet: string | null;
  passport: PassportRow | null;
};

function rounded(value: number, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function findAgent(
  client: SupabaseClient,
  input: AgentTrustReportInput,
  requester: { wallet: string | null; agentId: string | null },
  checkedAt: string,
): Promise<InternalAgentLookup> {
  try {
    const [byId, byWallet] = await Promise.all([
      input.agentId
        ? client.from("byoa_agents").select("*").eq("public_id", input.agentId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      input.agentWallet
        ? client.from("byoa_agents").select("*").ilike("agent_wallet", input.agentWallet).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (byId.error || byWallet.error) throw new Error("registry unavailable");
    const idAgent = (byId.data as AgentRow | null) ?? null;
    const walletAgent = (byWallet.data as AgentRow | null) ?? null;
    const identifierConflict = Boolean(
      idAgent && walletAgent && idAgent.id !== walletAgent.id,
    );
    const agent = idAgent ?? walletAgent;
    if (!agent) {
      return {
        internalId: null,
        ownerWallet: null,
        passport: null,
        snapshot: {
          status: "not_found",
          publicAgentId: input.agentId ?? null,
          displayName: null,
          registeredWallet: input.agentWallet ?? null,
          ownerVerified: null,
          agentStatus: "unknown",
          registeredAt: null,
          passportPresent: false,
          activeCredentialCount: null,
          allowedWorkflows: [],
          policy: null,
          identifierConflict: false,
          privateAggregatesAuthorized: false,
          checkedAt,
        },
      };
    }

    const now = new Date().toISOString();
    const [policyResult, passportResult, credentialResult] = await Promise.all([
      client.from("byoa_agent_policies").select([
        "allowed_workflows",
        "allowed_service_types",
        "max_price_per_run_usdc",
        "daily_spend_limit_usdc",
        "max_daily_calls",
        "status",
      ].join(",")).eq("agent_id", agent.id).maybeSingle(),
      client.from("byoa_agent_passports").select([
        "total_workflows",
        "completed_reports",
        "successful_calls",
        "verified_proofs",
        "workflow_spent_usdc",
        "downstream_spent_usdc",
        "success_rate",
        "last_run_at",
      ].join(",")).eq("agent_id", agent.id).maybeSingle(),
      client.from("byoa_agent_credentials")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agent.id)
        .is("revoked_at", null)
        .gt("expires_at", now),
    ]);
    if (policyResult.error || passportResult.error || credentialResult.error) {
      throw new Error("registry details unavailable");
    }
    const policy = (policyResult.data as PolicyRow | null) ?? null;
    const passport = (passportResult.data as PassportRow | null) ?? null;
    const privateAggregatesAuthorized =
      requester.agentId === agent.id ||
      requester.wallet?.toLowerCase() === agent.owner_wallet.toLowerCase();

    return {
      internalId: agent.id,
      ownerWallet: agent.owner_wallet,
      passport,
      snapshot: {
        status: "found",
        publicAgentId: agent.public_id,
        displayName: agent.display_name,
        registeredWallet: agent.agent_wallet,
        ownerVerified:
          agent.agent_wallet_status === "verified" &&
          Boolean(agent.wallet_verified_at),
        agentStatus: agent.status,
        registeredAt: agent.created_at,
        passportPresent: Boolean(passport),
        activeCredentialCount: credentialResult.count ?? 0,
        allowedWorkflows: policy?.allowed_workflows ?? [],
        policy: policy
          ? {
              status: policy.status,
              maxPricePerRunUsdc: String(policy.max_price_per_run_usdc),
              dailySpendLimitUsdc: String(policy.daily_spend_limit_usdc),
              maxDailyCalls: policy.max_daily_calls,
              allowedServiceTypes: policy.allowed_service_types ?? [],
            }
          : null,
        identifierConflict,
        privateAggregatesAuthorized,
        checkedAt,
      },
    };
  } catch {
    return {
      internalId: null,
      ownerWallet: null,
      passport: null,
      snapshot: {
        status: "unavailable",
        publicAgentId: input.agentId ?? null,
        displayName: null,
        registeredWallet: input.agentWallet ?? null,
        ownerVerified: null,
        agentStatus: "unknown",
        registeredAt: null,
        passportPresent: false,
        activeCredentialCount: null,
        allowedWorkflows: [],
        policy: null,
        identifierConflict: false,
        privateAggregatesAuthorized: false,
        checkedAt,
      },
    };
  }
}

async function executionSnapshot(
  client: SupabaseClient,
  lookup: InternalAgentLookup,
  currentJobId: string,
  checkedAt: string,
): Promise<ExecutionHistorySnapshot> {
  if (!lookup.internalId || lookup.snapshot.status !== "found") {
    return {
      status: "insufficient",
      completedRuns: 0,
      completedWithWarnings: null,
      failedRuns: 0,
      successRate: null,
      verifiedRuns: 0,
      verificationCoverage: null,
      totalPaidUsdc: null,
      averageWorkflowCostUsdc: null,
      lastActivityAt: null,
      uniqueWorkflowsUsed: 0,
      sellerServicesUsed: 0,
      receiptsCount: 0,
      checkedAt,
    };
  }

  const passport = lookup.passport;
  if (!lookup.snapshot.privateAggregatesAuthorized) {
    const successfulCalls = passport?.successful_calls ?? 0;
    const verifiedProofs = passport?.verified_proofs ?? 0;
    return {
      status: passport ? "restricted" : "insufficient",
      completedRuns: passport?.completed_reports ?? null,
      completedWithWarnings: null,
      failedRuns: null,
      successRate: safeNumber(passport?.success_rate),
      verifiedRuns: null,
      verificationCoverage:
        successfulCalls > 0
          ? rounded((verifiedProofs / successfulCalls) * 100)
          : null,
      totalPaidUsdc: passport?.workflow_spent_usdc ?? null,
      averageWorkflowCostUsdc:
        passport && passport.completed_reports > 0
          ? rounded(
              Number(passport.workflow_spent_usdc) /
                passport.completed_reports,
              6,
            ).toString()
          : null,
      lastActivityAt: passport?.last_run_at ?? null,
      uniqueWorkflowsUsed: null,
      sellerServicesUsed: null,
      receiptsCount: null,
      checkedAt,
    };
  }

  try {
    const result = await client
      .from("hosted_agent_jobs")
      .select([
        "id",
        "workflow_type",
        "status",
        "structured_result",
        "spent_usdc",
        "user_payment_id",
        "receipt_ids",
        "proof_transaction_hashes",
        "created_at",
        "completed_at",
      ].join(","))
      .eq("byoa_agent_id", lookup.internalId)
      .neq("id", currentJobId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (result.error) throw new Error("execution history unavailable");
    const jobs = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    const userPaymentIds = jobs
      .map((job) => job.user_payment_id)
      .filter((value): value is string => typeof value === "string");
    let grossWorkflowSpend = 0;
    if (userPaymentIds.length > 0) {
      const paymentsResult = await client
        .from("hosted_workflow_user_payments")
        .select("id,gross_amount_usdc,status")
        .in("id", userPaymentIds);
      if (paymentsResult.error) throw new Error("payment history unavailable");
      const payments = (paymentsResult.data ?? []) as unknown as Array<
        Record<string, unknown>
      >;
      grossWorkflowSpend = payments
        .filter((payment) =>
          ["sponsored", "settled"].includes(String(payment.status)),
        )
        .reduce(
          (sum, payment) =>
            sum + (safeNumber(payment.gross_amount_usdc) ?? 0),
          0,
        );
    }
    const completed = jobs.filter((job) => job.status === "completed");
    const failed = jobs.filter((job) => job.status === "failed");
    const completedWithWarnings = completed.filter(
      (job) =>
        Boolean(
          (job.structured_result as Record<string, unknown> | null)
            ?.completedWithWarnings,
        ),
    ).length;
    const verifiedRuns = completed.filter(
      (job) =>
        Array.isArray(job.proof_transaction_hashes) &&
        job.proof_transaction_hashes.length > 0,
    ).length;
    const receiptsCount = jobs.reduce(
      (sum, job) =>
        sum + (Array.isArray(job.receipt_ids) ? job.receipt_ids.length : 0),
      0,
    );
    const terminal = completed.length + failed.length;
    return {
      status: terminal > 0 ? "available" : "insufficient",
      completedRuns: completed.length,
      completedWithWarnings,
      failedRuns: failed.length,
      successRate:
        terminal > 0 ? rounded((completed.length / terminal) * 100) : null,
      verifiedRuns,
      verificationCoverage:
        completed.length > 0
          ? rounded((verifiedRuns / completed.length) * 100)
          : null,
      totalPaidUsdc: rounded(grossWorkflowSpend, 6).toString(),
      averageWorkflowCostUsdc:
        completed.length > 0
          ? rounded(grossWorkflowSpend / completed.length, 6).toString()
          : null,
      lastActivityAt:
        (jobs[0]?.completed_at as string | null | undefined) ??
        (jobs[0]?.created_at as string | null | undefined) ??
        null,
      uniqueWorkflowsUsed: new Set(
        jobs.map((job) => String(job.workflow_type)),
      ).size,
      sellerServicesUsed: new Set(
        jobs
          .map((job) => String(job.workflow_type))
          .filter((workflow) => workflow.startsWith("seller_")),
      ).size,
      receiptsCount,
      checkedAt,
    };
  } catch {
    return {
      status: "unavailable",
      completedRuns: null,
      completedWithWarnings: null,
      failedRuns: null,
      successRate: null,
      verifiedRuns: null,
      verificationCoverage: null,
      totalPaidUsdc: null,
      averageWorkflowCostUsdc: null,
      lastActivityAt: null,
      uniqueWorkflowsUsed: null,
      sellerServicesUsed: null,
      receiptsCount: null,
      checkedAt,
    };
  }
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

async function serviceSnapshot(
  client: SupabaseClient,
  ownerWallet: string | null,
  checkedAt: string,
): Promise<ServiceSignalsSnapshot> {
  if (!ownerWallet) {
    return {
      status: "not_found",
      publishedServiceCount: 0,
      services: [],
      checkedAt,
    };
  }
  try {
    const sellerResult = await client
      .from("seller_accounts")
      .select("id")
      .ilike("owner_wallet", ownerWallet)
      .maybeSingle();
    if (sellerResult.error) throw new Error("seller registry unavailable");
    const sellerId = (sellerResult.data as { id?: string } | null)?.id;
    if (!sellerId) {
      return {
        status: "not_found",
        publishedServiceCount: 0,
        services: [],
        checkedAt,
      };
    }
    const servicesResult = await client
      .from("store_services")
      .select([
        "id",
        "public_id",
        "name",
        "status",
        "service_version",
        "price_usdc",
        "availability_status",
        "last_healthy_at",
        "archived_at",
      ].join(","))
      .eq("seller_id", sellerId)
      .is("archived_at", null)
      .limit(50);
    if (servicesResult.error) throw new Error("seller services unavailable");
    const rows = (servicesResult.data ?? []) as unknown as Array<Record<string, unknown>>;
    const services: AgentServiceSignal[] = [];
    for (const row of rows) {
      const [healthResult, revenueResult] = await Promise.all([
        client
          .from("seller_service_health_checks")
          .select("status,latency_ms,checked_at")
          .eq("service_id", String(row.id))
          .order("checked_at", { ascending: false })
          .limit(50),
        client
          .from("seller_revenue_ledger")
          .select("settlement_status,earned_at,created_at")
          .eq("service_id", String(row.id))
          .limit(200),
      ]);
      const health = healthResult.error
        ? []
        : ((healthResult.data ?? []) as Array<Record<string, unknown>>);
      const revenue = revenueResult.error
        ? []
        : ((revenueResult.data ?? []) as Array<Record<string, unknown>>);
      const successful = revenue.filter((item) =>
        ["earned", "settlement_pending", "settled"].includes(
          String(item.settlement_status),
        ),
      );
      const verifiedSettlements = revenue.filter(
        (item) => item.settlement_status === "settled",
      );
      const failedExecutions = revenue.filter((item) =>
        ["failed", "reversed"].includes(String(item.settlement_status)),
      );
      const latencies = health
        .map((item) => safeNumber(item.latency_ms))
        .filter((item): item is number => item !== null);
      services.push({
        publicId: String(row.public_id),
        name: String(row.name),
        status: String(row.status),
        version: Number(row.service_version),
        priceUsdc: String(row.price_usdc),
        availabilityStatus: String(row.availability_status ?? "unknown"),
        successfulExecutions:
          revenue.length > 0 ? successful.length : null,
        failureRate:
          revenue.length > 0
            ? rounded((failedExecutions.length / revenue.length) * 100)
            : null,
        medianLatencyMs: median(latencies),
        verifiedSettlementCount:
          revenue.length > 0 ? verifiedSettlements.length : null,
        lastSuccessfulExecutionAt:
          (successful
            .map((item) => item.earned_at ?? item.created_at)
            .filter(Boolean)
            .sort()
            .at(-1) as string | undefined) ??
          (row.last_healthy_at as string | null) ??
          null,
        executionHistoryStatus:
          revenue.length > 0 || health.length > 0
            ? "available"
            : "insufficient",
      });
    }
    return {
      status: "available",
      publishedServiceCount: services.length,
      services,
      checkedAt,
    };
  } catch {
    return {
      status: "unavailable",
      publishedServiceCount: 0,
      services: [],
      checkedAt,
    };
  }
}

export async function collectAgentTrustSources(input: {
  client: SupabaseClient;
  reportInput: AgentTrustReportInput;
  reportId: string;
  requesterWallet: string | null;
  requesterAgentId: string | null;
  repository: GitHubRepositoryRef | null;
  githubSnapshot: GitHubRepositorySnapshot | null;
  githubAssessment: GitHubDueDiligenceAssessment | null;
  now?: Date;
}): Promise<AgentTrustSourceSnapshots> {
  const now = input.now ?? new Date();
  const checkedAt = now.toISOString();
  const identityLookup = await findAgent(
    input.client,
    input.reportInput,
    {
      wallet: input.requesterWallet,
      agentId: input.requesterAgentId,
    },
    checkedAt,
  );
  const [execution, services, contract, endpoint] = await Promise.all([
    executionSnapshot(
      input.client,
      identityLookup,
      input.reportId,
      checkedAt,
    ),
    serviceSnapshot(input.client, identityLookup.ownerWallet, checkedAt),
    snapshotArcContract(input.reportInput.contractAddress, undefined, now),
    snapshotEndpointAvailability(
      input.reportInput.serviceEndpoint,
      undefined,
      now,
    ),
  ]);
  const complianceWallet =
    identityLookup.snapshot.registeredWallet ?? input.reportInput.agentWallet ?? null;
  const complianceStatus = complianceWallet
    ? await readArcUsdcBlocklistStatus(complianceWallet)
    : "not_provided";

  return {
    code: {
      status: input.reportInput.repositoryUrl
        ? input.githubSnapshot && input.githubAssessment
          ? "available"
          : "unavailable"
        : "not_provided",
      repository: input.repository,
      snapshot: input.githubSnapshot,
      assessment: input.githubAssessment,
      checkedAt,
    },
    identity: identityLookup.snapshot,
    execution,
    services,
    contract,
    endpoint,
    arcCompliance: {
      status: complianceStatus,
      wallet: complianceWallet,
      source: "Arc USDC onchain blocklist",
      checkedAt,
    },
  };
}
