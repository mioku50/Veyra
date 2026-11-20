/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Request as BrowserRequest } from "playwright";

if ([".env", ".env.local", ".env.production", ".env.production.local"].some((file) => existsSync(file))) {
  throw new Error("Run the browser gate in a checkout without production dotenv files.");
}

const socket = createServer().listen(0, "127.0.0.1");
await once(socket, "listening");
const address = socket.address();
assert(address && typeof address !== "string");
const { port } = address;
await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));

const resourceKey = "c".repeat(64);
const trailingSlashKey = "b".repeat(64);
const resource = "https://paid.example/v1/search";
const now = new Date().toISOString();
const payee = "0x" + "1".repeat(40);
const receiptRunId = "28a5f020-d8ae-4d37-943e-1fbbc5c802b0";
const receiptPaymentId = "38a5f020-d8ae-4d37-943e-1fbbc5c802b0";
const receiptWallet = "0x" + "3".repeat(40);
const receiptEndpoint = "/api/provider/pyth/price";
const receiptRows = new Map<string, Record<string, unknown> & { id: string }>([
  ["/rest/v1/agent_runs", {
    id: receiptRunId,
    created_at: now,
    updated_at: now,
    task: "Receipt compatibility fixture",
    status: "completed",
    mode: "manual",
    agent_wallet: receiptWallet,
    budget_usdc: "0.020",
    spent_usdc: "0.001",
  }],
  ["/rest/v1/agent_purchase_steps", {
    id: "48a5f020-d8ae-4d37-943e-1fbbc5c802b0",
    created_at: now,
    run_id: receiptRunId,
    step_index: 0,
    service_id: "pyth-market-price",
    service_slug: "pyth-market-price",
    service_name: "Live Market Price",
    service_source_type: "provider_backed",
    endpoint: receiptEndpoint,
    method: "POST",
    price_usdc: "0.001",
    status: "paid",
    payment_event_id: receiptPaymentId,
    response_preview: { fixture: true },
  }],
  ["/rest/v1/payment_events", {
    id: receiptPaymentId,
    created_at: now,
    endpoint: receiptEndpoint,
    payer: receiptWallet,
    amount_usdc: "0.001",
    network: "eip155:5042002",
  }],
]);
let novaTickWrites = 0;
const fixture = createHttpServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (url.pathname === "/rest/v1/nova_ticks" && request.method === "POST") {
    novaTickWrites += 1;
    response.writeHead(201).end();
    return;
  }
  const receiptRow = receiptRows.get(url.pathname);
  const idFilter = url.searchParams.get("id");
  const includesReceiptRow = receiptRow && request.method === "GET"
    && (!idFilter?.startsWith("eq.") || idFilter === "eq." + receiptRow.id);
  let data: unknown[] = includesReceiptRow ? [receiptRow] : [];
  const requestedKey = url.searchParams.get("resource_key");
  const trailingSlash = requestedKey === "eq." + trailingSlashKey;
  if (url.pathname === "/rest/v1/arc_offer_index"
    && (!requestedKey || requestedKey === "eq." + resourceKey || trailingSlash)) {
    data = [{
      resource_key: trailingSlash ? trailingSlashKey : resourceKey,
      resource: trailingSlash ? resource + "/" : resource,
      hostname: "paid.example",
      method: "POST", sources: ["circle", "bazaar"], listed_amount: "12000", listed_payee: payee,
      listed_rail: "wallet", listed_at: now, last_checked_at: now,
    }];
  }
  if (url.pathname === "/rest/v1/arc_offer_checks") {
    data = [{
      checked_at: now, http_status: 402, error_category: "none", arc_challenge: true,
      live_amount: "20000", live_payee: payee, live_rail: "wallet", listed_amount: "12000",
      listed_payee: payee, drift: ["price_changed"], failed_checks: ["accepts_matches_catalog"],
    }];
  }
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
}).listen(0, "127.0.0.1");
await once(fixture, "listening");
const fixtureAddress = fixture.address();
assert(fixtureAddress && typeof fixtureAddress !== "string");

