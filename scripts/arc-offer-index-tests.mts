/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { checkArcListing, indexArcListings, summarizeArcOfferIndex } from "../lib/discovery/arc-offer-index.ts";
import { readBazaar, readCircleCatalogue } from "../lib/discovery/catalogues.ts";
import type { OfferInput } from "../lib/discovery/offers.ts";
import { ARC_MAINNET_NETWORK, ARC_MAINNET_USDC_ADDRESS } from "../lib/wallet/arc.ts";

const now = new Date("2026-11-20T01:00:00Z");
const payee = "0x0000000000000000000000000000000000000009";
const otherPayee = "0x0000000000000000000000000000000000000008";
const accept = {
  scheme: "exact",
  network: ARC_MAINNET_NETWORK,
  asset: ARC_MAINNET_USDC_ADDRESS,
  amount: "12000",
  payTo: payee,
  maxTimeoutSeconds: 60,
};
const resource = "https://example.com/premium/search";
const item = { resource, metadata: { method: "POST" }, accepts: [accept] };

function offer(change: Partial<OfferInput> = {}): OfferInput {
  return {
    resource, method: "POST", provider: null, description: null,
    accepts: [{ network: ARC_MAINNET_NETWORK, amountAtomic: "12000", payTo: payee, rail: "wallet", quotableByVeyra: true }],
    declaredPriceUsd: null, erc8004: null, listing: { source: "circle", listedAt: null },
    ...change,
  };
}

test("catalogue inputs merge by canonical URL and HTTP method, publishing only stable public Arc listings", () => {
  const changed = offer({ resource: "https://EXAMPLE.com/premium/search#docs", listing: { source: "bazaar", listedAt: null } });
  changed.accepts[0].amountAtomic = "19999";
  const filtered = [
    offer({ resource: resource + "?token=public-example" }),
    offer({ resource: "https://user:pass@example.com/path" }),
    offer({ resource: "https://example.com/%7Bid%7D" }),
    offer({ resource: "https://127.0.0.1/local" }),
    offer({ resource: "http://example.com/path" }),
    offer({ resource: "https://node.internal/path" }),
    offer({ resource: "https://base.example.com/premium/search", accepts: [{ ...offer().accepts[0], network: "eip155:8453" }] }),
  ];
  const rows = indexArcListings([changed, offer(), offer({ method: "GET" }), offer({ resource: resource + "/" }), ...filtered], now.toISOString());
  assert.equal(rows.length, 3);
  assert(rows.some((row) => row.resource === resource + "/"));
  const post = rows.find((row) => row.method === "POST");
  assert(post);
  assert.deepEqual(post.sources, ["circle", "bazaar"]);
  assert.equal(post.listed_amount, "12000");
  assert.equal(post.resource, resource);
  assert.equal(post.listed_at, now.toISOString());
  assert.notEqual(rows[0].resource_key, rows[1].resource_key);
});

test("Circle reads beyond its live-lookup cap and keeps completed pages on an interrupted inventory read", async () => {
  const options = {
    networks: [ARC_MAINNET_NETWORK],
    fetchImpl: async (url: RequestInfo | URL) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      if (offset === 1400) return new Response(null, { status: 502 });
      return Response.json({ pagination: { total: 1600 }, items: Array(200).fill(item) });
    },
  } as const;
  const ordinary = await readCircleCatalogue(options);
  assert.equal(ordinary.offers.length, 1000);
  assert.equal(ordinary.complete, false);
  const inventory = await readCircleCatalogue({ ...options, inventory: true });
  assert.equal(inventory.offers.length, 1400);
  assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.pageFailures, [
    { network: ARC_MAINNET_NETWORK, offset: 1400, status: 502, reason: "http" },
  ]);
});

test("Circle partial reads classify invalid responses and deadlines without provider text", async () => {
  const failures = [
    { fetch: () => new Response("malformed-provider-detail"), reason: "invalid_response" },
    { fetch: () => { throw new DOMException("timeout-provider-detail", "TimeoutError"); }, reason: "timeout" },
  ] as const;
  for (const failure of failures) {
    const result = await readCircleCatalogue({
      networks: [ARC_MAINNET_NETWORK],
      inventory: true,
      fetchImpl: async (url) => Number(new URL(String(url)).searchParams.get("offset")) === 0
        ? Response.json({ pagination: { total: 400 }, items: Array(200).fill(item) })
        : failure.fetch(),
    });
    assert.equal(result.offers.length, 200);
    assert.equal(result.complete, false);
    assert.deepEqual(result.pageFailures, [
      { network: ARC_MAINNET_NETWORK, offset: 200, status: null, reason: failure.reason },
    ]);
  }
});

