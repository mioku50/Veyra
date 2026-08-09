import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AgentTrustInputError,
  canonicalAgentTrustInput,
  normalizeAgentTrustInput,
} from "../lib/agent-trust/input.ts";
import { snapshotArcContract } from "../lib/agent-trust/contract.ts";
import { snapshotEndpointAvailability } from "../lib/agent-trust/endpoint.ts";
import {
  applyAgentTrustVerification,
  buildAgentTrustReport,
} from "../lib/agent-trust/build-report.ts";
import { calculateTrustScore, scoreCategory } from "../lib/agent-trust/scoring.ts";
import { formatAgentTrustReportAsMarkdown } from "../lib/agent-trust/markdown.ts";
import {
  createHostedWorkflowPlan,
  validateHostedWorkflowRequest,
} from "../lib/agent/hosted-workflows.ts";
import { hostedServiceAllowlist } from "../lib/agent/hosted-policy.ts";
import { serviceRegistry } from "../lib/services/registry.ts";
import type {
  AgentTrustSourceSnapshots,
  EvidenceItem,
} from "../lib/agent-trust/types.ts";

const fixedDate = new Date("2026-07-30T12:00:00.000Z");
const checkedAt = fixedDate.toISOString();

function expectInputCode(value: unknown, code: string) {
  assert.throws(
    () => normalizeAgentTrustInput(value),
    (error: unknown) =>
      error instanceof AgentTrustInputError && error.code === code,
  );
}

expectInputCode({}, "agent_trust_input_required");
expectInputCode({ agentWallet: "0xinvalid" }, "invalid_wallet");
assert.equal(
  normalizeAgentTrustInput({
    contractAddress: "0x0000000000000000000000000000000000000002",
  }).contractAddress,
  "0x0000000000000000000000000000000000000002",
);
assert.equal(
  normalizeAgentTrustInput({
    serviceEndpoint: "https://example.com/health",
  }).serviceEndpoint,
  "https://example.com/health",
);
expectInputCode({ repositoryUrl: "https://example.com/not-github" }, "invalid_repository");
expectInputCode(
  { repositoryUrl: "circlefin/agent-commerce", serviceEndpoint: "http://localhost:3000" },
  "endpoint_private_network_blocked",
);
expectInputCode(
  { repositoryUrl: "circlefin/agent-commerce", agentId: "agt_wrong" },
  "agent_not_found",
);
expectInputCode(
  { repositoryUrl: "circlefin/agent-commerce", serviceEndpoint: "https://example.com?api_key=sk-secret-value-123456" },
  "agent_trust_input_required",
);

const normalized = normalizeAgentTrustInput({
  agentWallet: "0x0000000000000000000000000000000000000001",
  repositoryUrl: "circlefin/agent-commerce",
  contractAddress: "0x0000000000000000000000000000000000000002",
  serviceEndpoint: "https://example.com/health",
});
assert.equal(normalized.repositoryUrl, "https://github.com/circlefin/agent-commerce");
assert.deepEqual(
  JSON.parse(canonicalAgentTrustInput(normalized)),
  {
    agentId: null,
    agentWallet: "0x0000000000000000000000000000000000000001",
    repositoryUrl: "https://github.com/circlefin/agent-commerce",
    contractAddress: "0x0000000000000000000000000000000000000002",
    serviceEndpoint: "https://example.com/health",
  },
);

const repositoryRequest = validateHostedWorkflowRequest({
  workflowType: "agent_trust_report",
  agentTrustInput: { repositoryUrl: "circlefin/agent-commerce" },
});
const repositoryPlan = createHostedWorkflowPlan({
  request: repositoryRequest,
  services: serviceRegistry,
  allowlist: hostedServiceAllowlist(),
});
assert.deepEqual(
  repositoryPlan.selectedServices.map((service) => service.slug),
  [
    "github-repository-intelligence",
    "github-due-diligence-analysis",
    "agent-trust-finalizer",
  ],
);
assert.equal(repositoryPlan.estimatedSpendUsdc, 0.0021);
const identityRequest = validateHostedWorkflowRequest({
  workflowType: "agent_trust_report",
  agentTrustInput: { agentId: "agt_0123456789abcdefghij" },
});
const identityPlan = createHostedWorkflowPlan({
  request: identityRequest,
  services: serviceRegistry,
  allowlist: hostedServiceAllowlist(),
});
assert.deepEqual(
  identityPlan.selectedServices.map((service) => service.slug),
  ["text-analyzer", "agent-trust-finalizer"],
);
assert.equal(identityPlan.estimatedSpendUsdc, 0.0004);

