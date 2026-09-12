/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const HOSTED_AGENT_MAX_BUDGET_USDC = 0.005;
export const PROJECT_360_MAX_BUDGET_USDC = 0.01;
export const HOSTED_AGENT_MIN_BUDGET_USDC = 0.001;
export const HOSTED_AGENT_MAX_TASK_LENGTH = 500;
export const HOSTED_AGENT_MIN_TASK_LENGTH = 10;

export const SAFE_HOSTED_SERVICES = [
  {
    slug: "premium-quote",
    endpoint: "/api/premium/quote",
    method: "GET" as const,
  },
  {
    slug: "text-analyzer",
    endpoint: "/api/premium/compute",
    method: "POST" as const,
  },
  {
    slug: "agent-trust-finalizer",
    endpoint: "/api/premium/agent-trust/finalize",
    method: "POST" as const,
  },
  {
    slug: "api-quality-finalizer",
    endpoint: "/api/provider/api-quality-finalizer",
    method: "POST" as const,
  },
  {
    slug: "treasury-health-finalizer",
    endpoint: "/api/provider/treasury-health-finalizer",
    method: "POST" as const,
  },
  {
    slug: "arc-contract-analysis-finalizer",
    endpoint: "/api/provider/arc-contract-analysis-finalizer",
    method: "POST" as const,
  },
  {
    slug: "project-360-finalizer",
    endpoint: "/api/provider/project-360-finalizer",
    method: "POST" as const,
  },
  {
    slug: "pyth-market-price",
    endpoint: "/api/provider/pyth/price",
    method: "POST" as const,
  },
  {
    slug: "github-repository-intelligence",
    endpoint: "/api/provider/github/repository-intelligence",
    method: "POST" as const,
  },
  {
    slug: "github-due-diligence-analysis",
    endpoint: "/api/premium/github/due-diligence",
    method: "POST" as const,
  },
] as const;

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function requiredValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function privateKey(name: string) {
  const value = requiredValue(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is not a valid private key.`);
  }
  return value as Hex;
}

function address(name: string) {
  const value = requiredValue(name);
  if (!isAddress(value)) throw new Error(`${name} is not a valid EVM address.`);
  return getAddress(value);
}

function hostedBaseUrl() {
  const raw =
    process.env.HOSTED_AGENT_BASE_URL?.trim() ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.BASE_URL?.trim());
  if (!raw) throw new Error("HOSTED_AGENT_BASE_URL is not configured.");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Hosted agent base URL must use HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

export function hostedServiceAllowlist() {
  const requested = new Set(
    (
      process.env.HOSTED_AGENT_ALLOWED_SERVICE_SLUGS ??
      "premium-quote,text-analyzer,agent-trust-finalizer,api-quality-finalizer,treasury-health-finalizer,arc-contract-analysis-finalizer,project-360-finalizer,pyth-market-price,github-repository-intelligence,github-due-diligence-analysis"
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return SAFE_HOSTED_SERVICES.filter((service) => requested.has(service.slug));
}

export function getHostedRunnerConfig() {
  const agentPrivateKey = privateKey("HOSTED_AGENT_PRIVATE_KEY");
  const configuredAddress = address("HOSTED_AGENT_ADDRESS");
  const derivedAddress = privateKeyToAccount(agentPrivateKey).address;
  if (configuredAddress.toLowerCase() !== derivedAddress.toLowerCase()) {
    throw new Error("HOSTED_AGENT_ADDRESS does not match its private key.");
  }

  return {
    agentPrivateKey,
    agentAddress: configuredAddress,
    sellerAddress: address("SELLER_ADDRESS"),
    baseUrl: hostedBaseUrl(),
    rateLimitSecret: requiredValue("HOSTED_AGENT_RATE_LIMIT_SECRET"),
    serviceAllowlist: hostedServiceAllowlist(),
    cooldownSeconds: boundedInteger(
      "HOSTED_AGENT_COOLDOWN_SECONDS",
      60,
      30,
      3_600,
    ),
    rateLimitWindowSeconds: boundedInteger(
      "HOSTED_AGENT_RATE_LIMIT_WINDOW_SECONDS",
      3_600,
      300,
      86_400,
    ),
    rateLimitMaxRuns: boundedInteger(
      "HOSTED_AGENT_RATE_LIMIT_MAX_RUNS",
      3,
      1,
      10,
    ),
  };
}

export function getHostedRunnerDiagnostic() {
  try {
    const config = getHostedRunnerConfig();
    return {
      configured: config.serviceAllowlist.length > 0,
      chainId: 5_042_002,
      payerAddress: config.agentAddress,
      maxBudgetUsdc: HOSTED_AGENT_MAX_BUDGET_USDC,
      supportedWorkflows: [
        "github_due_diligence",
        "agent_trust_report",
        "paid_api_quality",
        "treasury_health",
        "project_360",
        "sentiment_tone",
        "builder_update",
        "market_context",
        "custom_task",
      ],
      inputPersistence: "redacted_preview_and_sha256_only" as const,
      allowedServices: config.serviceAllowlist.map((service) => service.slug),
      cooldownSeconds: config.cooldownSeconds,
      rateLimitWindowSeconds: config.rateLimitWindowSeconds,
      rateLimitMaxRuns: config.rateLimitMaxRuns,
    };
  } catch {
    const configuredAddress = process.env.HOSTED_AGENT_ADDRESS?.trim();
    return {
      configured: false,
      chainId: 5_042_002,
      payerAddress:
        configuredAddress && isAddress(configuredAddress)
          ? getAddress(configuredAddress)
          : null,
      maxBudgetUsdc: HOSTED_AGENT_MAX_BUDGET_USDC,
      supportedWorkflows: [
        "github_due_diligence",
        "agent_trust_report",
        "paid_api_quality",
        "treasury_health",
        "project_360",
        "sentiment_tone",
        "builder_update",
        "market_context",
        "custom_task",
      ],
      inputPersistence: "redacted_preview_and_sha256_only" as const,
      allowedServices: hostedServiceAllowlist().map((service) => service.slug),
      cooldownSeconds: 60,
      rateLimitWindowSeconds: 3_600,
      rateLimitMaxRuns: 3,
    };
  }
}

export function validateHostedTask(value: unknown) {
  if (typeof value !== "string") throw new Error("Task must be a string.");
  const task = value.trim().replace(/\s+/g, " ");
  if (
    task.length < HOSTED_AGENT_MIN_TASK_LENGTH ||
    task.length > HOSTED_AGENT_MAX_TASK_LENGTH
  ) {
    throw new Error(
      `Task must contain ${HOSTED_AGENT_MIN_TASK_LENGTH}-${HOSTED_AGENT_MAX_TASK_LENGTH} characters.`,
    );
  }
  return task;
}

export function validateHostedBudget(
  value: unknown,
  maxBudgetUsdc = HOSTED_AGENT_MAX_BUDGET_USDC,
) {
  const budget = typeof value === "string" ? Number(value) : value;
  if (
    typeof budget !== "number" ||
    !Number.isFinite(budget) ||
    budget < HOSTED_AGENT_MIN_BUDGET_USDC ||
    budget > maxBudgetUsdc
  ) {
    throw new Error(
      `Budget must be between ${HOSTED_AGENT_MIN_BUDGET_USDC} and ${maxBudgetUsdc} USDC.`,
    );
  }
  const atomic = Math.round(budget * 1_000_000);
  if (Math.abs(budget * 1_000_000 - atomic) > 0.000001) {
    throw new Error("Budget supports at most 6 decimal places.");
  }
  return atomic / 1_000_000;
}

export function validateIdempotencyKey(value: string | null) {
  const key = value?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) {
    throw new Error("Idempotency-Key must contain 16-128 safe characters.");
  }
  return key;
}

export function optionalRequesterWallet(value: unknown): Address | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error("Requester wallet must be a valid EVM address.");
  }
  return getAddress(value);
}

function hmac(secret: string, purpose: string, value: string) {
  return createHmac("sha256", secret)
    .update(`${purpose}\n${value}`)
    .digest("hex");
}

export function hostedIdempotencyHash(secret: string, key: string) {
  return hmac(secret, "hosted-agent-idempotency-v1", key);
}

export function hostedIdempotencyRequestHash(input: {
  secret: string;
  workflowType: string;
  inputSha256: string;
  task: string;
  marketSymbol?: string | null;
  repository?: { canonicalUrl: string } | null;
  budgetUsdc: number;
}) {
  return hmac(
    input.secret,
    "hosted-agent-idempotency-request-v3",
    [
      input.workflowType,
      input.inputSha256,
      input.task,
      input.marketSymbol ?? "none",
      input.repository?.canonicalUrl ?? "none",
      input.budgetUsdc.toFixed(6),
    ].join("\n"),
  );
}

export function hostedRequesterFingerprint(input: {
  secret: string;
  forwardedFor: string | null;
  userAgent: string | null;
}) {
  const ip = input.forwardedFor?.split(",")[0]?.trim() || "unknown";
  const userAgent = input.userAgent?.slice(0, 300) || "unknown";
  return hmac(input.secret, "hosted-agent-requester-v1", `${ip}\n${userAgent}`);
}

export function safeHostedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = [
    process.env.HOSTED_AGENT_PRIVATE_KEY,
    process.env.HOSTED_AGENT_RATE_LIMIT_SECRET,
    process.env.AGENT_DB_SUPABASE_SECRET_KEY,
    process.env.AGENT_DB_SUPABASE_SERVICE_ROLE_KEY,
    process.env.PYTH_API_KEY,
  ].filter((value): value is string => Boolean(value));

  let safe = message;
  for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
  return safe
    .replace(/(?:private\s*key|secret|bearer)\s*[:=]?\s*\S+/gi, "secret [redacted]")
    .slice(0, 800);
}