test("Circle inventory honors seconds and HTTP dates when retrying the same page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const offsets: number[] = [];
  const inventory = readCircleCatalogue({
    networks: [ARC_MAINNET_NETWORK],
    inventory: true,
    fetchImpl: async (url) => {
      offsets.push(Number(new URL(String(url)).searchParams.get("offset")));
      if (offsets.length === 2) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
      if (offsets.length === 3) {
        const reset = new Date(now.getTime() + 65_000).toUTCString();
        return new Response(null, { status: 429, headers: { "Retry-After": reset } });
      }
      return Response.json({ pagination: { total: 400 }, items: Array(200).fill(item) });
    },
  });
  await nextTurn();
  t.mock.timers.tick(59_999);
  await nextTurn();
  assert.deepEqual(offsets, [0, 200]);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(offsets, [0, 200, 200]);
  t.mock.timers.tick(4_999);
  await nextTurn();
  assert.deepEqual(offsets, [0, 200, 200]);
  t.mock.timers.tick(1);

  const result = await inventory;
  assert.deepEqual(offsets, [0, 200, 200, 200]);
  assert.equal(result.offers.length, 400);
  assert.equal(result.complete, true);
  assert.equal(result.retries, 2);
  assert.deepEqual(result.pageFailures, []);
});

test("Circle inventory stops before a Retry-After beyond the remaining wait allowance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const offsets: number[] = [];
  const inventory = readCircleCatalogue({
    networks: [ARC_MAINNET_NETWORK],
    inventory: true,
    fetchImpl: async (url) => {
      offsets.push(Number(new URL(String(url)).searchParams.get("offset")));
      if (offsets.length === 1) return Response.json({ pagination: { total: 400 }, items: Array(200).fill(item) });
      return new Response(null, { status: 429, headers: { "Retry-After": offsets.length === 2 ? "60" : "6" } });
    },
  });
  await nextTurn();
  t.mock.timers.tick(60_000);
  const result = await inventory;
  assert.deepEqual(offsets, [0, 200, 200]);
  assert.equal(result.offers.length, 200);
  assert.equal(result.complete, false);
  assert.equal(result.retries, 1);
  assert.deepEqual(result.pageFailures, [
    { network: ARC_MAINNET_NETWORK, offset: 200, status: 429, reason: "http" },
  ]);
});

test("Circle retries are capped across the whole scan even when Retry-After is zero", async () => {
  const offsets: number[] = [];
  const result = await readCircleCatalogue({
    networks: [ARC_MAINNET_NETWORK],
    inventory: true,
    fetchImpl: async (url) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      const firstRequest = !offsets.includes(offset);
      offsets.push(offset);
      if (offset && firstRequest) return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
      return Response.json({ pagination: { total: 800 }, items: Array(200).fill(item) });
    },
  });
  assert.deepEqual(offsets, [0, 200, 200, 400, 400, 600]);
  assert.equal(result.offers.length, 600);
  assert.equal(result.complete, false);
  assert.equal(result.retries, 2);
  assert.equal(result.pageFailures[0].offset, 600);
});

test("A job deadline interrupts the Circle fallback wait and keeps the original 429", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const deadline = new AbortController();
  let calls = 0;
  const inventory = readCircleCatalogue({
    networks: [ARC_MAINNET_NETWORK],
    inventory: true,
    signal: deadline.signal,
    fetchImpl: async () => ++calls === 1
      ? Response.json({ pagination: { total: 400 }, items: Array(200).fill(item) })
      : new Response(null, { status: 429, headers: { "Retry-After": "1.5" } }),
  });
  await nextTurn();
  t.mock.timers.tick(9_999);
  await nextTurn();
  assert.equal(calls, 2);
  deadline.abort();
  const result = await inventory;
  assert.equal(calls, 2);
  assert.equal(result.offers.length, 200);
  assert.equal(result.complete, false);
  assert.equal(result.retries, 0);
  assert.deepEqual(result.pageFailures, [
    { network: ARC_MAINNET_NETWORK, offset: 200, status: 429, reason: "http" },
  ]);
});

test("Circle live-tool lookups surface 429 without retrying", async () => {
  let calls = 0;
  await assert.rejects(readCircleCatalogue({
    networks: [ARC_MAINNET_NETWORK],
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
    },
  }), { name: "CatalogueUnavailableError", status: 429 });
  assert.equal(calls, 1);
});