const baseUrl = `http://127.0.0.1:${port}`;
const fixtureUrl = "http://127.0.0.1:" + fixtureAddress.port;
const novaCronSecret = randomBytes(32).toString("hex");
const env: NodeJS.ProcessEnv = {
  CRON_SECRET: novaCronSecret,
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  SystemRoot: process.env.SystemRoot,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
  BASE_URL: baseUrl,
  NEXT_PUBLIC_AGENT_DB_SUPABASE_URL: fixtureUrl,
  NEXT_PUBLIC_AGENT_DB_SUPABASE_PUBLISHABLE_KEY: "receipt-local-fixture",
  AGENT_DB_SUPABASE_URL: fixtureUrl,
  AGENT_DB_SUPABASE_SECRET_KEY: "release-local-fixture",
  SELLER_SESSION_SECRET: randomBytes(32).toString("hex"),
};
const processPath = process.execPath;
const server = spawn(processPath, [
  "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port),
], { env, stdio: "inherit" });

async function execute(name: string, ...args: string[]) {
  const process = spawn(processPath, ["--experimental-transform-types", "--no-warnings", name, `--base-url=${baseUrl}`, ...args], {
    stdio: "inherit", env, timeout: 180_000,
  });
  const [status] = await once(process, "exit");
  if (status !== 0) throw new Error(`${name} exited with ${status}`);
}

async function checkLiveVerdict() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    const verdictUrl = baseUrl + "/api/x402/v1/verdict";
    const requests: BrowserRequest[] = [];
    const extraRequests: string[] = [];
    const livePayee = "0x" + "2".repeat(40);
    const verdict = {
      decision: "REQUIRE_EVALUATOR",
      granted: true,
      payTo: livePayee,
      priceUsdc: 0.021,
      reasons: ["NO_REPUTATION_DATA"],
      alerts: [],
      postCallVerificationRequired: true,
      signed: false,
      clearance: null,
      explanation: "An evaluator is required.",
    };
    const rateLimit = "Too many free verdicts from this caller. Retry shortly.";
    let reply: { status: number; json: object } = { status: 200, json: verdict };
    let checking = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.url() === verdictUrl) {
        requests.push(request);
        return route.fulfill(reply);
      }
      if (checking || new URL(request.url()).origin !== baseUrl || request.method() !== "GET") {
        extraRequests.push(request.method() + " " + request.url());
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(baseUrl + "/check/" + resourceKey, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Free live verdict" }).waitFor();
    const budget = page.getByLabel("Budget (USDC)", { exact: true });
    const check = page.getByRole("button", { name: "Check live offer", exact: true });
    assert.equal(await budget.inputValue(), "0.012");
    assert.equal(requests.length, 0);

    checking = true;
    await budget.fill("0");
    await check.click();
    await page.getByRole("alert").filter({ hasText: "Enter a budget greater than 0 and at most 5 USDC." }).waitFor();
    assert.equal(requests.length, 0);

    await budget.fill("0.03");
    await check.click();
    await page.getByRole("heading", { name: "Requires an evaluator" }).waitFor();
    for (const text of ["no reputation data", "Post-call verification required.", livePayee, "0.021 USDC", "Unsigned verdict. No payment sent."]) {
      await page.getByText(text, { exact: true }).waitFor();
    }

    const overBudgetExplanation = "The live quote exceeds the 0.03 USDC budget.";
    reply = { status: 200, json: { ...verdict, granted: false, priceUsdc: 0.031, explanation: overBudgetExplanation } };
    await check.click();
    await page.getByRole("heading", { name: "Over budget", exact: true }).waitFor();
    await page.getByText("Evidence verdict", { exact: true }).waitFor();
    await page.getByText("Requires an evaluator", { exact: true }).waitFor();
    await page.getByText(overBudgetExplanation, { exact: true }).waitFor();

    reply = { status: 429, json: { error: { code: "rate_limited", message: rateLimit } } };
    await check.click();
    await page.getByRole("alert").filter({ hasText: rateLimit }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Over budget" }).count(), 0);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.method(), "POST");
      assert.deepEqual(request.postDataJSON(), { resource, method: "POST", budgetUsdc: 0.03 });
      const headers = await request.allHeaders();
      for (const name of ["authorization", "x-payment", "payment-signature", "payment-required", "payment-response", "x-payment-response"]) {
        assert.equal(headers[name], undefined, name);
      }
    }
    assert.deepEqual(extraRequests, []);
  } finally {
    await browser.close();
  }
}

