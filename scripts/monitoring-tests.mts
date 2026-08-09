/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

process.env.NODE_ENV = "test";
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "test-only-webhook-encryption-key";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkProbeSafetyAndBudget,
  clearInMemoryApiQualityAlerts,
  clearInMemoryApiQualityObservations,
  detectQualityDegradationAlerts,
  executeScheduledProbe,
  getInMemoryApiQualityObservations,
  recordApiQualityObservation,
  runScheduledApiQualityProbes,
} from "../lib/providers/api-quality.ts";
import { buildTrustDeltaReport } from "../lib/monitoring/delta.ts";
import {
  buildTrustAlertDrafts,
  buildTrustDelta,
  buildTrustWebhookPayload,
} from "../lib/monitoring/alerts.ts";
import {
  signWebhookPayload,
  validateWebhookEndpoint,
  webhookDeliveryDecision,
} from "../lib/monitoring/webhooks.ts";
import {
  createWebhookSecret,
  decryptWebhookSecret,
  encryptWebhookSecret,
} from "../lib/monitoring/webhook-secret.ts";
import type { AgentTrustReport } from "../lib/agent-trust/types.ts";
import type {
  TrustMonitoringSnapshotRow,
  TrustProfileRow,
} from "../lib/monitoring/types.ts";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function mockTrustReport(input: {
  id: string;
  score: number;
  commits: number;
  security: boolean;
  workflows: number;
  release: string | null;
  agentStatus: "active" | "suspended";
  endpoint: boolean;
  risks?: AgentTrustReport["risksAndReviewItems"];
}): AgentTrustReport {
  const generatedAt = input.id === "before"
    ? "2026-07-20T00:00:00.000Z"
    : "2026-07-30T00:00:00.000Z";
  return {
    kind: "agent_trust_report",
    version: 1,
    workflowType: "agent_trust_report",
    reportId: input.id,
    input: { repositoryUrl: "https://github.com/example/agent", agentId: "agt_0123456789abcdefghij" },
    subject: {
      name: "Example Agent",
      agentId: "agt_0123456789abcdefghij",
      wallet: null,
      repository: {
        owner: "example",
        name: "agent",
        fullName: "example/agent",
        canonicalUrl: "https://github.com/example/agent",
      },
    },
    trustScore: {
      overall: input.score,
      status: input.score >= 70 ? "review_recommended" : "high_attention",
      categories: {},
      excludedCategories: [],
    },
    executiveSummary: [],
    identity: {
      status: "found",
      publicAgentId: "agt_0123456789abcdefghij",
      displayName: "Example Agent",
      registeredWallet: null,
      ownerVerified: true,
      agentStatus: input.agentStatus,
      registeredAt: "2026-01-01T00:00:00.000Z",
      passportPresent: true,
      activeCredentialCount: 1,
      allowedWorkflows: ["agent_trust_report"],
      policy: null,
      identifierConflict: false,
      privateAggregatesAuthorized: false,
      checkedAt: generatedAt,
    },
    codeIntelligence: {
      status: "available",
      repository: {
        owner: "example",
        name: "agent",
        fullName: "example/agent",
        canonicalUrl: "https://github.com/example/agent",
      },
      snapshot: {
        version: 1,
        ref: {
          owner: "example",
          name: "agent",
          fullName: "example/agent",
          canonicalUrl: "https://github.com/example/agent",
        },
        repository: {
          id: 1,
          owner: "example",
          name: "agent",
          fullName: "example/agent",
          description: null,
          isPrivate: false,
          isFork: false,
          isArchived: false,
          defaultBranch: "main",
          starsCount: 1,
          forksCount: 0,
          openIssuesCount: 0,
          watchersCount: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: generatedAt,
          pushedAt: generatedAt,
          license: { key: "mit", name: "MIT", spdxId: "MIT", url: null },
          homepage: null,
          topics: [],
        },
        activity: {
          recentCommitCount: input.commits,
          commitAuthorCount: 4,
          lastCommitAt: generatedAt,
          commitCount30d: input.commits,
          commitCount90d: input.commits,
          commitCount180d: input.commits,
          commitCount30dIsLowerBound: false,
          commitCount90dIsLowerBound: false,
          commitCount180dIsLowerBound: false,
        },
        contributors: {
          sampledCount: 4,
          topContributors: [],
          sampledTopContributorShare: 50,
          sampledHumanContributorCount: 4,
          sampledBotContributorCount: 0,
          topHumanContributorShare: 50,
          botContributionShare: 0,
        },
        releases: {
          totalCount: input.release ? 1 : 0,
          latestRelease: input.release
            ? {
                name: input.release,
                tagName: input.release,
                publishedAt: generatedAt,
                isPrerelease: false,
                body: null,
              }
            : null,
          releaseCount90d: input.release ? 1 : 0,
        },
        collaboration: {
          openIssuesCount: 0,
          hasDiscussions: false,
        },
        documentation: {
          hasReadme: true,
          hasLicense: true,
          hasSecurityPolicy: input.security,
          hasContributing: true,
          hasCodeOfConduct: false,
          readmeSize: 100,
          securityPolicySize: input.security ? 100 : null,
          contributingSize: 100,
        },
        stack: {
          primaryLanguage: "TypeScript",
          languages: { TypeScript: 100 },
          detectedFrameworks: ["Next.js"],
          hasWorkflows: input.workflows > 0,
          workflowCount: input.workflows,
          workflowNames: input.workflows > 0 ? ["CI"] : [],
        },
        dependencyProfile: {
          manifests: ["package.json"],
          productionDependencies: ["next"],
          developmentDependencies: [],
          detectedCapabilities: [],
        },
        excerpts: {
          readmeExcerpt: null,
          securityExcerpt: null,
          contributingExcerpt: null,
        },
        source: {
          fetchedAt: generatedAt,
          cacheHit: false,
          provider: "GitHub REST API v3",
          upstreamStatus: "success",
        },
      },
      assessment: null,
      checkedAt: generatedAt,
    },
    executionReliability: {
      status: "available",
      completedRuns: 10,
      completedWithWarnings: 0,
      failedRuns: 1,
      successRate: 90,
      verifiedRuns: 9,
      verificationCoverage: 90,
      totalPaidUsdc: "0.01",
      averageWorkflowCostUsdc: "0.001",
      lastActivityAt: generatedAt,
      uniqueWorkflowsUsed: 2,
      sellerServicesUsed: 0,
      receiptsCount: 20,
      checkedAt: generatedAt,
    },
    paymentsAndReceipts: {
      status: "available",
      completedRuns: 10,
      completedWithWarnings: 0,
      failedRuns: 1,
      successRate: 90,
      verifiedRuns: 9,
      verificationCoverage: 90,
      totalPaidUsdc: "0.01",
      averageWorkflowCostUsdc: "0.001",
      lastActivityAt: generatedAt,
      uniqueWorkflowsUsed: 2,
      sellerServicesUsed: 0,
      receiptsCount: 20,
      checkedAt: generatedAt,
    },
    services: {
      status: "not_found",
      publishedServiceCount: 0,
      services: [],
      checkedAt: generatedAt,
    },
    contractTransparency: {
      status: "not_provided",
      network: "arc-testnet",
      chainId: 5_042_002,
      address: null,
      hasBytecode: null,
      bytecodeSize: null,
      proxyDetected: null,
      implementationAddress: null,
      adminAddress: null,
      ownerAddress: null,
      pausable: null,
      upgradeable: null,
      verificationStatus: "unavailable",
      recentEventsStatus: "unavailable",
      providerMessage: null,
      checkedAt: generatedAt,
    },
    endpointAvailability: {
      status: input.endpoint ? "available" : "unreachable",
      endpoint: "https://api.example.com/health",
      reachable: input.endpoint,
      httpStatusCategory: input.endpoint ? "2xx" : null,
      responseTimeMs: input.endpoint ? 120 : null,
      contentType: input.endpoint ? "application/json" : null,
      checkedAt: generatedAt,
      redirectCount: 0,
      errorCategory: input.endpoint ? null : "endpoint_unreachable",
    },
    evidenceBackedStrengths: [],
    risksAndReviewItems: input.risks ?? [],
    questionsBeforeIntegration: [],
    evidence: [],
    dataFreshness: [],
    unavailableSources: [],
    limitations: [],
    githubDueDiligenceReportUrl: null,
    verification: {
      status: "verified",
      verifiedOnArc: true,
      network: "arc-testnet",
      chainId: 5_042_002,
      reportHash: `0x${input.id.padEnd(64, "0")}`,
      proofs: [],
    },
    generatedAt,
  };
}