test("Bazaar keeps Arc terms from a multi-chain catalogue and reports a complete page scan", async () => {
  const data = await readBazaar({
    inventory: true,
    networks: [ARC_MAINNET_NETWORK],
    fetchImpl: async () => Response.json({
      pagination: { total: 2 },
      items: [item, { ...item, accepts: [{ ...accept, network: "eip155:8453" }] }],
    }),
  });
  assert.equal(data.complete, true);
  assert.equal(data.scanned, 2);
  assert.equal(data.offers.length, 1);
});

const [listing] = indexArcListings([offer()], now.toISOString());
function challenge(accepts: unknown[]) {
  return new Response("{}", {
    status: 402,
    headers: { "Payment-Required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") },
  });
}

test("checks use one unpaid request with the catalogued method and detect confirmed Arc price and payee drift", async () => {
  let requested = 0;
  const check = await checkArcListing(listing, {
    now,
    fetchImpl: async (url, init) => {
      requested += 1;
      assert.equal(url, resource);
      assert.equal(init.method, "POST");
      assert.equal(init.body, "{}");
      const headers = new Headers(init.headers);
      for (const name of ["authorization", "x-payment", "payment-signature", "cookie"]) {
        assert.equal(headers.has(name), false);
      }
      return challenge([
        { ...accept, network: "eip155:8453", amount: "12000" },
        { ...accept, asset: otherPayee, amount: "1" },
        { ...accept, amount: "18000", payTo: otherPayee },
      ]);
    },
  });
  assert.equal(requested, 1);
  assert.equal(check.arc_challenge, true);
  assert.equal(check.live_amount, "18000");
  assert.equal(check.live_payee, otherPayee);
  assert.deepEqual(check.drift.sort(), ["payto_changed", "price_changed"]);
  assert(check.failed_checks.includes("accepts_matches_catalog"));
  assert.equal(check.checked_at, now.toISOString());
});

test("same-wallet listed terms are matched across accepts and empty-request price is unknown", async () => {
  for (const amount of ["00012000", "0"]) {
    const check = await checkArcListing(listing, { now, fetchImpl: async () => challenge([
      { ...accept, amount: "1", extra: { name: "GatewayWalletBatched" } },
      { ...accept, amount },
    ]) });
    assert.equal(check.arc_challenge, true);
    assert.equal(check.live_amount, amount === "0" ? null : "12000");
    assert.deepEqual(check.drift, []);
    assert(!check.failed_checks.includes("accepts_matches_catalog"));
  }
});

test("non-Arc and timeout results publish failed check codes without arbitrary provider text", async () => {
  const noArc = await checkArcListing(listing, {
    now, fetchImpl: async () => challenge([
      { ...accept, network: "eip155:8453" },
      { ...accept, extra: { name: "GatewayWalletBatched", verifyingContract: otherPayee } },
    ]),
  });
  assert.equal(noArc.arc_challenge, false);
  assert.equal(noArc.live_payee, null);
  assert(noArc.failed_checks.includes("challenge_parseable"));
  const timeout = await checkArcListing(listing, {
    now, fetchImpl: async () => { throw new Error("provider timeout with sensitive response"); },
  });
  assert.equal(timeout.error_category, "timeout");
  assert(!JSON.stringify(timeout).includes("sensitive"));
});

test("summarizeArcOfferIndex counts listings, unique hosts, 7d checks and valid Arc rate", () => {
  const empty = summarizeArcOfferIndex(
    [{ hostname: "api.example.com" }, { hostname: "api.example.com" }, { hostname: "other.example.com" }],
    [],
    now.toISOString(),
  );
  assert.deepEqual(empty, {
    listings: 3,
    hosts: 2,
    checks7d: 0,
    arcChallengeChecks7d: 0,
    arcChallengeRate7d: null,
    asOf: now.toISOString(),
  });

  const populated = summarizeArcOfferIndex(
    [{ hostname: "a.example" }, { hostname: "b.example" }, { hostname: "a.example" }, { hostname: "c.example" }],
    [{ arc_challenge: true }, { arc_challenge: false }, { arc_challenge: true }, { arc_challenge: true }],
    now.toISOString(),
  );
  assert.equal(populated.listings, 4);
  assert.equal(populated.hosts, 3);
  assert.equal(populated.checks7d, 4);
  assert.equal(populated.arcChallengeChecks7d, 3);
  assert.equal(populated.arcChallengeRate7d, 0.75);
  assert.equal(populated.asOf, now.toISOString());
});