try {
  const startedAt = Date.now();
  for (;;) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}`);
    const response = await fetch(baseUrl + "/api/status", { signal: AbortSignal.timeout(2_000) }).catch(() => null);
    if (response?.ok) break;
    if (Date.now() - startedAt > 30_000) throw new Error("Next.js did not start");
    await delay(250);
  }
  const novaSchedule = JSON.parse(readFileSync("vercel.json", "utf8")).schedules["nova-refresh"];
  assert.equal(novaSchedule.schedule, "7 * * * *");
  assert.equal(novaSchedule.path, "/api/nova/cron");
  assert.equal(novaSchedule.requestMethod, "POST");
  const cronUrl = baseUrl + novaSchedule.path;
  const method = novaSchedule.requestMethod;
  for (const headers of [new Headers(), new Headers({ Authorization: "Bearer wrong" })]) {
    const invalid = await fetch(cronUrl, { method, headers });
    assert.equal(invalid.status, 404);
  }
  assert.equal(novaTickWrites, 0);
  const tick = await fetch(cronUrl, { method, headers: { Authorization: "Bearer " + novaCronSecret } });
  assert.equal(tick.status, 200);
  const result = await tick.json();
  assert.equal(result.due, 0);
  assert.equal(result.shadowWouldSpendUsdc, 0);
  assert.equal(novaTickWrites, 1);

  await execute("scripts/frontend-responsive-smoke.mts");
  await execute("scripts/branding-tests.mts");
  await execute("scripts/verify-public-ui-cleanliness.mts");
  await execute("scripts/navigation-compatibility-tests.mts", "--check-receipts");
  for (const [path, contentType] of [["/robots.txt", "text/plain"], ["/sitemap.xml", "application/xml"], ["/llms.txt", "text/plain"]]) {
    const response = await fetch(baseUrl + path);
    assert.equal(response.status, 200, path);
    assert(response.headers.get("content-type")?.startsWith(contentType), path);
    const content = await response.text();
    assert(content.includes(path === "/robots.txt" ? "/sitemap.xml" : "/check"), path);
  }
  const index = await fetch(baseUrl + "/check?q=paid.example");
  assert.equal(index.status, 200);
  assert((await index.text()).includes("/check/" + resourceKey));
  const offer = await fetch(baseUrl + "/check/" + resourceKey);
  assert.equal(offer.status, 200);
  const detail = await offer.text();
  for (const text of ["Terms differ from the catalogue", "0.012 USDC", "0.02 USDC", "price changed"]) {
    assert(detail.includes(text), text);
  }
  await checkLiveVerdict();
  const trailingSlashOffer = await fetch(baseUrl + "/check/" + trailingSlashKey);
  assert.equal(trailingSlashOffer.status, 200);
  const trailingSlashDetail = await trailingSlashOffer.text();
  assert(trailingSlashDetail.includes(resource + "/"));
  assert(!trailingSlashDetail.includes("Free live verdict"));
  for (const key of ["incorrect-key", "f".repeat(64)]) {
    const unknown = await fetch(baseUrl + "/check/" + key);
    assert.equal(unknown.status, 404);
  }
} finally {
  server.kill();
  fixture.close();
}
