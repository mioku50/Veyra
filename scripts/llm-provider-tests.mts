import assert from "node:assert/strict";
import {
  generateOpenAiCompatibleText,
  getLlmSynthesisDiagnostic,
  resolveLlmConfig,
  resolveReadingLlmConfig,
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
  provider: "Example Router",
  protocol: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-sensitive-openrouter-key",
  model: "example-model-1",
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

assert.equal(JSON.parse(capturedBody).response_format, undefined, "Existing text callers remain unchanged");
await generateOpenAiCompatibleText({ config, systemPrompt: "Return JSON.", userPrompt: "Summarize.", responseFormat: "json_object", fetchImpl: successFetch });
assert.deepEqual(JSON.parse(capturedBody).response_format, { type: "json_object" });

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

/* A router that refuses can answer 200 with an error object, which from the
   client's side looks exactly like a model with nothing to say. The reason is
   the same either way; the note is what tells them apart. */
const refusedAt200 = await generateOpenAiCompatibleText({
  config: { provider: "Router", protocol: "openai-compatible", baseUrl: "https://router.example.com/v1", apiKey: "k", model: "m", userAgent: "cline/3.1.0" },
  systemPrompt: "x", userPrompt: "y", maxAttempts: 1,
  fetchImpl: async () => new Response(JSON.stringify({ error: { message: "insufficient balance for model m" } }), { status: 200 }),
});
assert.equal(refusedAt200.ok, false);
assert.equal(refusedAt200.ok === false && refusedAt200.reason, "invalid_response");
assert(refusedAt200.ok === false && refusedAt200.detail?.includes("insufficient balance"), "the provider's own words reach the caller");
assert(refusedAt200.ok === false && refusedAt200.detail?.includes("error"), "and which keys the body actually had");
const emptyChoices = await generateOpenAiCompatibleText({
  config: { provider: "Router", protocol: "openai-compatible", baseUrl: "https://router.example.com/v1", apiKey: "k", model: "m", userAgent: null },
  systemPrompt: "x", userPrompt: "y", maxAttempts: 1,
  fetchImpl: async () => new Response(JSON.stringify({ id: "1", choices: [] }), { status: 200 }),
});
assert(emptyChoices.ok === false && emptyChoices.detail?.includes("keys id,choices"), "and a body with no error still says what it did have");

/* Nova's judgement call may name its own provider, because measurement says
   no one model serves both it and the one-sentence rewrites. The invariant is
   the fallback: an environment that overrides nothing must resolve exactly as
   it did before the override existed. */
const base = {
  LLM_PROVIDER: "openai-compatible",
  LLM_BASE_URL: "https://api.example.com/v1",
  LLM_API_KEY: "base-key",
  LLM_MODEL: "small-fast-model",
  LLM_PROVIDER_LABEL: "Base",
} as NodeJS.ProcessEnv;
assert.deepEqual(resolveReadingLlmConfig(base), resolveLlmConfig(base), "No override means no difference at all");
const split = resolveReadingLlmConfig({
  ...base,
  LLM_READING_BASE_URL: "https://router.example.com/v1",
  LLM_READING_API_KEY: "reading-key",
  LLM_READING_MODEL: "big-judgement-model",
  LLM_READING_PROVIDER_LABEL: "Router",
  LLM_READING_USER_AGENT: "cline/3.1.0",
} as NodeJS.ProcessEnv);
assert(split.configured);
assert.equal(split.config.model, "big-judgement-model");
assert.equal(split.config.baseUrl, "https://router.example.com/v1");
assert.equal(split.config.apiKey, "reading-key");
assert.equal(split.config.provider, "Router");
assert.equal(split.config.userAgent, "cline/3.1.0");
assert.equal(resolveLlmConfig(base).configured && resolveLlmConfig(base).config.model, "small-fast-model",
  "and the rewrite path is untouched by the reading override");
/* A model named without a key of its own stays on the provider already
   configured -- the same vendor, a different model. */
const sameVendor = resolveReadingLlmConfig({ ...base, LLM_READING_MODEL: "bigger-model" } as NodeJS.ProcessEnv);
assert(sameVendor.configured);
assert.equal(sameVendor.config.apiKey, "base-key");
assert.equal(sameVendor.config.model, "bigger-model");
/* An override cannot conjure a configuration out of nothing. */
assert.equal(resolveReadingLlmConfig({ LLM_READING_MODEL: "x" } as NodeJS.ProcessEnv).configured, false);

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
      provider: "Example Router",
      protocol: "openai-compatible",
      model: "example-model-1",
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
assert.equal(aiReport.synthesis.provider, "Example Router");
assert.equal(aiReport.synthesis.model, "example-model-1");
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
    provider: "Example Router",
    protocol: "openai-compatible",
    model: "example-model-1",
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
    provider: "Example Router",
    protocol: "openai-compatible",
    model: "example-model-1",
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
  // Whichever provider is configured, not one named vendor.
  const diagnostic = getLlmSynthesisDiagnostic();
  assert.equal(diagnostic.configured, true, "Live LLM configuration is incomplete.");
  const expectedLiveModel = process.env.LLM_MODEL?.trim();
  const expectedLiveProvider = diagnostic.provider;
  assert.ok(expectedLiveModel, "LLM_MODEL must be set for the live smoke.");
  assert.equal(diagnostic.model, expectedLiveModel, `Live smoke must use the configured ${expectedLiveModel}.`);
  const liveReport = await synthesizeHostedFinalReport({
    request,
    report: deterministic,
    serviceResults: serviceResults.slice(0, 1),
  });
  assert.equal(
    liveReport.synthesis.status,
    "ai_generated",
    `Live ${expectedLiveProvider} synthesis fell back: ${liveReport.synthesis.fallbackReason ?? "unknown"}`,
  );
  assert.equal(liveReport.synthesis.provider, expectedLiveProvider);
  assert.equal(liveReport.synthesis.model, expectedLiveModel);
  console.log(`[llm-live-smoke] passed: provider=${expectedLiveProvider} model=${liveReport.synthesis.model} summaryChars=${liveReport.summary.length} findings=${liveReport.keyFindings.length}`);
}


