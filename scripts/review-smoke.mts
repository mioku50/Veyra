/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

type ReviewStatus = {
  latestRunUrl?: string | null;
  latestReceiptUrl?: string | null;
  mainPassportUrl?: string | null;
  latestHostedWorkflowUrl?: string | null;
  database?: {
    provider?: string;
    publicClient?: { configured?: boolean };
    serverClient?: { configured?: boolean };
  };
  checks?: {
    verifiedProofExists?: boolean;
    verifiedProofCount?: number;
    pendingProofCount?: number;
    failedProofCount?: number;
    hostedRealInputWorkflowsEnabled?: boolean;
    hostedInputPrivacyEnabled?: boolean;
    workflowFirstProductEnabled?: boolean;
    publicWorkflowPagesEnabled?: boolean;
    liveProviderEnabled?: boolean;
    llmSynthesisConfigured?: boolean;
    userPaidCheckoutEnabled?: boolean;
    byoaCanaryReady?: boolean;
  };
  productPositioning?: {
    mode?: string;
    primaryRoute?: string;
    templatesRoute?: string;
    resultsRoute?: string;
    proofsRoute?: string;
    developerToolsRoute?: string;
  };
  proofRegistry?: {
    registryAddress?: string | null;
    attesterAddress?: string | null;
    chainId?: number;
  };
  hostedRunner?: {
    configured?: boolean;
    payerAddress?: string | null;
    chainId?: number;
    maxBudgetUsdc?: number;
    supportedWorkflows?: string[];
    inputPersistence?: string;
  };
  provider?: {
    provider?: string;
    configured?: boolean;
    supportedSymbols?: string[];
    paidEndpoint?: string;
    priceUsdc?: string;
    maxPriceAgeSeconds?: number;
    dataBoundary?: string;
  };
  llm?: {
    provider?: string;
    protocol?: string;
    configured?: boolean;
    model?: string | null;
    externalProcessing?: boolean;
    deterministicFallback?: boolean;
    legacyOpenAiKeyUsed?: boolean;
    apiKey?: unknown;
    baseUrl?: unknown;
  };
  checkout?: {
    configured?: boolean;
    chainId?: number;
    asset?: string;
    treasuryAddress?: string | null;
    platformFeeUsdc?: number;
    maxPriceUsdc?: number;
    sponsoredQuota?: number;
    paymentModel?: string;
  };
  byoa?: {
    configured?: boolean;
    enabled?: boolean;
    publicRegistrationEnabled?: boolean;
    canaryOnly?: boolean;
    chainId?: number;
    custody?: string;
    credentialStorage?: string;
  };
};

const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const DEFAULT_BASE_URL = "https://agent-commerce-six.vercel.app";
const REQUEST_TIMEOUT_MS = Number(process.env.REVIEW_SMOKE_TIMEOUT_MS ?? 60_000);

function requiresVerifiedProof() {
  return process.argv.includes("--require-verified-proof");
}

async function checkHostedWorkflowPreview(baseUrl: string) {
  const response = await fetchWithTimeout(urlFor(baseUrl, "/api/hosted-agent/plan"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflowType: "sentiment_tone",
      task: "Preview a useful sentiment and tone workflow safely.",
      inputText: "This builder update is clear, stable, useful, and ready for a public test.",
      budgetUsdc: 0.005,
    }),
  });
  const json = (await readJson(response)) as {
    request?: { inputText?: unknown; inputPreview?: string; inputSha256?: string };
    plan?: {
      selectedServices?: unknown[];
      estimatedSpendUsdc?: number;
      maxPaidCalls?: number;
      inputPreview?: string;
      inputSha256?: string;
    };
  };
  const selected = json.plan?.selectedServices ?? [];
  return [
    {
      name: "hosted workflow preview returns valid JSON",
      ok: response.status === 200,
      detail: `HTTP ${response.status}`,
    },
    {
      name: "hosted workflow preview selects two allowlisted paid APIs",
      ok: selected.length === 2 && json.plan?.estimatedSpendUsdc === 0.0013,
      detail: `${selected.length} service(s), ${json.plan?.estimatedSpendUsdc ?? "missing"} USDC`,
    },
    {
      name: "hosted workflow preview enforces the three-call cap",
      ok: json.plan?.maxPaidCalls === 3,
      detail: `maxPaidCalls=${json.plan?.maxPaidCalls ?? "missing"}`,
    },
    {
      name: "hosted preview publishes only safe input metadata",
      ok:
        json.request?.inputText === undefined &&
        Boolean(json.request?.inputPreview) &&
        /^[0-9a-f]{64}$/.test(json.request?.inputSha256 ?? "") &&
        json.request?.inputSha256 === json.plan?.inputSha256,
      detail: `fullInput=${json.request?.inputText === undefined ? "absent" : "present"} hash=${json.request?.inputSha256 ? "present" : "missing"}`,
    },
  ] satisfies CheckResult[];
}

