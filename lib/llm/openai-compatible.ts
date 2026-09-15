import type { LlmFailureReason } from "./types.ts";
import { BRAND } from "../brand.ts";

/* The client speaks the OpenAI chat-completions protocol, so the vendor behind
   it is configuration, not a constant. It was pinned to one name, which then
   appeared verbatim in published report metadata regardless of who actually
   answered the request. LLM_PROVIDER_LABEL names the routed provider.

   The default used to be a vendor too, kept so deployments that predated the
   setting would read the same. That turned a missing setting into a confident
   wrong answer: the product went through two providers while the screen kept
   naming a third, and a person reading "StepFun timed out" was being told the
   name of something that had not been called in months. A deployment that has
   not said who answers its requests does not have a vendor to report, and this
   says so rather than picking one. */
export const DEFAULT_LLM_PROVIDER_LABEL = "Unnamed provider" as const;
export const LLM_PROVIDER_NAME = DEFAULT_LLM_PROVIDER_LABEL;
export const LLM_PROVIDER_PROTOCOL = "openai-compatible" as const;
export const LLM_REQUEST_TIMEOUT_MS = 30_000;
export const LLM_MAX_ATTEMPTS = 2;
export const LLM_MAX_RESPONSE_BYTES = 24_000;
// Budgeted for a reasoning model, because one was configured here twice and the
// cost of being wrong is asymmetric. A reasoning model spends this budget on its
// internal trace before emitting any content, and a 900-token cap truncated
// short answers to empty content, which the caller could only report as
// `invalid_response`. A model that does not reason -- which is what Nova's
// rewrite prompt wants, see .env.example -- answers in tens of tokens and never
// approaches this.
export const LLM_MAX_COMPLETION_TOKENS = 2_400;

export type OpenAiCompatibleConfig = {
  provider: string;
  protocol: typeof LLM_PROVIDER_PROTOCOL;
  baseUrl: string;
  apiKey: string;
  model: string;
  /* Some routers reject a request whose User-Agent they do not recognise —
     AgentRouter answers 401 `unauthorized_client_error` without it — so the
     header has to be configurable rather than whatever the runtime sends. */
  userAgent: string | null;
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
      provider: string;
      protocol: typeof LLM_PROVIDER_PROTOCOL;
      model: string;
      text: string;
      attempts: number;
    }
  | {
      ok: false;
      provider: string;
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
  const label = normalizedEnvironmentValue(environment.LLM_PROVIDER_LABEL) ?? DEFAULT_LLM_PROVIDER_LABEL;
  const userAgent = normalizedEnvironmentValue(environment.LLM_USER_AGENT);

  /* Case-insensitively, because this names a protocol rather than data and
     there is exactly one value it may hold. Matching it exactly bought nothing
     and cost a deployment: LLM_PROVIDER is the one setting whose value is not a
     vendor, a URL or a key, so it is also the one people fill in from memory. */
  if (provider && provider.toLowerCase() !== LLM_PROVIDER_PROTOCOL) {
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
        provider: label,
        protocol: LLM_PROVIDER_PROTOCOL,
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey,
        model,
        userAgent: userAgent && !/[\r\n\0]/.test(userAgent) ? userAgent : null,
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
  /* Which settings are missing, by name and never by value.
     `configured: false` on its own cost an afternoon: a deployment answered
     every question with "could not write a question just now" -- thirty of them
     in ten seconds, which is not a model being slow but a model never being
     called -- and this diagnostic, whose whole job is to say why, said only
     that something was wrong. Four settings are required and it named none of
     them. A name is not a secret; a value would be, and no value is read here. */
  const required: Array<[string, string | null]> = [
    ["LLM_PROVIDER", normalizedEnvironmentValue(environment.LLM_PROVIDER) ?? null],
    ["LLM_BASE_URL", normalizedEnvironmentValue(environment.LLM_BASE_URL) ?? null],
    ["LLM_API_KEY", normalizedEnvironmentValue(environment.LLM_API_KEY)
      ?? normalizedEnvironmentValue(environment.OPENROUTER_API_KEY) ?? null],
    ["LLM_MODEL", normalizedEnvironmentValue(environment.LLM_MODEL) ?? null],
  ];
  return {
    provider: resolution.configured
      ? resolution.config.provider
      : (normalizedEnvironmentValue(environment.LLM_PROVIDER_LABEL) ?? DEFAULT_LLM_PROVIDER_LABEL),
    protocol: LLM_PROVIDER_PROTOCOL,
    configured: resolution.configured,
    model: resolution.configured ? resolution.config.model : resolution.model,
    /** Set only when it is not configured. The names of the settings that have
     *  no value, and -- when every one of them does -- the fact that
     *  LLM_PROVIDER holds something other than the one protocol supported. */
    missing: resolution.configured
      ? []
      : required.filter(([, value]) => !value).map(([name]) => name),
    unsupportedProvider: !resolution.configured
      && (resolution as { reason?: string }).reason === "unsupported_provider",
    /** What LLM_PROVIDER has to say. Named, because "unsupported" tells
     *  somebody their value is wrong and not which value is right -- and the
     *  right one is a protocol name that looks nothing like the vendor every
     *  other setting on this list refers to. */
    expectedProvider: LLM_PROVIDER_PROTOCOL,
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
      provider:
        (input.environment ?? process.env).LLM_PROVIDER_LABEL?.trim()
        || DEFAULT_LLM_PROVIDER_LABEL,
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
          ...(config.userAgent ? { "User-Agent": config.userAgent } : {}),
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
