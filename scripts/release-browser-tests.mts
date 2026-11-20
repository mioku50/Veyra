/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

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
const now = new Date().toISOString();
const payee = "0x" + "1".repeat(40);
const fixture = createHttpServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  let data: unknown[] = [];
  if (url.pathname === "/rest/v1/arc_offer_index"
    && (!url.searchParams.has("resource_key") || url.searchParams.get("resource_key") === "eq." + resourceKey)) {
    data = [{
      resource_key: resourceKey, resource: "https://paid.example/v1/search", hostname: "paid.example",
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
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  SystemRoot: process.env.SystemRoot,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
  BASE_URL: baseUrl,
  AGENT_DB_SUPABASE_URL: "http://127.0.0.1:" + fixtureAddress.port,
  AGENT_DB_SUPABASE_SECRET_KEY: "release-local-fixture",
  SELLER_SESSION_SECRET: randomBytes(32).toString("hex"),
};
const processPath = process.execPath;
const server = spawn(processPath, [
  "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port),
], { env, stdio: "inherit" });

async function execute(name: string) {
  const process = spawn(processPath, ["--experimental-transform-types", "--no-warnings", name, `--base-url=${baseUrl}`], {
    stdio: "inherit", env, timeout: 180_000,
  });
  const [status] = await once(process, "exit");
  if (status !== 0) throw new Error(`${name} exited with ${status}`);
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
  await execute("scripts/frontend-responsive-smoke.mts");
  await execute("scripts/branding-tests.mts");
  await execute("scripts/verify-public-ui-cleanliness.mts");
  await execute("scripts/navigation-compatibility-tests.mts");
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
  for (const key of ["incorrect-key", "f".repeat(64)]) {
    const unknown = await fetch(baseUrl + "/check/" + key);
    assert.equal(unknown.status, 404);
  }
} finally {
  server.kill();
  fixture.close();
}