const noContract = await snapshotArcContract(undefined, undefined, fixedDate);
assert.equal(noContract.status, "not_provided");
assert.equal(noContract.chainId, 5_042_002);
const missingContract = await snapshotArcContract(
  "0x0000000000000000000000000000000000000002",
  {
    async getBytecode() { return "0x"; },
    async getStorageAt() { return undefined; },
    async readOwner() { return null; },
    async readPaused() { return null; },
  },
  fixedDate,
);
assert.equal(missingContract.status, "not_found");
assert.equal(missingContract.hasBytecode, false);

const liveContract = await snapshotArcContract(
  "0x0000000000000000000000000000000000000002",
  {
    async getBytecode() { return "0x60016000"; },
    async getStorageAt(_address, slot) {
      return slot.startsWith("0x3608")
        ? "0x0000000000000000000000000000000000000000000000000000000000000003"
        : undefined;
    },
    async readOwner() { return "0x0000000000000000000000000000000000000004"; },
    async readPaused() { return false; },
  },
  fixedDate,
);
assert.equal(liveContract.status, "available");
assert.equal(liveContract.proxyDetected, true);
assert.equal(liveContract.upgradeable, true);
assert.equal(liveContract.verificationStatus, "unavailable");

const endpoint = await snapshotEndpointAvailability(
  "https://example.com/health",
  (async () =>
    new Response(null, {
      status: 204,
      headers: { "content-type": "application/json; charset=utf-8" },
    })) as any,
  fixedDate,
);
assert.equal(endpoint.status, "available");
assert.equal(endpoint.httpStatusCategory, "2xx_success");
assert.equal(endpoint.contentType, "application/json");
assert.equal(endpoint.redirectCount, 0);

const evidence: EvidenceItem = {
  id: "ev_test",
  category: "agent_identity",
  signal: "positive",
  title: "Registry",
  detail: "Registered identity.",
  source: "test",
  observedAt: checkedAt,
};
const limited = calculateTrustScore({
  agentIdentity: scoreCategory({
    score: 90,
    confidence: "high",
    summary: "Identity only.",
    positiveSignals: [evidence],
  }),
});
assert.equal(limited.overall, null);
assert.equal(limited.status, "limited_data");
assert(limited.excludedCategories.includes("codeHealth"));

const fullScore = calculateTrustScore({
  codeHealth: scoreCategory({
    score: 80,
    confidence: "high",
    summary: "Code.",
    positiveSignals: [{ ...evidence, category: "code_health" }],
  }),
  agentIdentity: scoreCategory({
    score: 60,
    confidence: "low",
    summary: "Identity.",
    positiveSignals: [evidence],
  }),
});
assert.equal(fullScore.overall, 74);
assert.equal(fullScore.status, "review_recommended");
assert.equal(fullScore.categories.codeHealth?.evidenceCount, 1);

const sources: AgentTrustSourceSnapshots = {
  code: {
    status: "not_provided",
    repository: null,
    snapshot: null,
    assessment: null,
    checkedAt,
  },
  identity: {
    status: "found",
    publicAgentId: "agt_0123456789abcdefghij",
    displayName: "Reference Agent",
    registeredWallet: "0x0000000000000000000000000000000000000001",
    ownerVerified: true,
    agentStatus: "active",
    registeredAt: checkedAt,
    passportPresent: true,
    activeCredentialCount: 1,
    allowedWorkflows: ["agent_trust_report"],
    policy: {
      status: "active",
      maxPricePerRunUsdc: "0.005",
      dailySpendLimitUsdc: "0.05",
      maxDailyCalls: 10,
      allowedServiceTypes: ["internal_deterministic", "live_provider"],
    },
    identifierConflict: false,
    privateAggregatesAuthorized: true,
    checkedAt,
  },
  execution: {
    status: "available",
    completedRuns: 9,
    completedWithWarnings: 1,
    failedRuns: 1,
    successRate: 90,
    verifiedRuns: 8,
    verificationCoverage: 88.89,
    totalPaidUsdc: "0.018",
    averageWorkflowCostUsdc: "0.002",
    lastActivityAt: checkedAt,
    uniqueWorkflowsUsed: 2,
    sellerServicesUsed: 0,
    receiptsCount: 18,
    checkedAt,
  },
  services: {
    status: "not_found",
    publishedServiceCount: 0,
    services: [],
    checkedAt,
  },
  contract: noContract,
  endpoint: {
    status: "not_provided",
    endpoint: null,
    reachable: null,
    httpStatusCategory: null,
    responseTimeMs: null,
    contentType: null,
    checkedAt,
    redirectCount: 0,
    errorCategory: null,
  },
  arcCompliance: {
    status: "clear",
    wallet: "0x0000000000000000000000000000000000000001",
    source: "Arc USDC onchain blocklist",
    checkedAt,
  },
};
const reportA = buildAgentTrustReport({
  reportId: "00000000-0000-4000-8000-000000000001",
  reportInput: {
    agentId: "agt_0123456789abcdefghij",
  },
  sources,
  generatedAt: checkedAt,
});
const reportB = buildAgentTrustReport({
  reportId: "00000000-0000-4000-8000-000000000001",
  reportInput: {
    agentId: "agt_0123456789abcdefghij",
  },
  sources,
  generatedAt: checkedAt,
});
const blocklistedReport = buildAgentTrustReport({
  reportId: "00000000-0000-4000-8000-000000000002",
  reportInput: { agentWallet: "0x0000000000000000000000000000000000000001" },
  sources: {
    ...sources,
    arcCompliance: { ...sources.arcCompliance, status: "blocklisted" },
  },
  generatedAt: checkedAt,
});
assert.equal(blocklistedReport.trustScore.status, "high_attention");
assert.ok((blocklistedReport.trustScore.overall ?? 100) <= 20);
assert.ok(blocklistedReport.risksAndReviewItems.some((item) =>
  item.title === "Arc USDC blocklist restriction"));
