/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildHostedFinalReport,
  createHostedWorkflowPlan,
  hashHostedWorkflowInput,
  hostedExecutionAllowlist,
  hostedWorkflowInputMetadata,
  validateHostedWorkflowRequest,
} from "../lib/agent/hosted-workflows.ts";
import { hostedIdempotencyRequestHash } from "../lib/agent/hosted-policy.ts";
import { requestBodyForService } from "../lib/agent/execution.ts";
import { serviceRegistry } from "../lib/services/registry.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectInvalid(label: string, input: Parameters<typeof validateHostedWorkflowRequest>[0]) {
  try {
    validateHostedWorkflowRequest(input);
  } catch {
    return;
  }
  throw new Error(`${label} was accepted unexpectedly.`);
}

const allowlist = [
  { slug: "premium-quote", endpoint: "/api/premium/quote", method: "GET" as const },
  { slug: "text-analyzer", endpoint: "/api/premium/compute", method: "POST" as const },
  { slug: "pyth-market-price", endpoint: "/api/provider/pyth/price", method: "POST" as const },
];

const request = validateHostedWorkflowRequest({
  workflowType: "sentiment_tone",
  task: "Produce a useful sentiment and tone report from this update.",
  inputText: "The release is stable, thoughtfully documented, and ready for builders to test today.",
  budgetUsdc: "0.005",
});
const normalizedRequest = validateHostedWorkflowRequest({
  workflowType: "market_context",
  task: "Create a market context brief from the submitted note.",
  inputText: "  Volume rose 12% while volatility remained elevated.\r\nRisk appetite improved.  ",
  marketSymbol: "ETH/USD",
  budgetUsdc: "0.005",
});
assert(normalizedRequest.marketSymbol === "ETH/USD", "Explicit hosted market symbol was not preserved.");
assert(
  normalizedRequest.inputText ===
    "Volume rose 12% while volatility remained elevated.\nRisk appetite improved.",
  "Workflow input normalization is not deterministic.",
);
const normalizedMetadata = hostedWorkflowInputMetadata(normalizedRequest.inputText);
assert(
  normalizedMetadata.sha256 === hashHostedWorkflowInput(normalizedRequest.inputText),
  "Persisted input hash does not match normalized source input.",
);
const idempotencyRequestHash = hostedIdempotencyRequestHash({
  secret: "phase21-test-secret",
  workflowType: normalizedRequest.workflowType,
  inputSha256: normalizedMetadata.sha256,
  task: normalizedRequest.task,
  marketSymbol: normalizedRequest.marketSymbol,
  budgetUsdc: normalizedRequest.budgetUsdc,
});
const changedInputRequestHash = hostedIdempotencyRequestHash({
  secret: "phase21-test-secret",
  workflowType: normalizedRequest.workflowType,
  inputSha256: hashHostedWorkflowInput(`${normalizedRequest.inputText} changed`),
  task: normalizedRequest.task,
  marketSymbol: normalizedRequest.marketSymbol,
  budgetUsdc: normalizedRequest.budgetUsdc,
});
assert(
  idempotencyRequestHash !== changedInputRequestHash,
  "Idempotency request fingerprint does not include the workflow input hash.",
);
const changedSymbolRequestHash = hostedIdempotencyRequestHash({
  secret: "phase21-test-secret",
  workflowType: normalizedRequest.workflowType,
  inputSha256: normalizedMetadata.sha256,
  task: normalizedRequest.task,
  marketSymbol: "SOL/USD",
  budgetUsdc: normalizedRequest.budgetUsdc,
});
assert(
  idempotencyRequestHash !== changedSymbolRequestHash,
  "Idempotency request fingerprint does not include the selected market symbol.",
);
assert(
  hostedWorkflowInputMetadata(
    "Contact builder@example.com about the stable release and the next test window.",
  ).preview.includes("[redacted-email]"),
  "Safe input preview did not redact an email address.",
);
const plan = createHostedWorkflowPlan({
  request,
  services: serviceRegistry,
  allowlist,
});
const analyzer = serviceRegistry.find((service) => service.slug === "text-analyzer");
assert(analyzer, "Text Analyzer is missing from the service registry.");
const analyzerRequest = requestBodyForService(
  analyzer,
  request.task,
  request.inputText,
  [{ service: "premium-quote", response: { quote: "context" } }],
) as { text?: string };
assert(
  analyzerRequest.text === request.inputText,
  "The paid Text Analyzer request did not receive the real normalized user input.",
);

const marketPlan = createHostedWorkflowPlan({
  request: normalizedRequest,
  services: serviceRegistry,
  allowlist,
});
const pythService = serviceRegistry.find((service) => service.slug === "pyth-market-price");
assert(pythService, "Pyth live market service is missing from the registry.");
const pythRequest = requestBodyForService(
  pythService,
  normalizedRequest.task,
  "SOL/USD market context with elevated volatility.",
  [],
  normalizedRequest.marketSymbol,
) as { symbol?: string };
assert(pythRequest.symbol === "ETH/USD", "Pyth request did not use the explicit allowlisted hosted symbol.");
const btcRequest = requestBodyForService(
  pythService,
  "Use a current BTC, ETH, or SOL price sourced from Pyth Network.",
  "BTC/USD is the real user-requested symbol even though the effective task lists all supported assets.",
  [],
) as { symbol?: string };
assert(btcRequest.symbol === "BTC/USD", "Real input did not take priority over generic planner text.");
assert(
  marketPlan.selectedServices.map((service) => service.slug).join(",") ===
    "text-analyzer,pyth-market-price",
  "Market Context Brief did not select deterministic text analysis plus Pyth.",
);
assert(marketPlan.estimatedSpendUsdc === 0.0013, "Market workflow estimated cost is incorrect.");
assert(marketPlan.marketSymbol === "ETH/USD", "Planner snapshot did not persist the selected market symbol.");

