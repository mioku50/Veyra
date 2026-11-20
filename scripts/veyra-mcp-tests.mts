/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { GET, POST } from "../app/api/mcp/route.ts";
import { VEYRA_ORIGIN } from "../lib/erc8004/veyra-registration.ts";
import { setSellerRequestAdapterForTests } from "../lib/seller/ssrf.ts";
import { ARC_MAINNET_NETWORK, ARC_MAINNET_USDC_ADDRESS } from "../lib/wallet/arc.ts";
import { ARC_TRUST_API } from "../lib/x402/trust-api/arc-mainnet.ts";
import { consumeFreeCall } from "../lib/x402/trust-api/rate-limit.ts";

const endpoint = new URL("/api/mcp", VEYRA_ORIGIN);
const currentVersion = "2026-07-28";
const tools = ["veyra_check_endpoint", "veyra_endpoint_history", "veyra_list_resources"];

process.env.AGENT_DB_SUPABASE_URL = "https://db.example.test";
process.env.AGENT_DB_SUPABASE_SECRET_KEY = "not-a-real-key";

let historyRead = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "db.example.test" && url.pathname.endsWith("/x402_endpoint_observations")) {
    if (init?.method === "POST") return new Response(null, { status: 201 });
    assert.equal(url.searchParams.get("network"), `eq.${ARC_MAINNET_NETWORK}`);
    assert.equal(url.searchParams.get("observed_asset"), `eq.${ARC_MAINNET_USDC_ADDRESS}`);
    if (url.searchParams.get("limit") === "10") {
      historyRead = true;
      return Response.json([{ probed_at: "2026-11-19T10:00:00Z" }]);
    }
    return Response.json([]);
  }
  assert.equal(init?.method ?? "GET", "GET", "The tools must not send payment or settlement messages");
  if (url.pathname === "/v1/x402/supported") {
    return Response.json({ kinds: [{ network: ARC_MAINNET_NETWORK, scheme: "exact", extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
      assets: [{ symbol: "USDC", address: ARC_MAINNET_USDC_ADDRESS, decimals: 6 }],
    } }] });
  }
  throw new Error("Unexpected request during offline MCP tests");
};

function request(method: string, params: Record<string, unknown> = {}, version = currentVersion, caller = "198.51.100.1") {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": version,
    "X-Forwarded-For": caller,
  });
  if (version === currentVersion) {
    headers.set("Mcp-Method", method);
    if (typeof params.name === "string") headers.set("Mcp-Name", params.name);
    params = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": { name: "Veyra test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
  }
  return new Request(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: 1 }), method, params }),
  });
}

const discovered = await POST(request("tools/list"));
assert.equal(discovered.status, 200);
const listing = await discovered.json();
assert.deepEqual(listing.result.tools.map(({ name }: { name: string }) => name), tools);
assert.ok(listing.result.tools.every(({ annotations }: { annotations: { readOnlyHint?: boolean } }) => annotations.readOnlyHint));
assert.deepEqual(listing.result.tools[0].inputSchema.required, ["resource"]);

const streamableVersion = "2025-11-25";
const initialized = await POST(request("initialize", {
  protocolVersion: streamableVersion,
  capabilities: {},
  clientInfo: { name: "Release test", version: "1.0.0" },
}, streamableVersion));
assert.equal(initialized.status, 200);
assert.ok((await initialized.text()).includes(streamableVersion));
assert.equal((await POST(request("notifications/initialized", {}, streamableVersion))).status, 202);
const streamableTools = await POST(request("tools/list", {}, streamableVersion));
assert.equal(streamableTools.status, 200);
const streamableListing = await streamableTools.text();
assert.ok(tools.every((tool) => streamableListing.includes(tool)));