function mockSnapshot(input: {
  id: string;
  sequence: number;
  score: number;
  status?: string;
  verification?: string;
  changes?: Array<Record<string, unknown>>;
}) {
  return {
    id: input.id,
    public_id: `tms_${input.id.padEnd(20, "0").slice(0, 20)}`,
    watchlist_id: "watchlist",
    recheck_id: "recheck",
    job_id: "job",
    sequence_number: input.sequence,
    trust_score: input.score,
    trust_status: input.status ?? "review_recommended",
    report_hash: `0x${"1".repeat(64)}`,
    verification_status: input.verification ?? "verified",
    proof_transaction_hash: `0x${"2".repeat(64)}`,
    report_snapshot: {
      subject: { name: "Example" },
      codeIntelligence: { status: "available" },
      identity: { status: "found" },
      endpointAvailability: { status: "available" },
      services: { status: "available" },
      contractTransparency: { status: "available" },
    },
    delta_snapshot: {
      kind: "trust_delta_report",
      version: 1,
      previousSnapshotId: input.sequence > 1 ? "tms_previous0000000000" : null,
      currentSnapshotId: `tms_${input.id.padEnd(20, "0").slice(0, 20)}`,
      score: {
        before: input.sequence > 1 ? input.score + 3 : null,
        after: input.score,
        change: input.sequence > 1 ? -3 : null,
        direction: input.sequence > 1 ? "declined" : "unavailable",
      },
      summary: {
        newRisks: 0,
        improvements: 0,
        statusChanges: 0,
        activityChanges: 0,
        totalChanges: input.changes?.length ?? 0,
      },
      changes: input.changes ?? [],
      generatedAt: "2026-07-30T17:30:00.000Z",
    },
    observed_at: "2026-07-30T17:30:00.000Z",
    created_at: "2026-07-30T17:30:00.000Z",
  } as unknown as TrustMonitoringSnapshotRow;
}