async function checkHostedCheckoutBoundary(baseUrl: string) {
  const body = {
    workflowType: "sentiment_tone",
    task: "Preview a safe hosted checkout boundary without launching a job.",
    inputText: "This safe checkout boundary input is long enough for validation.",
    budgetUsdc: 0.005,
  };
  const [legacyLaunch, missingWalletQuote] = await Promise.all([
    fetchWithTimeout(urlFor(baseUrl, "/api/hosted-agent/jobs"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    }),
    fetchWithTimeout(urlFor(baseUrl, "/api/hosted-agent/quotes"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    }),
  ]);
  return [
    {
      name: "legacy direct hosted launch cannot bypass checkout",
      ok: legacyLaunch.status === 410,
      detail: `HTTP ${legacyLaunch.status}`,
    },
    {
      name: "hosted quote requires a connected requester/payer wallet",
      ok: missingWalletQuote.status === 400,
      detail: `HTTP ${missingWalletQuote.status}`,
    },
  ] satisfies CheckResult[];
}

function getBaseUrl() {
  const explicitArg = process.argv.find((arg) => arg.startsWith("--base-url="));
  const explicit = explicitArg?.split("=", 2)[1];

  return (
    explicit ??
    process.env.BASE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
}

function urlFor(baseUrl: string, path: string) {
  return `${baseUrl}${path}`;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: init.redirect ?? "manual",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkStatus(baseUrl: string, path: string, expectedStatus: number) {
  const response = await fetchWithTimeout(urlFor(baseUrl, path));
  return {
    name: `${path} returns ${expectedStatus}`,
    ok: response.status === expectedStatus,
    detail: `HTTP ${response.status}`,
  } satisfies CheckResult;
}

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 160)}`);
  }
}

function decodePaymentChallenge(headerValue: string) {
  const normalized = headerValue.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(decoded) as {
    accepts?: Array<{
      network?: string;
      asset?: string;
      [key: string]: unknown;
    }>;
  };
}

async function checkServiceDiscovery(baseUrl: string) {
  const response = await fetchWithTimeout(urlFor(baseUrl, "/api/store/services"));
  const json = await readJson(response);
  const services = Array.isArray((json as { services?: unknown }).services)
    ? (json as { services: unknown[] }).services
    : [];

  return [
    {
      name: "/api/store/services returns valid JSON",
      ok: response.status === 200,
      detail: `HTTP ${response.status}`,
    },
    {
      name: "/api/store/services has at least one service",
      ok: services.length > 0,
      detail: `${services.length} service(s)`,
    },
    {
      name: "API Store exposes the live Pyth provider service",
      ok: services.some((value) => {
        const service = value as { slug?: string; sourceType?: string; endpoint?: string };
        return service.slug === "pyth-market-price" &&
          service.sourceType === "provider_backed" &&
          service.endpoint === "/api/provider/pyth/price";
      }),
      detail: "slug=pyth-market-price source=provider_backed",
    },
  ] satisfies CheckResult[];
}

async function checkReceiptsJson(baseUrl: string) {
  const response = await fetchWithTimeout(urlFor(baseUrl, "/api/receipts"));
  await readJson(response);

  return {
    name: "/api/receipts returns valid JSON",
    ok: response.status === 200,
    detail: `HTTP ${response.status}`,
  } satisfies CheckResult;
}

async function checkReviewStatus(baseUrl: string) {
  const response = await fetchWithTimeout(urlFor(baseUrl, "/api/review/status"));
  const json = (await readJson(response)) as ReviewStatus;

  const checks = [
    {
      name: "/api/review/status returns valid JSON",
      ok: response.status === 200,
      detail: `HTTP ${response.status}`,
    },
    {
      name: "review status uses the AGENT_DB provider",
      ok:
        json.database?.provider === "agent-db" &&
        json.database.publicClient?.configured === true &&
        json.database.serverClient?.configured === true,
      detail: `provider=${json.database?.provider ?? "missing"} public=${json.database?.publicClient?.configured === true ? "configured" : "missing"} server=${json.database?.serverClient?.configured === true ? "configured" : "missing"}`,
    },
    {
      name: "review status exposes the app-owned Arc proof registry",
      ok:
        /^0x[0-9a-f]{40}$/i.test(json.proofRegistry?.registryAddress ?? "") &&
        /^0x[0-9a-f]{40}$/i.test(json.proofRegistry?.attesterAddress ?? "") &&
        json.proofRegistry?.chainId === 5_042_002,
      detail: `registry=${json.proofRegistry?.registryAddress ?? "missing"} attester=${json.proofRegistry?.attesterAddress ?? "missing"}`,
    },
    {
      name: "review status exposes the hosted Arc buyer-agent",
      ok:
        (json.hostedRunner?.configured === true ||
          new URL(baseUrl).hostname === "localhost" ||
          new URL(baseUrl).hostname === "127.0.0.1") &&
        /^0x[0-9a-f]{40}$/i.test(json.hostedRunner?.payerAddress ?? "") &&
        json.hostedRunner?.chainId === 5_042_002 &&
        json.hostedRunner?.maxBudgetUsdc === 0.005 &&
        json.hostedRunner?.supportedWorkflows?.includes("market_context") === true &&
        json.hostedRunner?.inputPersistence === "redacted_preview_and_sha256_only",
      detail: `configured=${json.hostedRunner?.configured === true ? "yes" : "no"} payer=${json.hostedRunner?.payerAddress ?? "missing"} phase21=${json.hostedRunner?.inputPersistence ?? "missing"}`,
    },
    {
      name: "review status exposes Phase 21 real-input privacy checks",
      ok:
        json.checks?.hostedRealInputWorkflowsEnabled === true &&
        json.checks?.hostedInputPrivacyEnabled === true,
      detail: `workflows=${json.checks?.hostedRealInputWorkflowsEnabled === true ? "ready" : "missing"} privacy=${json.checks?.hostedInputPrivacyEnabled === true ? "ready" : "missing"}`,
    },
    {
      name: "review status exposes the workflow-first product surfaces",
      ok:
        json.checks?.workflowFirstProductEnabled === true &&
        json.checks?.publicWorkflowPagesEnabled === true &&
        json.productPositioning?.mode === "workflow-first" &&
        json.productPositioning?.primaryRoute === "/agent-runner" &&
        json.productPositioning?.templatesRoute === "/workflows" &&
        json.productPositioning?.resultsRoute === "/results" &&
        json.productPositioning?.proofsRoute === "/proofs" &&
        json.productPositioning?.developerToolsRoute === "/developer-tools",
      detail: `mode=${json.productPositioning?.mode ?? "missing"} primary=${json.productPositioning?.primaryRoute ?? "missing"}`,
    },
    {
      name: "review status exposes single-payment hosted checkout",
      ok:
        json.checks?.userPaidCheckoutEnabled === true &&
        json.checkout?.configured === true &&
        json.checkout.chainId === 5_042_002 &&
        json.checkout.asset === "native_usdc" &&
        /^0x[0-9a-f]{40}$/i.test(json.checkout.treasuryAddress ?? "") &&
        json.checkout.platformFeeUsdc === 0.0007 &&
        json.checkout.maxPriceUsdc === 0.005 &&
        (json.checkout.sponsoredQuota ?? 0) >= 1 &&
        (json.checkout.sponsoredQuota ?? 0) <= 3 &&
        json.checkout.paymentModel === "single_user_payment_then_internal_x402",
      detail: `configured=${json.checkout?.configured === true ? "yes" : "no"} fee=${json.checkout?.platformFeeUsdc ?? "missing"} sponsored=${json.checkout?.sponsoredQuota ?? "missing"}`,
    },
    {
      name: "review status exposes non-custodial BYOA without secrets",
      ok:
        json.byoa?.configured === true &&
        json.byoa.enabled === true &&
        typeof json.byoa.publicRegistrationEnabled === "boolean" &&
        json.byoa.canaryOnly === !json.byoa.publicRegistrationEnabled &&
        json.byoa.chainId === 5_042_002 &&
        json.byoa.custody === "none" &&
        json.byoa.credentialStorage === "hmac_sha256_only" &&
        !Object.keys(json.byoa ?? {}).some((key) => /(secret|private|credentialPepper|wallets)/i.test(key)),
      detail: `configured=${json.byoa?.configured === true ? "yes" : "no"} enabled=${json.byoa?.enabled === true ? "yes" : "no"} canaryOnly=${json.byoa?.canaryOnly === true ? "yes" : "no"}`,
    },
    {
      name: "review status exposes the configured Pyth live provider without credentials",
      ok:
        (json.checks?.liveProviderEnabled === true ||
          ((new URL(baseUrl).hostname === "localhost" || new URL(baseUrl).hostname === "127.0.0.1") &&
            json.provider?.configured === false)) &&
        json.provider?.provider === "Pyth Network" &&
        (json.provider?.configured === true ||
          new URL(baseUrl).hostname === "localhost" ||
          new URL(baseUrl).hostname === "127.0.0.1") &&
        json.provider?.paidEndpoint === "/api/provider/pyth/price" &&
        json.provider?.priceUsdc === "0.001" &&
        json.provider?.maxPriceAgeSeconds === 120 &&
        json.provider?.supportedSymbols?.join(",") === "BTC/USD,ETH/USD,SOL/USD" &&
        !Object.keys(json.provider ?? {}).some((key) =>
          /(api.?key|authorization|bearer|raw.?response)/i.test(key),
        ),
      detail: `configured=${json.provider?.configured === true ? "yes" : "no"} endpoint=${json.provider?.paidEndpoint ?? "missing"} freshness=${json.provider?.maxPriceAgeSeconds ?? "missing"}s`,
    },
    {
      name: "review status exposes StepFun synthesis without credentials or endpoint",
      ok:
        json.checks?.llmSynthesisConfigured === true &&
        json.llm?.configured === true &&
        json.llm.provider === "StepFun" &&
        json.llm.protocol === "openai-compatible" &&
        json.llm.model === "nvidia/nemotron-3-super-120b-a12b:free" &&
        json.llm.externalProcessing === true &&
        json.llm.deterministicFallback === true &&
        json.llm.legacyOpenAiKeyUsed === false &&
        json.llm.apiKey === undefined &&
        json.llm.baseUrl === undefined,
      detail: `provider=${json.llm?.provider ?? "missing"} protocol=${json.llm?.protocol ?? "missing"} model=${json.llm?.model ?? "missing"} fallback=${json.llm?.deterministicFallback === true ? "enabled" : "missing"}`,
    },
  ] satisfies CheckResult[];

  if (requiresVerifiedProof()) {
    checks.push({
      name: "at least one paid receipt is Verified on Arc",
      ok: json.checks?.verifiedProofExists === true,
      detail: `verified=${json.checks?.verifiedProofCount ?? 0} pending=${json.checks?.pendingProofCount ?? 0} failed=${json.checks?.failedProofCount ?? 0}`,
    });
  }

  return {
    checks,
    status: json,
  };
}

async function checkPaymentRequiredChallenge(baseUrl: string) {
  const response = await fetchWithTimeout(urlFor(baseUrl, "/api/premium/quote"));
  const headerValue = response.headers.get("payment-required");
  const checks: CheckResult[] = [
    {
      name: "/api/premium/quote returns 402",
      ok: response.status === 402,
      detail: `HTTP ${response.status}`,
    },
    {
      name: "402 response includes payment-required header",
      ok: Boolean(headerValue),
      detail: headerValue ? "header present" : "header missing",
    },
  ];

  if (!headerValue) {
    checks.push(
      {
        name: "payment-required challenge decodes successfully",
        ok: false,
        detail: "no header to decode",
      },
      {
        name: `challenge network is ${ARC_TESTNET_NETWORK}`,
        ok: false,
        detail: "no decoded challenge",
      },
      {
        name: "challenge asset is Arc testnet USDC",
        ok: false,
        detail: "no decoded challenge",
      },
    );
    return checks;
  }

  try {
    const challenge = decodePaymentChallenge(headerValue);
    const accepted = challenge.accepts?.[0] ?? {};
    checks.push(
      {
        name: "payment-required challenge decodes successfully",
        ok: true,
        detail: `${challenge.accepts?.length ?? 0} accept option(s)`,
      },
      {
        name: `challenge network is ${ARC_TESTNET_NETWORK}`,
        ok: accepted.network === ARC_TESTNET_NETWORK,
        detail: String(accepted.network ?? "missing"),
      },
      {
        name: "challenge asset is Arc testnet USDC",
        ok: accepted.asset?.toLowerCase() === ARC_TESTNET_USDC.toLowerCase(),
        detail: String(accepted.asset ?? "missing"),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(
      {
        name: "payment-required challenge decodes successfully",
        ok: false,
        detail: message,
      },
      {
        name: `challenge network is ${ARC_TESTNET_NETWORK}`,
        ok: false,
        detail: "decode failed",
      },
      {
        name: "challenge asset is Arc testnet USDC",
        ok: false,
        detail: "decode failed",
      },
    );
  }

  return checks;
}

async function checkPythPaymentRequiredChallenge(baseUrl: string) {
  const response = await fetchWithTimeout(
    urlFor(baseUrl, "/api/provider/pyth/price"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "BTC/USD" }),
    },
  );
  const headerValue = response.headers.get("payment-required");
  return [
    {
      name: "/api/provider/pyth/price returns 402 before provider execution",
      ok: response.status === 402,
      detail: `HTTP ${response.status}`,
    },
    {
      name: "Pyth provider service includes an x402 payment challenge",
      ok: Boolean(headerValue),
      detail: headerValue ? "header present" : "header missing",
    },
  ] satisfies CheckResult[];
}

async function safelyRun(name: string, task: () => Promise<CheckResult | CheckResult[]>) {
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      ok: false,
      detail: message,
    } satisfies CheckResult;
  }
}

function printResults(
  baseUrl: string,
  results: CheckResult[],
  status: ReviewStatus | null,
  statusWarning: string | null,
) {
  const passed = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);

  console.log("\nVeyra review smoke");
  console.log(`Production URL: ${baseUrl}`);
  console.log(`Passed: ${passed.length}`);
  console.log(`Failed: ${failed.length}`);

  console.log("\nPassed checks");
  for (const result of passed) {
    console.log(`  [ok] ${result.name} - ${result.detail}`);
  }

  if (failed.length > 0) {
    console.log("\nFailed checks");
    for (const result of failed) {
      console.log(`  [fail] ${result.name} - ${result.detail}`);
    }
  }

  console.log("\nProof links");
  if (statusWarning) {
    console.log(`  Review status: unavailable (${statusWarning})`);
  }
  console.log(`  Latest run: ${status?.latestRunUrl ?? "n/a"}`);
  console.log(`  Latest receipt: ${status?.latestReceiptUrl ?? "n/a"}`);
  console.log(`  Main Agent Passport: ${status?.mainPassportUrl ?? "n/a"}`);
  console.log(`  Latest hosted report: ${status?.latestHostedWorkflowUrl ?? "n/a"}`);
  console.log("");
}

async function main() {
  const baseUrl = getBaseUrl();
  const results: CheckResult[] = [];
  let reviewStatus: ReviewStatus | null = null;
  let reviewStatusWarning: string | null = null;

  const pageChecks: Array<[path: string, expectedStatus: number]> = [
    ["/", 200],
    ["/review", 307],
    ["/demo", 307],
    ["/agent-runner", 200],
    ["/workflows", 200],
    ["/results", 200],
    ["/proofs", 200],
    ["/developer-tools", 200],
    ["/store", 200],
    ["/agent-control", 200],
    ["/agent-launch", 200],
    ["/runs", 200],
    ["/receipts", 200],
    ["/agents", 200],
    ["/my-agents", 200],
  ];

  for (const [path, expectedStatus] of pageChecks) {
    const result = await safelyRun(`${path} returns ${expectedStatus}`, () =>
      checkStatus(baseUrl, path, expectedStatus),
    );
    results.push(...(Array.isArray(result) ? result : [result]));
  }

  const serviceResults = await safelyRun("/api/store/services checks", () =>
    checkServiceDiscovery(baseUrl),
  );
  results.push(...(Array.isArray(serviceResults) ? serviceResults : [serviceResults]));

  const previewResults = await safelyRun("/api/hosted-agent/plan checks", () =>
    checkHostedWorkflowPreview(baseUrl),
  );
  results.push(...(Array.isArray(previewResults) ? previewResults : [previewResults]));

  const checkoutBoundary = await safelyRun("hosted checkout boundary checks", () =>
    checkHostedCheckoutBoundary(baseUrl),
  );
  results.push(...(Array.isArray(checkoutBoundary) ? checkoutBoundary : [checkoutBoundary]));

  const receiptsResult = await safelyRun("/api/receipts returns valid JSON", () =>
    checkReceiptsJson(baseUrl),
  );
  results.push(...(Array.isArray(receiptsResult) ? receiptsResult : [receiptsResult]));

  for (const path of ["/api/agent/runs", "/api/agents"]) {
    const result = await safelyRun(`${path} returns 200`, () =>
      checkStatus(baseUrl, path, 200),
    );
    results.push(...(Array.isArray(result) ? result : [result]));
  }

  const sellerBoundary = await safelyRun("Seller operator API rejects public reads", () =>
    checkStatus(baseUrl, "/api/seller/analytics", 401),
  );
  results.push(...(Array.isArray(sellerBoundary) ? sellerBoundary : [sellerBoundary]));

  try {
    const result = await checkReviewStatus(baseUrl);
    reviewStatus = result.status;
    results.push(...result.checks);
  } catch (error) {
    reviewStatusWarning = error instanceof Error ? error.message : String(error);
  }

  const paymentResults = await safelyRun("/api/premium/quote 402 challenge checks", () =>
    checkPaymentRequiredChallenge(baseUrl),
  );
  results.push(...(Array.isArray(paymentResults) ? paymentResults : [paymentResults]));

  const providerPaymentResults = await safelyRun("Pyth provider 402 challenge checks", () =>
    checkPythPaymentRequiredChallenge(baseUrl),
  );
  results.push(...(Array.isArray(providerPaymentResults) ? providerPaymentResults : [providerPaymentResults]));

  printResults(baseUrl, results, reviewStatus, reviewStatusWarning);

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

await main();
