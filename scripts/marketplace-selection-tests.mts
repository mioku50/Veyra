/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  atomicToUsdc,
  buildMarketplaceDiscoveryUrl,
  discoverMarketplaceCandidates,
  marketplaceCapabilities,
  normalizeMarketplaceItem,
  normalizeMarketplaceNetwork,
  MarketplaceDiscoveryError,
} from "../lib/counterparty-selection/marketplace-source.ts";
import {
  buildMarketplaceTrustDecision,
  marketplaceEvidenceCoverage,
  probeExpectationFor,
  selectMarketplaceCounterparty,
  validateMarketplaceSelectionRequest,
  MARKETPLACE_EVIDENCE_DIMENSIONS,
} from "../lib/counterparty-selection/marketplace.ts";
import { MARKETPLACE_RANKING_WEIGHTS } from "../lib/counterparty-selection/policy.ts";
import { CounterpartySelectionError } from "../lib/counterparty-selection/service.ts";
import {
  buildX402ProbeEvidence,
  compareChallengeToCatalog,
  decodePaymentRequiredHeader,
  parseChallengeAccepts,
  probeX402Resource,
} from "../lib/providers/x402-probe.ts";
import { recordApiQualityObservation } from "../lib/providers/api-quality.ts";
import { buildClearanceMessage } from "../lib/trust-gate/sign.ts";
import type { SelectionTenant } from "../lib/counterparty-selection/types.ts";

const REQUESTER = "0x00000000000000000000000000000000000000aa" as const;
const PAY_TO = "0x6302D9e6DBB22fEC3c350551568Bb39B4b35Ad57";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = "eip155:8453";

const tenant: SelectionTenant = { tenantKey: "test", requesterWallet: REQUESTER };

