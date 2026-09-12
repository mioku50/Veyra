/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * P2.1 production gate orchestrator.
 *
 * Creates isolated short-lived buyer agents through the public management API,
 * runs the seller commerce and negative-path checks with one-time Machine
 * credentials, and revokes every temporary credential and agent in a finally
 * block. Separate negative-path buyers keep those checks sponsored after the
 * core smoke consumes its one-run quota.
 * Private keys, cookies, and plaintext credentials stay in process memory and
 * are never logged.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";

const CONFIRMATION = "--confirm-production";
const CANONICAL_HOST = "agent-commerce-six.vercel.app";
const MACHINE_SCOPES = [
  "workflows:read",
  "quotes:create",
  "runs:create",
  "results:read",
] as const;

type Json = Record<string, any>;

type BuyerHandle = {
  agentId: string;
  credentialId: string;
  cookie: string;
  policy: Json;
  token: string;
  userAgent: string;
};

type SellerFixture = {
  id: string;
  workflowType: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Unknown production gate failure")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/0x[0-9a-fA-F]{64,}/g, "0x[redacted]")
    .slice(0, 600);
}

function sessionCookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(value, "Production owner session cookie was not issued.");
  return value;
}

async function requestJson(
  baseUrl: URL,
  path: string,
  init: RequestInit = {},
  expected: number | number[] = 200,
) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json().catch(() => ({})) as Json;
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(response.status)) {
    const code = typeof body.error?.code === "string"
      ? body.error.code
      : typeof body.reason === "string"
        ? body.reason
        : "unexpected_response";
    throw new Error(`${path} returned HTTP ${response.status} (${code}).`);
  }
  return { response, body };
}

async function createOwnerSession(
  baseUrl: URL,
  owner: ReturnType<typeof privateKeyToAccount>,
) {
  const originHeaders = {
    Origin: baseUrl.origin,
    "Content-Type": "application/json",
  };
  const ownerChallenge = await requestJson(
    baseUrl,
    "/api/byoa/management/challenges",
    {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ wallet: owner.address }),
    },
    201,
  );
  const ownerSignature = await owner.signMessage({
    message: ownerChallenge.body.challenge.message,
  });
  const ownerSession = await requestJson(
    baseUrl,
    "/api/byoa/management/session",
    {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({
        challengeId: ownerChallenge.body.challenge.id,
        message: ownerChallenge.body.challenge.message,
        signature: ownerSignature,
      }),
    },
  );
  const cookie = sessionCookie(ownerSession.response);
  return {
    cookie,
    headers: { ...originHeaders, Cookie: cookie },
  };
}

async function createBuyer(baseUrl: URL, label: string): Promise<BuyerHandle> {
  const owner = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const session = await createOwnerSession(baseUrl, owner);
  const cookie = session.cookie;
  const managementHeaders = session.headers;

  const created = await requestJson(
    baseUrl,
    "/api/byoa/management/agents",
    {
      method: "POST",
      headers: managementHeaders,
      body: JSON.stringify({
        displayName: `P2.1 Gate Buyer ${label}`,
        agentWallet: agent.address,
      }),
    },
    201,
  );
  const agentId = String(created.body.agent?.id ?? "");
  assert(agentId, "Production agent onboarding returned no agent ID.");

  const binding = await requestJson(
    baseUrl,
    `/api/byoa/management/agents/${agentId}/wallet-challenge`,
    { method: "POST", headers: managementHeaders, body: "{}" },
    201,
  );
  const agentSignature = await agent.signMessage({
    message: binding.body.challenge.message,
  });
  await requestJson(
    baseUrl,
    `/api/byoa/management/agents/${agentId}/verify-wallet`,
    {
      method: "POST",
      headers: managementHeaders,
      body: JSON.stringify({
        challengeId: binding.body.challenge.id,
        message: binding.body.challenge.message,
        signature: agentSignature,
      }),
    },
  );

  const policy = {
    allowedWorkflows: ["seller:*"],
    allowedServiceTypes: ["external_seller"],
    maxPricePerRunUsdc: 0.005,
    dailySpendLimitUsdc: 0.05,
    maxDailyCalls: 10,
    status: "active",
  };
  await requestJson(
    baseUrl,
    `/api/byoa/management/agents/${agentId}/policy`,
    {
      method: "PUT",
      headers: managementHeaders,
      body: JSON.stringify(policy),
    },
  );

  const issued = await requestJson(
    baseUrl,
    `/api/byoa/management/agents/${agentId}/credentials`,
    {
      method: "POST",
      headers: managementHeaders,
      body: JSON.stringify({
        credentialType: "machine_api",
        label: `P2.1 production gate ${label}`,
        scopes: MACHINE_SCOPES,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    },
    201,
  );
  const token = String(issued.body.token ?? "");
  const credentialId = String(issued.body.credential?.id ?? "");
  assert(token && credentialId, "Production Machine credential issuance was incomplete.");

  return {
    agentId,
    credentialId,
    cookie,
    policy,
    token,
    userAgent: `agent-commerce-p21-gate/${randomUUID()}`,
  };
}

async function cleanupBuyer(baseUrl: URL, buyer: BuyerHandle | null) {
  if (!buyer) return;
  const headers = {
    Origin: baseUrl.origin,
    "Content-Type": "application/json",
    Cookie: buyer.cookie,
  };
  const results = await Promise.allSettled([
    requestJson(
      baseUrl,
      `/api/byoa/management/agents/${buyer.agentId}/credentials/${buyer.credentialId}`,
      { method: "DELETE", headers },
    ),
    requestJson(
      baseUrl,
      `/api/byoa/management/agents/${buyer.agentId}/policy`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...buyer.policy, status: "paused" }),
      },
    ),
    requestJson(
      baseUrl,
      `/api/byoa/management/agents/${buyer.agentId}`,
      { method: "PATCH", headers, body: JSON.stringify({ status: "revoked" }) },
    ),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("A temporary production gate buyer could not be fully revoked.");
  }
}