assert(plan.selectedServices.length === 2, "Multi-service workflow did not select two paid APIs.");
assert(plan.selectedServices.length <= 3, "Hosted plan exceeded the three-call cap.");
assert(plan.estimatedSpendUsdc === 0.0013, "Multi-service estimated cost is incorrect.");
const executionAllowlist = hostedExecutionAllowlist(plan, allowlist);
assert(
  executionAllowlist.length === plan.selectedServices.length &&
    executionAllowlist.every((service) =>
      plan.selectedServices.some(
        (planned) =>
          planned.slug === service.slug &&
          planned.endpoint === service.endpoint &&
          planned.method === service.method,
      ),
    ),
  "Runtime execution allowlist expanded beyond the immutable quote plan.",
);
assert(
  plan.selectedServices.every((service) =>
    allowlist.some((allowed) =>
      allowed.slug === service.slug &&
      allowed.endpoint === service.endpoint &&
      allowed.method === service.method,
    ),
  ),
  "Hosted plan selected a service outside the fixed allowlist.",
);

expectInvalid("unknown workflow", {
  workflowType: "arbitrary",
  task: "A valid task that should still reject the workflow.",
  inputText: "A sufficiently long source text for validation.",
  budgetUsdc: 0.005,
});
expectInvalid("short workflow input", {
  workflowType: "builder_update",
  task: "Analyze this builder update safely.",
  inputText: "Too short",
  budgetUsdc: 0.005,
});
expectInvalid("oversized workflow input", {
  workflowType: "sentiment_tone",
  task: "Analyze this long text safely.",
  inputText: "x".repeat(5_001),
  budgetUsdc: 0.005,
});
expectInvalid("empty market context input", {
  workflowType: "market_context",
  task: "Analyze this market note with safe services.",
  inputText: "   ",
  budgetUsdc: 0.005,
});
expectInvalid("unsupported market symbol", {
  workflowType: "market_context",
  task: "Analyze this market note with safe services.",
  inputText: "A sufficiently long market context request for a live price.",
  marketSymbol: "DOGE/USD",
  budgetUsdc: 0.005,
});
expectInvalid("non-string input", {
  workflowType: "sentiment_tone",
  task: "Analyze this sentiment text with safe services.",
  inputText: { text: "not accepted" },
  budgetUsdc: 0.005,
});
expectInvalid("private key", {
  workflowType: "builder_update",
  task: "Analyze this builder update with safe services.",
  inputText: `Private key: 0x${"ab".repeat(32)}`,
  budgetUsdc: 0.005,
});
expectInvalid("API token", {
  workflowType: "sentiment_tone",
  task: "Analyze this sentiment text with safe services.",
  inputText: "Please inspect sk-proj-abcdefghijklmnopqrstuv before release.",
  budgetUsdc: 0.005,
});
expectInvalid("budget above cap", {
  workflowType: "custom_task",
  task: "Analyze a useful custom task with safe services.",
  inputText: "A sufficiently long custom workflow input.",
  budgetUsdc: 0.005001,
});

const report = buildHostedFinalReport({
  jobId: "00000000-0000-4000-8000-000000000020",
  request,
  plan,
  agentRunId: "00000000-0000-4000-8000-000000000021",
  agentWallet: "0x0000000000000000000000000000000000000020",
  spentUsdc: "0.001",
  receiptIds: ["00000000-0000-4000-8000-000000000022"],
  proofTransactionHashes: [`0x${"20".repeat(32)}`],
  explorerUrl: "https://testnet.arcscan.app",
  serviceResults: [
    {
      serviceId: "premium-quote",
      serviceSlug: "premium-quote",
      serviceName: "Premium Quote",
      status: "paid",
      amountUsdc: "0.001",
      stepId: "00000000-0000-4000-8000-000000000022",
      paymentEventId: "00000000-0000-4000-8000-000000000023",
      response: { quote: "A real paid response" },
      error: null,
    },
    {
      serviceId: "pyth-market-price",
      serviceSlug: "pyth-market-price",
      serviceName: "Live Market Price",
      status: "failed",
      amountUsdc: null,
      stepId: "00000000-0000-4000-8000-000000000024",
      paymentEventId: null,
      response: null,
      error: "Synthetic service failure",
    },
  ],
});
assert(report.completedWithWarnings, "Partial failure was not surfaced in the Final Report.");
assert(report.apiResults.length === 2, "Partial report did not preserve every selected API result.");
assert(report.keyFindings.some((finding) => finding.includes("failed")), "Partial failure finding is missing.");
assert(report.aggregationMode === "deterministic_structured", "Report claims an unsupported aggregation mode.");
assert(report.input.sha256 === plan.inputSha256, "Final Report input hash differs from the plan.");
assert(report.input.preview === plan.inputPreview, "Final Report input preview differs from the plan.");

console.log("[hosted-workflow-test] passed: input type/size/secret/symbol validation, input+asset idempotency hashing, safe preview, fixed allowlist, explicit ETH/USD execution, two-service planning, budget/call caps, dynamic Final Report, partial failure");