async function runMonitoringTests() {
  console.log("Starting Independent Monitoring Test Suite (Probes, Watchlists, Alerts, Webhook Leases & Degradation)...");

  // Setup: clear in-memory stores
  clearInMemoryApiQualityObservations();
  clearInMemoryApiQualityAlerts();

  const now = new Date();

  // ----------------------------------------------------
  // Section 1: API Quality Probes & Budget Enforcement
  // ----------------------------------------------------
  console.log("Section 1: API Quality Probes & Budget Enforcement");

  // 1.1 Cooldown guard
  const probeCheck1 = await checkProbeSafetyAndBudget("srv_probe_cd", "availability", { cooldownSeconds: 300 });
  assert.equal(probeCheck1.allowed, false);
  assert.equal(probeCheck1.status, "inactive_skipped");

  await executeScheduledProbe({ serviceId: "srv_probe_cd", probeType: "availability" });

  const probeCheck2 = await checkProbeSafetyAndBudget("srv_probe_cd", "availability", { cooldownSeconds: 300 });
  assert.equal(probeCheck2.allowed, false);
  assert.equal(probeCheck2.status, "inactive_skipped");

  // 1.2 Price limit guard
  const checkPriceLimit = await checkProbeSafetyAndBudget("srv_price_guard", "paid_execution", {
    maxPriceUsdc: 0.05,
  });
  assert.equal(checkPriceLimit.allowed, false);
  assert.equal(checkPriceLimit.status, "inactive_skipped");

  // 1.3 Daily budget guard
  clearInMemoryApiQualityObservations();
  for (let i = 0; i < 50; i++) {
    await recordApiQualityObservation({
      serviceId: "srv_budget_fill",
      startedAt: new Date(now.getTime() - i * 60000).toISOString(),
      completedAt: new Date(now.getTime() - i * 60000 + 100).toISOString(),
      quotedPriceUsdc: 0.1,
      paidAmountUsdc: 0.1,
      latencyMs: 100,
      httpStatusClass: "2xx",
      endpointReached: true,
      responseSchemaValid: true,
      responseWithinSizeLimit: true,
      paymentRequired: true,
      paymentAuthorized: true,
      paymentSettled: true,
      executionCompleted: true,
      arcProofVerified: true,
      errorCategory: "none",
      source: "scheduled_probe",
    });
  }

  const checkDailyBudget = await checkProbeSafetyAndBudget("srv_budget_guard", "paid_execution", {
    maxDailyProbeBudgetUsdc: 4.0, // Spent is 50 * 0.1 = 5.0 USDC > 4.0 USDC
    cooldownSeconds: 0,
    maxPriceUsdc: 1.0,
  });
  assert.equal(checkDailyBudget.allowed, false);
  assert.equal(checkDailyBudget.status, "inactive_skipped");

  // 1.4 Single Scheduled Probe Execution
  const probeExecRes = await executeScheduledProbe({
    serviceId: "srv_single_probe_exec",
    probeType: "availability",
    cooldownSeconds: 0,
  });
  assert.equal(probeExecRes.status, "inactive_skipped");
  assert.equal(probeExecRes.observation, undefined);
  assert.equal(probeExecRes.metricsDelta, undefined);

  // 1.5 Batch Scheduled Probes Runner
  const batchRes = await runScheduledApiQualityProbes({
    serviceIds: ["srv_batch_1", "srv_batch_2"],
    probeType: "availability",
    cooldownSeconds: 0,
  });
  assert.equal(batchRes.totalProbes, 2);
  assert.equal(batchRes.executed, 0);
  assert.equal(batchRes.skipped, 2);

  // ----------------------------------------------------
  // Section 2: Quality Degradation Triggers
  // ----------------------------------------------------
  console.log("Section 2: Quality Degradation Triggers");

  // 2.1 Score Drop Trigger (>= 15 pts)
  const prevScore = { overallScore: 95, availabilityScore: 25, executionReliabilityScore: 20, responseValidityScore: 15, paymentSuccessScore: 15, settlementSuccessScore: 15, latencyConsistencyScore: 10, status: "Excellent" as const, confidenceLevel: "high" as const, hasSufficientData: true };
  const newScore = { overallScore: 70, availabilityScore: 15, executionReliabilityScore: 15, responseValidityScore: 15, paymentSuccessScore: 15, settlementSuccessScore: 10, latencyConsistencyScore: 0, status: "Mixed signals" as const, confidenceLevel: "high" as const, hasSufficientData: true };
  const prevMetrics = { totalObservations: 20, uptimePercent: 100, executionSuccessPercent: 100, paymentSuccessPercent: 100, settlementSuccessPercent: 100, validResponsePercent: 100, latencyP50Ms: 100, latencyP95Ms: 150, latencyMaxMs: 200, quotedPriceMinUsdc: 0.05, quotedPriceMedianUsdc: 0.05, quotedPriceMaxUsdc: 0.05, costPerSuccessfulResultUsdc: 0.05, firstObservedAt: now.toISOString(), lastObservedAt: now.toISOString() };
  const newMetrics = { totalObservations: 21, uptimePercent: 95, executionSuccessPercent: 95, paymentSuccessPercent: 100, settlementSuccessPercent: 100, validResponsePercent: 100, latencyP50Ms: 100, latencyP95Ms: 150, latencyMaxMs: 200, quotedPriceMinUsdc: 0.05, quotedPriceMedianUsdc: 0.05, quotedPriceMaxUsdc: 0.05, costPerSuccessfulResultUsdc: 0.05, firstObservedAt: now.toISOString(), lastObservedAt: now.toISOString() };

  const scoreDropAlerts = detectQualityDegradationAlerts("srv_score_drop", prevScore, newScore, prevMetrics, newMetrics);
  const scoreDrop = scoreDropAlerts.find((a) => a.alertType === "score_drop");
  assert.ok(scoreDrop, "Should trigger score_drop alert when score drops >= 15 pts");
  assert.equal(scoreDrop.severity, "critical");

  // 2.2 Uptime Drop Trigger
  const prevMetricsUptime = { ...prevMetrics, uptimePercent: 100 };
  const newMetricsUptime = { ...newMetrics, uptimePercent: 85 };
  const uptimeAlerts = detectQualityDegradationAlerts("srv_uptime_drop", prevScore, prevScore, prevMetricsUptime, newMetricsUptime);
  const uptimeDrop = uptimeAlerts.find((a) => a.alertType === "uptime_drop");
  assert.ok(uptimeDrop, "Should trigger uptime_drop alert when uptime drops >= 10% below 90%");

  // 2.3 Latency Spike & Execution Failure Spike
  const prevMetricsSpikes = { ...prevMetrics, latencyP95Ms: 200, executionSuccessPercent: 100 };
  const newMetricsSpikes = { ...newMetrics, latencyP95Ms: 550, executionSuccessPercent: 75 };
  const spikeAlerts = detectQualityDegradationAlerts("srv_spikes", prevScore, prevScore, prevMetricsSpikes, newMetricsSpikes);
  const latencySpike = spikeAlerts.find((a) => a.alertType === "latency_spike");
  const execSpike = spikeAlerts.find((a) => a.alertType === "execution_failure_spike");
  assert.ok(latencySpike, "Should trigger latency_spike alert when latency increases 2.5x");
  assert.ok(execSpike, "Should trigger execution_failure_spike alert when execution success drops below 80%");

  // ----------------------------------------------------
  // Section 3: Continuous Trust Monitoring Watchlists & Delta Reports
  // ----------------------------------------------------
  console.log("Section 3: Continuous Trust Monitoring Watchlists & Delta Reports");

  const reportBefore = mockTrustReport({
    id: "before",
    score: 74,
    commits: 294,
    security: true,
    workflows: 0,
    release: null,
    agentStatus: "active",
    endpoint: true,
  });
  const reportAfter = mockTrustReport({
    id: "after",
    score: 63,
    commits: 318,
    security: false,
    workflows: 1,
    release: "v1.2.0",
    agentStatus: "suspended",
    endpoint: false,
    risks: [{
      id: "ev_security",
      category: "code_health",
      signal: "review",
      title: "Security policy",
      detail: "Security policy was removed.",
      source: "GitHub Project Due Diligence",
      observedAt: "2026-07-30T00:00:00.000Z",
    }],
  });

  const deltaReport = buildTrustDeltaReport({
    previous: reportBefore,
    current: reportAfter,
    previousSnapshotId: "tms_before00000000000000",
    currentSnapshotId: "tms_after000000000000000",
    generatedAt: reportAfter.generatedAt,
  });

  assert.deepEqual(deltaReport.score, {
    before: 74,
    after: 63,
    change: -11,
    direction: "declined",
  });
  assert(deltaReport.changes.some((item) => item.code === "github_commits_90d" && item.after === 318));
  assert(deltaReport.changes.some((item) => item.code === "agent_registry_status" && item.severity === "critical"));

  const baselineReport = buildTrustDeltaReport({
    previous: null,
    current: reportBefore,
    previousSnapshotId: null,
    currentSnapshotId: "tms_baseline000000000000",
  });
  assert.equal(baselineReport.changes.length, 0);
  assert.equal(baselineReport.score.direction, "unavailable");

  // Schema & migration verification for watchlists
  const watchlistMigration = read("supabase/migrations/20260730190000_p30_continuous_trust_monitoring.sql");
  assert(watchlistMigration.includes("create table if not exists public.trust_watchlists"));
  assert(watchlistMigration.includes("create table if not exists public.trust_monitoring_snapshots"));
  assert(watchlistMigration.includes("enable row level security"));

  // ----------------------------------------------------
  // Section 4: Alert Generation & Deterministic Drafts
  // ----------------------------------------------------
  console.log("Section 4: Alert Generation & Deterministic Drafts");

  const snapPrev = mockSnapshot({ id: "prev", sequence: 1, score: 76 });
  const snapIdentical = mockSnapshot({ id: "same", sequence: 2, score: 76, changes: [] });
  snapIdentical.delta_snapshot.score = { before: 76, after: 76, change: 0, direction: "unchanged" };
  assert.equal(buildTrustDelta(snapPrev, snapIdentical).meaningful, false);
  assert.equal(buildTrustAlertDrafts(snapPrev, snapIdentical).length, 0);

  const snapThreshold = mockSnapshot({ id: "large", sequence: 2, score: 73 });
  const thresholdEvents = buildTrustAlertDrafts(snapPrev, snapThreshold);
  assert.equal(thresholdEvents.filter((event) => event.type === "trust_score_changed").length, 1);
  assert.deepEqual(
    thresholdEvents.find((event) => event.type === "trust_score_changed")?.change,
    { previous: 76, current: 73, delta: -3 },
  );

  // Fingerprint stability assertion
  const repeatDrafts = buildTrustAlertDrafts(snapPrev, snapThreshold);
  assert.deepEqual(
    repeatDrafts.map((e) => e.fingerprint),
    thresholdEvents.map((e) => e.fingerprint),
    "Repeated alert drafts must generate identical fingerprints",
  );

  // ----------------------------------------------------
  // Section 5: Webhook Lease Recovery & Delivery Management
  // ----------------------------------------------------
  console.log("Section 5: Webhook Lease Recovery & Delivery Management");

  // 5.1 Webhook Payload & Signatures
  const profile = {
    id: "internal-profile-uuid",
    public_id: "vtr_1234567890abcdef1234",
    subject_type: "github_repository",
    display_name: "owner/repository",
  } as TrustProfileRow;

  const webhookPayload = buildTrustWebhookPayload({
    eventId: "evt_1234567890abcdef12345678",
    type: "risk_added",
    createdAt: "2026-07-30T17:30:00.000Z",
    profile,
    report: snapThreshold.report_snapshot,
    snapshot: snapThreshold,
    change: { risk: { riskCode: "missing_license", title: "Missing License", severity: "medium" } },
  });

  const rawBody = JSON.stringify(webhookPayload);
  const timestamp = 1_785_432_600;
  const secret = "vwhsec_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO";
  const signature = signWebhookPayload(secret, timestamp, rawBody);
  assert.equal(
    signature,
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"),
  );

  // 5.2 Secret Encryption
  const generatedSecret = createWebhookSecret();
  assert(generatedSecret.startsWith("vwhsec_"));
  assert.equal(decryptWebhookSecret(encryptWebhookSecret(generatedSecret)), generatedSecret);

  // 5.3 SSRF Validation
  for (const endpoint of [
    "http://example.com/webhook",
    "https://localhost/webhook",
    "https://127.0.0.1/webhook",
    "https://169.254.169.254/latest",
  ]) {
    await assert.rejects(() => validateWebhookEndpoint(endpoint));
  }

  // 5.4 Delivery State Machine
  assert.equal(webhookDeliveryDecision({ attempt: 1, httpStatus: 200 }), "delivered");
  assert.equal(webhookDeliveryDecision({ attempt: 1, httpStatus: 500 }), "retry_scheduled");
  assert.equal(webhookDeliveryDecision({ attempt: 6, failed: true }), "failed");

  // 5.5 Lease Recovery SQL Migration Assertions
  const leaseRecoveryMigration = read("supabase/migrations/20260730235700_recover_webhook_delivery_leases.sql");
  for (const requiredSql of [
    "delivery.status = 'delivering'",
    "delivery.updated_at <= now() - interval '2 minutes'",
    "delivery.attempt_count + 1",
  ]) {
    assert(
      leaseRecoveryMigration.includes(requiredSql),
      `Delivery lease recovery SQL is missing: ${requiredSql}`,
    );
  }

  console.log("\n=======================================================");
  console.log("ALL INDEPENDENT MONITORING TEST SCENARIOS PASSED!");
  console.log("=======================================================");
}

runMonitoringTests().catch((err) => {
  console.error("Monitoring test suite failed:", err);
  process.exit(1);
});