/* A router may gate on the User-Agent: AgentRouter answers 401
   `unauthorized_client_error` when the header is absent, so a missing header is
   a hard outage rather than cosmetics. The label travels into published report
   metadata, so it must follow the provider that actually answered. */
{
  const environment = {
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://agentrouter.org/v1",
    LLM_API_KEY: "test-key",
    LLM_MODEL: "deepseek-v4-flash",
    LLM_PROVIDER_LABEL: "AgentRouter",
    LLM_USER_AGENT: "cline/3.1.0",
  } as NodeJS.ProcessEnv;

  const resolution = resolveLlmConfig(environment);
  assert(resolution.configured);
  assert.equal(resolution.config.provider, "AgentRouter");
  assert.equal(resolution.config.userAgent, "cline/3.1.0");
  assert.equal(getLlmSynthesisDiagnostic(environment).provider, "AgentRouter");

  let seenHeaders: Record<string, string> = {};
  const result = await generateOpenAiCompatibleText({
    environment,
    systemPrompt: "s",
    userPrompt: "u",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"summary":"s","keyFindings":["a","b"]}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  assert.equal(seenHeaders["User-Agent"], "cline/3.1.0");
  assert(result.ok);
  assert.equal(result.provider, "AgentRouter");

  // Absent by default, so providers that reject unknown headers are unaffected.
  const withoutUa = resolveLlmConfig({ ...environment, LLM_USER_AGENT: undefined });
  assert(withoutUa.configured);
  assert.equal(withoutUa.config.userAgent, null);
  assert.equal(withoutUa.config.provider, "AgentRouter");
}

/* A router's own knob, for a router that needs one. OpenRouter serves a model
   id from a dozen upstreams and picks per request; those that do not implement
   response_format return prose, which the reading path throws out as
   ungrounded -- measured at a third of calls on one candidate. The knob is
   configuration rather than code because the next router will need a different
   one, and it may never reach the fields this client controls. */
{
  const environment = {
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
    LLM_API_KEY: "test-key",
    LLM_MODEL: "deepseek/deepseek-v4.1-flash",
    LLM_EXTRA_BODY: '{"provider":{"require_parameters":true}}',
  } as NodeJS.ProcessEnv;

  const resolution = resolveLlmConfig(environment);
  assert(resolution.configured);
  assert.deepEqual(resolution.config.extraBody, { provider: { require_parameters: true } });

  let sent: Record<string, unknown> = {};
  const result = await generateOpenAiCompatibleText({
    environment, systemPrompt: "s", userPrompt: "u",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"s","keyFindings":["a","b"]}' } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  assert(result.ok);
  assert.deepEqual(sent.provider, { require_parameters: true });

  /* It may not displace what this client is responsible for. */
  const hostile = resolveLlmConfig({ ...environment, LLM_EXTRA_BODY: '{"model":"someone-elses-model","messages":[{"role":"user","content":"x"}]}' });
  assert(hostile.configured);
  await generateOpenAiCompatibleText({
    environment: { ...environment, LLM_EXTRA_BODY: '{"model":"someone-elses-model","messages":[{"role":"user","content":"x"}]}' },
    systemPrompt: "s", userPrompt: "u",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"s","keyFindings":["a","b"]}' } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  assert.equal(sent.model, "deepseek/deepseek-v4.1-flash");
  assert.equal((sent.messages as unknown[]).length, 2);

  /* A knob typed in wrong is ignored, not an outage. */
  for (const bad of ['{"provider":', '["provider"]', "null", "true", ""]) {
    const broken = resolveLlmConfig({ ...environment, LLM_EXTRA_BODY: bad });
    assert(broken.configured, `LLM_EXTRA_BODY=${bad} must not stop the provider answering`);
    assert.equal(broken.config.extraBody, null);
  }
}

/* ---- a diagnostic that says which setting is missing ---- */

/* "configured: false" on its own cost an afternoon. A deployment answered every
   question with "could not write a question just now" -- thirty of them in ten
   seconds, which is a model never called rather than a model being slow -- and
   the diagnostic whose job is to say why named none of the four settings it
   needs. */
const noneSet = getLlmSynthesisDiagnostic({} as NodeJS.ProcessEnv);
assert.equal(noneSet.configured, false);
assert.deepEqual(noneSet.missing,
  ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"],
  "all four are named when none is set");

const partly = getLlmSynthesisDiagnostic({
  LLM_PROVIDER: "openai-compatible",
  LLM_MODEL: "ministral-8b-latest",
  LLM_PROVIDER_LABEL: "AgentRouter",
} as NodeJS.ProcessEnv);
assert.equal(partly.configured, false);
assert.deepEqual(partly.missing, ["LLM_BASE_URL", "LLM_API_KEY"],
  "and only the ones actually missing, which is the case a half-migrated "
  + "environment is in");

/* Names, never values. A missing setting is a fact about configuration; its
   value would be a credential, and none is read to produce this list. */
const withKey = getLlmSynthesisDiagnostic({
  LLM_PROVIDER: "openai-compatible",
  LLM_BASE_URL: "https://api.example.test/v1",
  LLM_API_KEY: "sk-do-not-leak-this",
  LLM_MODEL: "example-model-1",
} as NodeJS.ProcessEnv);
assert.equal(withKey.configured, true);
assert.deepEqual(withKey.missing, [], "nothing is named when nothing is missing");
assert.ok(!JSON.stringify(withKey).includes("sk-do-not-leak-this"),
  "the diagnostic never carries a value");

/* The legacy key still counts as the key, so an environment that has not been
   migrated is not reported as missing one. */
assert.deepEqual(getLlmSynthesisDiagnostic({
  LLM_PROVIDER: "openai-compatible",
  LLM_BASE_URL: "https://api.example.test/v1",
  OPENROUTER_API_KEY: "legacy",
  LLM_MODEL: "example-model-1",
} as NodeJS.ProcessEnv).missing, []);

/* A provider set to something this client cannot speak is its own answer, and
   is not the same as a setting nobody filled in. */
const wrongProtocol = getLlmSynthesisDiagnostic({
  LLM_PROVIDER: "anthropic",
  LLM_BASE_URL: "https://api.example.test/v1",
  LLM_API_KEY: "k",
  LLM_MODEL: "example-model-1",
} as NodeJS.ProcessEnv);
assert.equal(wrongProtocol.configured, false);
assert.deepEqual(wrongProtocol.missing, [], "nothing is missing");
assert.equal(wrongProtocol.unsupportedProvider, true, "the value is simply wrong");
assert.equal(wrongProtocol.expectedProvider, "openai-compatible",
  "and the right one is named, because a protocol name looks nothing like the "
  + "vendor every other setting on the list refers to");

/* The one setting whose value is not a vendor, a URL or a key is also the one
   people fill in from memory, so its case is not held against them. */
for (const spelling of ["openai-compatible", "OpenAI-Compatible", "OPENAI-COMPATIBLE"]) {
  assert.equal(getLlmSynthesisDiagnostic({
    LLM_PROVIDER: spelling,
    LLM_BASE_URL: "https://api.example.test/v1",
    LLM_API_KEY: "k",
    LLM_MODEL: "example-model-1",
  } as NodeJS.ProcessEnv).configured, true, `${spelling} is the same protocol`);
}
assert.equal(getLlmSynthesisDiagnostic({
  LLM_PROVIDER: "openai",
  LLM_BASE_URL: "https://api.example.test/v1",
  LLM_API_KEY: "k",
  LLM_MODEL: "example-model-1",
} as NodeJS.ProcessEnv).configured, false, "and a different value is still refused");

console.log("[llm-provider-test] passed: OpenAI-compatible request boundary, routed provider label, User-Agent header and a router knob that cannot displace the request this client owns, and a diagnostic that names the settings it needs without carrying one of their values, model config, timeout, 429 retry, response bounds, malformed output, a reading model configurable apart from the rewrite model without changing it, a 200 that carries a refusal rather than an answer telling the caller which it was, legacy-key rejection, secret-safe prompt, input-leak fallback, AI metadata, deterministic fallback, and partial failure");