async function runSmoke(baseUrl: URL, buyerA: BuyerHandle, buyerB: BuyerHandle) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--no-warnings",
        "scripts/p21-production-smoke.mts",
        CONFIRMATION,
        baseUrl.toString(),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SELLER_SMOKE_TOKEN_A: buyerA.token,
          SELLER_SMOKE_TOKEN_B: buyerB.token,
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Seller smoke exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
    });
  });
}

function fixtureServiceInput(
  baseUrl: URL,
  marker: string,
  scenario: "invalid-json" | "timeout",
  authorizationSecret: string,
) {
  return {
    name: `P2.1 Negative ${scenario}`,
    slug: `p21-negative-${scenario}-${marker}`,
    shortDescription: `Production-only P2.1 ${scenario} failure-path fixture.`,
    longDescription: `Temporary controlled fixture used to prove that a ${scenario} seller response cannot create revenue or a successful report.`,
    category: "Production Verification",
    method: "POST",
    priceUsdc: "0.0001",
    status: "draft",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 3, maxLength: 200 } },
      required: ["message"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    healthCheckInput: { message: `Review the controlled ${scenario} production fixture.` },
    fulfillmentUrl: new URL(
      `/api/reference-seller/p21-negative/${scenario}`,
      baseUrl,
    ).toString(),
    timeoutMs: scenario === "timeout" ? 1_000 : 15_000,
    maxResponseSizeBytes: 16_384,
    authorizationSecret,
  };
}

async function createFixture(
  baseUrl: URL,
  headers: Record<string, string>,
  input: ReturnType<typeof fixtureServiceInput>,
  authorizationSecret: string,
): Promise<SellerFixture> {
  const created = await requestJson(
    baseUrl,
    "/api/seller/services",
    { method: "POST", headers, body: JSON.stringify(input) },
    201,
  );
  assert(
    !JSON.stringify(created.body).includes(authorizationSecret),
    "Seller service creation response exposed its authorization secret.",
  );
  const id = String(created.body.service?.id ?? "");
  assert(id, "Negative seller fixture creation returned no service ID.");
  const reviewed = await requestJson(
    baseUrl,
    `/api/seller/services/${id}/review`,
    {
      method: "POST",
      headers,
    },
  );
  assert(
    reviewed.body.review?.reviewStatus === "approved",
    "Negative seller fixture did not pass the review preflight.",
  );
  assert(
    !JSON.stringify(reviewed.body).includes(authorizationSecret),
    "Seller review response exposed its authorization secret.",
  );
  return {
    id,
    workflowType: `seller_${input.slug.replace(/-/g, "_")}`,
  };
}

