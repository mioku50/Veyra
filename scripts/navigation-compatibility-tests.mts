import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import type { CommerceReceipt } from "../lib/commerce/receipts.ts";
import { operatorLoginDestination } from "../lib/navigation/frozen.ts";
import { COOKIE_NAME, issueSellerSession } from "../lib/seller/session.ts";
import { proxy } from "../proxy.ts";

const origin = "https://veyra.example";
const previousSecret = process.env.SELLER_SESSION_SECRET;
const previousLabs = process.env.VEYRA_LABS_PUBLIC;
process.env.SELLER_SESSION_SECRET = "veyra-navigation-local-fixture-secret";
delete process.env.VEYRA_LABS_PUBLIC;

function route(path: string, cookie?: string) {
  return proxy(new NextRequest(new URL(path, origin), { headers: cookie ? { cookie } : {} }));
}

try {
  const sessionCookie = `${COOKIE_NAME}=${issueSellerSession()}`;
  const consolePath = "/console/agent-api?tab=credentials";
  const loginPath = `/login?next=${encodeURIComponent(consolePath)}`;
  const anonymous = route(consolePath, "veyra_console=1");
  assert.equal(anonymous.status, 307);
  assert.equal(anonymous.headers.get("location"), origin + loginPath);
  assert.equal(anonymous.headers.get("set-cookie"), null);
  assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
  assert.equal(route(loginPath, sessionCookie).headers.get("location"), origin + consolePath);
  assert.equal(route(consolePath, sessionCookie).headers.get("x-middleware-next"), "1");
  assert.equal(route("/developer-tools").headers.get("location"),
    origin + "/login?next=%2Fconsole%2Fdeveloper-tools");
  assert.equal(route("/developer-tools", sessionCookie).headers.get("location"),
    origin + "/console/developer-tools");
  assert.equal(route("/agent-runner?workflow=github").headers.get("location"),
    origin + "/login?next=%2Fagent-runner%3Fworkflow%3Dgithub");

  process.env.VEYRA_LABS_PUBLIC = "true";
  for (const path of ["/console", "/dashboard", "/seller"]) assert.equal(route(path).status, 307);
  assert.equal(route("/agent-runner").headers.get("x-middleware-next"), "1");

  // Representative links from CommerceReceipt and HostedAgentJobPublicView.
  delete process.env.VEYRA_LABS_PUBLIC;
  for (const path of ["/runs/legacy-run", "/store/market-context", "/workflow-receipts/legacy-job",
    "/agents/veyra", "/receipts/legacy-receipt", "/trust/evidence-id"]) {
    const response = route(path);
    assert.equal(response.headers.get("location"), null, `${path} redirects`);
    assert.equal(response.headers.get("x-middleware-next"), "1", `${path} is blocked`);
  }
  for (const path of ["/store", "/runs", "/trust/select"]) assert.equal(route(path).status, 307);

  for (const next of [null, "https://outside.example", "//outside.example", "/\\outside.example",
    "/console/../login", "/console/%2e%2e/login", "/api/trust/v1/verify", "/console-fake"]) {
    assert.equal(operatorLoginDestination(next), "/dashboard");
  }
  assert.equal(operatorLoginDestination("/agent-runner?workflow=github"), "/agent-runner?workflow=github");
} finally {
  if (previousSecret === undefined) delete process.env.SELLER_SESSION_SECRET;
  else process.env.SELLER_SESSION_SECRET = previousSecret;
  if (previousLabs === undefined) delete process.env.VEYRA_LABS_PUBLIC;
  else process.env.VEYRA_LABS_PUBLIC = previousLabs;
}

const base = process.argv.find((argument) => argument.startsWith("--base-url="))?.slice("--base-url=".length);
if (base) {
  const localOrigin = new URL(base).origin;
  const get = (path: string, method = "GET") =>
    fetch(new URL(path, localOrigin), { method, redirect: "manual" });

  for (const path of ["/api/unknown-route", "/api/trust/v1/endpoints/history"]) {
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await get(path, method);
      assert.equal(response.status, 404);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
      assert.deepEqual(await response.json(), { error: "not_found", message: "API route not found." });
    }
  }

  for (const path of ["/demo", "/launch"]) {
    const response = await get(path);
    assert.equal(response.status, 307);
    assert.equal(new URL(response.headers.get("location")!, localOrigin).pathname, "/check");
  }
  assert.equal((await get("/check")).status, 200);

  const trustResponse = await get("/trust");
  assert.equal(trustResponse.status, 200);
  const trust = await trustResponse.text();
  for (const path of ["/check", "/.well-known/agent-registration.json", "/openapi/veyra-arc-trust-api.json"]) {
    assert(trust.includes(`href="${path}"`));
    const response = await get(path);
    assert.equal(response.status, 200, `Trust link ${path} is not reachable`);
  }
  assert.equal((await get("/openapi/veyra-arc-trust-api.json")).status, 200);
  assert.equal((await get("/openapi/agent-commerce-v1.json")).status, 200);

  // The browser gate supplies a paid receipt with all five public links.
  if (process.argv.includes("--check-receipts")) {
    assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(localOrigin).hostname),
      "Run the receipt-link check against a local fixture deployment.");
    const response = await get("/api/receipts");
    assert.equal(response.status, 200);
    const { receipts } = await response.json() as { receipts: CommerceReceipt[] };
    const markers = {
      receipt: "Purchase metadata",
      run: "Response preview",
      agent: "Reputation events",
      service: "Input schema",
      paymentEvent: 'id="payment-event"',
    } satisfies Record<keyof CommerceReceipt["links"], string>;
    const linkNames = Object.keys(markers) as (keyof typeof markers)[];
    assert(receipts.some(({ links }) => linkNames.every((name) => Boolean(links[name]))),
      "The fixture must include all five public receipt links.");

    for (const { links, receiptId, runId, buyerWallet, serviceSlug, paymentEvent } of receipts) {
      const receiptPath = "/receipts/" + receiptId;
      const expectedPaths = {
        receipt: receiptPath,
        run: "/runs/" + runId,
        agent: buyerWallet ? "/agents/" + buyerWallet : null,
        service: serviceSlug ? "/store/" + serviceSlug : null,
        paymentEvent: paymentEvent ? receiptPath + "#payment-event" : null,
      } satisfies Record<keyof CommerceReceipt["links"], string | null>;
      for (const name of linkNames) {
        const link = links[name];
        const expectedPath = expectedPaths[name];
        if (expectedPath === null) {
          assert.equal(link, null, name + " must be absent for this receipt");
          continue;
        }
        assert(link, name + " link is required for this receipt");
        const target = new URL(link, localOrigin);
        assert.equal(target.origin, localOrigin, `Public receipt link ${link} must stay on the app origin`);
        assert.equal(target.pathname + target.hash, expectedPath, name + " points to a different record");
        const detail = await fetch(target, { redirect: "manual" });
        assert.equal(detail.status, 200, `Public receipt link ${link}`);
        assert((await detail.text()).includes(markers[name]), `Public receipt link ${link} did not render its detail`);
      }
    }
  }
}

console.log("[navigation-compatibility] passed");