assert.deepEqual(reportA, reportB, "same snapshots must produce the same report and score");
assert.match(
  reportA.verification.reportHash,
  /^0x[0-9a-f]{64}$/,
  "canonical report hash must be a single bytes32 value",
);
assert.equal(reportA.verification.verifiedOnArc, false);
assert.equal(reportA.verification.status, "verification_pending");
for (const category of Object.values(reportA.trustScore.categories)) {
  if (category.score !== null) {
    assert(category.evidenceCount > 0, "every scored category must cite evidence");
  }
}
const verified = applyAgentTrustVerification(reportA, [
  {
    receiptId: "receipt-1",
    status: "verified",
    transactionHash: `0x${"1".repeat(64)}`,
    transactionUrl: `https://testnet.arcscan.app/tx/0x${"1".repeat(64)}`,
    responseHash: reportA.verification.reportHash,
  },
]);
assert.equal(verified.verification.verifiedOnArc, true);
assert.equal(verified.verification.status, "verified");
const pending = applyAgentTrustVerification(reportA, [
  {
    receiptId: "receipt-1",
    status: "pending",
    transactionHash: null,
    transactionUrl: null,
    responseHash: reportA.verification.reportHash,
  },
]);
assert.equal(pending.verification.verifiedOnArc, false);
assert.equal(pending.verification.status, "verification_pending");
const unrelatedReceiptProof = applyAgentTrustVerification(reportA, [
  {
    receiptId: "receipt-2",
    status: "verified",
    transactionHash: `0x${"2".repeat(64)}`,
    transactionUrl: `https://testnet.arcscan.app/tx/0x${"2".repeat(64)}`,
    responseHash: `0x${"3".repeat(64)}`,
  },
]);
assert.equal(unrelatedReceiptProof.verification.verifiedOnArc, false);
assert.equal(
  unrelatedReceiptProof.verification.status,
  "verification_pending",
);
const markdown = formatAgentTrustReportAsMarkdown(verified);
assert(markdown.includes("# Veyra Agent Trust Report"));
assert(markdown.includes("Trust Score Breakdown"));
assert(markdown.includes("Payment & Verification Details"));
assert(!markdown.includes("contract is safe"));

const sourceFiles = {
  dataSources: readFileSync("lib/agent-trust/data-sources.ts", "utf8"),
  reportRoute: readFileSync("app/api/agent/v1/reports/[reportId]/route.ts", "utf8"),
  input: readFileSync("lib/agent-trust/input.ts", "utf8"),
  ui: readFileSync("app/agent-runner/agent-trust-report-view.tsx", "utf8"),
  finalizer: readFileSync(
    "app/api/premium/agent-trust/finalize/route.ts",
    "utf8",
  ),
  x402: readFileSync("lib/x402.ts", "utf8"),
  storeServices: readFileSync(
    "lib/services/store-service-persistence.ts",
    "utf8",
  ),
  migration: readFileSync(
    "supabase/migrations/20260730160000_add_agent_trust_report_workflow.sql",
    "utf8",
  ),
};
assert(sourceFiles.dataSources.includes("privateAggregatesAuthorized"));
assert(sourceFiles.dataSources.includes("requester.agentId === agent.id"));
assert(sourceFiles.reportRoute.includes("machine_credential_id === context.credential.id"));
assert(sourceFiles.input.includes("endpoint_private_network_blocked"));
assert(sourceFiles.ui.includes("Verified on Arc"));
assert(sourceFiles.finalizer.includes("X-Veyra-Canonical-Response-Hash"));
assert(sourceFiles.finalizer.includes("requiredPayer"));
assert(sourceFiles.x402.includes("responseHashOverride"));
assert(sourceFiles.storeServices.includes("!service.internalOnly"));
assert(sourceFiles.migration.includes("'agent_trust_report'"));

console.log(
  "[agent-trust-test] passed: input validation, SSRF boundaries, Arc snapshots, deterministic confidence-aware scoring, missing-category redistribution, canonical JSON/Markdown, verified-proof badge gate, policy migration, and tenant/credential isolation markers",
);