async function runExpectedFailure(
  baseUrl: URL,
  buyer: BuyerHandle,
  workflowType: string,
  scenario: string,
) {
  const authHeaders = {
    Authorization: `Bearer ${buyer.token}`,
    "Content-Type": "application/json",
    "User-Agent": buyer.userAgent,
  };
  const quote = await requestJson(
    baseUrl,
    "/api/agent/v1/quotes",
    {
      method: "POST",
      headers: {
        ...authHeaders,
        "Idempotency-Key": `p21-negative-quote-${randomUUID()}`,
      },
      body: JSON.stringify({
        workflow: workflowType,
        input: { message: `Exercise the ${scenario} seller failure path.` },
      }),
    },
    [200, 201],
  );
  assert(quote.body.sponsored === true, "Negative gate refuses a paid buyer checkout.");
  const quoteId = String(quote.body.quoteId ?? "");
  assert(quoteId, "Negative seller quote returned no quote ID.");
  const runRequest = {
    method: "POST",
    headers: {
      ...authHeaders,
      "Idempotency-Key": `p21-negative-run-${randomUUID()}`,
    },
    body: JSON.stringify({
      quoteId,
      input: { message: `Exercise the ${scenario} seller failure path.` },
    }),
  } satisfies RequestInit;
  const launched = await requestJson(
    baseUrl,
    "/api/agent/v1/runs",
    runRequest,
    [200, 201],
  );
  const runId = String(launched.body.runId ?? "");
  assert(runId, "Negative seller run returned no run ID.");

  const deadline = Date.now() + 180_000;
  let status = "";
  while (Date.now() < deadline) {
    const current = await requestJson(
      baseUrl,
      `/api/agent/v1/runs/${runId}`,
      { headers: { Authorization: `Bearer ${buyer.token}` } },
    );
    status = String(current.body.status ?? "");
    if (["completed", "completed_with_warnings", "failed"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  assert(status === "failed", `${scenario} seller run did not fail closed (status=${status || "timeout"}).`);
  const report = await requestJson(
    baseUrl,
    `/api/agent/v1/reports/${runId}`,
    { headers: { Authorization: `Bearer ${buyer.token}` } },
    [200, 404, 409, 425],
  );
  if (report.response.status === 200) {
    assert(
      report.body.status === "failed" && report.body.result === null,
      `${scenario} seller failure exposed a successful report result.`,
    );
  }
  return runId;
}

async function runNegativeChecks(
  baseUrl: URL,
  buyerA: BuyerHandle,
  buyerB: BuyerHandle,
) {
  const fixtureToken = process.env.P21_NEGATIVE_FIXTURE_TOKEN?.trim();
  assert(
    fixtureToken && fixtureToken.length >= 32,
    "P21_NEGATIVE_FIXTURE_TOKEN must contain at least 32 characters.",
  );
  const sellerKey = process.env.SELLER_PRIVATE_KEY?.trim();
  assert(
    sellerKey && /^0x[0-9a-fA-F]{64}$/.test(sellerKey),
    "SELLER_PRIVATE_KEY is required for the reference seller negative gate.",
  );
  const seller = privateKeyToAccount(sellerKey as Hex);
  const expectedSeller = (
    process.env.REFERENCE_SELLER_WALLET || process.env.SELLER_ADDRESS || ""
  ).toLowerCase();
  assert(
    expectedSeller && seller.address.toLowerCase() === expectedSeller,
    "Reference seller wallet does not match SELLER_PRIVATE_KEY.",
  );
  const sellerSession = await createOwnerSession(baseUrl, seller);
  const fixtures: SellerFixture[] = [];
  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  let checkError: unknown = null;
  try {
    const privateEndpoint = fixtureServiceInput(
      baseUrl,
      `${marker}-private`,
      "invalid-json",
      fixtureToken,
    );
    privateEndpoint.fulfillmentUrl = "https://localhost/p21-private-endpoint";
    await requestJson(
      baseUrl,
      "/api/seller/services",
      {
        method: "POST",
        headers: sellerSession.headers,
        body: JSON.stringify(privateEndpoint),
      },
      400,
    );

    const invalidFixture = await createFixture(
      baseUrl,
      sellerSession.headers,
      fixtureServiceInput(baseUrl, `${marker}-json`, "invalid-json", fixtureToken),
      fixtureToken,
    );
    fixtures.push(invalidFixture);
    const timeoutFixture = await createFixture(
      baseUrl,
      sellerSession.headers,
      fixtureServiceInput(baseUrl, `${marker}-timeout`, "timeout", fixtureToken),
      fixtureToken,
    );
    fixtures.push(timeoutFixture);

    const [publicStore, manifest, machineWorkflows] = await Promise.all([
      requestJson(baseUrl, "/api/store/services"),
      requestJson(baseUrl, "/api/byoa/manifest"),
      requestJson(
        baseUrl,
        "/api/agent/v1/workflows",
        {
          headers: {
            Authorization: `Bearer ${buyerA.token}`,
            "User-Agent": buyerA.userAgent,
          },
        },
      ),
    ]);
    const publicProjection = JSON.stringify({
      store: publicStore.body,
      manifest: manifest.body,
      workflows: machineWorkflows.body,
    });
    assert(!publicProjection.includes(fixtureToken), "Public or Machine API exposed the seller secret.");
    for (const forbidden of ["authorizationSecret", "endpoint_auth_ciphertext"]) {
      assert(!publicProjection.includes(forbidden), `Public API exposed ${forbidden}.`);
    }

    const isolatedRevenue = await requestJson(
      baseUrl,
      "/api/seller/revenue",
      { headers: { Cookie: buyerB.cookie } },
    );
    assert(
      Array.isArray(isolatedRevenue.body.ledger) && isolatedRevenue.body.ledger.length === 0,
      "Unrelated seller session could read another seller's ledger.",
    );

    const invalidRunId = await runExpectedFailure(
      baseUrl,
      buyerA,
      invalidFixture.workflowType,
      "invalid-json",
    );
    const timeoutRunId = await runExpectedFailure(
      baseUrl,
      buyerB,
      timeoutFixture.workflowType,
      "timeout",
    );
    const sellerRevenue = await requestJson(
      baseUrl,
      "/api/seller/revenue",
      { headers: { Cookie: sellerSession.cookie } },
    );
    const negativeRuns = new Set([invalidRunId, timeoutRunId]);
    assert(
      Array.isArray(sellerRevenue.body.ledger) &&
        sellerRevenue.body.ledger.every((entry: Json) => !negativeRuns.has(String(entry.job_id))),
      "A failed seller response created earned revenue.",
    );
    console.log(
      "[p21-production-gate] negative checks passed: ledger isolation, invalid JSON, timeout, private endpoint, secret redaction",
    );
  } catch (error) {
    checkError = error;
  } finally {
    const cleanup = await Promise.allSettled(
      fixtures.map((fixture) => requestJson(
        baseUrl,
        `/api/seller/services/${fixture.id}`,
        { method: "DELETE", headers: sellerSession.headers },
      )),
    );
    if (cleanup.some((result) => result.status === "rejected") && !checkError) {
      checkError = new Error("Temporary negative seller fixtures could not be archived.");
    }
  }
  if (checkError) throw checkError;
}

async function main() {
  assert(process.argv[2] === CONFIRMATION, `Pass ${CONFIRMATION} to authorize the production gate.`);
  assert(process.argv[3], "Pass the canonical production HTTPS base URL.");
  const baseUrl = new URL(process.argv[3]);
  assert(
    baseUrl.protocol === "https:" && baseUrl.hostname === CANONICAL_HOST,
    `Production gate is restricted to https://${CANONICAL_HOST}.`,
  );

  let buyerA: BuyerHandle | null = null;
  let buyerB: BuyerHandle | null = null;
  let negativeBuyerA: BuyerHandle | null = null;
  let negativeBuyerB: BuyerHandle | null = null;
  let smokeError: unknown = null;
  const marker = randomUUID().slice(0, 8);
  try {
    buyerA = await createBuyer(baseUrl, `${marker} A`);
    buyerB = await createBuyer(baseUrl, `${marker} B`);
    negativeBuyerA = await createBuyer(baseUrl, `${marker} negative A`);
    negativeBuyerB = await createBuyer(baseUrl, `${marker} negative B`);
    console.log("[p21-production-gate] temporary buyers onboarded and verified");
    if (process.argv.includes("--negative-only")) {
      console.log("[p21-production-gate] core commerce smoke skipped; running negative checks only");
    } else {
      await runSmoke(baseUrl, buyerA, buyerB);
    }
    await runNegativeChecks(baseUrl, negativeBuyerA, negativeBuyerB);
  } catch (error) {
    smokeError = error;
  } finally {
    const cleanup = await Promise.allSettled([
      cleanupBuyer(baseUrl, negativeBuyerB),
      cleanupBuyer(baseUrl, negativeBuyerA),
      cleanupBuyer(baseUrl, buyerB),
      cleanupBuyer(baseUrl, buyerA),
    ]);
    if (cleanup.every((result) => result.status === "fulfilled")) {
      console.log("[p21-production-gate] temporary buyers and credentials revoked");
    } else if (!smokeError) {
      smokeError = new Error("Temporary production gate cleanup was incomplete.");
    }
  }
  if (smokeError) throw smokeError;
}

main().catch((error) => {
  console.error(`[p21-production-gate] FAILED: ${safeError(error)}`);
  process.exitCode = 1;
});
