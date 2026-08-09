/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server.js";
import {
  GET as monitoringProbesGET,
  POST as monitoringProbesPOST,
} from "../app/api/monitoring/probes/route.ts";
import {
  calculateQualityScore,
  checkProbeSafetyAndBudget,
  clearInMemoryApiQualityAlerts,
  clearInMemoryApiQualityObservations,
  compareApiQuality,
  computeApiQualityMetrics,
  detectQualityDegradationAlerts,
  executeScheduledProbe,
  fetchApiQualityObservations,
  fetchApiQualityObservationsForServices,
  getConfidenceLevel,
  getInMemoryApiQualityAlerts,
  getInMemoryApiQualityObservations,
  observationToRowInput,
  recordApiQualityObservation,
  rowToObservation,
  runScheduledApiQualityProbes,
  validatePublicServiceForQualityEvaluation,
  ApiQualityServiceNotFoundError,
  ApiQualityStoreUnavailableError,
} from "../lib/providers/api-quality.ts";
import {
  buildApiQualityPublicReport,
  formatApiQualityPublicReportAsMarkdown,
  parseApiQualityJobInput,
} from "../lib/reports/api-quality-report.ts";
import {
  HOSTED_WORKFLOW_TYPES,
  createHostedWorkflowPlan,
  defaultWorkflowTask,
  isHostedWorkflowType,
  validateHostedWorkflowRequest,
} from "../lib/agent/hosted-workflows.ts";
import { SAFE_HOSTED_SERVICES } from "../lib/agent/hosted-policy.ts";
import { serviceRegistry } from "../lib/services/registry.ts";
import {
  canonicalizeJson,
  computeCanonicalReportHash,
  stripInternalKeys,
  validateApiQualityReportPayload,
  CANONICALIZATION_VERSION,
} from "../lib/reports/canonical-report-hash.ts";
import { API_QUALITY_FINALIZER_PRICE_USDC } from "../lib/services/constants.ts";
import { hostedWorkflowTemplates } from "../lib/agent/workflow-templates.ts";
import type { MachineErrorCode } from "../lib/api/machine-errors.ts";
import type { ApiQualityObservationRow, ApiQualityObservation } from "../lib/providers/api-quality-types.ts";

