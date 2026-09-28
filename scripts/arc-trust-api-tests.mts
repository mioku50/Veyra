/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import { ARC_OPENAPI_PATH, ARC_TRUST_API, VEYRA_ARC_PAY_TO } from "../lib/x402/trust-api/arc-mainnet.ts";
import { arcTrustApiOpenApi } from "../lib/x402/trust-api/arc-openapi.ts";
import { checkHistoryRequest, checkSelectRequest } from "../lib/x402/trust-api/answers.ts";
import { buildTrustApiCatalog } from "../lib/x402/trust-api/catalog.ts";
import { TrustApiError } from "../lib/x402/trust-api/resource.ts";
import { requirementsFromKinds, withTrustApiChallenge, withTrustApiPayment, type SupportedKind } from "../lib/x402/trust-api/seller.ts";
import { TRUST_API_PRICING } from "../lib/x402/trust-api/pricing.ts";
import { VEYRA_ARC_AGENT_ID, VEYRA_ORIGIN, veyraRegistrationFile } from "../lib/erc8004/veyra-registration.ts";
import { isVeyraItself } from "../lib/veyra-self.ts";
import { challengeSchemas } from "../lib/providers/x402-probe.ts";

/* ---- Circle's facilitators, stubbed at fetch ---- */

/* The Arc kind as Circle's mainnet facilitator published it on 27 September. */
const ARC_KIND: SupportedKind = {
  network: "eip155:5042",
  extra: {
    name: "GatewayWalletBatched",
    version: "1",
    verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
    minValiditySeconds: 604800,
    assets: [{ symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6 }],
  },
};
const BASE_KIND: SupportedKind = {
  network: "eip155:8453",
  extra: { ...ARC_KIND.extra, assets: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }] },
};
const SEPOLIA_KIND: SupportedKind = {
  network: "eip155:11155111",
  extra: { ...ARC_KIND.extra, verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9", assets: [{ symbol: "USDC", address: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", decimals: 6 }] },
};
/* The twelve networks Circle's testnet facilitator published on 27 September,
   with their USDC. The challenge's size depends on how many there are. */
const TESTNET_KINDS: SupportedKind[] = ([
  ["eip155:11155111", "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"],
  ["eip155:84532", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"],
  ["eip155:43113", "0x5425890298aed601595a70ab815c96711a31bc65"],
  ["eip155:421614", "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d"],
  ["eip155:14601", "0x0ba304580ee7c9a980cf72e55f5ed2e9fd30bc51"],
  ["eip155:4801", "0x66145f38cbac35ca6f1dfb4914df98f1614aea88"],
  ["eip155:1328", "0x4fcf1784b31630811181f670aea7a7bef803eaed"],
  ["eip155:998", "0x2b3370ee501b4a559b57d449569354196457d8ab"],
  ["eip155:5042002", "0x3600000000000000000000000000000000000000"],
  ["eip155:11155420", "0x5fd84259d66cd46123540766be93dfe6d43130d7"],
  ["eip155:80002", "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582"],
  ["eip155:1301", "0x31d0220469e10c4e71834a79b1f276d740d3768f"],
] as const).map(([network, usdc]) => ({
  network,
  extra: { ...SEPOLIA_KIND.extra, assets: [{ symbol: "USDC", address: usdc, decimals: 6 }] },
}));

const facilitatorCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  facilitatorCalls.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/v1/x402/supported")) {
    return json({ kinds: url.includes("testnet")
      ? TESTNET_KINDS.map((kind) => ({ scheme: "exact", ...kind }))
      : [{ scheme: "exact", ...ARC_KIND }, { scheme: "exact", ...BASE_KIND }] });
  }
  if (url.endsWith("/v1/x402/verify")) return json({ isValid: false, invalidReason: "stubbed" });
  return new Response("not stubbed", { status: 599 });
}) as typeof fetch;

process.env.VEYRA_TRUST_API_PAY_TO = "0x1111111111111111111111111111111111111111";

/* ---- the accepts ---- */