function catalogItem(overrides: Record<string, unknown> = {}) {
  return {
    resource: "https://research.example.com/v1/market-research",
    type: "http",
    x402Version: 2,
    lastUpdated: "2026-08-28T14:37:34.535Z",
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        asset: USDC_BASE,
        payTo: PAY_TO,
        amount: "10000",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
    metadata: {
      provider: {
        name: "Example Research",
        website: "https://example.com",
        docsUrl: "https://docs.example.com",
        description: "Market research",
        category: "WEB_SEARCH_RESEARCH",
        tags: ["market_research", "x402"],
      },
      path: "/v1/market-research",
      method: "POST",
      description: "Market research report",
      mimeType: "application/json",
      input: { body: { type: "object", properties: {} }, type: "http", method: "POST" },
      output: { type: "object" },
      siwx: false,
      supportsVanillax402: true,
      supportsCircleGateway: true,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Discovery source normalization
// ---------------------------------------------------------------------------

assert.equal(atomicToUsdc("10000"), 0.01, "10000 atomic units is one cent");
assert.equal(atomicToUsdc("1"), 0.000001);
assert.ok(Number.isNaN(atomicToUsdc("1.5")), "Fractional atomic amounts are not valid wire values");
assert.ok(Number.isNaN(atomicToUsdc(undefined)));

assert.equal(normalizeMarketplaceNetwork("base"), "eip155:8453");
assert.equal(normalizeMarketplaceNetwork(undefined), "eip155:8453");
assert.throws(
  () => normalizeMarketplaceNetwork("eip155:5042002"),
  (error: unknown) => error instanceof MarketplaceDiscoveryError,
  "Arc must be rejected explicitly: the Circle catalog publishes zero Arc resources",
);

const normalized = normalizeMarketplaceItem(catalogItem(), {
  capability: "market_research",
  network: NETWORK,
})!;
assert.ok(normalized, "A well-formed catalog item normalizes");
assert.equal(normalized.priceUsdc, 0.01);
assert.equal(normalized.method, "POST");
assert.equal(normalized.declaresInputSchema, true);
assert.equal(normalized.declaresOutputSchema, true);
assert.equal(normalized.capabilityMatch, "exact", "market_research tag is an exact capability match");
assert.ok(normalized.candidateId.startsWith("x402:"));

assert.equal(
  normalizeMarketplaceItem(catalogItem({ resource: "http://insecure.example.com/x" }), {
    capability: "market_research", network: NETWORK,
  }),
  null,
  "Plaintext HTTP resources are dropped at the source",
);
assert.equal(
  normalizeMarketplaceItem(catalogItem({ accepts: [] }), { capability: "market_research", network: NETWORK }),
  null,
  "An item with no accepts on the requested network is unusable",
);

const priceChanged = normalizeMarketplaceItem(
  catalogItem({ accepts: [{ ...catalogItem().accepts[0], amount: "20000" }] }),
  { capability: "market_research", network: NETWORK },
)!;
assert.notEqual(
  normalized.catalogHash,
  priceChanged.catalogHash,
  "Catalog hash must move when the advertised price moves",
);

assert.deepEqual(
  marketplaceCapabilities({ category: "WEB SEARCH RESEARCH", tags: ["Market-Research"], path: "/v1/reports" }),
  ["web_search_research", "market_research", "v1", "reports"],
);
assert.deepEqual(
  marketplaceCapabilities({ category: "x", tags: ["a"], path: "/b" }),
  [],
  "Single-character path and tag fragments are noise, not capabilities",
);

const url = new URL(buildMarketplaceDiscoveryUrl({
  query: "market research", network: NETWORK, limit: 5, maxPriceUsdc: 0.02,
}));
assert.equal(url.searchParams.get("siwx"), "false", "SIWX endpoints can never be paid by an agent");
assert.equal(url.searchParams.get("network"), NETWORK);
assert.equal(url.searchParams.get("maxUsdPrice"), "0.02");

// ---------------------------------------------------------------------------
// Discovery filtering (stubbed catalog)
// ---------------------------------------------------------------------------

function stubCatalog(items: unknown[]) {
  return (async () => new Response(
    JSON.stringify({ x402Version: 2, items, pagination: { total: items.length } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;
}

const discovery = await discoverMarketplaceCandidates({
  capability: "market_research",
  network: NETWORK,
  maxPriceUsdc: 0.02,
  limit: 5,
  fetchImpl: stubCatalog([
    catalogItem(),
    catalogItem({
      resource: "https://expensive.example.com/v1/market-research",
      accepts: [{ ...catalogItem().accepts[0], amount: "5000000" }],
    }),
    catalogItem({
      resource: "https://unrelated.example.com/v1/weather",
      metadata: { ...catalogItem().metadata, provider: { name: "W", tags: [], category: "WEATHER" }, path: "/v1/weather" },
    }),
  ]),
});
assert.equal(discovery.candidates.length, 2, "The over-budget endpoint is filtered out by price");
assert.ok(
  discovery.candidates.every((candidate) => candidate.priceUsdc <= 0.02),
  "No candidate above the price ceiling survives discovery",
);
assert.equal(discovery.candidates[0].resource, "https://research.example.com/v1/market-research");
assert.equal(discovery.candidates[0].capabilityMatch, "exact", "Exact capability matches rank first");
assert.equal(discovery.candidates[1].capabilityMatch, "generic", "A weather endpoint is a generic, not exact, match");
assert.equal(discovery.readOnly, true);
assert.equal(discovery.paymentCreated, false);

await assert.rejects(
  () => discoverMarketplaceCandidates({ capability: "market_research", limit: 999, fetchImpl: stubCatalog([]) }),
  (error: unknown) => error instanceof MarketplaceDiscoveryError && error.code === "marketplace_limit_invalid",
);

// ---------------------------------------------------------------------------
// x402 probe
// ---------------------------------------------------------------------------

function stubChallenge(body: unknown, status = 402) {
  return async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "content-type": "application/json" } },
  );
}

const matchingChallenge = {
  x402Version: 2,
  accepts: [{ scheme: "exact", network: NETWORK, asset: USDC_BASE, payTo: PAY_TO, amount: "10000" }],
};

assert.equal(parseChallengeAccepts(matchingChallenge)!.length, 1);
assert.equal(parseChallengeAccepts({ nope: true }), null);

const expectation = probeExpectationFor(normalized);
const cleanProbe = await probeX402Resource(expectation, { fetchImpl: stubChallenge(matchingChallenge) });
assert.equal(cleanProbe.respondedWith402, true);
assert.equal(cleanProbe.criticalFailure, null);
assert.equal(cleanProbe.catalogDrift.length, 0);
assert.equal(cleanProbe.integrityScore, 100, "A fully conformant endpoint scores 100 on integrity");
assert.equal(cleanProbe.observation.source, "x402_discovery_probe");
assert.equal(cleanProbe.observation.paymentSettled, null, "A probe never settles a payment");
assert.equal(cleanProbe.observation.paidAmountUsdc, null, "A probe never pays");

const driftedProbe = await probeX402Resource(expectation, {
  fetchImpl: stubChallenge({
    x402Version: 2,
    accepts: [{ scheme: "exact", network: NETWORK, asset: USDC_BASE, payTo: PAY_TO, amount: "990000" }],
  }),
});
assert.deepEqual(driftedProbe.catalogDrift, ["price_changed"]);
assert.equal(driftedProbe.criticalFailure, "accepts_matches_catalog");
assert.equal(driftedProbe.integrityScore, 0, "Price drift between catalog and live challenge is disqualifying");

const payeeDrift = await probeX402Resource(expectation, {
  fetchImpl: stubChallenge({
    accepts: [{ scheme: "exact", network: NETWORK, asset: USDC_BASE, payTo: "0x1111111111111111111111111111111111111111", amount: "10000" }],
  }),
});
assert.ok(payeeDrift.catalogDrift.includes("payto_changed"), "A changed payee is drift, not a detail");
assert.equal(payeeDrift.integrityScore, 0);

// Real x402 v2 sellers return an empty body and carry the challenge in the
// `payment-required` header. The probe must read it there.
const headerChallenge = Buffer.from(JSON.stringify(matchingChallenge), "utf8").toString("base64");
const headerProbe = await probeX402Resource(expectation, {
  fetchImpl: async () => new Response("{}", {
    status: 402,
    headers: { "content-type": "application/json", "payment-required": headerChallenge },
  }),
});
assert.equal(headerProbe.challengeTransport, "payment_required_header");
assert.equal(headerProbe.criticalFailure, null, "A header-carried challenge is a conformant challenge");
assert.equal(headerProbe.integrityScore, 100);
assert.equal(cleanProbe.challengeTransport, "response_body");
assert.equal(
  decodePaymentRequiredHeader("not-base64-@@@"),
  null,
  "A malformed payment-required header decodes to nothing rather than throwing",
);

// Gateway-batched accepts legitimately publish a week-long window.
const gatewayProbe = await probeX402Resource(
  { ...expectation, gatewayBatched: true, maxTimeoutSeconds: 604_900 },
  { fetchImpl: stubChallenge(matchingChallenge) },
);
assert.equal(
  gatewayProbe.checks.find((check) => check.id === "timeout_window_sane")!.passed,
  true,
  "A Gateway-batched authorization window must not be scored as anomalous",
);
const vanillaLongWindow = await probeX402Resource(
  { ...expectation, gatewayBatched: false, maxTimeoutSeconds: 604_900 },
  { fetchImpl: stubChallenge(matchingChallenge) },
);
assert.equal(
  vanillaLongWindow.checks.find((check) => check.id === "timeout_window_sane")!.passed,
  false,
  "A week-long window on a vanilla accept is still anomalous",
);

const failedLatencyProbe = await probeX402Resource(expectation, {
  fetchImpl: async () => { throw new Error("boom"); },
});
assert.ok(
  (cleanProbe.latencyMs ?? -1) >= 0 && (failedLatencyProbe.latencyMs ?? -1) >= 0,
  "Latency is measured on a monotonic clock and can never come back negative",
);

const notPaid = await probeX402Resource(expectation, { fetchImpl: stubChallenge({ ok: true }, 200) });
assert.equal(notPaid.criticalFailure, "x402_challenge_returned");
assert.equal(notPaid.integrityScore, 0);

const unreachable = await probeX402Resource(expectation, {
  fetchImpl: async () => { throw new Error("network unreachable"); },
});
assert.equal(unreachable.reachable, false);
assert.equal(unreachable.criticalFailure, "endpoint_reachable");
assert.equal(unreachable.errorCategory, "network");

const siwxProbe = await probeX402Resource(
  { ...expectation, siwx: true },
  { fetchImpl: stubChallenge(matchingChallenge) },
);
assert.equal(siwxProbe.criticalFailure, "automatable_without_siwx");

assert.deepEqual(
  compareChallengeToCatalog([{ network: "eip155:137", payTo: PAY_TO, asset: USDC_BASE, amount: "10000" }], expectation).drift,
  ["network_absent_from_challenge"],
);

// ---------------------------------------------------------------------------
// Evidence honesty
// ---------------------------------------------------------------------------

const evidence = buildX402ProbeEvidence([cleanProbe]);
assert.equal(evidence.integrityScore, 100);
assert.equal(
  evidence.statisticalEvidenceAvailable,
  false,
  "One probe is not a statistical history and must not claim to be",
);
assert.equal(evidence.qualityScore.status, "Insufficient data");
assert.equal(evidence.qualityScore.overallScore, null);
assert.equal(evidence.qualityScore.confidenceLevel, "low");

const coverage = marketplaceEvidenceCoverage(evidence);
assert.deepEqual(coverage.observed, ["protocol_integrity", "catalog_integrity"]);
assert.equal(coverage.coverage, 2 / MARKETPLACE_EVIDENCE_DIMENSIONS.length);
assert.ok(
  coverage.missing.includes("veyra_reputation") && coverage.missing.includes("erc8183_execution"),
  "Missing evidence dimensions are reported, never silently dropped",
);

await assert.rejects(
  () => recordApiQualityObservation(cleanProbe.observation),
  /cannot be persisted/,
  "Discovery probes must never be written into the seller quality store",
);

// ---------------------------------------------------------------------------
// Policy: a first-contact marketplace endpoint can never reach ALLOW
// ---------------------------------------------------------------------------

function decisionFor(integrityScore: number, requestedValueUsdc = 0.01) {
  return buildMarketplaceTrustDecision({
    requesterWallet: REQUESTER,
    payTo: PAY_TO as `0x${string}`,
    candidate: normalized,
    integrityScore,
    coverage: coverage.coverage,
    confidence: 0.3,
    evidenceHash: cleanProbe.observation.observationId as unknown as `0x${string}`,
    capability: "market_research",
    requestedValueUsdc,
    issuedAt: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-08-30T00:05:00.000Z",
    riskSignals: [],
  });
}

const perfect = decisionFor(100);
assert.equal(perfect.decision, "REQUIRE_EVALUATOR", "No Arc history caps a perfect probe at REQUIRE_EVALUATOR");
assert.notEqual(perfect.decision, "ALLOW");
assert.equal(perfect.policy.maxValueUsdc, 10);
assert.ok(perfect.riskSignals.includes("NO_REPUTATION_DATA"));
assert.equal(perfect.request.action, "x402_payment");
assert.ok(
  perfect.request.workflowType!.startsWith("counterparty_selection:marketplace:"),
  "The workflow binding must reach the EIP-712 actionHash",
);

assert.equal(decisionFor(0).decision, "DENY", "A failed probe denies");
assert.equal(decisionFor(40).policy.maxValueUsdc, 0, "A weak probe cannot authorize any exposure");
assert.equal(
  decisionFor(100, 50).decision,
  "DENY",
  "A request above the tier ceiling denies rather than silently downgrading",
);

// Clearance binding: the same decision against a different resource must not
// produce a replayable authorization.
const otherCandidate = normalizeMarketplaceItem(
  catalogItem({ resource: "https://other.example.com/v1/market-research" }),
  { capability: "market_research", network: NETWORK },
)!;
const otherDecision = buildMarketplaceTrustDecision({
  requesterWallet: REQUESTER,
  payTo: PAY_TO as `0x${string}`,
  candidate: otherCandidate,
  integrityScore: 100,
  coverage: coverage.coverage,
  confidence: 0.3,
  evidenceHash: cleanProbe.observation.observationId as unknown as `0x${string}`,
  capability: "market_research",
  requestedValueUsdc: 0.01,
  issuedAt: "2026-08-30T00:00:00.000Z",
  expiresAt: "2026-08-30T00:05:00.000Z",
  riskSignals: [],
});
assert.notEqual(
  buildClearanceMessage(perfect).actionHash,
  buildClearanceMessage(otherDecision).actionHash,
  "A clearance for one resource must not be replayable against another",
);
assert.equal(
  buildClearanceMessage(perfect).maxAmount,
  10_000_000n,
  "An unbounded decision carries the policy tier ceiling in USDC base units",
);
// The signed artifact must never authorize more than the verdict recommends:
// the recommended exposure is min(caller budget, tier ceiling).
const boundedDecision = {
  ...perfect,
  policy: { ...perfect.policy, maxValueUsdc: 0.02 },
};
assert.equal(
  buildClearanceMessage(boundedDecision).maxAmount,
  20_000n,
  "A clearance signs the recommended exposure, not the tier ceiling",
);
assert.equal(buildClearanceMessage(boundedDecision).requestedAmount, 10_000n);

// ---------------------------------------------------------------------------
// Weight profile
// ---------------------------------------------------------------------------

assert.equal(
  Object.values(MARKETPLACE_RANKING_WEIGHTS).reduce((sum, weight) => sum + weight, 0),
  1,
  "Marketplace weights must still form a complete distribution",
);
assert.equal(MARKETPLACE_RANKING_WEIGHTS.reputationQuality, 0);
assert.equal(MARKETPLACE_RANKING_WEIGHTS.executionReliability, 0);

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

assert.throws(
  () => validateMarketplaceSelectionRequest({ capability: "market_research", budgetUsdc: 0.01, publishProof: true }),
  (error: unknown) => error instanceof CounterpartySelectionError && error.code === "client_derived_fields_forbidden",
);
assert.throws(
  () => validateMarketplaceSelectionRequest({ capability: "market_research", budgetUsdc: -1 }),
  (error: unknown) => error instanceof CounterpartySelectionError && error.code === "budget_invalid",
);
assert.throws(
  () => validateMarketplaceSelectionRequest({ capability: "market_research", budgetUsdc: 1, network: "eip155:5042002" }),
  (error: unknown) => error instanceof CounterpartySelectionError && error.code === "network_unsupported",
);

// ---------------------------------------------------------------------------
// End-to-end selection (stubbed catalog + stubbed probes, no clearance signing)
// ---------------------------------------------------------------------------

const selection = await selectMarketplaceCounterparty({
  request: { capability: "market_research", budgetUsdc: 0.05, maxPriceUsdc: 0.02, limit: 5 },
  tenant,
  issueClearance: false,
  fetchImpl: stubCatalog([
    catalogItem(),
    catalogItem({
      resource: "https://noschema.example.com/v1/market-research",
      metadata: { ...catalogItem().metadata, output: undefined, input: undefined, docsUrl: undefined },
    }),
  ]),
  probeFetchImpl: stubChallenge(matchingChallenge) as unknown as (url: string, init: RequestInit) => Promise<Response>,
});

assert.equal(selection.settlementNetworkIsArc, false, "Marketplace settlement is off-Arc and says so");
assert.equal(selection.network, NETWORK);
assert.ok(selection.candidates.length >= 1);
assert.equal(selection.candidates[0].rank, 1);
assert.equal(selection.candidates[0].evidenceLimits.arcProofBacked, false);
assert.equal(selection.candidates[0].evidenceLimits.veyraReputationRecords, 0);
assert.ok(
  selection.candidates[0].rankingScore < 90,
  "An unproven counterparty must never reach a near-perfect ranking score",
);
const unbackedDimensions = ["reputationQuality", "executionReliability", "evaluatorSuccess", "economicReliability"];
assert.ok(
  selection.candidates.every((candidate) =>
    candidate.dimensions
      .filter((dimension) => unbackedDimensions.includes(dimension.name))
      .every((dimension) => dimension.score === 0 && dimension.weight === 0)),
  "Dimensions with no evidence must score zero and carry zero weight, never borrow a score",
);
assert.ok(
  selection.candidates.every((candidate) =>
    candidate.dimensions
      .filter((dimension) => ["executionReliability", "evaluatorSuccess", "economicReliability"].includes(dimension.name))
      .every((dimension) => dimension.evidenceCount === 0)),
  "Execution, evaluator and economic evidence counts must report the true zero",
);
assert.ok(
  selection.candidates.every((candidate) => candidate.evidenceLimits.veyraReputationRecords === 0),
  "The response must state outright that no Veyra reputation record backs the candidate",
);
assert.equal(
  selection.recommendation.granted,
  false,
  "Without a signed clearance the verdict is not granted - fail closed",
);
assert.equal(selection.recommendation.postCallVerificationRequired, true);
assert.ok(
  selection.recommendation.maxExposureUsdc <= selection.requestedBudgetUsdc,
  "Recommended exposure can never exceed the caller's own budget",
);
assert.ok(
  selection.candidates.every((candidate) =>
    candidate.recommendedMaxExposureUsdc <= candidate.policyMaxExposureUsdc),
  "Recommended exposure can never exceed the policy tier ceiling",
);
assert.ok(selection.canonicalHash.startsWith("0x"));

const replay = await selectMarketplaceCounterparty({
  request: { capability: "market_research", budgetUsdc: 0.05, maxPriceUsdc: 0.02, limit: 5 },
  tenant,
  issueClearance: false,
  now: new Date("2026-08-30T00:00:00.000Z"),
  fetchImpl: stubCatalog([catalogItem()]),
  probeFetchImpl: stubChallenge(matchingChallenge) as unknown as (url: string, init: RequestInit) => Promise<Response>,
});
const replayAgain = await selectMarketplaceCounterparty({
  request: { capability: "market_research", budgetUsdc: 0.05, maxPriceUsdc: 0.02, limit: 5 },
  tenant,
  issueClearance: false,
  now: new Date("2026-08-30T00:00:00.000Z"),
  fetchImpl: stubCatalog([catalogItem()]),
  probeFetchImpl: stubChallenge(matchingChallenge) as unknown as (url: string, init: RequestInit) => Promise<Response>,
});
assert.deepEqual(
  replay.candidates.map((item) => [item.rank, item.rankingScore, item.evidenceHash]),
  replayAgain.candidates.map((item) => [item.rank, item.rankingScore, item.evidenceHash]),
  "Ranking must be deterministic for identical canonical evidence",
);

const empty = await selectMarketplaceCounterparty({
  request: { capability: "market_research", budgetUsdc: 0.05 },
  tenant,
  issueClearance: false,
  fetchImpl: stubCatalog([]),
});
assert.equal(empty.candidates.length, 0);
assert.equal(empty.recommendation.granted, false);
assert.equal(empty.recommendation.reason, "no_candidates_discovered");

console.log("Marketplace selection tests passed.");