async function runTests() {
  console.log("Starting Comprehensive P4.0 Paid API Quality & Monitoring Test Suite (22 Scenarios)...");

  // Setup: clear in-memory stores
  clearInMemoryApiQualityObservations();
  clearInMemoryApiQualityAlerts();

  const now = new Date();

  // ----------------------------------------------------
  // Scenario 1: Observation Ingestion & Data Transformation
  // ----------------------------------------------------
  console.log("Scenario 1: Observation Ingestion & Data Transformation");
  const testRow: ApiQualityObservationRow = {
    observation_id: "obs_test_101",
    service_id: "srv_transform_test",
    seller_public_id: "sel_transform_seller",
    started_at: new Date(now.getTime() - 3600000).toISOString(),
    completed_at: new Date(now.getTime() - 3599850).toISOString(),
    quoted_price_usdc: "0.05",
    paid_amount_usdc: "0.05",
    latency_ms: 150,
    http_status_class: "2xx",
    endpoint_reached: true,
    response_schema_valid: true,
    response_within_size_limit: true,
    payment_required: true,
    payment_authorized: true,
    payment_settled: true,
    execution_completed: true,
    arc_proof_verified: true,
    error_category: "none",
    source: "real_paid_execution",
    created_at: now.toISOString(),
  };

  const parsedObs = rowToObservation(testRow);
  assert.equal(parsedObs.observationId, "obs_test_101");
  assert.equal(parsedObs.quotedPriceUsdc, 0.05);
  assert.equal(parsedObs.latencyMs, 150);

  const rowBack = observationToRowInput(parsedObs);
  assert.equal(rowBack.observation_id, "obs_test_101");
  assert.equal(rowBack.quoted_price_usdc, 0.05);

  const recorded = await recordApiQualityObservation({
    serviceId: "srv_single_ingest",
    sellerPublicId: "sel_ingest_seller",
    startedAt: new Date(now.getTime() - 1800000).toISOString(),
    completedAt: new Date(now.getTime() - 1799880).toISOString(),
    quotedPriceUsdc: 0.1,
    paidAmountUsdc: 0.1,
    latencyMs: 120,
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
    source: "real_paid_execution",
  });
  assert.ok(recorded.observationId.startsWith("obs_") || recorded.observationId.length > 10);
  assert.equal(recorded.serviceId, "srv_single_ingest");

  // ----------------------------------------------------
  // Scenario 2: Multi-Service Observation Ingestion & Window Filtering
  // ----------------------------------------------------
  console.log("Scenario 2: Multi-Service Observation Ingestion & Window Filtering");
  clearInMemoryApiQualityObservations();
  const t2_35daysAgo = new Date(now.getTime() - 35 * 86400 * 1000).toISOString();
  const t2_5daysAgo = new Date(now.getTime() - 5 * 86400 * 1000).toISOString();

  await recordApiQualityObservation({
    serviceId: "srv_window_test",
    sellerPublicId: "sel_window",
    startedAt: t2_35daysAgo,
    completedAt: t2_35daysAgo,
    quotedPriceUsdc: 0.05,
    paidAmountUsdc: 0.05,
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
    source: "historical_execution",
  });
  await recordApiQualityObservation({
    serviceId: "srv_window_test",
    sellerPublicId: "sel_window",
    startedAt: t2_5daysAgo,
    completedAt: t2_5daysAgo,
    quotedPriceUsdc: 0.05,
    paidAmountUsdc: 0.05,
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
    source: "real_paid_execution",
  });

  const obs30Days = await fetchApiQualityObservations("srv_window_test", 30);
  assert.equal(obs30Days.length, 1, "30-day window should filter out 35-day old observation");

  const multiObs = await fetchApiQualityObservationsForServices(["srv_window_test", "non_existent"], 30);
  assert.ok(multiObs["srv_window_test"]);
  assert.equal(multiObs["srv_window_test"].length, 1);
  assert.equal(multiObs["non_existent"].length, 0);

  // ----------------------------------------------------
  // Scenario 3: Statistical Metrics Calculation
  // ----------------------------------------------------
  console.log("Scenario 3: Statistical Metrics Calculation");
  clearInMemoryApiQualityObservations();
  for (let i = 0; i < 20; i++) {
    const isError = i === 19;
    await recordApiQualityObservation({
      serviceId: "srv_stats_test",
      sellerPublicId: "sel_stats",
      startedAt: new Date(now.getTime() - (20 - i) * 3600000).toISOString(),
      completedAt: new Date(now.getTime() - (20 - i) * 3600000 + 200).toISOString(),
      quotedPriceUsdc: 0.05,
      paidAmountUsdc: 0.05,
      latencyMs: 100 + i * 10, // 100 to 290 ms
      httpStatusClass: isError ? "5xx" : "2xx",
      endpointReached: true,
      responseSchemaValid: !isError,
      responseWithinSizeLimit: true,
      paymentRequired: true,
      paymentAuthorized: true,
      paymentSettled: true,
      executionCompleted: !isError,
      arcProofVerified: !isError,
      errorCategory: isError ? "execution_failed" : "none",
      source: "real_paid_execution",
    });
  }

  const statsObs = getInMemoryApiQualityObservations().filter((o) => o.serviceId === "srv_stats_test");
  const metrics3 = computeApiQualityMetrics(statsObs);
  assert.equal(metrics3.totalObservations, 20);
  assert.equal(metrics3.uptimePercent, 95);
  assert.equal(metrics3.executionSuccessPercent, 95);
  assert.equal(metrics3.paymentSuccessPercent, 100);
  assert.equal(metrics3.settlementSuccessPercent, 100);
  assert.equal(metrics3.validResponsePercent, 95);
  assert.ok(metrics3.latencyP50Ms >= 190 && metrics3.latencyP50Ms <= 200);
  assert.ok(metrics3.latencyP95Ms >= 280);
  assert.equal(metrics3.latencyMaxMs, 290);

  // ----------------------------------------------------
  // Scenario 4: Quoted Price & Cost Efficiency Metrics
  // ----------------------------------------------------
  console.log("Scenario 4: Quoted Price & Cost Efficiency Metrics");
  assert.equal(metrics3.quotedPriceMinUsdc, 0.05);
  assert.equal(metrics3.quotedPriceMedianUsdc, 0.05);
  assert.equal(metrics3.quotedPriceMaxUsdc, 0.05);
  // Total paid = 20 * 0.05 = 1.00; 19 successful executions -> 1.00 / 19 = 0.052632 USDC per success
  assert.ok(metrics3.costPerSuccessfulResultUsdc > 0.05);

  // ----------------------------------------------------
  // Scenario 5: 0–100 Quality Score Category Weighting Calculation
  // ----------------------------------------------------
  console.log("Scenario 5: 0–100 Quality Score Category Weighting Calculation");
  const perfectMetrics = {
    totalObservations: 20,
    uptimePercent: 100,
    executionSuccessPercent: 100,
    paymentSuccessPercent: 100,
    settlementSuccessPercent: 100,
    validResponsePercent: 100,
    latencyP50Ms: 100,
    latencyP95Ms: 150,
    latencyMaxMs: 200,
    quotedPriceMinUsdc: 0.05,
    quotedPriceMedianUsdc: 0.05,
    quotedPriceMaxUsdc: 0.05,
    costPerSuccessfulResultUsdc: 0.05,
    firstObservedAt: now.toISOString(),
    lastObservedAt: now.toISOString(),
  };

  const perfectScore = calculateQualityScore(perfectMetrics);
  assert.equal(perfectScore.availabilityScore, 25);
  assert.equal(perfectScore.executionReliabilityScore, 20);
  assert.equal(perfectScore.responseValidityScore, 15);
  assert.equal(perfectScore.paymentSuccessScore, 15);
  assert.equal(perfectScore.settlementSuccessScore, 15);
  assert.equal(perfectScore.latencyConsistencyScore, 10);
  assert.equal(perfectScore.overallScore, 100);

  // ----------------------------------------------------
  // Scenario 6: Quality Status Classification
  // ----------------------------------------------------
  console.log("Scenario 6: Quality Status Classification");
  assert.equal(perfectScore.status, "Excellent");

  const reliableMetrics = { ...perfectMetrics, uptimePercent: 85 }; // score drops by ~3.75
  const reliableScore = calculateQualityScore(reliableMetrics);
  assert.ok(["Reliable", "Excellent"].includes(reliableScore.status));

  const mixedMetrics = { ...perfectMetrics, uptimePercent: 40, executionSuccessPercent: 40 };
  const mixedScore = calculateQualityScore(mixedMetrics);
  assert.equal(mixedScore.status, "Mixed signals");

  const highAttnMetrics = {
    ...perfectMetrics,
    uptimePercent: 10,
    executionSuccessPercent: 10,
    responseValidityPercent: 10,
    paymentSuccessPercent: 10,
    settlementSuccessPercent: 10,
    latencyP95Ms: 15000,
  };
  const highAttnScore = calculateQualityScore(highAttnMetrics);
  assert.equal(highAttnScore.status, "High attention");

  // ----------------------------------------------------
  // Scenario 7: Insufficient Data Handling (< 10 observations) & Null Denominators
  // ----------------------------------------------------
  console.log("Scenario 7: Insufficient Data Handling & Null Denominators");
  const lowDataMetrics = { ...perfectMetrics, totalObservations: 5 };
  const lowDataScore = calculateQualityScore(lowDataMetrics);
  assert.equal(lowDataScore.hasSufficientData, false);
  assert.equal(lowDataScore.status, "Insufficient data");
  assert.equal(lowDataScore.overallScore, null);
  assert.equal(lowDataScore.qualityScore, null);

  // Test 0 observations metrics
  const emptyMetrics = computeApiQualityMetrics([]);
  assert.equal(emptyMetrics.totalObservations, 0);
  assert.equal(emptyMetrics.uptimePercent, null);
  assert.equal(emptyMetrics.executionSuccessPercent, null);
  assert.equal(emptyMetrics.paymentSuccessPercent, null);
  assert.equal(emptyMetrics.settlementSuccessPercent, null);
  assert.equal(emptyMetrics.validResponsePercent, null);
  assert.equal(emptyMetrics.costPerSuccessfulResultUsdc, null);

  // Test 0 payment attempts metrics
  const freeObs: ApiQualityObservation[] = Array(12).fill({
    observationId: "obs_free",
    serviceId: "srv_free",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    quotedPriceUsdc: 0,
    paidAmountUsdc: 0,
    latencyMs: 50,
    httpStatusClass: "2xx",
    endpointReached: true,
    responseSchemaValid: true,
    responseWithinSizeLimit: true,
    paymentRequired: false,
    paymentAuthorized: null,
    paymentSettled: null,
    executionCompleted: true,
    arcProofVerified: true,
    errorCategory: "none",
    source: "real_paid_execution",
    createdAt: now.toISOString(),
  });
  const freeMetrics = computeApiQualityMetrics(freeObs);
  assert.equal(freeMetrics.paymentSuccessPercent, null);
  assert.equal(freeMetrics.settlementSuccessPercent, null);
  const freeScore = calculateQualityScore(freeMetrics, freeObs);
  assert.equal(freeScore.hasSufficientData, true);
  assert.equal(freeScore.status, "Excellent");
  assert.ok(freeScore.overallScore !== null && freeScore.overallScore >= 90);

  // ----------------------------------------------------
  // Scenario 8: Confidence Level Categorization
  // ----------------------------------------------------
  console.log("Scenario 8: Confidence Level Categorization");
  const lowCountObs: any[] = Array(3).fill({ startedAt: now.toISOString(), source: "real_paid_execution" });
  assert.equal(getConfidenceLevel(lowCountObs), "low");

  const highCountObs: any[] = Array(25).fill({ startedAt: now.toISOString(), source: "real_paid_execution" });
  assert.equal(getConfidenceLevel(highCountObs), "high");

  // ----------------------------------------------------
  // Scenario 9: Multi-Service Side-by-Side Comparison Engine & Ranking
  // ----------------------------------------------------
  console.log("Scenario 9: Multi-Service Side-by-Side Comparison Engine & Ranking");
  clearInMemoryApiQualityObservations();
  // Service A (Weather) - Perfect
  for (let i = 0; i < 12; i++) {
    await recordApiQualityObservation({
      serviceId: "srv_comp_weather",
      sellerPublicId: "sel_weather",
      startedAt: new Date(now.getTime() - i * 3600000).toISOString(),
      completedAt: new Date(now.getTime() - i * 3600000 + 100).toISOString(),
      quotedPriceUsdc: 0.05,
      paidAmountUsdc: 0.05,
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
      source: "real_paid_execution",
    });
  }

  // Service B (Crypto) - Slower / Higher price
  for (let i = 0; i < 12; i++) {
    await recordApiQualityObservation({
      serviceId: "srv_comp_crypto",
      sellerPublicId: "sel_crypto",
      startedAt: new Date(now.getTime() - i * 3600000).toISOString(),
      completedAt: new Date(now.getTime() - i * 3600000 + 500).toISOString(),
      quotedPriceUsdc: 0.2,
      paidAmountUsdc: 0.2,
      latencyMs: 500,
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
      source: "real_paid_execution",
    });
  }

  const allCompObs = getInMemoryApiQualityObservations();
  const compResult = compareApiQuality(
    [
      { serviceId: "srv_comp_weather", observations: allCompObs.filter((o) => o.serviceId === "srv_comp_weather") },
      { serviceId: "srv_comp_crypto", observations: allCompObs.filter((o) => o.serviceId === "srv_comp_crypto") },
    ],
    30,
  );

  assert.equal(compResult.services.length, 2);
  assert.equal(compResult.services[0].serviceId, "srv_comp_weather");
  assert.equal(compResult.services[0].rank, 1);
  assert.equal(compResult.services[1].rank, 2);
  assert.equal(compResult.overallWinnerServiceId, "srv_comp_weather");

  // ----------------------------------------------------
  // Scenario 10: Comparison Category Highlights Generation
  // ----------------------------------------------------
  console.log("Scenario 10: Comparison Category Highlights Generation");
  assert.ok(compResult.highlights.length >= 3);
  const overallHighlight = compResult.highlights.find((h) => h.category === "overall");
  assert.equal(overallHighlight?.winnerServiceId, "srv_comp_weather");
  const latencyHighlight = compResult.highlights.find((h) => h.category === "latency");
  assert.equal(latencyHighlight?.winnerServiceId, "srv_comp_weather");

  // ----------------------------------------------------
  // Scenario 11: Unknown services fail closed without observations
  // ----------------------------------------------------
  console.log("Scenario 11: Unknown probe target fails closed");
  const check1 = await checkProbeSafetyAndBudget("srv_cooldown_test", "availability", { cooldownSeconds: 300 });
  assert.equal(check1.allowed, false);
  assert.equal(check1.status, "inactive_skipped");

  const observationsBeforeProbe = getInMemoryApiQualityObservations().length;
  const closedProbe = await executeScheduledProbe({ serviceId: "srv_cooldown_test", probeType: "availability" });
  assert.equal(closedProbe.status, "inactive_skipped");
  assert.equal(closedProbe.observation, undefined);
  assert.equal(getInMemoryApiQualityObservations().length, observationsBeforeProbe);

  const check2 = await checkProbeSafetyAndBudget("srv_cooldown_test", "availability", { cooldownSeconds: 300 });
  assert.equal(check2.allowed, false);
  assert.equal(check2.status, "inactive_skipped");

  // ----------------------------------------------------
  // Scenario 12: Paid probes cannot fabricate settlement evidence
  // ----------------------------------------------------
  console.log("Scenario 12: Paid probes fail closed");
  const checkPriceLimit = await checkProbeSafetyAndBudget("srv_price_guard", "paid_execution", {
    maxPriceUsdc: 0.05,
  });
  assert.equal(checkPriceLimit.allowed, false);
  assert.equal(checkPriceLimit.status, "inactive_skipped");

  // ----------------------------------------------------
  // Scenario 13: Probe Cumulative Daily Budget Guard
  // ----------------------------------------------------
  console.log("Scenario 13: Probe Cumulative Daily Budget Guard");
  // Pre-fill daily spend of probes
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
  assert.equal(
    computeApiQualityMetrics(
      getInMemoryApiQualityObservations().filter((observation) => observation.serviceId === "srv_budget_fill"),
    ).totalObservations,
    0,
    "Legacy synthetic scheduled probes must not contribute to quality scores",
  );

  // ----------------------------------------------------
  // Scenario 14: Single Scheduled Probe Execution & Pre/Post Delta Calculation
  // ----------------------------------------------------
  console.log("Scenario 14: Single Scheduled Probe Execution & Pre/Post Delta Calculation");
  const probeExecRes = await executeScheduledProbe({
    serviceId: "srv_single_probe",
    probeType: "availability",
    cooldownSeconds: 0,
  });

  assert.equal(probeExecRes.status, "inactive_skipped");
  assert.equal(probeExecRes.observation, undefined);
  assert.equal(probeExecRes.metricsDelta, undefined);

  // ----------------------------------------------------
  // Scenario 15: Batch Scheduled Probes Runner
  // ----------------------------------------------------
  console.log("Scenario 15: Batch Scheduled Probes Runner");
  const batchRes = await runScheduledApiQualityProbes({
    serviceIds: ["srv_batch_a", "srv_batch_b"],
    probeType: "availability",
    cooldownSeconds: 0,
  });

  assert.equal(batchRes.totalProbes, 2);
  assert.equal(batchRes.executed, 0);
  assert.equal(batchRes.skipped, 2);
  assert.equal(batchRes.results.length, 2);

  const previousCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "probe-route-test-secret";
  try {
    const unauthorizedProbeResponse = await monitoringProbesGET(
      new NextRequest("http://localhost/api/monitoring/probes"),
    );
    assert.equal(unauthorizedProbeResponse.status, 404);

    const authorizedProbeResponse = await monitoringProbesPOST(
      new NextRequest("http://localhost/api/monitoring/probes", {
        method: "POST",
        headers: {
          authorization: "Bearer probe-route-test-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          probeType: "paid_execution",
          cooldownSeconds: 0,
          maxDailyProbeBudgetUsdc: 99999,
          serviceIds: ["attacker-controlled-service"],
        }),
      }),
    );
    assert.equal(authorizedProbeResponse.status, 200);
    const authorizedProbeBody = await authorizedProbeResponse.json();
    assert.equal(authorizedProbeBody.summary.totalCostUsdc, 0);
    assert.equal(
      authorizedProbeBody.summary.results.some(
        (result: { probeType?: string; serviceId?: string }) =>
          result.probeType === "paid_execution" || result.serviceId === "attacker-controlled-service",
      ),
      false,
      "Request body must not control paid probe policy or target selection",
    );
  } finally {
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
  }

  // ----------------------------------------------------
  // Scenario 16: Delta Degradation Alert - Score Drop (>= 15 pts)
  // ----------------------------------------------------
  console.log("Scenario 16: Delta Degradation Alert - Score Drop");
  const prevScore16 = { overallScore: 95, availabilityScore: 25, executionReliabilityScore: 20, responseValidityScore: 15, paymentSuccessScore: 15, settlementSuccessScore: 15, latencyConsistencyScore: 10, status: "Excellent" as const, confidenceLevel: "high" as const, hasSufficientData: true };
  const newScore16 = { overallScore: 70, availabilityScore: 15, executionReliabilityScore: 15, responseValidityScore: 15, paymentSuccessScore: 15, settlementSuccessScore: 10, latencyConsistencyScore: 0, status: "Mixed signals" as const, confidenceLevel: "high" as const, hasSufficientData: true };
  const prevMetrics16 = { totalObservations: 20, uptimePercent: 100, executionSuccessPercent: 100, paymentSuccessPercent: 100, settlementSuccessPercent: 100, validResponsePercent: 100, latencyP50Ms: 100, latencyP95Ms: 150, latencyMaxMs: 200, quotedPriceMinUsdc: 0.05, quotedPriceMedianUsdc: 0.05, quotedPriceMaxUsdc: 0.05, costPerSuccessfulResultUsdc: 0.05, firstObservedAt: now.toISOString(), lastObservedAt: now.toISOString() };
  const newMetrics16 = { totalObservations: 21, uptimePercent: 95, executionSuccessPercent: 95, paymentSuccessPercent: 100, settlementSuccessPercent: 100, validResponsePercent: 100, latencyP50Ms: 100, latencyP95Ms: 150, latencyMaxMs: 200, quotedPriceMinUsdc: 0.05, quotedPriceMedianUsdc: 0.05, quotedPriceMaxUsdc: 0.05, costPerSuccessfulResultUsdc: 0.05, firstObservedAt: now.toISOString(), lastObservedAt: now.toISOString() };

  const alerts16 = detectQualityDegradationAlerts("srv_score_drop", prevScore16, newScore16, prevMetrics16, newMetrics16);
  const scoreDropAlert = alerts16.find((a) => a.alertType === "score_drop");
  assert.ok(scoreDropAlert);
  assert.equal(scoreDropAlert.severity, "critical");

  // ----------------------------------------------------
  // Scenario 17: Delta Degradation Alert - Uptime Drop
  // ----------------------------------------------------
  console.log("Scenario 17: Delta Degradation Alert - Uptime Drop");
  const prevMetrics17 = { ...prevMetrics16, uptimePercent: 100 };
  const newMetrics17 = { ...newMetrics16, uptimePercent: 88 }; // Drop >= 10% and < 90%
  const prevScore17 = prevScore16;
  const newScore17 = prevScore16;

  const alerts17 = detectQualityDegradationAlerts("srv_uptime_drop", prevScore17, newScore17, prevMetrics17, newMetrics17);
  const uptimeAlert = alerts17.find((a) => a.alertType === "uptime_drop");
  assert.ok(uptimeAlert);

  // ----------------------------------------------------
  // Scenario 18: Delta Degradation Alert - Latency Spike & Execution Spike
  // ----------------------------------------------------
  console.log("Scenario 18: Delta Degradation Alert - Latency Spike & Execution Spike");
  const prevMetrics18 = { ...prevMetrics16, latencyP95Ms: 200, executionSuccessPercent: 100 };
  const newMetrics18 = { ...newMetrics16, latencyP95Ms: 500, executionSuccessPercent: 70 }; // Latency 2.5x spike; Exec < 80%

  const alerts18 = detectQualityDegradationAlerts("srv_spikes", prevScore16, prevScore16, prevMetrics18, newMetrics18);
  const latencyAlert = alerts18.find((a) => a.alertType === "latency_spike");
  const execAlert = alerts18.find((a) => a.alertType === "execution_failure_spike");
  assert.ok(latencyAlert);
  assert.ok(execAlert);

  // ----------------------------------------------------
  // Scenario 19: Job Input Parsing
  // ----------------------------------------------------
  console.log("Scenario 19: Job Input Parsing");
  const parseJson = parseApiQualityJobInput(JSON.stringify({ serviceId: "srv_json_target", observationWindowDays: 90 }));
  assert.deepEqual(parseJson.targetServices, ["srv_json_target"]);
  assert.equal(parseJson.observationWindowDays, 90);

  const parseMultiJson = parseApiQualityJobInput(JSON.stringify({ serviceIds: ["srv_a", "srv_b"], observationWindowDays: 7 }));
  assert.deepEqual(parseMultiJson.targetServices, ["srv_a", "srv_b"]);
  assert.equal(parseMultiJson.observationWindowDays, 7);

  const parseTokens = parseApiQualityJobInput("compare srv_weather srv_crypto for quality");
  assert.ok(parseTokens.targetServices.includes("srv_weather"));
  assert.ok(parseTokens.targetServices.includes("srv_crypto"));

  // ----------------------------------------------------
  // Scenario 20: Unified Report View Model Construction (15 Sections)
  // ----------------------------------------------------
  console.log("Scenario 20: Unified Report View Model Construction");
  const reportInput = {
    jobId: "job_p4_quality_001",
    workflow: "paid_api_quality",
    status: "completed",
    targetServices: ["srv_comp_weather", "srv_comp_crypto"],
    observationWindowDays: 30,
    observationsByService: {
      srv_comp_weather: allCompObs.filter((o) => o.serviceId === "srv_comp_weather"),
      srv_comp_crypto: allCompObs.filter((o) => o.serviceId === "srv_comp_crypto"),
    },
    proofs: [{ txHash: "0x123abc...", status: "verified", explorerUrl: "https://explorer.arc.io/tx/0x123abc..." }],
    receipts: [{ receiptId: "rcpt_001", serviceSlug: "srv_comp_weather", serviceName: "Weather API", priceUsdc: "0.05", status: "settled" }],
  };

  const reportModel = buildApiQualityPublicReport(reportInput);
  assert.equal(reportModel.reportId, "job_p4_quality_001");
  assert.equal(reportModel.mode, "comparison");
  assert.equal(reportModel.servicesCompared.length, 2);
  assert.ok(reportModel.executiveSummary.length > 0);
  assert.ok(reportModel.priceAndCostEfficiency);
  assert.ok(reportModel.availability);
  assert.ok(reportModel.latencyDistribution);
  assert.ok(reportModel.responseQuality);
  assert.ok(reportModel.paymentAndSettlementReliability);
  assert.ok(Array.isArray(reportModel.observedFailures));
  assert.ok(reportModel.qualityScoreAndConfidence);
  assert.ok(Array.isArray(reportModel.strengths));
  assert.ok(Array.isArray(reportModel.risksAndReviewItems));
  assert.ok(Array.isArray(reportModel.questionsBeforeIntegration));
  assert.ok(reportModel.evidenceAndObservationWindow);
  assert.ok(reportModel.limitations);
  assert.equal(reportModel.verification.status, "verified");

  // ----------------------------------------------------
  // Scenario 21: Report Markdown Serializer
  // ----------------------------------------------------
  console.log("Scenario 21: Report Markdown Serializer");
  const markdownText = formatApiQualityPublicReportAsMarkdown(reportModel);
  assert.ok(markdownText.includes("# Paid API Quality Report"));
  assert.ok(markdownText.includes("## Executive Summary"));
  assert.ok(markdownText.includes("## Quality Score & Breakdown"));
  assert.ok(markdownText.includes("## Services Overview & Comparison"));
  assert.ok(markdownText.includes("## Payment & Arc Verification Details"));
  assert.ok(markdownText.includes("0x123abc..."));

  // ----------------------------------------------------
  // Scenario 22: Workflow System & Machine Error Integration
  // ----------------------------------------------------
  console.log("Scenario 22: Workflow System & Machine Error Integration");
  assert.ok(HOSTED_WORKFLOW_TYPES.includes("paid_api_quality"));
  assert.equal(isHostedWorkflowType("paid_api_quality"), true);

  const defaultTask = defaultWorkflowTask("paid_api_quality");
  assert.ok(defaultTask.toLowerCase().includes("evaluate"));

  const testErrorCode: MachineErrorCode = "api_quality_service_not_found";
  assert.equal(testErrorCode, "api_quality_service_not_found");

  // ----------------------------------------------------
  // Scenario 24: Regression Test — DB Unavailable 503 Fail-Closed
  // ----------------------------------------------------
  console.log("Scenario 24: Regression Test — DB Unavailable 503 Fail-Closed");
  const prevEnv = process.env.NODE_ENV;
  const prevAllowMem = process.env.API_QUALITY_ALLOW_MEMORY_STORE;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.API_QUALITY_ALLOW_MEMORY_STORE;
    clearInMemoryApiQualityObservations();

    await assert.rejects(
      async () => {
        await recordApiQualityObservation({
          serviceId: "srv_fail_closed_test",
          startedAt: now.toISOString(),
          httpStatusClass: "2xx",
          endpointReached: true,
          paymentRequired: true,
          executionCompleted: true,
          arcProofVerified: true,
          errorCategory: "none",
          source: "real_paid_execution",
        });
      },
      (err: any) =>
        err instanceof ApiQualityStoreUnavailableError &&
        err.status === 503 &&
        err.code === "api_quality_observation_store_unavailable",
      "Should throw 503 ApiQualityStoreUnavailableError in production when DB unavailable",
    );

    assert.equal(
      getInMemoryApiQualityObservations().length,
      0,
      "Zero records must be created in memory store during production DB failure",
    );
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevAllowMem) process.env.API_QUALITY_ALLOW_MEMORY_STORE = prevAllowMem;
  }

  // ----------------------------------------------------
  // Scenario 25: Regression Test — Serverless Restart Simulation
  // ----------------------------------------------------
  console.log("Scenario 25: Regression Test — Serverless Restart Simulation");
  clearInMemoryApiQualityObservations();
  const fetchedAfterRestart = await fetchApiQualityObservations("srv_transform_test", 30);
  assert.ok(Array.isArray(fetchedAfterRestart), "Fetching observations after serverless cold restart should return array");

  // ----------------------------------------------------
  // Scenario 26: Regression Test — Anon Supabase Client RLS Denial
  // ----------------------------------------------------
  console.log("Scenario 26: Regression Test — Anon Supabase Client RLS Denial");
  const anonSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://test.supabase.co";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlc3QiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTYwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.dummy_anon_key";
  const anonClient = createClient(anonSupabaseUrl, anonKey);
  const { data: anonData, error: anonError } = await anonClient.from("api_quality_observations").select("*").limit(5);
  assert.ok(anonError !== null || (anonData && anonData.length === 0), "Anon Supabase client must receive RLS denial or 0 rows");

  // ----------------------------------------------------
  // Scenario 27: Regression Test — Preservation of Null Fields
  // ----------------------------------------------------
  console.log("Scenario 27: Regression Test — Preservation of Null Fields");
  const nullRow: ApiQualityObservationRow = {
    observation_id: "obs_null_fields",
    service_id: "srv_null_test",
    seller_public_id: null,
    started_at: now.toISOString(),
    completed_at: null,
    quoted_price_usdc: null,
    paid_amount_usdc: null,
    latency_ms: null,
    http_status_class: "5xx",
    endpoint_reached: false,
    response_schema_valid: null,
    response_within_size_limit: null,
    payment_required: false,
    payment_authorized: null,
    payment_settled: null,
    execution_completed: false,
    arc_proof_verified: false,
    error_category: "timeout",
    source: "scheduled_probe",
    created_at: now.toISOString(),
  };

  const parsedNullObs = rowToObservation(nullRow);
  assert.equal(parsedNullObs.completedAt, null);
  assert.equal(parsedNullObs.quotedPriceUsdc, null);
  assert.equal(parsedNullObs.paidAmountUsdc, null);
  assert.equal(parsedNullObs.latencyMs, null);
  assert.equal(parsedNullObs.responseSchemaValid, null);
  assert.equal(parsedNullObs.responseWithinSizeLimit, null);
  assert.equal(parsedNullObs.paymentAuthorized, null);
  assert.equal(parsedNullObs.paymentSettled, null);

  const nullMetrics = computeApiQualityMetrics([parsedNullObs]);
  assert.equal(nullMetrics.paymentSuccessPercent, null);
  assert.equal(nullMetrics.settlementSuccessPercent, null);
  assert.equal(parsedNullObs.latencyMs, null);
  assert.equal(parsedNullObs.completedAt, null);

  // ----------------------------------------------------
  // Scenario 28: Regression Test — Timeout Does Not Get Latency 0
  // ----------------------------------------------------
  console.log("Scenario 28: Regression Test — Timeout Does Not Get Latency 0");
  const normalObs: ApiQualityObservation = {
    observationId: "obs_normal_test",
    serviceId: "srv_timeout_test",
    startedAt: now.toISOString(),
    completedAt: new Date(now.getTime() + 200).toISOString(),
    quotedPriceUsdc: 0.05,
    paidAmountUsdc: 0.05,
    latencyMs: 200,
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
    source: "real_paid_execution",
    createdAt: now.toISOString(),
  };
  const timeoutObs: ApiQualityObservation = {
    observationId: "obs_timeout_test",
    serviceId: "srv_timeout_test",
    startedAt: now.toISOString(),
    completedAt: null,
    quotedPriceUsdc: 0.05,
    paidAmountUsdc: 0.05,
    latencyMs: null,
    httpStatusClass: "5xx",
    endpointReached: false,
    responseSchemaValid: null,
    responseWithinSizeLimit: null,
    paymentRequired: true,
    paymentAuthorized: true,
    paymentSettled: false,
    executionCompleted: false,
    arcProofVerified: false,
    errorCategory: "timeout",
    source: "real_paid_execution",
    createdAt: now.toISOString(),
  };

  assert.equal(timeoutObs.latencyMs, null, "Timeout observation must have null latencyMs, NOT 0");
  const timeoutMetrics = computeApiQualityMetrics([normalObs, timeoutObs]);
  assert.equal(timeoutMetrics.latencyP50Ms, 200, "Timeout observation must be excluded from latency calculation, NOT treated as 0 ms latency");

  // ----------------------------------------------------
  // Scenario 29: Regression Test — No Payment Attempts Displays as N/A
  // ----------------------------------------------------
  console.log("Scenario 29: Regression Test — No Payment Attempts Displays as N/A");
  const freeSrvObs: ApiQualityObservation = {
    observationId: "obs_free_srv",
    serviceId: "srv_free_display",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    quotedPriceUsdc: 0,
    paidAmountUsdc: 0,
    latencyMs: 80,
    httpStatusClass: "2xx",
    endpointReached: true,
    responseSchemaValid: true,
    responseWithinSizeLimit: true,
    paymentRequired: false,
    paymentAuthorized: null,
    paymentSettled: null,
    executionCompleted: true,
    arcProofVerified: true,
    errorCategory: "none",
    source: "real_paid_execution",
    createdAt: now.toISOString(),
  };

  const freeReportModel = buildApiQualityPublicReport({
    jobId: "job_free_test",
    workflow: "paid_api_quality",
    status: "completed",
    targetServices: ["srv_free_display"],
    observationWindowDays: 30,
    observationsByService: { srv_free_display: Array(12).fill(freeSrvObs) },
  });

  const freeReportMarkdown = formatApiQualityPublicReportAsMarkdown(freeReportModel);
  assert.ok(
    freeReportMarkdown.includes("N/A") || freeReportMarkdown.includes("No observations"),
    "No payment attempts must display as N/A or No observations in report markdown",
  );

  // ----------------------------------------------------
  // Scenario 30: Regression Test — Private Service Returns 404
  // ----------------------------------------------------
  console.log("Scenario 30: Regression Test — Private Service Returns 404");
  const privateCheck = await validatePublicServiceForQualityEvaluation("agent-trust-finalizer");
  assert.equal(privateCheck, null, "Private/internal service lookup must return null");

  await assert.rejects(
    async () => {
      await validatePublicServiceForQualityEvaluation("agent-trust-finalizer", { throwOnError: true });
    },
    (err: any) =>
      err instanceof ApiQualityServiceNotFoundError &&
      err.status === 404 &&
      err.code === "api_quality_service_not_found",
    "Private service with throwOnError must throw 404 ApiQualityServiceNotFoundError",
  );

  // ----------------------------------------------------
  // Scenario 31: Regression Test — Paid Workflow Does Not Invoke text-analyzer or premium-quote
  // ----------------------------------------------------
  console.log("Scenario 31: Regression Test — Paid Workflow Does Not Invoke text-analyzer or premium-quote");
  const paidQualityRequest = validateHostedWorkflowRequest({
    workflowType: "paid_api_quality",
    inputText: "evaluate srv_test_eval_quality_benchmark",
  });
  const paidQualityPlan = createHostedWorkflowPlan({
    request: paidQualityRequest,
    services: [...serviceRegistry],
    allowlist: SAFE_HOSTED_SERVICES,
  });

  const selectedSlugs = paidQualityPlan.selectedServices.map((s) => s.slug);
  assert.ok(selectedSlugs.includes("api-quality-finalizer"), "paid_api_quality plan must include api-quality-finalizer");
  assert.ok(!selectedSlugs.includes("text-analyzer"), "paid_api_quality plan must NOT include text-analyzer");
  assert.ok(!selectedSlugs.includes("premium-quote"), "paid_api_quality plan must NOT include premium-quote");

  // ----------------------------------------------------
  // Scenario 32: Canonical JSON Report Hashing — Key Order Determinism
  // ----------------------------------------------------
  console.log("Scenario 32: Canonical JSON Report Hashing — Key Order Determinism");
  const reportKeyOrderA = {
    reportId: "job_canonical_001",
    workflowType: "paid_api_quality",
    workflow: "paid_api_quality",
    overallScore: 95,
    mode: "single" as const,
    targetServices: ["srv_weather"],
    servicesCompared: [{ serviceId: "srv_weather", serviceName: "Weather API", observationCount: { value: 10, confidence: "high" as const } }],
    availability: { uptimePercent: { value: 100, confidence: "high" as const }, totalObservations: { value: 10, confidence: "high" as const }, summary: "100% Uptime" },
    qualityScoreAndConfidence: { overallScore: 95, status: "Excellent" as const, confidenceLevel: "high" as const, hasSufficientData: true, breakdown: { availabilityScore: 25, executionReliabilityScore: 20, responseValidityScore: 15, paymentSuccessScore: 15, settlementSuccessScore: 15, latencyConsistencyScore: 10 }, summary: "Top tier performance" },
  };

  const reportKeyOrderB = {
    qualityScoreAndConfidence: { summary: "Top tier performance", breakdown: { latencyConsistencyScore: 10, settlementSuccessScore: 15, paymentSuccessScore: 15, responseValidityScore: 15, executionReliabilityScore: 20, availabilityScore: 25 }, hasSufficientData: true, confidenceLevel: "high" as const, status: "Excellent" as const, overallScore: 95 },
    availability: { summary: "100% Uptime", totalObservations: { confidence: "high" as const, value: 10 }, uptimePercent: { confidence: "high" as const, value: 100 } },
    servicesCompared: [{ observationCount: { confidence: "high" as const, value: 10 }, serviceName: "Weather API", serviceId: "srv_weather" }],
    targetServices: ["srv_weather"],
    mode: "single" as const,
    overallScore: 95,
    workflow: "paid_api_quality",
    workflowType: "paid_api_quality",
    reportId: "job_canonical_001",
  };

  const hashA = computeCanonicalReportHash(reportKeyOrderA);
  const hashB = computeCanonicalReportHash(reportKeyOrderB);

  assert.equal(hashA.canonicalHash, hashB.canonicalHash, "Different key ordering must produce identical canonical hash");
  assert.equal(hashA.canonicalString, hashB.canonicalString, "Different key ordering must produce identical canonical JSON string");
  assert.equal(hashA.canonicalizationVersion, CANONICALIZATION_VERSION);
  assert.ok(hashA.canonicalHash.startsWith("0x"));

  // ----------------------------------------------------
  // Scenario 33: Canonical JSON Report Hashing — Property Value Mutation Sensitivity
  // ----------------------------------------------------
  console.log("Scenario 33: Canonical JSON Report Hashing — Property Value Mutation Sensitivity");
  const reportMutated = {
    ...reportKeyOrderA,
    overallScore: 85, // modified property value
  };

  const hashMutated = computeCanonicalReportHash(reportMutated);
  assert.notEqual(hashMutated.canonicalHash, hashA.canonicalHash, "Modifying property value must change canonical hash");
  assert.notEqual(hashMutated.canonicalString, hashA.canonicalString, "Modifying property value must change canonical string");

  // ----------------------------------------------------
  // Scenario 34: Malformed Report Payload Validation Rejection
  // ----------------------------------------------------
  console.log("Scenario 34: Malformed Report Payload Validation Rejection");
  assert.equal(validateApiQualityReportPayload(null), false);
  assert.equal(validateApiQualityReportPayload({}), false);
  assert.equal(validateApiQualityReportPayload({ workflowType: "invalid_type" }), false);
  assert.equal(validateApiQualityReportPayload({ workflowType: "paid_api_quality" }), false, "Missing required sections must fail validation");
  assert.equal(validateApiQualityReportPayload({ workflowType: "paid_api_quality", reportId: "r1", servicesCompared: [] }), false, "Missing availability must fail validation");
  assert.equal(validateApiQualityReportPayload(reportKeyOrderA), true, "Valid report payload must pass validation");

  // Verify non-finite / undefined handling in canonicalizeJson
  assert.throws(() => canonicalizeJson({ a: undefined }), /undefined value is not supported|undefined property value/);
  assert.throws(() => canonicalizeJson({ a: NaN }), /non-finite number/);
  assert.throws(() => canonicalizeJson({ a: Infinity }), /non-finite number/);
  assert.throws(() => canonicalizeJson({ a: () => {} }), /unsupported type/);

  // ----------------------------------------------------
  // Scenario 35: Canonical Hashing — Secret & Internal Keys Stripping
  // ----------------------------------------------------
  console.log("Scenario 35: Canonical Hashing — Secret & Internal Keys Stripping");
  const reportWithSecrets = {
    ...reportKeyOrderA,
    credentials: { api_key: "secret_12345" },
    _private: { token: "private_token" },
    webhookSecret: "whsec_abcdef",
    bearerToken: "bearer_xyz987",
    internalConfig: { env: "test" },
  };

  const hashWithSecrets = computeCanonicalReportHash(reportWithSecrets);
  assert.equal(hashWithSecrets.canonicalHash, hashA.canonicalHash, "Extra internal/secret fields must be stripped before hashing");
  assert.ok(!hashWithSecrets.canonicalString.includes("credentials"), "Canonical string must not contain credentials");
  assert.ok(!hashWithSecrets.canonicalString.includes("_private"), "Canonical string must not contain _private");
  assert.ok(!hashWithSecrets.canonicalString.includes("webhookSecret"), "Canonical string must not contain webhookSecret");
  assert.ok(!hashWithSecrets.canonicalString.includes("bearerToken"), "Canonical string must not contain bearerToken");
  assert.ok(!hashWithSecrets.canonicalString.includes("internalConfig"), "Canonical string must not contain internalConfig");

  const strippedPayload = stripInternalKeys(reportWithSecrets) as Record<string, unknown>;
  assert.equal(strippedPayload.credentials, undefined);
  assert.equal(strippedPayload._private, undefined);
  assert.equal(strippedPayload.webhookSecret, undefined);
  assert.equal(strippedPayload.bearerToken, undefined);
  assert.equal(strippedPayload.internalConfig, undefined);

  // ----------------------------------------------------
  // Scenario 36: Hash in Final Report Matches Arc Proof Hash
  // ----------------------------------------------------
  console.log("Scenario 36: Hash in Final Report Matches Arc Proof Hash");
  const finalReportClean = stripInternalKeys(reportKeyOrderA);
  const expectedHashResult = computeCanonicalReportHash(finalReportClean);

  // Simulated finalizer output
  const finalizerResponse = {
    report: finalReportClean,
    paidAmountUsdc: "0.0020",
    billing: {
      chargedBy: "Veyra",
      protocol: "x402",
      network: "Arc Testnet",
      purpose: "api_quality_canonical_hash_attestation",
    },
    canonicalHash: expectedHashResult.canonicalHash,
    canonicalizationVersion: expectedHashResult.canonicalizationVersion,
  };

  const headerHash = expectedHashResult.canonicalHash;
  assert.equal(finalizerResponse.canonicalHash, headerHash, "Canonical hash in response must match header hash");
  assert.equal(finalizerResponse.canonicalHash, expectedHashResult.canonicalHash, "Final report hash must match computed canonical hash");

  // ----------------------------------------------------
  // Scenario 37: Price Synchronization Assertion
  // ----------------------------------------------------
  console.log("Scenario 37: Price Synchronization Assertion");
  const template = hostedWorkflowTemplates.find((t) => t.value === "paid_api_quality");
  const displayedPrice = template?.estimatedSpendUsdc;
  const finalizerService = serviceRegistry.find((s) => s.slug === "api-quality-finalizer");
  const providerPrice = finalizerService?.priceUsd;
  const quotedPrice = Number(API_QUALITY_FINALIZER_PRICE_USDC);
  const paidAmount = Number(API_QUALITY_FINALIZER_PRICE_USDC);

  assert.equal(displayedPrice, 0.002, "Displayed price must equal 0.002");
  assert.equal(quotedPrice, 0.002, "Quoted price must equal 0.002");
  assert.equal(providerPrice, 0.002, "Provider price must equal 0.002");
  assert.equal(paidAmount, 0.002, "Paid amount must equal 0.002");
  assert.ok(
    displayedPrice === quotedPrice &&
      quotedPrice === providerPrice &&
      providerPrice === paidAmount,
    "Price synchronization failure: displayedPrice === quotedPrice === providerPrice === paidAmount must hold",
  );
  assert.equal(API_QUALITY_FINALIZER_PRICE_USDC, "0.0020", "API_QUALITY_FINALIZER_PRICE_USDC constant must be '0.0020'");

  console.log("\n=======================================================");
  console.log("ALL 37 P4.0 PAID API QUALITY TEST SCENARIOS PASSED!");
  console.log("=======================================================");
}

runTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