{
  const PAY_TO = "0x2222222222222222222222222222222222222222";
  const onArc = requirementsFromKinds([ARC_KIND, BASE_KIND, SEPOLIA_KIND], {
    amount: "5000",
    payTo: PAY_TO,
    allowed: new Set(["eip155:5042"]),
    schema: ARC_TRUST_API.history.schema,
  });
  assert.equal(onArc.length, 1, "Arc alone, although the facilitator settles Base too");
  assert.deepEqual(
    { network: onArc[0].network, asset: onArc[0].asset, amount: onArc[0].amount, payTo: onArc[0].payTo },
    { network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", amount: "5000", payTo: PAY_TO },
  );
  assert.deepEqual(onArc[0].extra, { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" },
    "The facilitator's own domain, echoed");
  assert.ok(onArc[0].outputSchema, "The schema travels in the challenge");
  const noUsdc = requirementsFromKinds([{ network: "eip155:5042", extra: { name: "GatewayWalletBatched" } }], {
    amount: "5000", payTo: PAY_TO, allowed: null,
  });
  assert.deepEqual(noUsdc, [], "A kind with no USDC asset is not offered");
}

/* ---- what is checked before any money moves ---- */

{
  const refused = (fn: () => unknown, code: string) => assert.throws(fn,
    (error: unknown) => error instanceof TrustApiError && error.code === code && error.status === 400, code);

  refused(() => checkHistoryRequest({}), "resource_required");
  assert.equal(checkHistoryRequest({ resource: "https://api.example.com/x", method: "GET" }).method, "GET");

  const withWallet = checkSelectRequest({ capability: "web_research", budgetUsdc: 1, requesterWallet: "0x1111111111111111111111111111111111111111" }, "testnets");
  assert.equal(withWallet.capability, "web_research", "The published `requesterWallet` no longer makes the engine refuse the request");
  refused(() => checkSelectRequest({ capability: "web_research", budgetUsdc: 1, requesterWallet: "nope" }, "testnets"), "requester_wallet_invalid");
  refused(() => checkSelectRequest({ capability: "web_research", budgetUsdc: 1, invented: true }, "testnets"), "client_derived_fields_forbidden");
  refused(() => checkSelectRequest({ capability: "web_research", budgetUsdc: 0 }, "arc"), "budget_invalid");

  assert.equal(checkSelectRequest({ capability: "web_research", budgetUsdc: 1 }, "arc").network, "eip155:5042", "On Arc the search defaults to Arc");
  assert.equal(checkSelectRequest({ capability: "web_research", budgetUsdc: 1, network: "base" }, "arc").network, "base", "Another network can still be asked for");
  assert.equal(checkSelectRequest({ capability: "web_research", budgetUsdc: 1 }, "testnets").network, undefined, "The testnet route keeps its own default");
}

/* ---- the seller, per rail ---- */

const paymentHeader = (network: string) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network }, payload: {} })).toString("base64");
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(`https://veyra.test${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

{
  let served = 0;
  const arcHistory = withTrustApiPayment(async () => {
    served += 1;
    return new Response("{}") as never;
  }, { endpoint: ARC_TRUST_API.history.path, priceUsdc: ARC_TRUST_API.history.priceUsdc, description: "t", validate: checkHistoryRequest, rail: "arc" });

  const credit = await arcHistory(post(ARC_TRUST_API.history.path, { resource: "https://api.example.com/x" }, { "X-Veyra-Credit": `vcr_${"a".repeat(64)}` }));
  assert.equal(credit.status, 402);
  assert.equal((await credit.json()).error, "credits_not_accepted", "A testnet credit buys nothing on Arc mainnet");
  assert.equal(served, 0);

  const unpaid = await arcHistory(post(ARC_TRUST_API.history.path, { resource: "https://api.example.com/x" }));
  if (VEYRA_ARC_PAY_TO === null) {
    assert.equal(unpaid.status, 503, "Nothing is sold on Arc before there is a wallet to be paid to");
    assert.equal((await unpaid.json()).error, "payments_unavailable");
  } else {
    assert.equal(unpaid.status, 402);
    const challenge = await unpaid.json();
    assert.deepEqual(challenge.accepts.map((accept: { network: string }) => accept.network), ["eip155:5042"], "Arc only");
    assert.equal(challenge.accepts[0].payTo.toLowerCase(), VEYRA_ARC_PAY_TO.toLowerCase());
    assert.equal(challenge.freeAlternative.earnCredit, undefined, "No credit is offered where credits do not pay");
  }
  assert.equal(served, 0);
}

{
  let served = 0;
  const testnetSelect = withTrustApiPayment(async () => {
    served += 1;
    return new Response("{}") as never;
  }, {
    endpoint: "/api/x402/v1/select",
    priceUsdc: 0.02,
    description: "t",
    validate: (body) => checkSelectRequest(body, "testnets"),
  });

  facilitatorCalls.length = 0;
  const refused = await testnetSelect(post("/api/x402/v1/select", { capability: "web_research", budgetUsdc: 1, invented: true },
    { "PAYMENT-SIGNATURE": paymentHeader("eip155:11155111") }));
  assert.equal(refused.status, 400, "An unservable request is refused while it is unpaid");
  assert.equal((await refused.json()).error.code, "client_derived_fields_forbidden");
  assert.ok(!facilitatorCalls.some((url) => url.endsWith("/verify") || url.endsWith("/settle")), "Nothing was sent to be verified or settled");

  facilitatorCalls.length = 0;
  const checked = await testnetSelect(post("/api/x402/v1/select", {
    capability: "web_research", budgetUsdc: 1, requesterWallet: "0x1111111111111111111111111111111111111111",
  }, { "PAYMENT-SIGNATURE": paymentHeader("eip155:11155111") }));
  assert.equal(checked.status, 402, "A servable request goes on to the facilitator");
  assert.equal((await checked.json()).error, "payment_invalid");
  assert.ok(facilitatorCalls.some((url) => url.includes("gateway-api-testnet.circle.com") && url.endsWith("/verify")), "Verified by the testnet facilitator");
  assert.equal(served, 0);

  const challenge = await testnetSelect(post("/api/x402/v1/select", {}));
  assert.equal(challenge.status, 402, "An unpaid request is not checked: a probe with no body still gets the challenge");
  assert.equal((await challenge.json()).freeAlternative.earnCredit, "/api/x402/v1/outcomes");
}

/* ---- a GET reads the challenge, and is never charged ---- */

{
  /* The routes answer POST only, and a GET used to get a bare 405, so
     `circle services inspect`, which probes with GET unless told otherwise,
     reported both Arc routes as unavailable. */
  const terms = {
    endpoint: ARC_TRUST_API.history.path,
    priceUsdc: ARC_TRUST_API.history.priceUsdc,
    description: "t",
    schema: ARC_TRUST_API.history.schema,
    validate: checkHistoryRequest,
    rail: "arc" as const,
  };
  const arcHistoryGet = withTrustApiChallenge(terms);
  const get = (headers: Record<string, string> = {}) => new NextRequest(`https://veyra.test${terms.endpoint}`, { method: "GET", headers });

  facilitatorCalls.length = 0;
  const challenged = await arcHistoryGet(get());
  if (VEYRA_ARC_PAY_TO === null) {
    assert.equal(challenged.status, 503, "Nothing is offered before there is a wallet to be paid to");
  } else {
    assert.equal(challenged.status, 402, "A GET reads the same challenge a POST does");
    const decoded = JSON.parse(Buffer.from(challenged.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8")) as { accepts: Array<Record<string, any>> };
    assert.deepEqual(decoded.accepts.map((accept) => accept.network), ["eip155:5042"]);
    assert.equal(decoded.accepts[0].payTo.toLowerCase(), VEYRA_ARC_PAY_TO.toLowerCase());
    assert.equal(decoded.accepts[0].outputSchema.input.method, "POST", "And it says the answer takes a POST");
  }

  const paidByGet = await arcHistoryGet(get({ "PAYMENT-SIGNATURE": paymentHeader("eip155:5042") }));
  assert.equal(paidByGet.status, 405, "A payment sent with a GET is refused, since there is no body to answer");
  assert.equal(paidByGet.headers.get("Allow"), "POST");
  assert.match((await paidByGet.json()).message, /Nothing was charged/);
  assert.ok(!facilitatorCalls.some((url) => url.endsWith("/verify") || url.endsWith("/settle")), "A GET never reaches verify or settle");

  // Every paid route answers GET this way, with the terms its POST sells on.
  for (const path of [
    "app/api/x402/v1/arc/history/route.ts",
    "app/api/x402/v1/arc/select/route.ts",
    "app/api/x402/v1/history/route.ts",
    "app/api/x402/v1/select/route.ts",
    "app/api/x402/v1/clearance/route.ts",
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /export const GET = withTrustApiChallenge\(TERMS\);/, `${path} answers GET with the challenge`);
    assert.match(source, /export const POST = withTrustApiPayment\([\s\S]*, TERMS\);/, `${path} sells on the same terms`);
  }
}

/* ---- a challenge a Node buyer can read ---- */

for (const product of ["history", "select"] as const) {
  const route = withTrustApiPayment(async () => new Response("{}") as never, {
    endpoint: TRUST_API_PRICING[product].path,
    priceUsdc: TRUST_API_PRICING[product].priceUsdc,
    description: "t",
    schema: TRUST_API_PRICING[product].schema,
  });
  const challenge = await route(post(TRUST_API_PRICING[product].path, {}));
  assert.equal(challenge.status, 402);

  /* Node's fetch reads at most 16 KB of headers, and throws before the body.
     With the schema on each of twelve networks this header was about 20 KB. */
  const header = challenge.headers.get("PAYMENT-REQUIRED") ?? "";
  assert.ok(header.length > 0 && header.length < 12 * 1024, `${product}: the challenge header is ${header.length} bytes; a Node buyer must be able to read it`);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: Array<Record<string, unknown>> };
  assert.equal(decoded.accepts.length, 12, "Every network the facilitator settles is still offered");
  assert.deepEqual(decoded.accepts.map((accept) => "outputSchema" in accept), [true, ...Array(11).fill(false)], "The schema rides once, on the first accept");
  const schemas = challengeSchemas(decoded.accepts);
  assert.ok(schemas.input && schemas.output, "A reader still finds both schemas");
}

/* ---- the catalogue ---- */

{
  const catalog = await buildTrustApiCatalog("https://veyra.test");
  const arcItems = catalog.items.filter((item) => item.metadata.path.startsWith("/api/x402/v1/arc/"));
  assert.equal(arcItems.length, VEYRA_ARC_PAY_TO === null ? 0 : 2, "Arc items are listed only once there is a wallet to be paid to");
  assert.equal("erc8004" in catalog, VEYRA_ARC_AGENT_ID !== null, "The identity is named back only once it exists");
  assert.match(catalog.economics.creditPolicy, /Credits do not pay on Arc mainnet/);
}

/* ---- Veyra, never its own candidate ---- */

assert.ok(isVeyraItself({ resource: `${VEYRA_ORIGIN}/api/x402/v1/arc/select` }));
assert.ok(isVeyraItself({ resource: "https://veyras.vercel.app/api/x402/v1/arc/history" }));
assert.ok(!isVeyraItself({ resource: "https://api.example.com/v1/x", payTo: "0x3333333333333333333333333333333333333333" }));
assert.ok(!isVeyraItself({ resource: "not a url" }));
if (VEYRA_ARC_PAY_TO) assert.ok(isVeyraItself({ resource: "https://elsewhere.example/x", payTo: VEYRA_ARC_PAY_TO.toUpperCase() }), "Or by its wallet, on any host");

/* ---- the registration file, once Veyra sells on Arc ---- */

{
  const selling = veyraRegistrationFile(null, "0x2222222222222222222222222222222222222222");
  assert.equal(selling.x402Support, true);
  assert.deepEqual(selling.services.map((service) => service.name), ["web", "x402", "OpenAPI"]);
  assert.ok(selling.services.every((service) => service.endpoint.startsWith(`${VEYRA_ORIGIN}/`)));
  assert.ok(selling.services.some((service) => service.endpoint === `${VEYRA_ORIGIN}${ARC_OPENAPI_PATH}`));
  assert.match(selling.description, /0\.005 USDC/);
  assert.match(selling.description, /0\.02 USDC/);
  assert.match(selling.description, /signs no clearance there/);
  assert.doesNotMatch(selling.description, /no paid service/);
}

/* ---- the OpenAPI document ---- */

{
  const document = arcTrustApiOpenApi();
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths).sort(), Object.values(ARC_TRUST_API).map((entry) => entry.path).sort());
  for (const entry of Object.values(ARC_TRUST_API)) {
    const operation = (document.paths as Record<string, { post: Record<string, any> }>)[entry.path].post;
    assert.deepEqual(operation.requestBody.content["application/json"].schema, entry.schema.input, "The request it documents is the one the route checks");
    assert.deepEqual(operation.responses[200].content["application/json"].schema, entry.schema.output);
    assert.equal(operation["x-payment-info"].network, "eip155:5042");
    assert.equal(operation["x-payment-info"].priceUsdc, entry.priceUsdc);
  }
  assert.ok(!("requesterWallet" in ARC_TRUST_API.select.schema.input.properties), "No clearance, so no wallet to name for one");
}

console.log("arc trust api: all assertions passed");
