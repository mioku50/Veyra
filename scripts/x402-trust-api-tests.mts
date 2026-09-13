/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
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
import { TRUST_API_PRICING } from "../lib/x402/trust-api/pricing.ts";
import { consumeFreeCall } from "../lib/x402/trust-api/rate-limit.ts";

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
