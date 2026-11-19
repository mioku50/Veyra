/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { setByoaClientForTesting } from "../lib/byoa/service.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isCreditTokenShaped,
  hashCreditToken,
  CREDIT_HEADER,
} from "../lib/x402/trust-api/credits.ts";
import {
  summariseEndpointHistory,
  type EndpointObservationRow,
} from "../lib/x402/trust-api/observations.ts";
import {
  normalizeResourceUrl,
  parseProbeMethod,
  readAccept,
  resourceKeyFor,
  selectBaselineAccept,
  TrustApiError,
} from "../lib/x402/trust-api/resource.ts";
import { readPublicArcChallenge } from "../lib/x402/trust-api/public-probe.ts";
import { computeTrustApiVerdict } from "../lib/x402/trust-api/verdict.ts";
import { ARC_MAINNET_NETWORK, ARC_MAINNET_USDC_ADDRESS } from "../lib/wallet/arc.ts";
import { TRUST_API_PRICING } from "../lib/x402/trust-api/pricing.ts";
import { consumeFreeCall } from "../lib/x402/trust-api/rate-limit.ts";
import { historyAnswer } from "../lib/x402/trust-api/answers.ts";
import { validateJsonSchemaValue } from "../lib/seller/json-schema.ts";

/* ---- resource identity ---- */

// The same endpoint keeps one identity across the spellings a catalog produces.
const canonical = normalizeResourceUrl("https://API.Exa.ai/contents/");
assert.equal(canonical, "https://api.exa.ai/contents");
assert.equal(normalizeResourceUrl("https://api.exa.ai/contents#frag"), canonical);
assert.equal(normalizeResourceUrl("https://api.exa.ai:443/contents"), canonical);
assert.equal(resourceKeyFor("POST", canonical), resourceKeyFor("POST", normalizeResourceUrl("https://API.exa.ai/contents/")));

// Query strings select different resources, so they are kept - but their order
// is not meaningful, so it must not fork the identity.
assert.equal(
  resourceKeyFor("GET", normalizeResourceUrl("https://x.dev/a?b=1&a=2")),
  resourceKeyFor("GET", normalizeResourceUrl("https://x.dev/a?a=2&b=1")),
);
assert.notEqual(
  resourceKeyFor("GET", normalizeResourceUrl("https://x.dev/a?b=1")),
  resourceKeyFor("GET", normalizeResourceUrl("https://x.dev/a")),
);
// Method is part of the identity: GET and POST on one path are two resources.
assert.notEqual(resourceKeyFor("GET", canonical), resourceKeyFor("POST", canonical));

assert.throws(() => normalizeResourceUrl("not a url"), (e: unknown) =>
  e instanceof TrustApiError && e.code === "resource_not_a_url");
assert.throws(() => normalizeResourceUrl("ftp://x.dev/a"), (e: unknown) =>
  e instanceof TrustApiError && e.code === "resource_scheme_unsupported");
assert.throws(() => normalizeResourceUrl(""), (e: unknown) =>
  e instanceof TrustApiError && e.code === "resource_required");
assert.throws(() => normalizeResourceUrl("https://example-user:example-password@api.example.com/search"), (e: unknown) =>
  e instanceof TrustApiError && e.code === "resource_credentials_unsupported");
assert.throws(() => parseProbeMethod("DELETE"), (e: unknown) =>
  e instanceof TrustApiError && e.code === "method_unsupported");
assert.equal(parseProbeMethod(undefined), "POST");

/* ---- accepts ---- */

const gatewayAccept = readAccept({
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192",
  amount: "2000",
  maxTimeoutSeconds: 604900,
  extra: { name: "GatewayWalletBatched", version: "1" },
});
assert.equal(gatewayAccept.priceUsdc, 0.002);
assert.equal(gatewayAccept.gatewayBatched, true);
// `maxAmountRequired` is the other spelling live sellers use.
assert.equal(readAccept({ maxAmountRequired: "1500" }).priceUsdc, 0.0015);

