/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Veyra benchmark runner.
 *
 * Exercises the production decision path against outcomes fixed in
 * `ground-truth.json` before the run. Nothing here reimplements Veyra's logic:
 * the probe, the policy resolver and the ranking engine are the same modules
 * the API serves from. What the harness controls is the *input* - a scripted
 * HTTP response standing in for a seller that is dead, or has quietly changed
 * its price since Circle indexed it.
 *
 *   node --experimental-transform-types --no-warnings benchmarks/run.mts
 *
 * Results are written under benchmarks/results/<timestamp>/ as raw JSONL plus a
 * summary. Raw output is committed: a benchmark whose inputs cannot be
 * re-examined is a claim, not a measurement.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rankCounterparties, rankCounterpartyCandidate } from "../lib/counterparty-selection/engine.ts";
import { COUNTERPARTY_SELECTION_POLICY } from "../lib/counterparty-selection/policy.ts";
import type { CandidateRankingInput, CandidateEvidence, CanonicalCandidateIdentity } from "../lib/counterparty-selection/types.ts";
import { probeX402Resource, type X402ProbeExpectation } from "../lib/providers/x402-probe.ts";
import { resolvePolicy } from "../lib/trust-gate/policy.ts";
import type { TrustDecision, TrustDecisionLevel, TrustRiskCode } from "../lib/trust-gate/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const GROUND_TRUTH = JSON.parse(readFileSync(resolve(ROOT, "benchmarks/ground-truth.json"), "utf8"));

/* -------------------------------------------------------------------------- */
/* Catalog entry the scripted sellers are compared against                     */
/* -------------------------------------------------------------------------- */

const CATALOG_PAYTO = "0x1111111111111111111111111111111111111111";
const CATALOG_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const CATALOG_AMOUNT = "10000"; // 0.01 USDC, 6 decimals

const CATALOG: X402ProbeExpectation = {
  candidateId: "bench_candidate",
  resource: "https://benchmark.veyra.invalid/v1/research",
  method: "POST",
  network: "eip155:8453",
  payTo: CATALOG_PAYTO,
  asset: CATALOG_ASSET,
  amountAtomic: CATALOG_AMOUNT,
  priceUsdc: 0.01,
  maxTimeoutSeconds: 300,
  siwx: false,
  supportsVanillaX402: true,
  supportsCircleGateway: true,
  gatewayBatched: true,
  declaresInputSchema: true,
  declaresOutputSchema: true,
  docsUrl: null,
};

function substitute(value: unknown): unknown {
  if (value === "CATALOG_PAYTO") return CATALOG_PAYTO;
  if (value === "CATALOG_ASSET") return CATALOG_ASSET;
  if (value === "CATALOG_AMOUNT") return CATALOG_AMOUNT;
  return value;
}

