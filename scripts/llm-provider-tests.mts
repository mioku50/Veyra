import assert from "node:assert/strict";
import {
  generateOpenAiCompatibleText,
  getLlmSynthesisDiagnostic,
  resolveLlmConfig,
  type LlmGenerationResult,
  type OpenAiCompatibleConfig,
} from "../lib/llm/openai-compatible.ts";
import { synthesizeHostedFinalReport } from "../lib/agent/llm-synthesis.ts";
import {
  buildHostedFinalReport,
  createHostedWorkflowPlan,
  validateHostedWorkflowRequest,
} from "../lib/agent/hosted-workflows.ts";
import type { BuyerAgentServiceResult } from "../lib/agent/execution.ts";
import { serviceRegistry } from "../lib/services/registry.ts";

const config: OpenAiCompatibleConfig = {
  provider: "StepFun",
  protocol: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-sensitive-openrouter-key",
  model: "step-3.7-flash",
};

const successPayload = JSON.stringify({
  choices: [{
    message: {
      content: JSON.stringify({
        summary: "The paid services support a concise release assessment.",
        keyFindings: ["The text analysis response was used.", "One provider response was preserved."],
      }),
    },
  }],
});

let capturedUrl = "";
let capturedBody = "";
let capturedAuthorization = "";
let capturedReferer = "";
let capturedTitle = "";
const successFetch: typeof fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedBody = String(init?.body ?? "");
  const headers = new Headers(init?.headers);
  capturedAuthorization = headers.get("authorization") ?? "";
  capturedReferer = headers.get("HTTP-Referer") ?? "";
  capturedTitle = headers.get("X-Title") ?? "";
  return new Response(successPayload, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const success = await generateOpenAiCompatibleText({
  config,
  systemPrompt: "Return safe JSON.",
  userPrompt: "Use a paid API response.",
  fetchImpl: successFetch,
  sleep: async () => undefined,
});
assert.equal(success.ok, true);
assert.equal(capturedUrl, "https://openrouter.ai/api/v1/chat/completions");
assert.equal(capturedAuthorization, `Bearer ${config.apiKey}`);
assert.equal(capturedReferer, "https://agent-commerce-six.vercel.app");
assert.equal(capturedTitle, "Veyra");
assert.equal((JSON.parse(capturedBody) as { reasoning_effort?: unknown }).reasoning_effort, undefined);
assert(!capturedBody.includes(config.apiKey), "LLM API key leaked into the request body.");
assert(!JSON.stringify(success).includes(config.apiKey), "LLM API key leaked into the public result.");

let rateLimitCalls = 0;
const rateLimitFetch: typeof fetch = async () => {
  rateLimitCalls += 1;
  return rateLimitCalls === 1
    ? new Response("limited", { status: 429 })
    : new Response(successPayload, { status: 200 });
};
const retried = await generateOpenAiCompatibleText({
  config,
  systemPrompt: "Return JSON.",
  userPrompt: "Retry safely.",
  fetchImpl: rateLimitFetch,
  sleep: async () => undefined,
});
assert.equal(retried.ok, true);
assert.equal(retried.attempts, 2);
assert.equal(rateLimitCalls, 2);

const timeoutFetch = ((_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
const timedOut = await generateOpenAiCompatibleText({
  config,
  systemPrompt: "Return JSON.",
  userPrompt: "Timeout safely.",
  fetchImpl: timeoutFetch,
  sleep: async () => undefined,
  timeoutMs: 5,
  maxAttempts: 1,
});
assert.equal(timedOut.ok, false);
assert.equal(timedOut.reason, "timeout");

const tooLarge = await generateOpenAiCompatibleText({
  config,
  systemPrompt: "Return JSON.",
  userPrompt: "Bound output.",
  fetchImpl: async () => new Response("oversized", {
    status: 200,
    headers: { "content-length": "10000" },
  }),
  maxResponseBytes: 100,
  maxAttempts: 1,
});
assert.equal(tooLarge.ok, false);
assert.equal(tooLarge.reason, "response_too_large");

const malformed = await generateOpenAiCompatibleText({
  config,
  systemPrompt: "Return JSON.",
  userPrompt: "Validate output.",
  fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
  maxAttempts: 1,
});
assert.equal(malformed.ok, false);
assert.equal(malformed.reason, "invalid_response");

assert.deepEqual(resolveLlmConfig({
  OPENAI_API_KEY: "legacy-key-must-not-be-used",
  LLM_API_KEY: "legacy-router-key-must-not-be-used",
} as NodeJS.ProcessEnv), {
  configured: false,
  reason: "not_configured",
  model: null,
});
assert.deepEqual(resolveLlmConfig({
  LLM_PROVIDER: "anthropic",
  LLM_BASE_URL: "https://example.invalid/v1",
  LLM_API_KEY: "secret",
  LLM_MODEL: "some-model",
} as NodeJS.ProcessEnv), {
  configured: false,
  reason: "unsupported_provider",
  model: "some-model",
});

const request = validateHostedWorkflowRequest({
  workflowType: "builder_update",
  task: "Create a concise report from this real builder update.",
  inputText: "The release shipped successfully with stable APIs, clearer docs, and one remaining rollout risk.",
  budgetUsdc: 0.005,
});
const allowlist = [
  { slug: "premium-quote", endpoint: "/api/premium/quote", method: "GET" as const },
  { slug: "text-analyzer", endpoint: "/api/premium/compute", method: "POST" as const },
];
const plan = createHostedWorkflowPlan({ request, services: serviceRegistry, allowlist });
const serviceResults: BuyerAgentServiceResult[] = [
  {
    serviceId: "premium-quote",
    serviceSlug: "premium-quote",
    serviceName: "Premium Quote",
    status: "paid",
    amountUsdc: "0.001",
    stepId: "00000000-0000-4000-8000-000000000101",
    paymentEventId: "00000000-0000-4000-8000-000000000102",
    response: {
      quote: "The release has a clear rollout narrative.",
      authorization: "Bearer must-never-enter-prompt",
      apiKey: "must-never-enter-prompt",
      feedId: "must-never-enter-prompt",
      rawResponse: { secret: "must-never-enter-prompt" },
    },
    error: null,
  },
  {
    serviceId: "text-analyzer",
    serviceSlug: "text-analyzer",
    serviceName: "Text Analyzer",
    status: "failed",
    amountUsdc: null,
    stepId: "00000000-0000-4000-8000-000000000103",
    paymentEventId: null,
    response: null,
    error: "raw upstream failure must not enter the model prompt",
  },
];
const deterministic = buildHostedFinalReport({
  jobId: "00000000-0000-4000-8000-000000000100",
  request,
  plan,
  agentRunId: "00000000-0000-4000-8000-000000000104",
  agentWallet: "0x0000000000000000000000000000000000000100",
  spentUsdc: "0.001",
  receiptIds: ["00000000-0000-4000-8000-000000000101"],
  proofTransactionHashes: [`0x${"10".repeat(32)}`],
  serviceResults,
  explorerUrl: "https://testnet.arcscan.app",
});

let synthesisPrompt = "";
const aiReport = await synthesizeHostedFinalReport({
  request,
  report: deterministic,
  serviceResults,
  generateText: async (input): Promise<LlmGenerationResult> => {
    synthesisPrompt = input.userPrompt;
    return {
      ok: true,
      provider: "StepFun",
      protocol: "openai-compatible",
      model: "step-3.7-flash",
      text: JSON.stringify({
        summary: "AI synthesis for person@example.com uses the successful paid response.",
        keyFindings: ["The paid quote supports the report.", "The failed service did not erase useful work."],
      }),
      attempts: 1,
    };
  },
});
assert.equal(aiReport.aggregationMode, "ai_generated_synthesis");
assert.equal(aiReport.aggregationLabel, "AI-generated synthesis");
assert.equal(aiReport.synthesis.provider, "StepFun");
assert.equal(aiReport.synthesis.model, "step-3.7-flash");
assert.equal(aiReport.synthesis.usedPaidApiResponses.length, 1);
assert.equal(aiReport.synthesis.usedPaidApiResponses[0]?.serviceSlug, "premium-quote");
assert.equal(aiReport.completedWithWarnings, true, "Partial failure warning was lost after synthesis.");
assert(aiReport.summary.includes("[redacted-email]"), "LLM output was not privacy-redacted before persistence.");
assert(synthesisPrompt.includes(request.inputText), "Validated real input was not sent to synthesis.");
assert(!synthesisPrompt.includes("must-never-enter-prompt"), "Sensitive provider metadata leaked into the prompt.");
assert(!synthesisPrompt.includes("raw upstream failure"), "Failed provider error leaked into the prompt.");

const fallback = await synthesizeHostedFinalReport({
  request,
  report: deterministic,
  serviceResults,
  generateText: async (): Promise<LlmGenerationResult> => ({
    ok: false,
    provider: "StepFun",
    protocol: "openai-compatible",
    model: "step-3.7-flash",
    reason: "rate_limited",
    attempted: true,
    attempts: 2,
  }),
});
assert.equal(fallback.aggregationMode, "deterministic_structured");
assert.equal(fallback.summary, deterministic.summary);
assert.deepEqual(fallback.receiptIds, deterministic.receiptIds);
assert.deepEqual(fallback.proofTransactionHashes, deterministic.proofTransactionHashes);
assert.equal(fallback.synthesis.fallbackReason, "rate_limited");
assert(!JSON.stringify(fallback).includes("must-never-enter-prompt"));

const inputLeakFallback = await synthesizeHostedFinalReport({
  request,
  report: deterministic,
  serviceResults,
  generateText: async (): Promise<LlmGenerationResult> => ({
    ok: true,
    provider: "StepFun",
    protocol: "openai-compatible",
    model: "step-3.7-flash",
    text: JSON.stringify({
      summary: request.inputText,
      keyFindings: ["This output improperly repeated the private workflow input."],
    }),
    attempts: 1,
  }),
});
assert.equal(inputLeakFallback.aggregationMode, "deterministic_structured");
assert.equal(inputLeakFallback.synthesis.fallbackReason, "invalid_response");
assert(!inputLeakFallback.summary.includes(request.inputText));
assert(!inputLeakFallback.keyFindings.some((finding) => finding.includes(request.inputText)));

if (process.argv.includes("--live")) {
  const diagnostic = getLlmSynthesisDiagnostic();
  assert.equal(diagnostic.configured, true, "Live StepFun configuration is incomplete.");
  const expectedLiveModel = process.env.LLM_MODEL?.trim();
  assert.ok(expectedLiveModel, "LLM_MODEL must be set for the live smoke.");
  assert.equal(diagnostic.model, expectedLiveModel, `Live smoke must use the configured ${expectedLiveModel}.`);
  const liveReport = await synthesizeHostedFinalReport({
    request,
    report: deterministic,
    serviceResults: serviceResults.slice(0, 1),
  });
  assert.equal(liveReport.synthesis.status, "ai_generated", `Live StepFun synthesis fell back: ${liveReport.synthesis.fallbackReason ?? "unknown"}`);
  assert.equal(liveReport.synthesis.provider, "StepFun");
  assert.equal(liveReport.synthesis.model, expectedLiveModel);
  console.log(`[llm-live-smoke] passed: provider=StepFun model=${liveReport.synthesis.model} summaryChars=${liveReport.summary.length} findings=${liveReport.keyFindings.length}`);
}

console.log("[llm-provider-test] passed: OpenAI-compatible request boundary, step-3.7-flash config, timeout, 429 retry, response bounds, malformed output, legacy-key rejection, secret-safe prompt, input-leak fallback, AI metadata, deterministic fallback, and partial failure");