// The cheapest payable accept is the baseline, matching how a buyer would pick.
const baseline = selectBaselineAccept([
  readAccept({ scheme: "exact", network: "eip155:8453", asset: "0xa", payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192", amount: "5000" }),
  readAccept({ scheme: "exact", network: "eip155:8453", asset: "0xa", payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192", amount: "1000" }),
]);
assert.equal(baseline?.priceUsdc, 0.001);

/* ---- the public verdict checks the Arc option on the working method ---- */

type ObservationInput = Record<string, unknown>;
const stored: ObservationInput[] = [];
function mockObservations(history: EndpointObservationRow[]): SupabaseClient {
  return {
    from: () => ({
      select: () => {
        let rows = history;
        const query = {
          eq(field: keyof EndpointObservationRow, value: string) {
            rows = rows.filter((item) => item[field] === value);
            return query;
          },
          order: () => query,
          limit: async (limit: number) => ({ data: rows.slice(0, limit), error: null }),
        };
        return query;
      },
      insert: async (value: ObservationInput) => {
        stored.push(value);
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
}
setByoaClientForTesting(mockObservations([]));

const arcQuote = {
  scheme: "exact",
  network: ARC_MAINNET_NETWORK,
  asset: ARC_MAINNET_USDC_ADDRESS,
  payTo: "0x1111111111111111111111111111111111111111",
  amount: "1234",
  maxTimeoutSeconds: 60,
};
const otherNetwork = { ...arcQuote, network: "eip155:84532", amount: "1" };
const otherAsset = { ...arcQuote, asset: "0x2222222222222222222222222222222222222222", amount: "1" };
const anOlderAccept = { ...arcQuote, amount: "1500" };
const input = { resource: canonical, publicArc: true, budgetUsdc: 0.01 };
const methods: string[] = [];
const options = [otherNetwork, otherAsset, anOlderAccept, arcQuote];
const fetchVerdict = async (_: string, init: RequestInit): Promise<Response> => {
  methods.push(String(init.method));
  assert.equal(new Headers(init.headers).has("payment-signature"), false);
  if (init.method === "POST") {
    // A lookalike response with accepts is not a successful challenge.
    return Response.json({ accepts: options }, { status: 405 });
  }
  assert.equal(init.body, undefined);
  const challenge = Buffer.from(JSON.stringify({ x402Version: 2, accepts: options })).toString("base64");
  return new Response(null, { status: 402, headers: { "payment-required": challenge } });
};

const publicVerdict = await computeTrustApiVerdict({
  ...input, catalogueMethod: async () => null, probeFetchImpl: fetchVerdict,
});
assert.deepEqual(methods, ["POST", "GET", "GET"]);
assert.equal(publicVerdict.method, "GET");
assert.equal(publicVerdict.network, ARC_MAINNET_NETWORK);
assert.equal(publicVerdict.priceUsdc, 0.001234);
assert.equal(publicVerdict.resourceKey, resourceKeyFor("GET", canonical));
assert.equal(publicVerdict.payTo, arcQuote.payTo);
assert.deepEqual(publicVerdict.probe.catalogDrift, []);

methods.length = 0;
const listed = await readPublicArcChallenge({
  resource: canonical, lookupMethod: async (resource) => {
    assert.equal(resource, canonical);
    return "GET";
  }, fetchImpl: fetchVerdict,
});
assert.equal(listed.accept.amountAtomic, arcQuote.amount);
assert.deepEqual(methods, ["GET"]);

methods.length = 0;
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.circle.com");
    const metadata = { method: "GET" };
    const accepts = [arcQuote];
    return Response.json({ items: [{ resource: "https://", metadata, accepts },
      { resource: canonical, metadata, accepts }] });
  };
  const withMalformedListing = await readPublicArcChallenge({
    resource: canonical, fetchImpl: fetchVerdict,
  });
  assert.equal(withMalformedListing.method, "GET");
  assert.deepEqual(methods, ["GET"]);
} finally {
  globalThis.fetch = originalFetch;
}

await assert.rejects(readPublicArcChallenge({
  resource: "http://api.example.com/search", method: "GET",
  fetchImpl: async () => { throw new Error("non-HTTPS URL reached the transport"); },
}), (e: unknown) => e instanceof TrustApiError && e.code === "resource_scheme_unsupported");


methods.length = 0;
await assert.rejects(readPublicArcChallenge({
  resource: canonical, method: "POST",
  lookupMethod: async () => { throw new Error("explicit methods skip catalogue lookup"); },
  fetchImpl: fetchVerdict,
}), (e: unknown) => e instanceof TrustApiError && e.code === "no_payable_challenge");
assert.deepEqual(methods, ["POST"]);

await assert.rejects(readPublicArcChallenge({
  resource: canonical, method: "GET",
  fetchImpl: async () => Response.json({ accepts: [otherNetwork, otherAsset] }, { status: 402 }),
}), (e: unknown) => e instanceof TrustApiError && e.code === "arc_mainnet_not_offered");

let repeat = false;
await assert.rejects(computeTrustApiVerdict({
  ...input, method: "GET", probeFetchImpl: async () => {
    const accepts = repeat ? [otherNetwork, otherAsset] : [arcQuote];
    repeat = true;
    return Response.json({ accepts }, { status: 402 });
  },
}), (e: unknown) => e instanceof TrustApiError && e.code === "arc_quote_unavailable");

/* ---- history and the alert the product is built on ---- */

function row(over: Partial<EndpointObservationRow>): EndpointObservationRow {
  return {
    observation_id: crypto.randomUUID(),
    resource_key: "a".repeat(64),
    resource_url: canonical,
    method: "POST",
    network: "eip155:8453",
    candidate_id: null,
    observed_pay_to: "0x1111111111111111111111111111111111111111",
    observed_price_usdc: 0.002,
    observed_asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    reachable: true,
    responded_with_402: true,
    challenge_parseable: true,
    challenge_transport: "payment_required_header",
    http_status: 402,
    http_status_class: "4xx",
    latency_ms: 400,
    integrity_score: 90,
    catalog_drift: [],
    critical_failure: null,
    error_category: "none",
    probe_version: "veyra-x402-probe-v1",
    probed_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const resourceKey = resourceKeyFor("GET", canonical);
setByoaClientForTesting(mockObservations([
  row({ resource_key: resourceKey, method: "GET", network: "eip155:84532", observed_price_usdc: 1 }),
  row({ resource_key: resourceKey, method: "GET", network: ARC_MAINNET_NETWORK,
    observed_asset: ARC_MAINNET_USDC_ADDRESS, observed_price_usdc: 0.001234,
    observed_pay_to: "0x3333333333333333333333333333333333333333",
  }),
]));
const driftVerdict = await computeTrustApiVerdict({
  ...input, method: "GET", probeFetchImpl: fetchVerdict,
});
assert.equal(driftVerdict.baseline, "veyra_history");
assert.equal(driftVerdict.priceUsdc, 0.001234);
assert.equal(driftVerdict.granted, false);
assert.ok(driftVerdict.alerts.some((alert) => alert.code === "pay_to_changed"
  && alert.detail.includes("0x3333333333333333333333333333333333333333")));
assert.equal(stored.at(-1)?.network, ARC_MAINNET_NETWORK);
assert.equal(stored.at(-1)?.resource_key, resourceKey);

setByoaClientForTesting(mockObservations([]));
const zeroVerdict = await computeTrustApiVerdict({
  ...input, method: "GET",
  probeFetchImpl: async () => Response.json({ accepts: [{ ...arcQuote, amount: "0" }] }, { status: 402 }),
});
assert.equal(zeroVerdict.granted, false);
assert.equal(zeroVerdict.maxExposureUsdc, 0);
assert.ok(zeroVerdict.alerts.some((alert) => alert.code === "price_not_quoted"));
setByoaClientForTesting(null);

const changed = summariseEndpointHistory("a".repeat(64), [
  row({ probed_at: "2026-09-01T00:00:00.000Z" }),
  row({ probed_at: "2026-09-02T00:00:00.000Z" }),
  row({
    probed_at: "2026-09-03T00:00:00.000Z",
    observed_pay_to: "0x2222222222222222222222222222222222222222",
    observed_price_usdc: 0.004,
  }),
]);
assert.equal(changed.observations, 3);
assert.equal(changed.distinctPayTos, 2);
assert.equal(changed.payToNow, "0x2222222222222222222222222222222222222222");
// Newest change first: a truncated list must show the most recent one.
assert.equal(changed.changes[0]?.field, "pay_to");
assert.equal(changed.changes[0]?.to, "0x2222222222222222222222222222222222222222");
assert.equal(changed.changes[0]?.observedAt, "2026-09-03T00:00:00.000Z");
assert.ok(changed.changes.some((c) => c.field === "price_usdc" && c.to === "0.004000"));
// The payee has only been stable since it changed, not since first contact.
assert.equal(changed.payToStableSince, "2026-09-03T00:00:00.000Z");

// A steady endpoint reports no changes at all.
const steady = summariseEndpointHistory("a".repeat(64), [row({}), row({ probed_at: "2026-09-02T00:00:00.000Z" })]);
assert.equal(steady.changes.length, 0);
assert.equal(steady.distinctPayTos, 1);

// Honesty about thin evidence: below the quality engine's threshold it refuses
// to claim a statistical opinion rather than extrapolating from three samples.
assert.equal(steady.statisticalEvidenceAvailable, false);
const many = summariseEndpointHistory(
  "a".repeat(64),
  Array.from({ length: 12 }, (_, i) => row({ probed_at: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` })),
);
assert.equal(many.statisticalEvidenceAvailable, true);
assert.equal(many.metrics.latencyP95Ms > 0, true);

// No history is an empty answer, never an invented one.
const none = summariseEndpointHistory("a".repeat(64), []);
assert.equal(none.observations, 0);
assert.equal(none.payToNow, null);
assert.equal(none.statisticalEvidenceAvailable, false);

/* A seller that prices each request, as Exa's /contents does, quotes 0 for the
   probe's empty request. Rows stored before the probe knew that also carry the
   price change it raised against the catalogue. Read as prices, they sold the
   endpoint as free with 0% valid responses. */
const perRequest = summariseEndpointHistory(
  "a".repeat(64),
  Array.from({ length: 12 }, (_, i) => row({
    probed_at: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    observed_price_usdc: "0.000000",
    catalog_drift: ["price_changed"],
  })),
);
assert.equal(perRequest.priceQuotes, 0);
assert.equal(perRequest.zeroQuotes, 12);
assert.equal(perRequest.metrics.validResponsePercent, 100, "A zero quote's price change does not make the response invalid");
assert.equal(perRequest.changes.length, 0);
const perRequestAnswer = historyAnswer({ resource: canonical, method: "POST", resourceKey: "a".repeat(64) }, perRequest);
assert.equal(perRequestAnswer.priceUsdc, null, "No price was stated, so none is reported, and certainly not 0");
assert.match(perRequestAnswer.note ?? "", /prices each request/);
// A zero among stated prices is not a price change either.
const mixed = summariseEndpointHistory("a".repeat(64), [
  row({}),
  row({ probed_at: "2026-09-02T00:00:00.000Z", observed_price_usdc: 0 }),
  row({ probed_at: "2026-09-03T00:00:00.000Z" }),
]);
assert.equal(mixed.changes.length, 0);
assert.equal(mixed.priceQuotes, 2);
assert.equal(mixed.metrics.quotedPriceMinUsdc, 0.002, "The zero is left out of the price distribution");
// Other drift on a zero-quote row still counts against it.
assert.equal(summariseEndpointHistory("a".repeat(64), [row({ observed_price_usdc: 0, catalog_drift: ["price_changed", "payto_changed"] })]).metrics.validResponsePercent, 0);

// Every history answer matches the schema it publishes, checked with the
// validator Veyra holds sellers' answers to.
for (const summary of [changed, steady, many, none, perRequest]) {
  const answer = historyAnswer({ resource: canonical, method: "POST", resourceKey: "a".repeat(64) }, summary);
  const result = validateJsonSchemaValue(JSON.parse(JSON.stringify(answer)), TRUST_API_PRICING.history.schema.output);
  assert.ok(result.ok, `history's answer fails its own published schema: ${result.ok ? "" : `${result.path} ${result.message}`}`);
}

/* ---- credits ---- */

assert.equal(isCreditTokenShaped(`vcr_${"a".repeat(64)}`), true);
assert.equal(isCreditTokenShaped(`vcr_${"a".repeat(63)}`), false);
assert.equal(isCreditTokenShaped("bearer abc"), false);
assert.equal(isCreditTokenShaped(null), false);
// Only the hash is ever stored, and it is not reversible to the token.
const token = `vcr_${"b".repeat(64)}`;
assert.match(hashCreditToken(token), /^[0-9a-f]{64}$/);
assert.notEqual(hashCreditToken(token), token);
assert.equal(CREDIT_HEADER, "X-Veyra-Credit");

/* ---- what is free stays free ---- */

assert.equal(TRUST_API_PRICING.verdict.priceUsdc, 0, "the verdict must never be sold");
assert.equal(TRUST_API_PRICING.outcomes.priceUsdc, 0, "reporting evidence must never cost the reporter");
assert.ok(TRUST_API_PRICING.clearance.priceUsdc > 0);
// A credit must be worth less than the clearance that earns it, or minting
// credits becomes profitable and the evidence base fills with noise.
assert.ok(TRUST_API_PRICING.clearance.priceUsdc >= TRUST_API_PRICING.history.priceUsdc);

/* ---- free tier courtesy limit ---- */

const key = `test-${Date.now()}`;
for (let i = 0; i < 20; i += 1) assert.equal(consumeFreeCall(key, 20).allowed, true);
const blocked = consumeFreeCall(key, 20);
assert.equal(blocked.allowed, false);
assert.ok(blocked.retryAfterSeconds > 0);
// One caller's limit never touches another's.
assert.equal(consumeFreeCall(`${key}-other`, 20).allowed, true);

console.log("[x402-trust-api-test] passed: resource identity, accept parsing, payee-change detection, price distributions, evidence thresholds, credit tokens, pricing invariants, free-tier limit");
