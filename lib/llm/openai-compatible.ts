import type { LlmFailureReason } from "./types.ts";
import { BRAND } from "../brand.ts";

export const LLM_PROVIDER_NAME = "StepFun" as const;
export const LLM_PROVIDER_PROTOCOL = "openai-compatible" as const;
export const LLM_REQUEST_TIMEOUT_MS = 30_000;
export const LLM_MAX_ATTEMPTS = 2;
export const LLM_MAX_RESPONSE_BYTES = 24_000;
// StepFun's step-3.7-flash is a reasoning model: tokens spent on its internal
// reasoning trace count against this budget before any content is emitted. A
// 900-token cap truncated short answers to empty content, which the caller
// could only report as `invalid_response`. Budget for reasoning plus answer.
export const LLM_MAX_COMPLETION_TOKENS = 2_400;

export type OpenAiCompatibleConfig = {
  provider: typeof LLM_PROVIDER_NAME;
  protocol: typeof LLM_PROVIDER_PROTOCOL;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type LlmConfigResolution =
  | { configured: true; config: OpenAiCompatibleConfig }
  | {
      configured: false;
      reason: "not_configured" | "unsupported_provider";
      model: string | null;
    };

export type LlmGenerationResult =
  | {
      ok: true;
      provider: typeof LLM_PROVIDER_NAME;
      protocol: typeof LLM_PROVIDER_PROTOCOL;
      model: string;
      text: string;
      attempts: number;
    }
  | {
      ok: false;
      provider: typeof LLM_PROVIDER_NAME;
      protocol: typeof LLM_PROVIDER_PROTOCOL;
      model: string | null;
      reason: LlmFailureReason;
      attempted: boolean;
      attempts: number;
    };

function normalizedEnvironmentValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(localhost && url.protocol === "http:")) {
    throw new Error("LLM_BASE_URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("LLM_BASE_URL must not contain credentials, query parameters, or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function resolveLlmConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LlmConfigResolution {
  const provider = normalizedEnvironmentValue(environment.LLM_PROVIDER);
  const baseUrl = normalizedEnvironmentValue(environment.LLM_BASE_URL);
  // `LLM_API_KEY` is the provider-neutral name. `OPENROUTER_API_KEY` stays as a
  // fallback so an environment that has not been migrated yet keeps working.
  const apiKey = normalizedEnvironmentValue(environment.LLM_API_KEY)
    ?? normalizedEnvironmentValue(environment.OPENROUTER_API_KEY);
  const model = normalizedEnvironmentValue(environment.LLM_MODEL);

  if (provider && provider !== LLM_PROVIDER_PROTOCOL) {
    return { configured: false, reason: "unsupported_provider", model };
  }
  if (!provider || !baseUrl || !apiKey || !model) {
    return { configured: false, reason: "not_configured", model };
  }
  if (model.length > 120 || /[\r\n\0]/.test(model)) {
    return { configured: false, reason: "not_configured", model: null };
  }
  try {
    return {
      configured: true,
      config: {
        provider: LLM_PROVIDER_NAME,
        protocol: LLM_PROVIDER_PROTOCOL,
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey,
        model,
      },
    };
  } catch {
    return { configured: false, reason: "not_configured", model };
  }
}

export function getLlmSynthesisDiagnostic(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const resolution = resolveLlmConfig(environment);
  return {
    provider: LLM_PROVIDER_NAME,
    protocol: LLM_PROVIDER_PROTOCOL,
    configured: resolution.configured,
    model: resolution.configured ? resolution.config.model : resolution.model,
    externalProcessing: true,
    deterministicFallback: true,
    legacyOpenAiKeyUsed: false,
  };
}

function chatCompletionsUrl(baseUrl: string) {
  return baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;
}

async function boundedResponseText(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("response_too_large");
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("response_too_large");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function responseContent(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      })
      .join("")
      .trim();
    return joined || null;
  }
  return null;
}

function retryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function failureForStatus(status: number): LlmFailureReason {
  return status === 429 ? "rate_limited" : "upstream_error";
}

export async function generateOpenAiCompatibleText(input: {
  systemPrompt: string;
  userPrompt: string;
  environment?: NodeJS.ProcessEnv;
  config?: OpenAiCompatibleConfig;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  maxResponseBytes?: number;
}): Promise<LlmGenerationResult> {
  const resolution = input.config
    ? ({ configured: true, config: input.config } as const)
    : resolveLlmConfig(input.environment);
  if (!resolution.configured) {
    return {
      ok: false,
      provider: LLM_PROVIDER_NAME,
      protocol: LLM_PROVIDER_PROTOCOL,
      model: resolution.model,
      reason: resolution.reason,
      attempted: false,
      attempts: 0,
    };
  }

  const config = resolution.config;
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = input.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? LLM_MAX_ATTEMPTS, 3));
  const maxResponseBytes = input.maxResponseBytes ?? LLM_MAX_RESPONSE_BYTES;
  let lastReason: LlmFailureReason = "upstream_error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "HTTP-Referer": "https://agent-commerce-six.vercel.app",
          "X-Title": BRAND.name,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
          max_completion_tokens: LLM_MAX_COMPLETION_TOKENS,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        lastReason = failureForStatus(response.status);
        await response.body?.cancel().catch(() => undefined);
        if (retryableStatus(response.status) && attempt < maxAttempts) {
          await sleep(250 * attempt);
          continue;
        }
        return {
          ok: false,
          provider: config.provider,
          protocol: config.protocol,
          model: config.model,
          reason: lastReason,
          attempted: true,
          attempts: attempt,
        };
      }

      let raw: string;
      try {
        raw = await boundedResponseText(response, maxResponseBytes);
      } catch (error) {
        const reason = error instanceof Error && error.message === "response_too_large"
          ? "response_too_large"
          : "invalid_response";
        return {
          ok: false,
          provider: config.provider,
          protocol: config.protocol,
          model: config.model,
          reason,
          attempted: true,
          attempts: attempt,
        };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      const text = responseContent(payload);
      if (!text) {
        return {
          ok: false,
          provider: config.provider,
          protocol: config.protocol,
          model: config.model,
          reason: "invalid_response",
          attempted: true,
          attempts: attempt,
        };
      }
      return {
        ok: true,
        provider: config.provider,
        protocol: config.protocol,
        model: config.model,
        text,
        attempts: attempt,
      };
    } catch {
      lastReason = controller.signal.aborted ? "timeout" : "upstream_error";
      if (attempt < maxAttempts) {
        await sleep(250 * attempt);
        continue;
      }
      return {
        ok: false,
        provider: config.provider,
        protocol: config.protocol,
        model: config.model,
        reason: lastReason,
        attempted: true,
        attempts: attempt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ok: false,
    provider: config.provider,
    protocol: config.protocol,
    model: config.model,
    reason: lastReason,
    attempted: true,
    attempts: maxAttempts,
  };
}