/** Turns a ground-truth `behaviour` block into the seller it describes. */
function sellerFor(behaviour: any): (url: string, init: RequestInit) => Promise<Response> {
  return async () => {
    if (behaviour.kind === "throw") {
      throw new Error(behaviour.message);
    }
    if (behaviour.kind === "respond") {
      return new Response(behaviour.body, { status: behaviour.status });
    }
    const accepts = (behaviour.accepts as Array<Record<string, unknown>>).map((accept) =>
      Object.fromEntries(Object.entries(accept).map(([k, v]) => [k, substitute(v)])));
    const challenge = { x402Version: 2, accepts };
    if (behaviour.transport === "header") {
      return new Response("{}", {
        status: behaviour.status,
        headers: {
          "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
          "content-type": "application/json",
        },
      });
    }
    return new Response(JSON.stringify(challenge), {
      status: behaviour.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

type Check = { field: string; expected: unknown; actual: unknown; pass: boolean };

function check(field: string, expected: unknown, actual: unknown): Check {
  return { field, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) };
}

/* -------------------------------------------------------------------------- */
/* Part A - probe classification                                               */
/* -------------------------------------------------------------------------- */

async function runProbeCases() {
  const rows: any[] = [];
  for (const testCase of GROUND_TRUTH.probeCases) {
    const started = performance.now();
    const result = await probeX402Resource(CATALOG, { fetchImpl: sellerFor(testCase.behaviour) });
    const harnessMs = Math.round(performance.now() - started);

    const e = testCase.expect;
    const checks: Check[] = [];
    if ("reachable" in e) checks.push(check("reachable", e.reachable, result.reachable));
    if ("respondedWith402" in e) checks.push(check("respondedWith402", e.respondedWith402, result.respondedWith402));
    if ("challengeParseable" in e) checks.push(check("challengeParseable", e.challengeParseable, result.challengeParseable));
    if ("errorCategory" in e) checks.push(check("errorCategory", e.errorCategory, result.errorCategory));
    if ("criticalFailureNotNull" in e) {
      checks.push(check("criticalFailureNotNull", e.criticalFailureNotNull, result.criticalFailure !== null));
    }
    if ("driftEmpty" in e) checks.push(check("catalogDrift", [], result.catalogDrift));
    if ("driftIncludes" in e) {
      for (const code of e.driftIncludes as string[]) {
        checks.push(check(`drift:${code}`, true, result.catalogDrift.includes(code)));
      }
    }
    if ("maxIntegrityScore" in e) {
      checks.push({
        field: "integrityScore<=max",
        expected: `<= ${e.maxIntegrityScore}`,
        actual: result.integrityScore,
        pass: result.integrityScore <= e.maxIntegrityScore,
      });
    }

    rows.push({
      part: "probe",
      id: testCase.id,
      condition: testCase.condition,
      pass: checks.every((c) => c.pass),
      checks,
      harnessMs,
      observed: {
        reachable: result.reachable,
        httpStatus: result.httpStatus,
        respondedWith402: result.respondedWith402,
        challengeParseable: result.challengeParseable,
        catalogDrift: result.catalogDrift,
        criticalFailure: result.criticalFailure,
        integrityScore: result.integrityScore,
        errorCategory: result.errorCategory,
        observedPriceUsdc: result.observedPriceUsdc,
        observedPayTo: result.observedPayTo,
        failedChecks: result.checks.filter((c) => !c.passed).map((c) => c.id),
      },
    });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Part B - policy tiers                                                       */
/* -------------------------------------------------------------------------- */

function runPolicyCases() {
  return GROUND_TRUTH.policyCases.map((testCase: any) => {
    const { score, confidence, coverage, freshnessSeconds, riskFlags } = testCase.input;
    const started = performance.now();
    const { tier } = resolvePolicy(score, confidence, coverage, freshnessSeconds, riskFlags as TrustRiskCode[]);
    const elapsedMs = performance.now() - started;

    const e = testCase.expect;
    const checks: Check[] = [check("decision", e.decision, tier.level)];
    if ("evaluatorRequired" in e) checks.push(check("evaluatorRequired", e.evaluatorRequired, tier.evaluatorRequired));
    if ("maxValueUsdc" in e) checks.push(check("maxValueUsdc", e.maxValueUsdc, tier.maxValueUsdc));
    if ("notDecision" in e) {
      for (const forbidden of e.notDecision as string[]) {
        checks.push({
          field: `never:${forbidden}`,
          expected: `not ${forbidden}`,
          actual: tier.level,
          pass: tier.level !== forbidden,
        });
      }
    }

    return {
      part: "policy",
      id: testCase.id,
      pass: checks.every((c) => c.pass),
      checks,
      elapsedMs,
      observed: { decision: tier.level, evaluatorRequired: tier.evaluatorRequired, maxValueUsdc: tier.maxValueUsdc },
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Part C - budget and exposure                                                */
/* -------------------------------------------------------------------------- */

function identity(id: string): CanonicalCandidateIdentity {
  return {
    agentId: id,
    ownerAddress: "0x2222222222222222222222222222222222222222",
    registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    metadataUri: "https://benchmark.veyra.invalid/agent.json",
    serviceIds: [],
    source: "circle_marketplace",
    verifiedOnchain: false,
  };
}

function evidenceFor(id: string): CandidateEvidence {
  return {
    identity: identity(id),
    snapshotHash: "0x00",
    snapshotCreatedAt: new Date().toISOString(),
    trustScore: 80,
    snapshotConfidence: 70,
    snapshotCoverage: 0.33,
    dimensions: {
      reputationQuality: 0, executionReliability: 0, evaluatorSuccess: 0,
      economicReliability: 0, serviceQuality: 80,
    },
    evidenceCounts: {
      total: 1, execution: 0, evaluator: 0, economic: 0,
      serviceQuality: 1, independentCounterparties: 0,
    },
    sources: [{ source: "x402_probe", freshness: "fresh", count: 1 } as any],
    riskSignals: [],
    positiveSignals: ["live endpoint verified"],
    services: [],
    evidenceHash: "0x00",
  } as unknown as CandidateEvidence;
}

/** Only the fields the engine actually reads are populated; the rest of a real
 *  TrustDecision is signing metadata that plays no part in eligibility. */
function trustDecision(level: TrustDecisionLevel, maxValueUsdc: number): TrustDecision {
  return {
    decisionId: "bench",
    decision: level,
    policy: { maxValueUsdc, evaluatorRequired: level !== "ALLOW" },
    reasons: [],
    riskSignals: [],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  } as unknown as TrustDecision;
}

function runBudgetCases() {
  return GROUND_TRUTH.budgetCases
    .filter((testCase: any) => testCase.id)
    .map((testCase: any) => {
      const { priceUsdc, budgetUsdc, tierMaxValueUsdc, decision } = testCase.input;
      const level: TrustDecisionLevel = decision ?? "REQUIRE_EVALUATOR";

      const input: CandidateRankingInput = {
        identity: identity(testCase.id),
        evidence: evidenceFor(testCase.id),
        trustDecision: trustDecision(level, tierMaxValueUsdc),
        requestedBudgetUsdc: budgetUsdc,
        capability: "market_research",
        capabilityMatch: "exact",
        requireExactCapability: false,
        advertisedPriceUsdc: priceUsdc,
        priceKind: "advertised",
        weights: COUNTERPARTY_SELECTION_POLICY.weights,
      };

      const ranked = rankCounterpartyCandidate(input);
      const executable = ["ELIGIBLE", "ELIGIBLE_WITH_LIMITS", "REQUIRES_EVALUATOR"].includes(ranked.eligibility);

      const e = testCase.expect;
      const checks: Check[] = [check("eligible", e.eligible, executable)];
      if ("maxExposureUsdc" in e) {
        checks.push(check("maxExposureUsdc", e.maxExposureUsdc, ranked.recommendedMaxExposureUsdc));
      }
      if ("reason" in e) checks.push(check("reason", e.reason, ranked.rejectionReason));

      return {
        part: "budget",
        id: testCase.id,
        pass: checks.every((c) => c.pass),
        checks,
        observed: {
          eligibility: ranked.eligibility,
          rejectionReason: ranked.rejectionReason ?? null,
          recommendedMaxExposureUsdc: ranked.recommendedMaxExposureUsdc,
          policyMaxExposureUsdc: ranked.policyMaxExposureUsdc,
        },
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Part D - decision latency                                                   */
/* -------------------------------------------------------------------------- */

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function runDecisionLatency(candidateCount: number, iterations: number) {
  const inputs: CandidateRankingInput[] = Array.from({ length: candidateCount }, (_, i) => ({
    identity: identity(`bench_${i}`),
    evidence: evidenceFor(`bench_${i}`),
    trustDecision: trustDecision("REQUIRE_EVALUATOR", 10),
    requestedBudgetUsdc: 0.1,
    capability: "market_research",
    capabilityMatch: "exact",
    requireExactCapability: false,
    advertisedPriceUsdc: 0.01 + i * 0.002,
    priceKind: "advertised",
    weights: COUNTERPARTY_SELECTION_POLICY.weights,
  }));

  // Warm the JIT so the reported figures describe steady state rather than
  // first-call compilation.
  for (let i = 0; i < 50; i += 1) rankCounterparties(inputs);

  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    rankCounterparties(inputs);
    resolvePolicy(85, 0.7, 0.33, 0, []);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);

  return {
    candidateCount,
    iterations,
    unit: "ms",
    p50: Number(percentile(samples, 50).toFixed(3)),
    p95: Number(percentile(samples, 95).toFixed(3)),
    p99: Number(percentile(samples, 99).toFixed(3)),
    min: Number(samples[0].toFixed(3)),
    max: Number(samples[samples.length - 1].toFixed(3)),
  };
}

/* -------------------------------------------------------------------------- */

async function main() {
  const startedAt = new Date();
  const probe = await runProbeCases();
  const policy = runPolicyCases();
  const budget = runBudgetCases();
  const all = [...probe, ...policy, ...budget];

  const decisionLatency = [2, 6, 25].map((n) => runDecisionLatency(n, 2000));

  const byCondition: Record<string, { total: number; passed: number }> = {};
  for (const row of probe) {
    const bucket = byCondition[row.condition] ??= { total: 0, passed: 0 };
    bucket.total += 1;
    if (row.pass) bucket.passed += 1;
  }

  const summary = {
    schemaVersion: "veyra.benchmark.summary.v1",
    groundTruthVersion: GROUND_TRUTH.schemaVersion,
    groundTruthDefinedAt: GROUND_TRUTH.definedAt,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    node: process.version,
    totals: {
      cases: all.length,
      passed: all.filter((r) => r.pass).length,
      failed: all.filter((r) => !r.pass).length,
    },
    byPart: {
      probe: { total: probe.length, passed: probe.filter((r) => r.pass).length },
      policy: { total: policy.length, passed: policy.filter((r: any) => r.pass).length },
      budget: { total: budget.length, passed: budget.filter((r: any) => r.pass).length },
    },
    probeByCondition: byCondition,
    unsafeConditionsCaught: {
      note: "Conditions that must never reach an agent's wallet unflagged.",
      deadEndpoints: probe.filter((r) => r.condition === "dead_endpoint" && r.pass).length,
      protocolViolations: probe.filter((r) => r.condition === "protocol_violation" && r.pass).length,
      priceDrift: probe.filter((r) => r.condition === "price_drift" && r.pass).length,
      payeeDrift: probe.filter((r) => r.condition === "payee_drift" && r.pass).length,
      assetDrift: probe.filter((r) => r.condition === "asset_drift" && r.pass).length,
      networkDrift: probe.filter((r) => r.condition === "network_drift" && r.pass).length,
    },
    latency: {
      decision: decisionLatency,
      probe: "Not measured here: the probe is driven by a scripted seller, so its latency describes the harness, not a network. Use --live for observed probe latency.",
      execution: "Measured onchain, not in this harness. See docs/PROOF_OF_LIVE_ERC8183.md - job #186207 settled in 19 s across five transactions.",
    },
  };

  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const dir = resolve(ROOT, "benchmarks/results", stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "raw.jsonl"), all.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  for (const row of all) {
    const mark = row.pass ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${row.part}/${row.id}`);
    if (!row.pass) {
      for (const c of row.checks.filter((c: Check) => !c.pass)) {
        console.log(`         ${c.field}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`);
      }
    }
  }
  console.log();
  console.log(`  cases      ${summary.totals.passed}/${summary.totals.cases} passed`);
  for (const row of decisionLatency) {
    console.log(`  decision   ${String(row.candidateCount).padStart(2)} candidates  p50 ${row.p50} ms  p95 ${row.p95} ms`);
  }
  console.log(`  results    benchmarks/results/${stamp}/`);

  process.exit(summary.totals.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