const legacy = await POST(request("tools/list", {}, "2025-06-18"));
assert.equal(legacy.status, 200);
const legacyResult = (await legacy.text()).split("\n").find((line) => line.startsWith("data: "));
assert.ok(legacyResult);
assert.deepEqual(JSON.parse(legacyResult.slice(6)).result.tools.map(({ name }: { name: string }) => name), tools);

const history = await POST(request("tools/call", {
  name: tools[1],
  arguments: { resource: "https://seller.example.test/lookup", method: "GET" },
}));
assert.equal(history.status, 200);
assert.ok(historyRead);
assert.deepEqual((await history.json()).result.structuredContent, {
  resource: "https://seller.example.test/lookup",
  method: "GET",
  network: ARC_MAINNET_NETWORK,
  observationSampleSize: 1,
  sampleLimit: 10,
  lastObservedAt: "2026-11-19T10:00:00Z",
  fullHistoryEndpoint: new URL(ARC_TRUST_API.history.path, VEYRA_ORIGIN).href,
});

const catalog = await POST(request("tools/call", { name: tools[2], arguments: {} }));
assert.equal(catalog.status, 200);
const { items } = (await catalog.json()).result.structuredContent;
assert.ok(items.some(({ resource }: { resource: string }) => resource === new URL(ARC_TRUST_API.history.path, VEYRA_ORIGIN).href));

Object.assign(process.env, { NODE_ENV: "test" });
const localResource = "https://127.0.0.1:3000/lookup";
const payTo = "0x1111111111111111111111111111111111111111";
let successfulProbes = 0;
setSellerRequestAdapterForTests(async (url, init) => {
  assert.equal(url.toString(), localResource);
  assert.equal(init.method, "GET");
  assert.equal(new Headers(init.headers).get("PAYMENT-SIGNATURE"), null);
  assert.equal(new Headers(init.headers).get("X-PAYMENT"), null);
  successfulProbes += 1;
  const accepts = [
    { network: "eip155:84532", asset: "0x2222222222222222222222222222222222222222", amount: "1000000" },
    { network: ARC_MAINNET_NETWORK, asset: ARC_MAINNET_USDC_ADDRESS, amount: "100" },
  ].map((accept) => ({ ...accept, payTo, scheme: "exact", maxTimeoutSeconds: 60 }));
  const challenge = Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
  return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
});
try {
  const verdictRequest = request("tools/call", {
    name: tools[0],
    arguments: { resource: localResource, method: "GET" },
  });
  verdictRequest.headers.set("Origin", VEYRA_ORIGIN);
  const verdict = await POST(verdictRequest);
  assert.equal(verdict.status, 200);
  const answer = (await verdict.json()).result.structuredContent;
  assert.equal(answer.network, ARC_MAINNET_NETWORK);
  assert.equal(answer.priceUsdc, 0.0001);
  assert.equal(answer.method, "GET");
  assert.equal(answer.signed, false);
  assert.equal(answer.clearance, null);
  assert.ok(successfulProbes > 0);
} finally {
  setSellerRequestAdapterForTests(null);
}

const invalid = await POST(request("tools/call", {
  name: tools[0],
  arguments: { resource: "ftp://seller.example.test/lookup" },
}));
const invalidTool = (await invalid.json()).result;
assert.equal(invalidTool.isError, true);
assert.equal(invalidTool.structuredContent.error.code, "resource_scheme_unsupported");

const limitedCaller = "198.51.100.2";
for (let index = 0; index < 20; index += 1) assert.ok(consumeFreeCall(limitedCaller).allowed);
const limited = await POST(request("tools/call", { name: tools[2], arguments: {} }, currentVersion, limitedCaller));
assert.equal((await limited.json()).result.structuredContent.error.code, "rate_limited");

const refused = await GET(new Request(endpoint, { headers: { Origin: "https://elsewhere.example.test" } }));
assert.equal(refused.status, 403);

console.log("veyra mcp: legacy and stateless tool discovery, unsigned Arc verdict and history preview, catalog, refusal and rate limit passed");
